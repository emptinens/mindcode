//! A worker's disjoint file-ownership scope: a non-empty set of relative
//! paths under the workspace root. Two active workers must never overlap.
//!
//! This module also owns the shared disjoint-scope allocator and the
//! `ActiveScopes` registry so both the native CLI and the daemon reserve
//! non-overlapping ownership for parallel workers identically.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Error returned when a scope entry is malformed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopeError {
    pub entry: String,
    pub reason: &'static str,
}

/// A validated set of relative ownership paths. A directory entry covers
/// everything under it; a file entry covers exactly that file.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct WorkerScope {
    entries: Vec<PathBuf>,
    all: bool,
}

impl WorkerScope {
    /// Build a scope from relative paths. Every entry must be non-empty,
    /// relative, and free of `..`, root, and prefix components.
    pub fn new(entries: Vec<PathBuf>) -> Result<Self, ScopeError> {
        let mut normalized = Vec::with_capacity(entries.len());
        for entry in entries {
            validate_entry(&entry)?;
            normalized.push(normalize(entry));
        }
        Ok(Self {
            entries: normalized,
            all: false,
        })
    }

    /// A scope covering the entire workspace (a single non-disjoint worker).
    pub fn all() -> Self {
        Self {
            entries: Vec::new(),
            all: true,
        }
    }

    pub fn entries(&self) -> &[PathBuf] {
        &self.entries
    }

    /// Whether this scope covers the entire workspace.
    pub fn is_all(&self) -> bool {
        self.all
    }

    pub fn is_empty(&self) -> bool {
        !self.all && self.entries.is_empty()
    }

    /// Whether the workspace-relative `rel` path is covered by this scope.
    pub fn contains(&self, rel: &Path) -> bool {
        self.all
            || self
                .entries
                .iter()
                .any(|entry| entry == rel || rel.starts_with(entry))
    }

    /// Whether this scope overlaps another (neither must be dispatched while
    /// the other is active).
    pub fn intersects(&self, other: &WorkerScope) -> bool {
        self.all
            || other.all
            || self.entries.iter().any(|a| {
                other
                    .entries
                    .iter()
                    .any(|b| a.starts_with(b) || b.starts_with(a))
            })
    }
}

fn validate_entry(entry: &Path) -> Result<(), ScopeError> {
    let display = entry.display().to_string();
    let reason = if display.is_empty() {
        Some("scope entry is empty")
    } else if entry.is_absolute() || entry.has_root() {
        Some("scope entry must be relative")
    } else if entry.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    }) {
        Some("scope entry must not contain '..' or an absolute root")
    } else {
        None
    };
    match reason {
        Some(reason) => Err(ScopeError {
            entry: display,
            reason,
        }),
        None => Ok(()),
    }
}

/// Drop `.` components so `./crates/foo` and `crates/foo` compare equal.
fn normalize(entry: PathBuf) -> PathBuf {
    entry
        .components()
        .filter(|component| !matches!(component, Component::CurDir))
        .collect()
}

/// Why a disjoint scope could not be assigned. Kept structural so callers can
/// map it to their own diagnostic surface without parsing strings.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScopeAssignmentError {
    /// A scope entry was malformed.
    Malformed(ScopeError),
    /// The requested scope overlaps an active worker's ownership.
    OverlapsActiveWorker,
    /// A whole-workspace worker is already active.
    WorkspaceAlreadyActive,
    /// The active-scope registry lock is poisoned.
    RegistryPoisoned,
    /// The worker id is already registered.
    DuplicateWorker,
}

impl fmt::Display for ScopeAssignmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed(error) => write!(
                f,
                "invalid worker scope entry '{}': {}",
                error.entry, error.reason
            ),
            Self::OverlapsActiveWorker => write!(f, "worker scope overlaps an active worker"),
            Self::WorkspaceAlreadyActive => {
                write!(f, "a workspace-scoped worker is already active; scope this task to a subdirectory")
            }
            Self::RegistryPoisoned => write!(f, "worker scope registry poisoned"),
            Self::DuplicateWorker => write!(f, "worker id is already active"),
        }
    }
}

impl std::error::Error for ScopeAssignmentError {}

/// Registry of active worker scopes keyed by worker id. Parallel workers must
/// receive non-overlapping ownership; a new worker that would overlap an
/// active one is refused instead of silently sharing the workspace.
#[derive(Clone, Default)]
pub struct ActiveScopes {
    inner: Arc<Mutex<BTreeMap<String, WorkerScope>>>,
}

/// RAII lease that releases a worker's scope when dropped, so an aborted or
/// dropped worker can never pin ownership forever.
pub struct ScopeLease {
    scopes: ActiveScopes,
    worker_id: String,
}

impl Drop for ScopeLease {
    fn drop(&mut self) {
        self.scopes.release(&self.worker_id);
    }
}

impl ActiveScopes {
    /// Reserve a disjoint scope for `worker_id` atomically: the allocator runs
    /// against the current registry and the registration happens under the same
    /// lock, so two concurrent spawns cannot both win the workspace.
    pub fn assign_for(
        &self,
        cwd: &Path,
        task: &str,
        worker_id: &str,
    ) -> Result<(WorkerScope, ScopeLease), ScopeAssignmentError> {
        let mut active = self
            .inner
            .lock()
            .map_err(|_| ScopeAssignmentError::RegistryPoisoned)?;
        if active.contains_key(worker_id) {
            return Err(ScopeAssignmentError::DuplicateWorker);
        }
        let scope = assign_worker_scope(cwd, task, &active.values().cloned().collect::<Vec<_>>())?;
        active.insert(worker_id.to_owned(), scope.clone());
        Ok((
            scope,
            ScopeLease {
                scopes: self.clone(),
                worker_id: worker_id.to_owned(),
            },
        ))
    }

    /// Register an already-assigned scope (callers that need the scope before
    /// reserving it). Prefer [`Self::assign_for`] for the atomic path.
    pub fn register(
        &self,
        worker_id: &str,
        scope: WorkerScope,
    ) -> Result<(), ScopeAssignmentError> {
        let mut active = self
            .inner
            .lock()
            .map_err(|_| ScopeAssignmentError::RegistryPoisoned)?;
        if active.contains_key(worker_id) {
            return Err(ScopeAssignmentError::DuplicateWorker);
        }
        active.insert(worker_id.to_owned(), scope);
        Ok(())
    }

    /// Release a worker's scope by id (idempotent).
    pub fn release(&self, worker_id: &str) {
        if let Ok(mut active) = self.inner.lock() {
            active.remove(worker_id);
        }
    }

    /// Snapshot of the currently active scopes.
    pub fn active(&self) -> Result<Vec<WorkerScope>, ScopeAssignmentError> {
        let active = self
            .inner
            .lock()
            .map_err(|_| ScopeAssignmentError::RegistryPoisoned)?;
        Ok(active.values().cloned().collect())
    }

    /// Number of registered workers.
    pub fn len(&self) -> usize {
        self.inner.lock().map(|active| active.len()).unwrap_or(0)
    }

    /// Whether no worker is registered.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Pick a workspace subdirectory explicitly named by the task, if any. Only
/// existing top-level directories are recognized, so a task like
/// "fix crates/foo" scopes the worker to `crates/foo` while unrelated prose
/// leaves the scope default (the whole workspace).
pub fn task_workspace_dir(cwd: &Path, task: &str) -> Option<PathBuf> {
    let directories = fs::read_dir(cwd)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.file_name())
        .collect::<Vec<_>>();
    task.split_whitespace()
        .filter_map(|word| {
            let cleaned: String = word
                .chars()
                .filter(|character| {
                    character.is_alphanumeric() || matches!(character, '-' | '_' | '.' | '/')
                })
                .collect();
            // A task path like `crates/foo/bar.rs` scopes to its first
            // top-level component, so only existing top-level dirs match.
            let head = cleaned.split('/').next().unwrap_or_default();
            directories
                .iter()
                .find(|directory| directory.as_os_str() == head)
                .map(PathBuf::from)
        })
        .next()
}

/// Assign an explicit, disjoint scope to a worker (§6.5). Default is the whole
/// workspace when no other worker is active; a task that names an existing
/// workspace subdirectory gets exactly that directory. Overlap with any active
/// scope fails closed.
pub fn assign_worker_scope(
    cwd: &Path,
    task: &str,
    active: &[WorkerScope],
) -> Result<WorkerScope, ScopeAssignmentError> {
    if let Some(directory) = task_workspace_dir(cwd, task) {
        let scope = WorkerScope::new(vec![directory]).map_err(ScopeAssignmentError::Malformed)?;
        if active.iter().any(|other| other.intersects(&scope)) {
            return Err(ScopeAssignmentError::OverlapsActiveWorker);
        }
        return Ok(scope);
    }
    let scope = WorkerScope::all();
    if active.iter().any(|other| other.intersects(&scope)) {
        return Err(ScopeAssignmentError::WorkspaceAlreadyActive);
    }
    Ok(scope)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(paths: &[&str]) -> WorkerScope {
        WorkerScope::new(paths.iter().map(PathBuf::from).collect()).unwrap()
    }

    #[test]
    fn rejects_malformed_entries() {
        assert!(WorkerScope::new(vec![PathBuf::new()]).is_err());
        assert!(WorkerScope::new(vec![PathBuf::from("/abs/path")]).is_err());
        assert!(WorkerScope::new(vec![PathBuf::from("../escape")]).is_err());
        assert!(WorkerScope::new(vec![PathBuf::from("a/../../b")]).is_err());
    }

    #[test]
    fn normalizes_cur_dir_components() {
        let scoped = scope(&["./crates/foo"]);
        assert!(scoped.contains(Path::new("crates/foo/a.rs")));
    }

    #[test]
    fn directory_entry_covers_subtree_but_not_siblings() {
        let scoped = scope(&["crates/foo"]);
        assert!(scoped.contains(Path::new("crates/foo")));
        assert!(scoped.contains(Path::new("crates/foo/a/b.rs")));
        assert!(!scoped.contains(Path::new("crates/foobar")));
        assert!(!scoped.contains(Path::new("crates")));
    }

    #[test]
    fn file_entry_covers_exactly_that_file() {
        let scoped = scope(&["crates/foo/Cargo.toml"]);
        assert!(scoped.contains(Path::new("crates/foo/Cargo.toml")));
        assert!(!scoped.contains(Path::new("crates/foo/Cargo.toml.bak")));
        assert!(!scoped.contains(Path::new("crates/foo/lib.rs")));
    }

    #[test]
    fn intersects_detects_overlaps_in_both_directions() {
        let a = scope(&["crates/foo"]);
        let b = scope(&["crates/foo/src"]);
        let c = scope(&["crates/bar"]);
        assert!(a.intersects(&b));
        assert!(b.intersects(&a));
        assert!(!a.intersects(&c));
        assert!(!c.intersects(&b));
    }

    #[test]
    fn whole_workspace_scope_covers_everything_and_intersects_all() {
        let all = WorkerScope::all();
        assert!(all.contains(Path::new("crates/foo/a.rs")));
        assert!(all.contains(Path::new("src/lib.rs")));
        assert!(!all.is_empty());
        assert!(all.intersects(&scope(&["crates/foo"])));
        assert!(scope(&["crates/foo"]).intersects(&all));
    }

    #[test]
    fn task_workspace_dir_matches_only_existing_top_level_dirs() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir_all(directory.path().join("crates")).unwrap();
        fs::create_dir_all(directory.path().join("src")).unwrap();
        assert_eq!(
            task_workspace_dir(directory.path(), "fix crates/foo/bar.rs"),
            Some(PathBuf::from("crates"))
        );
        assert_eq!(
            task_workspace_dir(directory.path(), "refactor the src module"),
            Some(PathBuf::from("src"))
        );
        assert_eq!(
            task_workspace_dir(directory.path(), "build everything"),
            None
        );
    }

    #[test]
    fn assign_worker_scope_defaults_to_workspace_and_rejects_overlap() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir_all(directory.path().join("crates")).unwrap();
        fs::create_dir_all(directory.path().join("src")).unwrap();

        let idle = assign_worker_scope(directory.path(), "build everything", &[]).unwrap();
        assert!(idle.is_all());

        let scoped = assign_worker_scope(
            directory.path(),
            "fix crates/foo",
            &[WorkerScope::new(vec![PathBuf::from("src")]).unwrap()],
        )
        .unwrap();
        assert_eq!(scoped.entries(), &[PathBuf::from("crates")]);

        assert_eq!(
            assign_worker_scope(
                directory.path(),
                "fix crates/foo",
                &[WorkerScope::new(vec![PathBuf::from("crates")]).unwrap()],
            ),
            Err(ScopeAssignmentError::OverlapsActiveWorker)
        );

        assert_eq!(
            assign_worker_scope(
                directory.path(),
                "build everything",
                &[WorkerScope::new(vec![PathBuf::from("src")]).unwrap()],
            ),
            Err(ScopeAssignmentError::WorkspaceAlreadyActive)
        );
    }

    #[test]
    fn active_scopes_assigns_atomically_and_lease_releases_on_drop() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir_all(directory.path().join("crates")).unwrap();
        let registry = ActiveScopes::default();

        let (first, first_lease) = registry
            .assign_for(directory.path(), "fix crates/foo", "worker-1")
            .unwrap();
        assert_eq!(first.entries(), &[PathBuf::from("crates")]);
        assert_eq!(registry.len(), 1);

        // A second worker that would overlap the first fails closed.
        assert!(matches!(
            registry.assign_for(directory.path(), "fix crates/bar", "worker-2"),
            Err(ScopeAssignmentError::OverlapsActiveWorker)
        ));

        // Dropping the lease releases the reservation.
        drop(first_lease);
        assert!(registry.is_empty());
        let (second, _second_lease) = registry
            .assign_for(directory.path(), "build everything", "worker-2")
            .unwrap();
        assert!(second.is_all());
        assert!(registry.active().unwrap()[0].is_all());
    }
}
