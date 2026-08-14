//! The worker tools, each enforcing the ownership scope and permission guard
//! before doing anything (§10.4.3, §11.10). Fail-closed: a path that escapes
//! the scope, the workspace boundary, or the deny-list never reaches the file
//! or process layer.

use crate::error::{WorkerError, WorkerResult};
use crate::guard::{OwnershipGuard, ToolAccess};
use crate::scope::WorkerScope;
use mindcode_core_tools::{process_run, ProcessRunRequest, ProcessRunResult};
use std::path::{Component, Path, PathBuf};
use tokio_util::sync::CancellationToken;

const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_PROCESS_OUTPUT: usize = 1024 * 1024;
const SHELL_TIMEOUT_MS: u64 = 60_000;
const GIT_TIMEOUT_MS: u64 = 30_000;
const RG_TIMEOUT_MS: u64 = 30_000;
/// Result budget for `agentgrep` (§11.10): matches are trimmed to this many
/// bytes at a line boundary, not simply cut mid-line.
const MAX_AGENTGREP_OUTPUT: usize = 64 * 1024;
/// Context lines around each `agentgrep` match.
const AGENTGREP_CONTEXT_LINES: usize = 2;
/// Maximum top-level entries in the `agentgrep` directory outline.
const AGENTGREP_OUTLINE_ENTRIES: usize = 24;
const GIT_READ_ONLY: &[&str] = &[
    "status",
    "diff",
    "log",
    "show",
    "blame",
    "rev-parse",
    "ls-files",
];
const GIT_DISABLED_HOOKS: &str = "/nonexistent/mindcode-hooks";

/// A bounded file read: content plus whether the size cap truncated it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileReadResult {
    pub content: String,
    pub truncated: bool,
}

/// A worker-local task list (the `todo` tool, §11.10).  Independent of the
/// system task graph; it exists so a worker can keep a plan across iterations.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TodoList {
    pub items: Vec<TodoItem>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TodoItem {
    pub text: String,
    pub done: bool,
}

impl TodoList {
    /// Apply a `todo` tool action and return a human-readable rendering of the
    /// resulting list.  `list` never mutates, `clear` empties the list, `add`
    /// appends an open item, `check`/`uncheck` toggle the 1-based index.
    pub fn apply(&mut self, action: &str, item: Option<&str>) -> WorkerResult<String> {
        match action {
            "list" => {}
            "clear" => self.items.clear(),
            "add" => {
                let text = item
                    .filter(|text| !text.trim().is_empty())
                    .ok_or_else(|| {
                        WorkerError::InvalidRequest("todo add requires a non-empty item".to_owned())
                    })?;
                self.items.push(TodoItem {
                    text: text.trim().to_owned(),
                    done: false,
                });
            }
            "check" | "uncheck" => {
                let index = item
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .filter(|index| *index > 0)
                    .ok_or_else(|| {
                        WorkerError::InvalidRequest(
                            "todo check/uncheck requires a 1-based item index".to_owned(),
                        )
                    })?;
                let Some(entry) = self.items.get_mut(index - 1) else {
                    return Err(WorkerError::InvalidRequest(format!(
                        "todo item {index} does not exist"
                    )));
                };
                entry.done = action == "check";
            }
            other => {
                return Err(WorkerError::InvalidRequest(format!(
                    "unknown todo action '{other}' (list|add|check|uncheck|clear)"
                )));
            }
        }
        Ok(self.render())
    }

    /// Render the list as `1. [ ] item` / `1. [x] item`, or an empty note.
    pub fn render(&self) -> String {
        if self.items.is_empty() {
            return "todo list is empty".to_owned();
        }
        self.items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let mark = if item.done { "x" } else { " " };
                format!("{}. [{}] {}", index + 1, mark, item.text)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn check_cancelled(cancel: &CancellationToken) -> WorkerResult<()> {
    if cancel.is_cancelled() {
        Err(WorkerError::Cancelled)
    } else {
        Ok(())
    }
}

/// Resolve a worker-supplied (relative) path against the workspace, verify it
/// is inside the ownership scope, and return the canonical target after the
/// permission guard approves it.
pub fn resolve_path(
    scope: &WorkerScope,
    guard: &OwnershipGuard,
    path: &Path,
    write: bool,
) -> WorkerResult<PathBuf> {
    if path.is_absolute() {
        return Err(WorkerError::InvalidRequest(
            "worker paths must be workspace-relative".to_owned(),
        ));
    }
    let absolute = guard.workspace_root().join(path);
    let canonical = guard
        .canonicalize(&absolute)
        .ok_or_else(|| WorkerError::Io(format!("path is not resolvable: {}", path.display())))?;
    // The ownership scope bounds in-workspace files on every tier.
    if let Ok(rel) = canonical.strip_prefix(guard.workspace_root()) {
        if !scope.contains(rel) {
            return Err(WorkerError::OutOfScope { path: canonical });
        }
    }
    match guard.check_canonical(&canonical, write) {
        ToolAccess::Allowed => Ok(canonical),
        ToolAccess::NeedsApproval => Err(WorkerError::NeedsApproval { path: canonical }),
        ToolAccess::Denied => Err(WorkerError::Denied { path: canonical }),
    }
}

/// Read a file fully (up to the size cap) from inside the worker scope.
pub async fn read_file(
    scope: &WorkerScope,
    guard: &OwnershipGuard,
    path: &Path,
    cancel: &CancellationToken,
) -> WorkerResult<FileReadResult> {
    check_cancelled(cancel)?;
    let target = resolve_path(scope, guard, path, false)?;
    let metadata = tokio::fs::metadata(&target)
        .await
        .map_err(|_| WorkerError::Io(format!("cannot stat: {}", target.display())))?;
    if !metadata.is_file() {
        return Err(WorkerError::InvalidRequest(format!(
            "not a file: {}",
            target.display()
        )));
    }
    let bytes = tokio::fs::read(&target)
        .await
        .map_err(|_| WorkerError::Io(format!("cannot read: {}", target.display())))?;
    let truncated = bytes.len() > MAX_FILE_BYTES;
    let kept = &bytes[..bytes.len().min(MAX_FILE_BYTES)];
    Ok(FileReadResult {
        content: String::from_utf8_lossy(kept).into_owned(),
        truncated,
    })
}

/// Write a file (replacing its contents) inside the worker scope.
pub async fn write_file(
    scope: &WorkerScope,
    guard: &OwnershipGuard,
    path: &Path,
    content: &str,
    cancel: &CancellationToken,
) -> WorkerResult<u64> {
    check_cancelled(cancel)?;
    let target = resolve_path(scope, guard, path, true)?;
    ensure_parent_exists(&target).await?;
    tokio::fs::write(&target, content)
        .await
        .map_err(|_| WorkerError::Io(format!("cannot write: {}", target.display())))?;
    Ok(content.len() as u64)
}

/// Append to a file (creating it if needed) inside the worker scope.
pub async fn append_file(
    scope: &WorkerScope,
    guard: &OwnershipGuard,
    path: &Path,
    content: &str,
    cancel: &CancellationToken,
) -> WorkerResult<u64> {
    check_cancelled(cancel)?;
    let target = resolve_path(scope, guard, path, true)?;
    ensure_parent_exists(&target).await?;
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .await
        .map_err(|_| WorkerError::Io(format!("cannot open: {}", target.display())))?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|_| WorkerError::Io(format!("cannot append: {}", target.display())))?;
    Ok(content.len() as u64)
}

async fn ensure_parent_exists(target: &Path) -> WorkerResult<()> {
    let Some(parent) = target.parent() else {
        return Err(WorkerError::Io("path has no parent directory".to_owned()));
    };
    match tokio::fs::metadata(parent).await {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        _ => Err(WorkerError::Io(format!(
            "parent directory does not exist: {}",
            parent.display()
        ))),
    }
}

/// Run a shell command with `cwd` set to the workspace root. The shell obeys
/// the scope contractually in v1 (§10.4.8); only the tier gates it here.
pub async fn run_shell(
    guard: &OwnershipGuard,
    argv: &[String],
    cancel: &CancellationToken,
) -> WorkerResult<ProcessRunResult> {
    check_cancelled(cancel)?;
    match guard.check_command() {
        ToolAccess::Allowed => {}
        ToolAccess::NeedsApproval => {
            return Err(WorkerError::NeedsApproval {
                path: guard.workspace_root().to_path_buf(),
            });
        }
        ToolAccess::Denied => {
            return Err(WorkerError::Denied {
                path: guard.workspace_root().to_path_buf(),
            });
        }
    }
    let request = ProcessRunRequest {
        argv: argv.to_vec(),
        cwd: guard.workspace_root().to_path_buf(),
        env: Default::default(),
        stdin: None,
        timeout_ms: SHELL_TIMEOUT_MS,
        max_output_bytes: MAX_PROCESS_OUTPUT,
    };
    process_run(request, cancel.clone())
        .await
        .map_err(WorkerError::from)
}

/// Run a read-only git subcommand with `cwd` set to the workspace root. Only
/// the allowlist runs; mutating subcommands and option-injection arguments are
/// rejected fail-closed.
pub async fn run_git(
    guard: &OwnershipGuard,
    args: &[String],
    cancel: &CancellationToken,
) -> WorkerResult<String> {
    check_cancelled(cancel)?;
    let Some(subcommand) = args.first() else {
        return Err(WorkerError::InvalidRequest(
            "git requires a subcommand".to_owned(),
        ));
    };
    if !GIT_READ_ONLY.contains(&subcommand.as_str()) {
        return Err(WorkerError::InvalidRequest(format!(
            "git subcommand '{subcommand}' is not allowed (read-only only)"
        )));
    }
    for argument in &args[1..] {
        if argument.is_empty()
            || argument.starts_with('-')
            || argument.contains('\0')
            || argument.chars().any(char::is_control)
            || Path::new(argument).is_absolute()
            || Path::new(argument).components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(WorkerError::InvalidRequest(format!(
                "git argument is not allowed: {argument}"
            )));
        }
    }
    match guard.check_command() {
        ToolAccess::Allowed => {}
        ToolAccess::NeedsApproval => {
            return Err(WorkerError::NeedsApproval {
                path: guard.workspace_root().to_path_buf(),
            });
        }
        ToolAccess::Denied => {
            return Err(WorkerError::Denied {
                path: guard.workspace_root().to_path_buf(),
            });
        }
    }
    let mut argv = vec![
        "git".to_owned(),
        "-c".to_owned(),
        format!("core.hooksPath={GIT_DISABLED_HOOKS}"),
        "--no-optional-locks".to_owned(),
    ];
    argv.extend(args.iter().cloned());
    let request = ProcessRunRequest {
        argv,
        cwd: guard.workspace_root().to_path_buf(),
        env: Default::default(),
        stdin: None,
        timeout_ms: GIT_TIMEOUT_MS,
        max_output_bytes: MAX_PROCESS_OUTPUT,
    };
    let result = process_run(request, cancel.clone()).await?;
    Ok(result.stdout)
}

/// Run ripgrep over the workspace (or a scoped subpath) and return matches.
pub async fn run_rg(
    scope: &WorkerScope,
    guard: &OwnershipGuard,
    pattern: &str,
    path: Option<&Path>,
    cancel: &CancellationToken,
) -> WorkerResult<String> {
    check_cancelled(cancel)?;
    if pattern.is_empty()
        || pattern.len() > 16 * 1024
        || pattern.contains('\0')
        || pattern.chars().any(char::is_control)
    {
        return Err(WorkerError::InvalidRequest(
            "rg pattern is empty or invalid".to_owned(),
        ));
    }
    let search_root = match path {
        Some(path) => resolve_path(scope, guard, path, false)?,
        // A scopeless search is only safe when the worker owns the whole
        // workspace; otherwise it would leak matches from outside the disjoint
        // ownership scope (§10.4.3). Fail closed and require a path.
        None if scope.is_all() => guard.workspace_root().to_path_buf(),
        None => {
            return Err(WorkerError::InvalidRequest(
                "rg needs an explicit path inside your scope".to_owned(),
            ));
        }
    };
    match guard.check_command() {
        ToolAccess::Allowed => {}
        ToolAccess::NeedsApproval => {
            return Err(WorkerError::NeedsApproval { path: search_root });
        }
        ToolAccess::Denied => {
            return Err(WorkerError::Denied { path: search_root });
        }
    }
    let request = ProcessRunRequest {
        argv: vec![
            "rg".to_owned(),
            "--no-heading".to_owned(),
            "--color".to_owned(),
            "never".to_owned(),
            pattern.to_owned(),
            search_root.to_string_lossy().into_owned(),
        ],
        cwd: guard.workspace_root().to_path_buf(),
        env: Default::default(),
        stdin: None,
        timeout_ms: RG_TIMEOUT_MS,
        max_output_bytes: MAX_PROCESS_OUTPUT,
    };
    let result = process_run(request, cancel.clone()).await?;
    Ok(result.stdout)
}

/// Run a context-aware search (agentgrep, §11.10): a short directory outline
/// of the search root plus ripgrep matches with surrounding context, trimmed
/// to the result budget at a line boundary.
pub async fn run_agentgrep(
    scope: &WorkerScope,
    guard: &OwnershipGuard,
    query: &str,
    path: Option<&Path>,
    cancel: &CancellationToken,
) -> WorkerResult<String> {
    check_cancelled(cancel)?;
    if query.is_empty()
        || query.len() > 16 * 1024
        || query.contains('\0')
        || query.chars().any(char::is_control)
    {
        return Err(WorkerError::InvalidRequest(
            "agentgrep query is empty or invalid".to_owned(),
        ));
    }
    let search_root = match path {
        Some(path) => resolve_path(scope, guard, path, false)?,
        // A scopeless search is only safe when the worker owns the whole
        // workspace; otherwise it would leak match context from outside the
        // disjoint ownership scope (§10.4.3). Fail closed and require a path.
        None if scope.is_all() => guard.workspace_root().to_path_buf(),
        None => {
            return Err(WorkerError::InvalidRequest(
                "agentgrep needs an explicit path inside your scope".to_owned(),
            ));
        }
    };
    match guard.check_command() {
        ToolAccess::Allowed => {}
        ToolAccess::NeedsApproval => {
            return Err(WorkerError::NeedsApproval { path: search_root });
        }
        ToolAccess::Denied => {
            return Err(WorkerError::Denied { path: search_root });
        }
    }
    let outline = outline_directory(&search_root, AGENTGREP_OUTLINE_ENTRIES);
    let request = ProcessRunRequest {
        argv: vec![
            "rg".to_owned(),
            "--no-heading".to_owned(),
            "--color".to_owned(),
            "never".to_owned(),
            "-n".to_owned(),
            "-C".to_owned(),
            AGENTGREP_CONTEXT_LINES.to_string(),
            query.to_owned(),
            search_root.to_string_lossy().into_owned(),
        ],
        cwd: guard.workspace_root().to_path_buf(),
        env: Default::default(),
        stdin: None,
        timeout_ms: RG_TIMEOUT_MS,
        max_output_bytes: MAX_PROCESS_OUTPUT,
    };
    let result = process_run(request, cancel.clone()).await?;
    let matches = adaptive_trim(&result.stdout, MAX_AGENTGREP_OUTPUT);
    let mut rendered = format!("search: {query}\n");
    if !outline.is_empty() {
        rendered.push_str("outline:\n");
        rendered.push_str(&outline);
        rendered.push('\n');
    }
    rendered.push_str("matches:\n");
    rendered.push_str(&matches);
    Ok(rendered)
}

/// List top-level entries of a directory as a compact outline (directories
/// first, then files), capped to `limit` lines.  This is the "file/dir
/// structure" prefix of an agentgrep result.
fn outline_directory(root: &Path, limit: usize) -> String {
    let Ok(entries) = std::fs::read_dir(root) else {
        return String::new();
    };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => dirs.push(format!("  {name}/")),
            _ => files.push(format!("  {name}")),
        }
    }
    dirs.extend(files);
    dirs.truncate(limit);
    if dirs.len() == limit {
        dirs.push("  …".to_owned());
    }
    dirs.join("\n")
}

/// Trim a search result to a byte budget at a line boundary (adaptive trim):
/// drop whole trailing lines rather than cutting mid-line, and mark how many
/// bytes were dropped.
fn adaptive_trim(text: &str, budget: usize) -> String {
    if text.len() <= budget {
        return text.to_owned();
    }
    let mut end = budget.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let end = text[..end].rfind('\n').map(|index| index + 1).unwrap_or(end);
    let mut kept = text[..end].to_owned();
    kept.push_str(&format!("…\n[trimmed {} bytes]\n", text.len() - end));
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn todo_list_apply_round_trips() {
        let mut list = TodoList::default();
        assert_eq!(list.apply("list", None).unwrap(), "todo list is empty");
        assert_eq!(
            list.apply("add", Some("write tests")).unwrap(),
            "1. [ ] write tests"
        );
        assert_eq!(
            list.apply("add", Some("run build")).unwrap(),
            "1. [ ] write tests\n2. [ ] run build"
        );
        assert_eq!(
            list.apply("check", Some("1")).unwrap(),
            "1. [x] write tests\n2. [ ] run build"
        );
        assert_eq!(
            list.apply("uncheck", Some("1")).unwrap(),
            "1. [ ] write tests\n2. [ ] run build"
        );
        assert!(matches!(
            list.apply("check", Some("9")),
            Err(WorkerError::InvalidRequest(_))
        ));
        assert!(matches!(
            list.apply("nope", None),
            Err(WorkerError::InvalidRequest(_))
        ));
        assert_eq!(list.apply("clear", None).unwrap(), "todo list is empty");
    }

    #[test]
    fn adaptive_trim_truncates_at_a_line_boundary() {
        let text = "line one\nline two\nline three\n";
        let trimmed = adaptive_trim(text, 14);
        assert!(trimmed.starts_with("line one\n"));
        assert!(trimmed.contains("[trimmed "));
        assert!(!trimmed.contains("line three"));
    }
}
