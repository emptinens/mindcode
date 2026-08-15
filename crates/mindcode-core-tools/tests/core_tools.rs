use mindcode_core_tools::{
    git_diff, git_rev_parse, git_root, git_status, process_run, GitDiffRequest, GitRevParseRequest,
    GitRootRequest, GitStatusRequest, ProcessRunRequest,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

fn request(argv: Vec<String>, cwd: &Path) -> ProcessRunRequest {
    ProcessRunRequest {
        argv,
        cwd: cwd.to_owned(),
        env: BTreeMap::new(),
        stdin: None,
        timeout_ms: 2_000,
        max_output_bytes: 64 * 1024,
        rlimits: None,
        seccomp_fd: None,
    }
}

#[cfg(unix)]
fn emit_argv() -> Vec<String> {
    vec![
        "sh".into(),
        "-c".into(),
        "printf out; printf err >&2".into(),
    ]
}

#[cfg(windows)]
fn emit_argv() -> Vec<String> {
    vec![
        "cmd".into(),
        "/C".into(),
        "<nul set /p=out && <nul set /p=err 1>&2".into(),
    ]
}

#[tokio::test]
async fn reads_stdout_and_stderr_concurrently() {
    let dir = TempDir::new().unwrap();
    let result = process_run(request(emit_argv(), dir.path()), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.stdout, "out");
    assert_eq!(result.stderr, "err");
    assert_eq!(result.exit_code, Some(0));
    assert!(!result.truncated);
}

#[cfg(unix)]
#[tokio::test]
async fn stdin_is_string_and_common_output_budget_is_bounded() {
    let dir = TempDir::new().unwrap();
    let mut req = request(vec!["cat".into()], dir.path());
    req.stdin = Some("1234567890".into());
    req.max_output_bytes = 5;
    let result = process_run(req, CancellationToken::new()).await.unwrap();
    assert_eq!(result.stdout, "12345");
    assert!(result.truncated);
}

#[cfg(unix)]
#[tokio::test]
async fn timeout_terminates_process_group() {
    let dir = TempDir::new().unwrap();
    let mut req = request(
        vec!["sh".into(), "-c".into(), "sleep 30".into()],
        dir.path(),
    );
    req.timeout_ms = 50;
    let result = process_run(req, CancellationToken::new()).await.unwrap();
    assert!(result.timed_out);
    assert!(result.duration_ms < 2_000);
}

#[cfg(unix)]
#[tokio::test]
async fn timeout_does_not_wait_for_setsid_descendant_holding_pipes() {
    let dir = TempDir::new().unwrap();
    let pid_file = dir.path().join("descendant.pid");
    let command = format!(
        r#"set -m; sleep 30 & echo $! > '{}'; sleep 30"#,
        pid_file.display()
    );
    let mut req = request(vec!["sh".into(), "-c".into(), command], dir.path());
    req.timeout_ms = 50;

    let started = std::time::Instant::now();
    let result = process_run(req, CancellationToken::new()).await.unwrap();
    assert!(result.timed_out);
    assert!(started.elapsed() < std::time::Duration::from_secs(2));

    if let Ok(pid) = fs::read_to_string(pid_file) {
        let _ = Command::new("kill").args(["-KILL", pid.trim()]).status();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn successful_parent_does_not_wait_for_setsid_descendant_holding_pipes() {
    let dir = TempDir::new().unwrap();
    let pid_file = dir.path().join("successful-descendant.pid");
    let command = format!(
        r#"set -m; sleep 30 & echo $! > '{}'; exit 0"#,
        pid_file.display()
    );
    let req = request(vec!["sh".into(), "-c".into(), command], dir.path());

    let started = std::time::Instant::now();
    let result = process_run(req, CancellationToken::new()).await.unwrap();
    assert_eq!(result.exit_code, Some(0));
    assert!(!result.timed_out);
    assert!(result.truncated);
    assert!(started.elapsed() < std::time::Duration::from_secs(2));

    if let Ok(pid) = fs::read_to_string(pid_file) {
        let _ = Command::new("kill").args(["-KILL", pid.trim()]).status();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_terminates_process_group() {
    let dir = TempDir::new().unwrap();
    let token = CancellationToken::new();
    let child_token = token.clone();
    let task = tokio::spawn(async move {
        process_run(
            request(
                vec!["sh".into(), "-c".into(), "sleep 30".into()],
                dir.path(),
            ),
            child_token,
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    token.cancel();
    let error = task.await.unwrap().unwrap_err();
    assert_eq!(error.code.to_string(), "CANCELLED");
}

#[tokio::test]
async fn validates_wire_contract_and_byte_bounds() {
    let dir = TempDir::new().unwrap();
    let unknown = serde_json::from_value::<ProcessRunRequest>(json!({
        "argv": ["true"], "cwd": dir.path(), "unknown": true
    }));
    assert!(unknown.is_err());
    let mut req = request(vec!["true".into()], dir.path());
    req.env.insert("Authorization".into(), "x".into());
    assert_eq!(
        req.validate().unwrap_err().code.to_string(),
        "INVALID_ENVIRONMENT"
    );
    req.env.clear();
    req.env.insert("SSH_KEY".into(), "x".into());
    assert_eq!(
        req.validate().unwrap_err().code.to_string(),
        "INVALID_ENVIRONMENT"
    );
    req.env.clear();
    req.argv[0] = "bad\ncommand".into();
    assert_eq!(req.validate().unwrap_err().code.to_string(), "INVALID_ARGV");
    req.argv[0] = "true".into();
    req.stdin = Some("bad\u{1}input".into());
    assert_eq!(
        req.validate().unwrap_err().code.to_string(),
        "INVALID_INPUT"
    );
    req.stdin = None;
    req.argv[0] = "x".repeat(16 * 1024 + 1);
    assert_eq!(req.validate().unwrap_err().code.to_string(), "INVALID_ARGV");

    let minimal_diff = serde_json::from_value::<GitDiffRequest>(json!({
        "cwd": dir.path()
    }))
    .unwrap();
    assert!(!minimal_diff.staged);
    assert!(minimal_diff.paths.is_empty());
    assert_eq!(minimal_diff.context_lines, 3);
    assert_eq!(minimal_diff.max_output_bytes, 1024 * 1024);
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(status.success());
}

#[tokio::test]
async fn exact_git_contracts_parse_local_repository() {
    let dir = TempDir::new().unwrap();
    git(dir.path(), &["init", "-q"]);
    git(
        dir.path(),
        &["config", "user.email", "test@example.invalid"],
    );
    git(dir.path(), &["config", "user.name", "Test"]);
    fs::write(dir.path().join("tracked.txt"), "one\n").unwrap();
    git(dir.path(), &["add", "tracked.txt"]);
    git(dir.path(), &["commit", "-qm", "initial"]);
    fs::write(dir.path().join("tracked.txt"), "two\n").unwrap();
    fs::write(dir.path().join("new.txt"), "new\n").unwrap();

    let token = CancellationToken::new();
    let root = git_root(
        GitRootRequest {
            cwd: dir.path().to_owned(),
        },
        token.clone(),
    )
    .await
    .unwrap();
    assert_eq!(root.root, Some(fs::canonicalize(dir.path()).unwrap()));

    let status = git_status(
        GitStatusRequest {
            cwd: dir.path().to_owned(),
            include_untracked: true,
        },
        token.clone(),
    )
    .await
    .unwrap();
    assert_eq!(status.untracked, vec!["new.txt"]);
    assert_eq!(status.unstaged, vec!["tracked.txt"]);
    assert!(status.staged.is_empty());
    assert_eq!(status.changes.len(), 1);
    assert_eq!(status.changes[0].path, "tracked.txt");
    assert_eq!(status.changes[0].xy, ".M");

    let diff = git_diff(
        GitDiffRequest {
            cwd: dir.path().to_owned(),
            staged: false,
            paths: Vec::new(),
            context_lines: 3,
            max_output_bytes: 4096,
        },
        token.clone(),
    )
    .await
    .unwrap();
    assert!(diff.patch.contains("-one"));
    assert_eq!(diff.root, fs::canonicalize(dir.path()).unwrap());

    let revision = git_rev_parse(
        GitRevParseRequest {
            cwd: dir.path().to_owned(),
            revision: None,
        },
        token,
    )
    .await
    .unwrap();
    assert_eq!(revision.value.unwrap().len(), 40);
}

#[tokio::test]
async fn git_revision_rejects_option_injection() {
    let dir = TempDir::new().unwrap();
    let error = git_rev_parse(
        GitRevParseRequest {
            cwd: dir.path().to_owned(),
            revision: Some("--upload-pack=x".into()),
        },
        CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code.to_string(), "INVALID_INPUT");
}

#[tokio::test]
async fn concurrent_runs_are_isolated() {
    let dir = TempDir::new().unwrap();
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let cwd = dir.path().to_owned();
        tasks.push(tokio::spawn(async move {
            process_run(request(emit_argv(), &cwd), CancellationToken::new()).await
        }));
    }
    for task in tasks {
        assert!(task.await.unwrap().is_ok());
    }
}
