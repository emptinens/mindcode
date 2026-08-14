//! A worker's disjoint file-ownership scope: a non-empty set of relative
//! paths under the workspace root. Two active workers must never overlap.

use std::path::{Component, Path, PathBuf};

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
}
