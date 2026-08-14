//! The four worker tools, each enforcing the ownership scope and permission
//! guard before doing anything (§10.4.3). Fail-closed: a path that escapes the
//! scope, the workspace boundary, or the deny-list never reaches the file or
//! process layer.

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
fn resolve_path(
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
        None => guard.workspace_root().to_path_buf(),
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
