//! Daemon-side worker execution (§6.5 convergence, first slice).
//!
//! The daemon resolves the active provider and its credential itself —
//! environment first, then the on-disk secret store, failing closed when
//! neither is present — through `mindcode_runtime`, so credential material
//! never crosses the control socket. Worker agents run on a bounded
//! `WorkerPool` owned by the daemon (not by the TUI client process), with
//! per-session disjoint scopes reserved atomically via [`ActiveScopes`].

use anyhow::{anyhow, Result};
use mindcode_runtime::{native_settings_path, TransportModelClient};
use mindcode_settings::{NativeSettings, WorkerEffort};
use mindcode_worker::{
    ActiveScopes, ApprovalDecision, ApprovalGate, ApprovalRequest, DecisionFuture, HookSet,
    ModelClient, OwnershipGuard, PermissionTier, PoolOutcome, ScopeLease, WorkerAgent, WorkerPool,
    WorkerReport, DEFAULT_WORKER_CONTEXT_TOKEN_BUDGET,
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Inputs for one daemon-side worker launch. Everything is secret-free: the
/// credential is resolved daemon-side, never transported from the client.
pub struct WorkerRequest {
    pub worker_id: String,
    pub session_id: String,
    pub task: String,
    pub cwd: PathBuf,
    pub tier: PermissionTier,
    pub allow_unsafe_shell: bool,
    pub allow_network: bool,
    /// Optional Ares effort for this step; the global effort lock still wins.
    pub effort: Option<WorkerEffort>,
}

/// A worker whose client, scope, guard, and hooks are fully resolved. The
/// [`ScopeLease`] held here releases the disjoint reservation when the worker
/// is dropped or finishes, so an aborted worker can never pin ownership.
pub struct PreparedWorker {
    pub worker_id: String,
    pub task: String,
    agent: WorkerAgent,
    _scope_lease: ScopeLease,
}

/// Pending tool execution approval waiting for client/TUI decision.
pub struct PendingApproval {
    pub id: String,
    pub session_id: String,
    pub worker_id: String,
    pub tool: String,
    pub target: String,
    pub requested_at_ms: u64,
    pub sender: oneshot::Sender<ApprovalDecision>,
}

/// Secret-free serializable view of a pending approval.
#[derive(Clone, Debug, Serialize)]
pub struct PendingApprovalInfo {
    pub id: String,
    pub session_id: String,
    pub worker_id: String,
    pub tool: String,
    pub target: String,
    pub requested_at_ms: u64,
}

/// Interactive approval gate bridging daemon-side worker execution with
/// the RPC control layer.
pub struct DaemonApprovalGate {
    session_id: String,
    approvals: Arc<Mutex<BTreeMap<String, PendingApproval>>>,
    next_id: Arc<AtomicU64>,
}

impl ApprovalGate for DaemonApprovalGate {
    fn decide(&self, request: ApprovalRequest) -> DecisionFuture {
        let (sender, receiver) = oneshot::channel();
        let id_num = self.next_id.fetch_add(1, Ordering::SeqCst);
        let id = format!("perm-{id_num}");
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let pending = PendingApproval {
            id: id.clone(),
            session_id: self.session_id.clone(),
            worker_id: request.worker_id,
            tool: request.tool,
            target: request.target,
            requested_at_ms: now_ms,
            sender,
        };

        if let Ok(mut map) = self.approvals.lock() {
            map.insert(id, pending);
        }

        Box::pin(async move { receiver.await.unwrap_or(ApprovalDecision::Deny) })
    }
}

/// Bounded daemon-side worker executor keyed by session.
pub struct WorkerRuntime {
    pool: WorkerPool,
    config_home: PathBuf,
    scopes: Arc<Mutex<BTreeMap<String, ActiveScopes>>>,
    approvals: Arc<Mutex<BTreeMap<String, PendingApproval>>>,
    next_approval_id: Arc<AtomicU64>,
}

impl WorkerRuntime {
    /// Build the executor with the default config home (`native_settings_path`
    /// parent). `max_concurrent` must be within the worker pool bounds.
    pub fn new(max_concurrent: usize) -> Result<Self> {
        let config_home = default_config_home()?;
        Self::with_config_home(max_concurrent, config_home)
    }

    /// Build the executor with an explicit config home (used by tests to keep
    /// the guard and hook directories hermetic).
    pub fn with_config_home(max_concurrent: usize, config_home: PathBuf) -> Result<Self> {
        let pool = WorkerPool::with_defaults(max_concurrent)
            .map_err(|error| anyhow!(error.to_string()))?;
        Ok(Self {
            pool,
            config_home,
            scopes: Arc::new(Mutex::new(BTreeMap::new())),
            approvals: Arc::new(Mutex::new(BTreeMap::new())),
            next_approval_id: Arc::new(AtomicU64::new(1)),
        })
    }

    pub fn max_concurrent(&self) -> usize {
        self.pool.max_concurrent()
    }

    /// The config home used for the ownership guard and global shell hooks.
    pub fn config_home(&self) -> &Path {
        &self.config_home
    }

    /// Obtain an interactive approval gate for the specified session.
    pub fn gate_for(&self, session_id: String) -> Arc<dyn ApprovalGate> {
        Arc::new(DaemonApprovalGate {
            session_id,
            approvals: Arc::clone(&self.approvals),
            next_id: Arc::clone(&self.next_approval_id),
        })
    }

    /// List all currently pending tool approvals, optionally filtered by session.
    pub fn pending_approvals(&self, session_id: Option<&str>) -> Vec<PendingApprovalInfo> {
        let Ok(map) = self.approvals.lock() else {
            return Vec::new();
        };
        map.values()
            .filter(|p| session_id.is_none_or(|s| p.session_id == s))
            .map(|p| PendingApprovalInfo {
                id: p.id.clone(),
                session_id: p.session_id.clone(),
                worker_id: p.worker_id.clone(),
                tool: p.tool.clone(),
                target: p.target.clone(),
                requested_at_ms: p.requested_at_ms,
            })
            .collect()
    }

    /// Resolve a pending tool approval with the user's decision. Returns false if
    /// the approval ID was not found or already resolved.
    pub fn decide_approval(&self, approval_id: &str, decision: ApprovalDecision) -> bool {
        let Ok(mut map) = self.approvals.lock() else {
            return false;
        };
        if let Some(pending) = map.remove(approval_id) {
            let _ = pending.sender.send(decision);
            true
        } else {
            false
        }
    }

    /// Resolve the active provider credential (env → store → fail-closed) and
    /// build the worker agent with a disjoint scope reserved under the
    /// session's registry. No secret crosses the socket: this is the proof
    /// point that the daemon reads credentials itself.
    pub async fn prepare(
        &self,
        request: WorkerRequest,
        gate: Arc<dyn ApprovalGate>,
        settings: &NativeSettings,
    ) -> Result<PreparedWorker> {
        let client = TransportModelClient::resolve_with_effort(settings, request.effort).await?;
        self.build_agent(request, Arc::new(client), gate, settings)
    }

    /// Build an agent around an already-resolved client. Split from
    /// [`Self::prepare`] so tests can inject a scripted client without
    /// touching credentials or the network.
    pub fn build_agent(
        &self,
        request: WorkerRequest,
        client: Arc<dyn ModelClient>,
        gate: Arc<dyn ApprovalGate>,
        settings: &NativeSettings,
    ) -> Result<PreparedWorker> {
        // Reserve a disjoint scope atomically under the session's registry.
        let (scope, scope_lease) = {
            let mut sessions = self
                .scopes
                .lock()
                .map_err(|_| anyhow!("worker scope registry poisoned"))?;
            sessions
                .entry(request.session_id.clone())
                .or_default()
                .assign_for(&request.cwd, &request.task, &request.worker_id)
                .map_err(anyhow::Error::msg)?
        };
        // §11.4: shell hooks live globally and project-locally; project-local
        // scripts shadow the global ones by name.
        let hooks = HookSet {
            global: Some(self.config_home.join("hooks")),
            project: Some(request.cwd.join(".mindcode").join("hooks")),
            fail_closed: true,
        };
        let guard =
            OwnershipGuard::new(request.cwd.clone(), self.config_home.clone(), request.tier)
                .map_err(anyhow::Error::msg)?;
        let tool_output_dir = self
            .config_home
            .join("sessions")
            .join(&request.session_id)
            .join("worker-outputs")
            .join(&request.worker_id);
        let worker_context_budget = settings
            .context_token_budget
            .unwrap_or(DEFAULT_WORKER_CONTEXT_TOKEN_BUDGET);
        let agent = WorkerAgent::new(request.worker_id.clone(), client, gate, scope, guard)
            .with_hooks(hooks)
            .with_max_iterations(settings.worker_max_iterations)
            .with_context_token_budget(worker_context_budget)
            .with_tool_output_dir(tool_output_dir)
            .with_approval_ttl(Duration::from_secs(settings.approval_cache_ttl_seconds))
            .with_unsafe_shell(request.allow_unsafe_shell)
            .with_allow_network(request.allow_network);
        Ok(PreparedWorker {
            worker_id: request.worker_id,
            task: request.task,
            agent,
            _scope_lease: scope_lease,
        })
    }

    /// Run a prepared worker on the bounded pool to completion, folding
    /// cancellation and timeout into a report. Never returns a missing report:
    /// an absent report becomes `cancelled` or `timed_out`.
    pub async fn run(&self, prepared: PreparedWorker) -> WorkerReport {
        let PreparedWorker {
            worker_id,
            task,
            agent,
            _scope_lease,
        } = prepared;
        let agent = Arc::new(agent);
        let cancel = CancellationToken::new();
        let outcome = self
            .pool
            .run(cancel.clone(), {
                let agent = Arc::clone(&agent);
                let task = task.clone();
                let cancel = cancel.clone();
                move || {
                    let agent = Arc::clone(&agent);
                    let task = task.clone();
                    let cancel = cancel.clone();
                    async move { agent.run(&task, cancel).await }
                }
            })
            .await;
        match outcome {
            PoolOutcome {
                report: Some(report),
                ..
            } => report,
            PoolOutcome {
                cancelled: true, ..
            } => WorkerReport::cancelled(worker_id),
            _ => WorkerReport::timed_out(worker_id),
        }
    }
}

fn default_config_home() -> Result<PathBuf> {
    native_settings_path()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow!("MindCode config home is unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mindcode_transport::{ChatMessage, ChatUsage, ToolSpec};
    use mindcode_worker::{AllowAllGate, ModelTurn, WorkerResult, WorkerStatus};
    use std::future::Future;
    use std::pin::Pin;

    /// Scripted client that answers a single text turn and never calls tools.
    struct ScriptedClient;

    impl ModelClient for ScriptedClient {
        fn turn(
            &self,
            _messages: &[ChatMessage],
            _tools: &[ToolSpec],
            _cancel: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = WorkerResult<ModelTurn>> + Send>> {
            Box::pin(async {
                Ok(ModelTurn {
                    text: "done".to_owned(),
                    tool_calls: Vec::new(),
                    usage: ChatUsage::default(),
                    cost: 0.0,
                    cost_known: false,
                })
            })
        }
    }

    /// An isolated config home (created) and a live workspace dir, both kept
    /// alive for the duration of the test.
    fn isolated_runtime(
        max_concurrent: usize,
    ) -> (WorkerRuntime, tempfile::TempDir, tempfile::TempDir) {
        let config = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let runtime =
            WorkerRuntime::with_config_home(max_concurrent, config.path().join("mindcode"))
                .unwrap();
        // The guard canonicalizes the config home, so it must already exist.
        std::fs::create_dir_all(config.path().join("mindcode")).unwrap();
        (runtime, config, workspace)
    }

    fn request(worker_id: &str, session_id: &str, cwd: &Path) -> WorkerRequest {
        WorkerRequest {
            worker_id: worker_id.to_owned(),
            session_id: session_id.to_owned(),
            task: "summarize the workspace".to_owned(),
            cwd: cwd.to_path_buf(),
            tier: PermissionTier::AskEverything,
            allow_unsafe_shell: false,
            allow_network: false,
            effort: None,
        }
    }

    #[tokio::test]
    async fn scripted_worker_runs_to_completion_and_produces_a_report() {
        let (runtime, _config, workspace) = isolated_runtime(4);
        let settings = NativeSettings::default();
        let prepared = runtime
            .build_agent(
                request("worker-1", "session-a", workspace.path()),
                Arc::new(ScriptedClient),
                Arc::new(AllowAllGate),
                &settings,
            )
            .unwrap();
        let report = runtime.run(prepared).await;
        assert_eq!(report.id, "worker-1");
        assert_eq!(report.status, WorkerStatus::Success);
    }

    #[tokio::test]
    async fn disjoint_scopes_are_enforced_across_workers_in_one_session() {
        let (runtime, _config, workspace) = isolated_runtime(4);
        std::fs::create_dir_all(workspace.path().join("crates")).unwrap();
        let settings = NativeSettings::default();

        // The first worker holds the whole workspace; the second, even scoped
        // to crates/, must fail closed.
        let _first = runtime
            .build_agent(
                request("worker-1", "session-a", workspace.path()),
                Arc::new(ScriptedClient),
                Arc::new(AllowAllGate),
                &settings,
            )
            .unwrap();
        let mut second = request("worker-2", "session-a", workspace.path());
        second.task = "fix crates/foo".to_owned();
        assert!(runtime
            .build_agent(
                second,
                Arc::new(ScriptedClient),
                Arc::new(AllowAllGate),
                &settings,
            )
            .is_err());
    }

    #[tokio::test]
    async fn prepare_fails_closed_when_no_active_provider_is_configured() {
        let (runtime, _config, workspace) = isolated_runtime(1);
        // First-run settings have no provider profile, so credential resolution
        // must fail closed without any network or store access.
        let error = match runtime
            .prepare(
                request("worker-1", "session-a", workspace.path()),
                Arc::new(AllowAllGate),
                &NativeSettings::default(),
            )
            .await
        {
            Ok(_) => panic!("no provider must fail closed"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("no active provider"));
    }
}
