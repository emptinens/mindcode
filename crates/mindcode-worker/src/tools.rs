//! The worker tools, each enforcing the ownership scope and permission guard
//! before doing anything (§10.4.3, §11.10). Fail-closed: a path that escapes
//! the scope, the workspace boundary, or the deny-list never reaches the file
//! or process layer.

use crate::error::{WorkerError, WorkerResult};
use crate::guard::{OwnershipGuard, ToolAccess};
use crate::scope::WorkerScope;
use mindcode_core_tools::{
    process_run, redact_secrets, run_sandboxed, NetworkPolicy, ProcessRunRequest, ProcessRunResult,
    SandboxConfig,
};
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

/// A worker-local task list (the `todo` tool, §5.1.4). Independent of the
/// system task graph; it carries enough semantic evidence for the final
/// quality-gate to distinguish an unfinished item from an explained blocker.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TodoList {
    pub items: Vec<TodoItem>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TodoMaturity {
    #[default]
    Planned,
    InProgress,
    Done,
    Blocked,
}

impl TodoMaturity {
    fn parse(value: Option<&str>) -> WorkerResult<Self> {
        match value.unwrap_or("planned") {
            "planned" => Ok(Self::Planned),
            "in_progress" | "in-progress" => Ok(Self::InProgress),
            "done" => Ok(Self::Done),
            "blocked" => Ok(Self::Blocked),
            other => Err(WorkerError::InvalidRequest(format!(
                "unknown todo maturity '{other}' (planned|in_progress|done|blocked)"
            ))),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TodoItem {
    pub text: String,
    pub done: bool,
    pub assessment: Option<String>,
    pub maturity: TodoMaturity,
    pub requirement_ref: Option<String>,
}

impl TodoList {
    /// Backward-compatible shorthand for the basic todo API.
    pub fn apply(&mut self, action: &str, item: Option<&str>) -> WorkerResult<String> {
        self.apply_detailed(action, item, None, None, None)
    }

    /// Apply a todo action with semantic completion evidence. `assessment` is
    /// intentionally plain text (not a model-generated status trusted by the
    /// runtime); it only explains why an open item is blocked or deferred.
    pub fn apply_detailed(
        &mut self,
        action: &str,
        item: Option<&str>,
        assessment: Option<&str>,
        maturity: Option<&str>,
        requirement_ref: Option<&str>,
    ) -> WorkerResult<String> {
        match action {
            "list" => {}
            "clear" => self.items.clear(),
            "add" => {
                let text = item.filter(|text| !text.trim().is_empty()).ok_or_else(|| {
                    WorkerError::InvalidRequest("todo add requires a non-empty item".to_owned())
                })?;
                let maturity = TodoMaturity::parse(maturity)?;
                self.items.push(TodoItem {
                    text: text.trim().to_owned(),
                    done: maturity == TodoMaturity::Done,
                    assessment: clean_metadata(assessment),
                    maturity,
                    requirement_ref: clean_metadata(requirement_ref),
                });
            }
            "check" | "uncheck" | "update" => {
                let index = item
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .filter(|index| *index > 0)
                    .ok_or_else(|| {
                        WorkerError::InvalidRequest(
                            "todo check/uncheck/update requires a 1-based item index".to_owned(),
                        )
                    })?;
                let Some(entry) = self.items.get_mut(index - 1) else {
                    return Err(WorkerError::InvalidRequest(format!(
                        "todo item {index} does not exist"
                    )));
                };
                if action != "update" {
                    entry.done = action == "check";
                    entry.maturity = if entry.done {
                        TodoMaturity::Done
                    } else {
                        TodoMaturity::InProgress
                    };
                }
                if let Some(maturity) = maturity {
                    entry.maturity = TodoMaturity::parse(Some(maturity))?;
                    entry.done = entry.maturity == TodoMaturity::Done;
                }
                if assessment.is_some() {
                    entry.assessment = clean_metadata(assessment);
                }
                if requirement_ref.is_some() {
                    entry.requirement_ref = clean_metadata(requirement_ref);
                }
            }
            other => {
                return Err(WorkerError::InvalidRequest(format!(
                    "unknown todo action '{other}' (list|add|check|uncheck|update|clear)"
                )));
            }
        }
        Ok(self.render())
    }

    /// Return an explanation request when planned/in-progress items lack an
    /// assessment. Explained blockers are visible but do not deadlock the run.
    pub fn quality_gate_prompt(&self) -> Option<String> {
        let unresolved = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                matches!(
                    item.maturity,
                    TodoMaturity::Planned | TodoMaturity::InProgress
                ) && item.assessment.as_deref().is_none_or(str::is_empty)
            })
            .map(|(index, item)| format!("{}. {}", index + 1, item.text))
            .collect::<Vec<_>>();
        if unresolved.is_empty() {
            None
        } else {
            Some(format!(
                "todo quality check: explain or close these unfinished items before the final answer:\n{}\nUse todo update/check with an assessment for each item.",
                unresolved.join("\n")
            ))
        }
    }

    /// Render the list as `1. [ ] item` / `1. [x] item`, with optional semantic
    /// metadata on separate lines so the model can see its own evidence.
    pub fn render(&self) -> String {
        if self.items.is_empty() {
            return "todo list is empty".to_owned();
        }
        self.items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let mark = if item.done { "x" } else { " " };
                let mut line = format!("{}. [{}] {}", index + 1, mark, item.text);
                if let Some(assessment) = &item.assessment {
                    line.push_str(&format!("\n   assessment: {assessment}"));
                }
                if let Some(requirement_ref) = &item.requirement_ref {
                    line.push_str(&format!("\n   requirement: {requirement_ref}"));
                }
                line
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn clean_metadata(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn check_cancelled(cancel: &CancellationToken) -> WorkerResult<()> {
    if cancel.is_cancelled() {
        Err(WorkerError::Cancelled)
    } else {
        Ok(())
    }
}

/// Scrub credential-shaped values from process output before it reaches the
/// model transcript (§13.1 hardening). The sandbox hides the config home, but
/// a worker can still read an in-workspace `.env` and echo it back; this
/// filters that leak at the boundary.
fn redact_result(mut result: ProcessRunResult) -> ProcessRunResult {
    result.stdout = redact_secrets(&result.stdout);
    result.stderr = redact_secrets(&result.stderr);
    result
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

/// Structured result of the bounded test runner. The full output is kept only
/// long enough to provide the model a capped preview; the agent records the
/// typed counters in `WorkerReport::test_runs`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TestRunResult {
    pub command: String,
    pub exit_code: Option<i32>,
    pub passed: u64,
    pub failed: u64,
    pub skipped: u64,
    pub summary_lines: Vec<String>,
    pub output: String,
}

/// Determine the safest project-local default test command without executing
/// anything. Explicit argv overrides are still accepted by `run_tests`, but
/// all variants execute through the sandbox.
pub fn default_test_argv(workspace: &Path) -> WorkerResult<Vec<String>> {
    if workspace.join("Cargo.toml").is_file() {
        return Ok(vec!["cargo".to_owned(), "test".to_owned()]);
    }
    if workspace.join("pyproject.toml").is_file() || workspace.join("pytest.ini").is_file() {
        return Ok(vec!["pytest".to_owned()]);
    }
    if workspace.join("Makefile").is_file() {
        return Ok(vec!["make".to_owned(), "test".to_owned()]);
    }
    Err(WorkerError::InvalidRequest(
        "run_tests could not detect a test command; provide argv".to_owned(),
    ))
}

/// Run a detected or explicitly supplied test command in the bwrap sandbox.
/// Network access is always explicit and the output is capped/redacted at the
/// process boundary. The timeout is the sandbox's bounded 120-second limit.
pub async fn run_tests(
    guard: &OwnershipGuard,
    argv: &[String],
    allow_network: bool,
    cancel: &CancellationToken,
) -> WorkerResult<TestRunResult> {
    check_cancelled(cancel)?;
    if argv.is_empty() || argv[0].is_empty() {
        return Err(WorkerError::InvalidRequest(
            "run_tests argv must not be empty".to_owned(),
        ));
    }
    let network = if allow_network {
        NetworkPolicy::Allow
    } else {
        NetworkPolicy::Deny
    };
    let config = SandboxConfig::new(
        guard.workspace_root().to_path_buf(),
        guard.config_home().to_path_buf(),
    )
    .with_network(network);
    let config = match sanitized_toolchain_path(guard) {
        Some(path) => config.with_path(path),
        None => config,
    };
    let config = match sanitized_rustup_home(guard) {
        Some(path) => config.with_toolchain_home(path),
        None => config,
    };
    let result = run_sandboxed(&config, argv, cancel)
        .await
        .map_err(WorkerError::from)?;
    let result = redact_result(result);
    let output = process_output_text(&result);
    let (passed, failed, skipped) = parse_test_counts(&output, result.exit_code);
    let summary_lines = output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let summary_lines = summary_lines
        .into_iter()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Ok(TestRunResult {
        command: argv.join(" "),
        exit_code: result.exit_code,
        passed,
        failed,
        skipped,
        summary_lines,
        output,
    })
}

/// Preserve only absolute, existing PATH directories that are outside the
/// writable workspace and hidden config directory. This makes user-installed
/// tools such as Cargo available without allowing a workspace executable to
/// shadow them inside the sandbox.
fn sanitized_toolchain_path(guard: &OwnershipGuard) -> Option<String> {
    let workspace = guard.workspace_root();
    let config_home = guard.config_home();
    let paths = std::env::var_os("PATH")?
        .into_string()
        .ok()?
        .split(':')
        .map(PathBuf::from)
        .filter(|path| {
            path.is_absolute()
                && path.is_dir()
                && !path.starts_with(workspace)
                && !path.starts_with(config_home)
        })
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return None;
    }
    std::env::join_paths(paths)
        .ok()
        .and_then(|path| path.into_string().ok())
}

fn sanitized_rustup_home(guard: &OwnershipGuard) -> Option<PathBuf> {
    let candidate = std::env::var_os("RUSTUP_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".rustup")))?;
    if candidate.is_absolute()
        && candidate.is_dir()
        && !candidate.starts_with(guard.workspace_root())
        && !candidate.starts_with(guard.config_home())
    {
        Some(candidate)
    } else {
        None
    }
}

fn process_output_text(result: &ProcessRunResult) -> String {
    let mut output = result.stdout.clone();
    if !result.stderr.is_empty() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str("[stderr] ");
        output.push_str(&result.stderr);
    }
    if result.timed_out {
        output.push_str("\n[timed out]");
    }
    if result.truncated {
        output.push_str("\n[truncated]");
    }
    output
}

fn parse_test_counts(output: &str, exit_code: Option<i32>) -> (u64, u64, u64) {
    let passed = count_before_word(output, &["passed", "pass"]);
    let failed = count_before_word(output, &["failed", "fail", "failure"]);
    let skipped = count_before_word(output, &["skipped", "skip", "ignored"]);
    if passed.is_none() && failed.is_none() && skipped.is_none() {
        if exit_code == Some(0) {
            (1, 0, 0)
        } else {
            (0, 1, 0)
        }
    } else {
        (
            passed.unwrap_or(0),
            failed.unwrap_or(0),
            skipped.unwrap_or(0),
        )
    }
}

fn count_before_word(output: &str, words: &[&str]) -> Option<u64> {
    let tokens = output.split_whitespace().collect::<Vec<_>>();
    for window in tokens.windows(2) {
        let number = window[0].trim_matches(|character: char| !character.is_ascii_digit());
        let word = window[1]
            .trim_matches(|character: char| !character.is_ascii_alphabetic())
            .to_ascii_lowercase();
        if words.iter().any(|candidate| *candidate == word) {
            if let Ok(number) = number.parse::<u64>() {
                return Some(number);
            }
        }
    }
    None
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
        rlimits: None,
        seccomp_fd: None,
    };
    let result = process_run(request, cancel.clone())
        .await
        .map_err(WorkerError::from)?;
    Ok(redact_result(result))
}

/// Run a shell command under the bwrap sandbox (§13.1): the filesystem is
/// read-only, only the workspace is writable, and the config home — the
/// credential store — is hidden behind an empty tmpfs.  Fails closed when
/// bwrap is absent so the caller can apply its `--allow-unsafe-shell` policy.
pub async fn run_shell_sandboxed(
    guard: &OwnershipGuard,
    argv: &[String],
    network: NetworkPolicy,
    cancel: &CancellationToken,
) -> WorkerResult<ProcessRunResult> {
    check_cancelled(cancel)?;
    let config = SandboxConfig::new(
        guard.workspace_root().to_path_buf(),
        guard.config_home().to_path_buf(),
    )
    .with_network(network);
    let config = match sanitized_toolchain_path(guard) {
        Some(path) => config.with_path(path),
        None => config,
    };
    let config = match sanitized_rustup_home(guard) {
        Some(path) => config.with_toolchain_home(path),
        None => config,
    };
    let result = run_sandboxed(&config, argv, cancel)
        .await
        .map_err(WorkerError::from)?;
    Ok(redact_result(result))
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
        rlimits: None,
        seccomp_fd: None,
    };
    let result = process_run(request, cancel.clone()).await?;
    Ok(redact_secrets(&result.stdout))
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
        rlimits: None,
        seccomp_fd: None,
    };
    let result = process_run(request, cancel.clone()).await?;
    Ok(redact_secrets(&result.stdout))
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
        rlimits: None,
        seccomp_fd: None,
    };
    let result = process_run(request, cancel.clone()).await?;
    let matches = adaptive_trim(&redact_secrets(&result.stdout), MAX_AGENTGREP_OUTPUT);
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
    let end = text[..end]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(end);
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
    fn todo_quality_metadata_explains_or_closes_unfinished_items() {
        let mut list = TodoList::default();
        list.apply_detailed(
            "add",
            Some("verify the patch"),
            None,
            Some("in_progress"),
            Some("5.1.3"),
        )
        .unwrap();
        assert!(list.quality_gate_prompt().is_some());
        list.apply_detailed(
            "update",
            Some("1"),
            Some("blocked by unavailable fixture; reported to user"),
            None,
            None,
        )
        .unwrap();
        assert!(list.quality_gate_prompt().is_none());
        list.apply_detailed("check", Some("1"), None, None, None)
            .unwrap();
        assert_eq!(list.items[0].maturity, TodoMaturity::Done);
        assert!(list.items[0].done);
    }

    #[test]
    fn default_test_command_is_project_aware() {
        let temp = tempfile::tempdir().unwrap();
        assert!(matches!(
            default_test_argv(temp.path()),
            Err(WorkerError::InvalidRequest(_))
        ));
        std::fs::write(temp.path().join("Cargo.toml"), "[package]\nname='x'\n").unwrap();
        assert_eq!(default_test_argv(temp.path()).unwrap(), ["cargo", "test"]);
        std::fs::remove_file(temp.path().join("Cargo.toml")).unwrap();
        std::fs::write(temp.path().join("pyproject.toml"), "[tool.pytest]\n").unwrap();
        assert_eq!(default_test_argv(temp.path()).unwrap(), ["pytest"]);
        std::fs::remove_file(temp.path().join("pyproject.toml")).unwrap();
        std::fs::write(temp.path().join("Makefile"), "test:\n").unwrap();
        assert_eq!(default_test_argv(temp.path()).unwrap(), ["make", "test"]);
    }

    #[test]
    fn test_result_parser_handles_rust_and_pytest_formats() {
        assert_eq!(
            parse_test_counts("test result: ok. 7 passed; 0 failed; 2 ignored;", Some(0)),
            (7, 0, 2)
        );
        assert_eq!(
            parse_test_counts("2 passed, 1 failed, 3 skipped", Some(1)),
            (2, 1, 3)
        );
        assert_eq!(parse_test_counts("finished", Some(0)), (1, 0, 0));
        assert_eq!(parse_test_counts("finished", Some(1)), (0, 1, 0));
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
