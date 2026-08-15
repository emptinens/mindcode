//! Integration tests for the agentic worker loop against a scripted model
//! client (no network, no live provider).

use mindcode_transport::{ChatMessage, ChatUsage, ToolSpec};
use mindcode_worker::{
    AllowAllGate, ApprovalDecision, ApprovalRequest, DenyAllGate, ModelClient, ModelTurn,
    OwnershipGuard, PermissionTier, ResolvedToolCall, WorkerAgent, WorkerError, WorkerReport,
    WorkerScope, WorkerStatus,
};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

type ModelFuture = Pin<Box<dyn Future<Output = Result<ModelTurn, WorkerError>> + Send>>;

/// A model client that replays a fixed turn sequence, then repeats a final
/// "done" turn forever.
struct ScriptedClient {
    turns: Vec<ModelTurn>,
    cursor: Mutex<usize>,
}

impl ScriptedClient {
    fn new(turns: Vec<ModelTurn>) -> Self {
        Self {
            turns,
            cursor: Mutex::new(0),
        }
    }
}

impl ModelClient for ScriptedClient {
    fn turn(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolSpec],
        cancel: CancellationToken,
    ) -> ModelFuture {
        let index = {
            let mut cursor = self.cursor.lock().unwrap();
            let index = *cursor;
            *cursor += 1;
            index
        };
        let turn = self.turns.get(index).cloned().unwrap_or_else(|| ModelTurn {
            text: "done".to_owned(),
            ..Default::default()
        });
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Err(WorkerError::Cancelled);
            }
            Ok(turn)
        })
    }
}

fn tool_call(id: &str, name: &str, arguments: serde_json::Value) -> ResolvedToolCall {
    ResolvedToolCall {
        id: id.to_owned(),
        name: name.to_owned(),
        arguments,
    }
}

fn turn_text(text: &str) -> ModelTurn {
    ModelTurn {
        text: text.to_owned(),
        usage: ChatUsage {
            input_tokens: 10,
            output_tokens: 2,
            ..Default::default()
        },
        ..Default::default()
    }
}

fn fixture(
    tier: PermissionTier,
) -> (
    tempfile::TempDir,
    tempfile::TempDir,
    WorkerScope,
    OwnershipGuard,
) {
    let workspace = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(workspace.path().join("src")).unwrap();
    let guard = OwnershipGuard::new(
        workspace.path().to_path_buf(),
        config.path().to_path_buf(),
        tier,
    )
    .unwrap();
    let scope = WorkerScope::new(vec![PathBuf::from("src")]).unwrap();
    (workspace, config, scope, guard)
}

#[tokio::test]
async fn agent_runs_tools_and_produces_a_report() {
    let (workspace, _config, scope, guard) = fixture(PermissionTier::Workspace);
    let client = Arc::new(ScriptedClient::new(vec![
        ModelTurn {
            tool_calls: vec![tool_call(
                "call_1",
                "read_file",
                serde_json::json!({"path": "src/a.txt"}),
            )],
            ..Default::default()
        },
        ModelTurn {
            tool_calls: vec![tool_call(
                "call_2",
                "write_file",
                serde_json::json!({"path": "src/b.txt", "content": "hello"}),
            )],
            ..Default::default()
        },
        turn_text("migrated the file"),
    ]));
    std::fs::write(workspace.path().join("src/a.txt"), "input").unwrap();

    let agent = WorkerAgent::new("w-1", client, Arc::new(AllowAllGate), scope, guard);
    let report: WorkerReport = agent
        .run("read a.txt and write b.txt", CancellationToken::new())
        .await;

    assert_eq!(report.status, WorkerStatus::Success);
    assert_eq!(report.summary, "migrated the file");
    assert_eq!(report.files_read, vec!["src/a.txt".to_owned()]);
    assert_eq!(report.files_changed, vec!["src/b.txt".to_owned()]);
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("src/b.txt")).unwrap(),
        "hello"
    );
    assert!(report.usage.input_tokens >= 10);
}

#[tokio::test]
async fn agent_reports_a_denied_tool_and_continues() {
    let (workspace, _config, scope, guard) = fixture(PermissionTier::AskEverything);
    let client = Arc::new(ScriptedClient::new(vec![
        ModelTurn {
            tool_calls: vec![tool_call(
                "call_1",
                "read_file",
                serde_json::json!({"path": "src/a.txt"}),
            )],
            ..Default::default()
        },
        turn_text("I could not read the file"),
    ]));
    std::fs::write(workspace.path().join("src/a.txt"), "secret-ish").unwrap();

    // A gate that always denies: the read is refused, the loop feeds the
    // denial back, and the model's next turn finishes the task.
    struct DenyGate;
    impl mindcode_worker::ApprovalGate for DenyGate {
        fn decide(&self, request: ApprovalRequest) -> mindcode_worker::DecisionFuture {
            Box::pin(async move {
                assert_eq!(request.tool, "read_file");
                ApprovalDecision::Deny
            })
        }
    }

    let agent = WorkerAgent::new("w-2", client, Arc::new(DenyGate), scope, guard);
    let report = agent.run("read a.txt", CancellationToken::new()).await;

    assert_eq!(report.status, WorkerStatus::Success);
    assert_eq!(report.summary, "I could not read the file");
    // The denied read must not have been recorded as a successful read.
    assert!(report.files_read.is_empty());
}

// §13.1: under `full-access` a shell command is sandboxed by default, and the
// explicit `--allow-unsafe-shell` opt-out runs it unsandboxed.
#[tokio::test]
async fn run_tests_returns_structured_evidence_for_a_mini_project() {
    if !mindcode_core_tools::bwrap_available() {
        return;
    }
    let (workspace, _config, scope, guard) = fixture(PermissionTier::Workspace);
    std::fs::write(
        workspace.path().join("Cargo.toml"),
        "[package]\nname = \"mini-test-project\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    std::fs::write(
        workspace.path().join("src/lib.rs"),
        "#[test]\nfn one_test_passes() { assert_eq!(2 + 2, 4); }\n",
    )
    .unwrap();
    std::fs::write(
        workspace.path().join("rust-toolchain.toml"),
        "[toolchain]\nchannel = \"1.97.1\"\n",
    )
    .unwrap();
    let client = Arc::new(ScriptedClient::new(vec![
        ModelTurn {
            tool_calls: vec![tool_call(
                "call-tests",
                "run_tests",
                serde_json::json!({"argv": ["cargo", "test"]}),
            )],
            ..Default::default()
        },
        turn_text("tests passed"),
    ]));

    let agent = WorkerAgent::new("w-tests", client, Arc::new(AllowAllGate), scope, guard);
    let report = agent
        .run("run the project tests", CancellationToken::new())
        .await;

    assert_eq!(report.status, WorkerStatus::Success);
    assert_eq!(report.test_runs.len(), 1);
    assert_eq!(
        report.test_runs[0].exit_code,
        Some(0),
        "test report: {:?}",
        report.test_runs
    );
    assert!(
        report.test_runs[0].passed >= 1,
        "test report: {:?}",
        report.test_runs
    );
    assert_eq!(report.test_runs[0].failed, 0);
    assert!(report.commands_run[0].command.contains("cargo test"));
}

#[tokio::test]
async fn full_access_shell_runs_unsandboxed_when_unsafe_shell_allowed() {
    let (_workspace, _config, scope, guard) = fixture(PermissionTier::FullAccess);
    let client = Arc::new(ScriptedClient::new(vec![ModelTurn {
        tool_calls: vec![tool_call(
            "call_1",
            "run_shell",
            serde_json::json!({"argv": ["echo", "hi"]}),
        )],
        ..Default::default()
    }]));

    let agent = WorkerAgent::new("w-unsafe", client, Arc::new(AllowAllGate), scope, guard)
        .with_unsafe_shell(true);
    let report = agent.run("echo hi", CancellationToken::new()).await;

    assert_eq!(report.status, WorkerStatus::Success);
    assert_eq!(report.commands_run.len(), 1);
    assert_eq!(report.commands_run[0].exit_code, Some(0));
}

#[tokio::test]
async fn full_access_shell_is_sandboxed_by_default() {
    let (_workspace, _config, scope, guard) = fixture(PermissionTier::FullAccess);
    let client = Arc::new(ScriptedClient::new(vec![ModelTurn {
        tool_calls: vec![tool_call(
            "call_1",
            "run_shell",
            serde_json::json!({"argv": ["echo", "hi"]}),
        )],
        ..Default::default()
    }]));

    let agent = WorkerAgent::new("w-sandboxed", client, Arc::new(AllowAllGate), scope, guard);
    let report = agent.run("echo hi", CancellationToken::new()).await;

    assert_eq!(report.status, WorkerStatus::Success);
    if mindcode_core_tools::bwrap_available() {
        // The command runs, but only under the bwrap sandbox.
        assert_eq!(report.commands_run.len(), 1);
        assert_eq!(report.commands_run[0].exit_code, Some(0));
    } else {
        // bwrap is absent: fail closed, the command is never recorded as run.
        assert!(report.commands_run.is_empty());
    }
}

#[tokio::test]
async fn deny_all_gate_refuses_every_tool_call() {
    let (_workspace, _config, scope, guard) = fixture(PermissionTier::AskEverything);
    let client = Arc::new(ScriptedClient::new(vec![ModelTurn {
        tool_calls: vec![tool_call(
            "call_1",
            "run_shell",
            serde_json::json!({"argv": ["echo", "hi"]}),
        )],
        ..Default::default()
    }]));

    let agent = WorkerAgent::new("w-3", client, Arc::new(DenyAllGate), scope, guard);
    let report = agent.run("echo hi", CancellationToken::new()).await;
    // The only turn requests a tool; after it is denied, the fallback "done"
    // turn has no tool calls, so the worker still succeeds with a summary.
    assert_eq!(report.status, WorkerStatus::Success);
    assert!(report.commands_run.is_empty());
}
