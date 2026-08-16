//! Integration tests for the scoped tools against a real tempdir workspace.

use mindcode_worker::{
    append_file, read_file, run_agentgrep, run_git, run_rg, run_shell, write_file, OwnershipGuard,
    PermissionTier, WorkerError, WorkerScope,
};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

struct Fixture {
    _workspace: tempfile::TempDir,
    _config: tempfile::TempDir,
    guard: OwnershipGuard,
    scope: WorkerScope,
}

impl Fixture {
    fn new(tier: PermissionTier) -> Self {
        let workspace = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let guard = OwnershipGuard::new(
            workspace.path().to_path_buf(),
            config.path().to_path_buf(),
            tier,
        )
        .unwrap();
        let scope = WorkerScope::new(vec![PathBuf::from("src")]).unwrap();
        Self {
            _workspace: workspace,
            _config: config,
            guard,
            scope,
        }
    }

    fn root(&self) -> &Path {
        self.guard.workspace_root()
    }
}

fn cancel() -> CancellationToken {
    CancellationToken::new()
}

#[tokio::test]
async fn read_write_round_trips_inside_scope() {
    let fixture = Fixture::new(PermissionTier::Workspace);
    std::fs::create_dir(fixture.root().join("src")).unwrap();

    let written = write_file(
        &fixture.scope,
        &fixture.guard,
        Path::new("src/a.txt"),
        "hello",
        &cancel(),
    )
    .await
    .unwrap();
    assert_eq!(written, 5);

    let read = read_file(
        &fixture.scope,
        &fixture.guard,
        Path::new("src/a.txt"),
        &cancel(),
    )
    .await
    .unwrap();
    assert_eq!(read.content, "hello");
    assert!(!read.truncated);
}

#[tokio::test]
async fn write_outside_scope_is_rejected() {
    let fixture = Fixture::new(PermissionTier::Workspace);
    std::fs::create_dir_all(fixture.root().join("other")).unwrap();
    let error = write_file(
        &fixture.scope,
        &fixture.guard,
        Path::new("other/x.txt"),
        "x",
        &cancel(),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, WorkerError::OutOfScope { .. }));
}

#[tokio::test]
async fn writing_a_secret_shaped_file_is_denied() {
    let fixture = Fixture::new(PermissionTier::FullAccess);
    std::fs::create_dir(fixture.root().join("src")).unwrap();
    let error = write_file(
        &fixture.scope,
        &fixture.guard,
        Path::new("src/.env"),
        "KEY=1",
        &cancel(),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, WorkerError::Denied { .. }));
}

#[tokio::test]
async fn writing_into_git_is_denied_outside_full_access() {
    let fixture = Fixture::new(PermissionTier::Workspace);
    std::fs::create_dir_all(fixture.root().join("src/.git")).unwrap();
    let error = write_file(
        &fixture.scope,
        &fixture.guard,
        Path::new("src/.git/config"),
        "x",
        &cancel(),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, WorkerError::Denied { .. }));
}

#[tokio::test]
async fn ask_everything_prompts_for_even_in_scope_reads() {
    let fixture = Fixture::new(PermissionTier::AskEverything);
    std::fs::create_dir(fixture.root().join("src")).unwrap();
    std::fs::write(fixture.root().join("src/a.txt"), "x").unwrap();
    let error = read_file(
        &fixture.scope,
        &fixture.guard,
        Path::new("src/a.txt"),
        &cancel(),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, WorkerError::NeedsApproval { .. }));
}

#[tokio::test]
async fn shell_runs_in_workspace_tier() {
    let fixture = Fixture::new(PermissionTier::Workspace);
    let result = run_shell(&fixture.guard, &["echo".into(), "hi".into()], &cancel())
        .await
        .unwrap();
    assert_eq!(result.stdout.trim(), "hi");
    assert_eq!(result.exit_code, Some(0));
}

#[tokio::test]
async fn shell_prompts_in_ask_everything() {
    let fixture = Fixture::new(PermissionTier::AskEverything);
    let error = run_shell(&fixture.guard, &["echo".into(), "hi".into()], &cancel())
        .await
        .unwrap_err();
    assert!(matches!(error, WorkerError::NeedsApproval { .. }));
}

#[tokio::test]
async fn read_file_redacts_credentials_before_reaching_the_caller() {
    let fixture = Fixture::new(PermissionTier::Workspace);
    std::fs::create_dir(fixture.root().join("src")).unwrap();
    std::fs::write(
        fixture.root().join("src/notes.md"),
        "PROVIDER_API_KEY=forge-read-file-secret-12345\nplain text\n",
    )
    .unwrap();

    let result = read_file(
        &fixture.scope,
        &fixture.guard,
        Path::new("src/notes.md"),
        &cancel(),
    )
    .await
    .unwrap();
    assert!(result.content.contains("[redacted]"));
    assert!(!result.content.contains("forge-read-file-secret-12345"));
    assert!(result.content.contains("plain text"));
}

#[tokio::test]
async fn shell_output_is_redacted_before_reaching_the_caller() {
    // §13.1: a worker can echo an in-workspace secret back out; the output
    // boundary must scrub it before it reaches the model transcript.
    let fixture = Fixture::new(PermissionTier::Workspace);
    let result = run_shell(
        &fixture.guard,
        &[
            "sh".into(),
            "-c".into(),
            "echo 'api_key=forge-supersecret12345'".into(),
        ],
        &cancel(),
    )
    .await
    .unwrap();
    assert!(result.stdout.contains("[redacted]"));
    assert!(!result.stdout.contains("forge-supersecret12345"));
}

#[tokio::test]
async fn scopeless_rg_and_agentgrep_fail_closed_outside_all_scope() {
    // §10.4.3 / §11.10: a worker whose scope is a subset of the workspace must
    // not search the whole tree (which would leak match context). No explicit
    // path → error, before any process is spawned.
    let fixture = Fixture::new(PermissionTier::Workspace);
    let rg_error = run_rg(&fixture.scope, &fixture.guard, "needle", None, &cancel())
        .await
        .unwrap_err();
    assert!(matches!(rg_error, WorkerError::InvalidRequest(_)));
    let agentgrep_error = run_agentgrep(&fixture.scope, &fixture.guard, "needle", None, &cancel())
        .await
        .unwrap_err();
    assert!(matches!(agentgrep_error, WorkerError::InvalidRequest(_)));
}

#[tokio::test]
async fn scoped_rg_and_agentgrep_search_inside_the_scope() {
    if std::process::Command::new("rg")
        .arg("--version")
        .output()
        .is_err()
    {
        return; // rg unavailable in this environment
    }
    let fixture = Fixture::new(PermissionTier::Workspace);
    std::fs::create_dir_all(fixture.root().join("src")).unwrap();
    std::fs::write(fixture.root().join("src/needle.txt"), "needle here\n").unwrap();

    let rg = run_rg(
        &fixture.scope,
        &fixture.guard,
        "needle",
        Some(Path::new("src")),
        &cancel(),
    )
    .await
    .unwrap();
    assert!(rg.contains("needle"));

    let agentgrep = run_agentgrep(
        &fixture.scope,
        &fixture.guard,
        "needle",
        Some(Path::new("src")),
        &cancel(),
    )
    .await
    .unwrap();
    assert!(agentgrep.contains("needle"));
}

#[tokio::test]
async fn append_creates_and_appends() {
    let fixture = Fixture::new(PermissionTier::Workspace);
    std::fs::create_dir(fixture.root().join("src")).unwrap();
    append_file(
        &fixture.scope,
        &fixture.guard,
        Path::new("src/log.txt"),
        "a",
        &cancel(),
    )
    .await
    .unwrap();
    append_file(
        &fixture.scope,
        &fixture.guard,
        Path::new("src/log.txt"),
        "b",
        &cancel(),
    )
    .await
    .unwrap();
    let read = read_file(
        &fixture.scope,
        &fixture.guard,
        Path::new("src/log.txt"),
        &cancel(),
    )
    .await
    .unwrap();
    assert_eq!(read.content, "ab");
}

#[tokio::test]
async fn git_rejects_mutating_subcommands_and_option_injection() {
    let fixture = Fixture::new(PermissionTier::Workspace);
    for args in [
        vec!["commit".to_owned()],
        vec!["status".to_owned(), "--upload-pack=x".to_owned()],
        vec!["log".to_owned(), "../escape".to_owned()],
    ] {
        let error = run_git(&fixture.guard, &args, &cancel()).await.unwrap_err();
        assert!(
            matches!(error, WorkerError::InvalidRequest(_)),
            "unexpected error for {args:?}: {error:?}"
        );
    }
}

#[tokio::test]
async fn git_status_runs_in_a_real_repo() {
    let fixture = Fixture::new(PermissionTier::Workspace);
    let init = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(fixture.root())
        .status();
    if init.is_err() || !init.unwrap().success() {
        // git unavailable in this environment; the validation tests above still hold.
        return;
    }
    let output = run_git(&fixture.guard, &["status".to_owned()], &cancel())
        .await
        .unwrap();
    assert!(
        output.contains("No commits yet") || output.contains("master") || output.contains("main")
    );
}
