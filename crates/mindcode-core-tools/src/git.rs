use crate::process::{process_run, ProcessRunRequest};
use crate::{CoreToolError, CoreToolErrorCode, CoreToolResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use tokio_util::sync::CancellationToken;

const GIT_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const MAX_PATHS: usize = 128;
const MAX_CONTEXT_LINES: u32 = 100_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GitRootRequest {
    pub cwd: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GitRootResult {
    pub root: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GitStatusRequest {
    pub cwd: PathBuf,
    #[serde(default = "default_include_untracked")]
    pub include_untracked: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GitStatusResult {
    pub root: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub staged: Vec<String>,
    pub unstaged: Vec<String>,
    pub untracked: Vec<String>,
    pub conflicts: Vec<String>,
    pub changes: Vec<GitStatusChange>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GitStatusChange {
    pub path: String,
    pub xy: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GitDiffRequest {
    pub cwd: PathBuf,
    #[serde(default)]
    pub staged: bool,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default = "default_context_lines")]
    pub context_lines: u32,
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GitDiffResult {
    pub root: PathBuf,
    pub patch: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GitRevParseRequest {
    pub cwd: PathBuf,
    #[serde(default)]
    pub revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GitRevParseResult {
    pub value: Option<String>,
}

fn default_include_untracked() -> bool {
    true
}

fn default_context_lines() -> u32 {
    3
}

fn default_max_output_bytes() -> usize {
    1024 * 1024
}

pub async fn git_root(
    request: GitRootRequest,
    cancellation: CancellationToken,
) -> CoreToolResult<GitRootResult> {
    validate_cwd(&request.cwd)?;
    match git_root_path(&request.cwd, cancellation).await {
        Ok(root) => Ok(GitRootResult { root: Some(root) }),
        Err(error) if error.code == CoreToolErrorCode::GitCommandFailed => {
            Ok(GitRootResult { root: None })
        }
        Err(error) => Err(error),
    }
}

pub async fn git_status(
    request: GitStatusRequest,
    cancellation: CancellationToken,
) -> CoreToolResult<GitStatusResult> {
    validate_cwd(&request.cwd)?;
    let token_for_root = cancellation.clone();
    let untracked = if request.include_untracked {
        "--untracked-files=all"
    } else {
        "--untracked-files=no"
    };
    let result = git_command(
        &request.cwd,
        vec![
            "--no-optional-locks".into(),
            "status".into(),
            "--porcelain=v2".into(),
            "--branch".into(),
            "-z".into(),
            untracked.into(),
        ],
        GIT_OUTPUT_LIMIT,
        cancellation,
    )
    .await?;
    if result.truncated {
        return Err(CoreToolError::new(
            CoreToolErrorCode::GitOutputTruncated,
            "git status output exceeded the bounded limit",
        ));
    }
    let root = git_root_path(&request.cwd, token_for_root).await?;
    let mut parsed = parse_status(&result.stdout)?;
    parsed.root = root;
    Ok(parsed)
}

pub async fn git_diff(
    request: GitDiffRequest,
    cancellation: CancellationToken,
) -> CoreToolResult<GitDiffResult> {
    validate_cwd(&request.cwd)?;
    if request.paths.len() > MAX_PATHS {
        return Err(CoreToolError::new(
            CoreToolErrorCode::InvalidGitPath,
            "paths must contain at most 128 items",
        ));
    }
    if request.context_lines > MAX_CONTEXT_LINES {
        return Err(CoreToolError::new(
            CoreToolErrorCode::InvalidInput,
            "context_lines must be at most 100000",
        ));
    }
    if !(1..=GIT_OUTPUT_LIMIT).contains(&request.max_output_bytes) {
        return Err(CoreToolError::new(
            CoreToolErrorCode::InvalidInput,
            "max_output_bytes must be between 1 and 8 MiB",
        ));
    }
    for path in &request.paths {
        validate_git_path(path)?;
    }
    let token_for_root = cancellation.clone();
    let mut argv = vec![
        "--no-optional-locks".into(),
        "diff".into(),
        "--no-ext-diff".into(),
        "--no-color".into(),
        format!("--unified={}", request.context_lines),
    ];
    if request.staged {
        argv.push("--cached".into());
    }
    argv.push("--".into());
    argv.extend(request.paths);
    let result = git_command(&request.cwd, argv, request.max_output_bytes, cancellation).await?;
    Ok(GitDiffResult {
        root: git_root_path(&request.cwd, token_for_root).await?,
        patch: String::from_utf8_lossy(&result.stdout).into_owned(),
        truncated: result.truncated,
    })
}

pub async fn git_rev_parse(
    request: GitRevParseRequest,
    cancellation: CancellationToken,
) -> CoreToolResult<GitRevParseResult> {
    validate_cwd(&request.cwd)?;
    let revision = request.revision.unwrap_or_else(|| "HEAD".to_owned());
    validate_revision(&revision)?;
    let result = git_command(
        &request.cwd,
        vec![
            "--no-optional-locks".into(),
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            "--end-of-options".into(),
            revision,
        ],
        4096,
        cancellation,
    )
    .await;
    match result {
        Ok(output) => Ok(GitRevParseResult {
            value: Some(String::from_utf8_lossy(&output.stdout).trim().to_owned()),
        }),
        Err(error) if error.code == CoreToolErrorCode::GitCommandFailed => {
            Ok(GitRevParseResult { value: None })
        }
        Err(error) => Err(error),
    }
}

struct GitCommandOutput {
    stdout: Vec<u8>,
    truncated: bool,
}

/// Full argv for a git tool invocation.  Hardening (§10.4.8.2): every git
/// tool invocation disables repository hooks and fsmonitor before the
/// subcommand, so a hostile `.git/hooks` or fsmonitor hook can never run from
/// a read-only query.  `env` is additionally cleared to the safe allowlist by
/// `process_run`.
fn git_argv(args: &[String]) -> Vec<String> {
    let mut argv = Vec::with_capacity(args.len() + 5);
    argv.push("git".to_owned());
    argv.push("-c".to_owned());
    argv.push("core.hooksPath=/dev/null".to_owned());
    argv.push("-c".to_owned());
    argv.push("core.fsmonitor=false".to_owned());
    argv.extend(args.iter().cloned());
    argv
}

async fn git_command(
    cwd: &Path,
    args: Vec<String>,
    max_output_bytes: usize,
    cancellation: CancellationToken,
) -> CoreToolResult<GitCommandOutput> {
    let argv = git_argv(&args);
    let result = process_run(
        ProcessRunRequest {
            argv,
            cwd: cwd.to_owned(),
            env: BTreeMap::new(),
            stdin: None,
            timeout_ms: 30_000,
            max_output_bytes,
            rlimits: None,
            seccomp_fd: None,
        },
        cancellation,
    )
    .await?;
    if result.timed_out || result.exit_code != Some(0) {
        return Err(CoreToolError::new(
            CoreToolErrorCode::GitCommandFailed,
            "local git command failed",
        ));
    }
    Ok(GitCommandOutput {
        stdout: result.stdout.into_bytes(),
        truncated: result.truncated,
    })
}

async fn git_root_path(cwd: &Path, cancellation: CancellationToken) -> CoreToolResult<PathBuf> {
    let result = git_command(
        cwd,
        vec![
            "--no-optional-locks".into(),
            "rev-parse".into(),
            "--show-toplevel".into(),
        ],
        16 * 1024,
        cancellation,
    )
    .await?;
    Ok(PathBuf::from(
        String::from_utf8_lossy(&result.stdout).trim(),
    ))
}

fn parse_status(bytes: &[u8]) -> CoreToolResult<GitStatusResult> {
    let mut status = GitStatusResult {
        root: PathBuf::new(),
        branch: None,
        head: None,
        detached: false,
        staged: Vec::new(),
        unstaged: Vec::new(),
        untracked: Vec::new(),
        conflicts: Vec::new(),
        changes: Vec::new(),
    };
    let mut records = bytes.split(|byte| *byte == 0).peekable();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if record.starts_with(b"# ") {
            parse_header(record, &mut status)?;
            continue;
        }
        match record[0] {
            b'?' => status.untracked.push(path_string(&record[2..])),
            b'!' => {}
            b'1' => {
                let fields = split_fields(record, 9)?;
                add_change(&mut status, fields[1], path_string(fields[8]))?;
            }
            b'2' => {
                let fields = split_fields(record, 10)?;
                records.next().ok_or_else(|| {
                    CoreToolError::new(
                        CoreToolErrorCode::GitStatusParse,
                        "missing rename source path",
                    )
                })?;
                add_change(&mut status, fields[1], path_string(fields[9]))?;
            }
            b'u' => {
                let fields = split_fields(record, 11)?;
                let path = path_string(fields[10]);
                let xy = status_code(fields[1])?;
                status.changes.push(GitStatusChange {
                    path: path.clone(),
                    xy,
                });
                status.conflicts.push(path);
            }
            _ => {
                return Err(CoreToolError::new(
                    CoreToolErrorCode::GitStatusParse,
                    "unrecognized porcelain-v2 status record",
                ))
            }
        }
    }
    Ok(status)
}

fn parse_header(record: &[u8], status: &mut GitStatusResult) -> CoreToolResult<()> {
    let text = String::from_utf8_lossy(record);
    let mut fields = text.splitn(3, ' ');
    if fields.next() != Some("#") {
        return Err(CoreToolError::new(
            CoreToolErrorCode::GitStatusParse,
            "malformed git status header",
        ));
    }
    let key = fields.next().ok_or_else(|| {
        CoreToolError::new(
            CoreToolErrorCode::GitStatusParse,
            "malformed git status header",
        )
    })?;
    let value = fields.next().ok_or_else(|| {
        CoreToolError::new(
            CoreToolErrorCode::GitStatusParse,
            "malformed git status header",
        )
    })?;
    match key {
        "branch.oid" if value != "(initial)" && value != "(unknown)" => {
            status.head = Some(value.to_owned())
        }
        "branch.head" if value == "(detached)" => status.detached = true,
        "branch.head" if value != "(unknown)" => status.branch = Some(value.to_owned()),
        _ => {}
    }
    Ok(())
}

fn split_fields(record: &[u8], expected: usize) -> CoreToolResult<Vec<&[u8]>> {
    let fields: Vec<&[u8]> = record.splitn(expected, |byte| *byte == b' ').collect();
    if fields.len() != expected {
        return Err(CoreToolError::new(
            CoreToolErrorCode::GitStatusParse,
            "malformed porcelain-v2 status record",
        ));
    }
    Ok(fields)
}

fn add_change(status: &mut GitStatusResult, xy: &[u8], path: String) -> CoreToolResult<()> {
    let xy = status_code(xy)?;
    status.changes.push(GitStatusChange {
        path: path.clone(),
        xy,
    });
    let xy = status
        .changes
        .last()
        .expect("change was just pushed")
        .xy
        .as_bytes();
    if xy[0] != b'.' {
        status.staged.push(path.clone());
    }
    if xy[1] != b'.' {
        status.unstaged.push(path);
    }
    Ok(())
}

fn status_code(xy: &[u8]) -> CoreToolResult<String> {
    if xy.len() != 2 || xy.contains(&b' ') {
        return Err(CoreToolError::new(
            CoreToolErrorCode::GitStatusParse,
            "malformed status code",
        ));
    }
    Ok(String::from_utf8_lossy(xy).into_owned())
}

fn validate_cwd(cwd: &Path) -> CoreToolResult<()> {
    if path_bytes_len(cwd) > 16 * 1024 {
        return Err(CoreToolError::new(
            CoreToolErrorCode::InvalidCwd,
            "cwd exceeds its byte bound",
        ));
    }
    if !cwd.is_absolute() {
        return Err(CoreToolError::new(
            CoreToolErrorCode::InvalidCwd,
            "cwd must be an absolute path",
        ));
    }
    match std::fs::metadata(cwd) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        _ => Err(CoreToolError::new(
            CoreToolErrorCode::InvalidCwd,
            "cwd must be an existing directory",
        )),
    }
}

fn validate_git_path(path: &str) -> CoreToolResult<()> {
    if path.is_empty()
        || path.len() > 16 * 1024
        || path.contains('\0')
        || path.chars().any(char::is_control)
        || Path::new(path).is_absolute()
        || Path::new(path).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(CoreToolError::new(
            CoreToolErrorCode::InvalidGitPath,
            "git path is invalid",
        ));
    }
    Ok(())
}

fn validate_revision(revision: &str) -> CoreToolResult<()> {
    if revision.is_empty()
        || revision.starts_with('-')
        || revision.contains('\0')
        || revision.chars().any(char::is_control)
    {
        return Err(CoreToolError::new(
            CoreToolErrorCode::InvalidInput,
            "revision is invalid",
        ));
    }
    Ok(())
}

fn path_string(path: &[u8]) -> String {
    String::from_utf8_lossy(path).into_owned()
}

fn path_bytes_len(path: &Path) -> usize {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().len()
    }
    #[cfg(not(unix))]
    {
        path.to_string_lossy().len()
    }
}

#[cfg(test)]
mod tests {
    use super::{git_argv, parse_status};

    #[test]
    fn git_argv_disables_hooks_and_fsmonitor_before_the_subcommand() {
        let argv = git_argv(&[
            "--no-optional-locks".to_owned(),
            "status".to_owned(),
            "--porcelain=v2".to_owned(),
        ]);
        assert_eq!(argv[0], "git");
        assert_eq!(
            &argv[1..5],
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false"
            ]
        );
        // The hardening flags precede the subcommand, as git requires.
        assert_eq!(argv[5], "--no-optional-locks");
        assert_eq!(argv[6], "status");
    }

    #[test]
    fn preserves_exact_xy_codes_for_all_tracked_change_kinds() {
        let status = parse_status(
            b"1 A. N... 100644 100644 100644 0000000 0000000 added\0\
              1 .D N... 100644 100644 100644 0000000 0000000 deleted\0\
              2 R. N... 100644 100644 100644 0000000 0000000 R100 renamed\0old\0\
              2 .C N... 100644 100644 100644 0000000 0000000 C100 copied\0source\0\
              u UU N... 100644 100644 100644 100644 0000000 0000000 0000000 conflict\0",
        )
        .unwrap();

        assert_eq!(
            status
                .changes
                .iter()
                .map(|change| (change.path.as_str(), change.xy.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("added", "A."),
                ("deleted", ".D"),
                ("renamed", "R."),
                ("copied", ".C"),
                ("conflict", "UU"),
            ]
        );
        assert_eq!(status.staged, vec!["added", "renamed"]);
        assert_eq!(status.unstaged, vec!["deleted", "copied"]);
        assert_eq!(status.conflicts, vec!["conflict"]);
    }
}
