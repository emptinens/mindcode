//! Leader-driven worker orchestration (§10.4).
//!
//! The safety-critical runtime behind the agentic worker loop: a bounded pool
//! that runs at most `MAX_CONCURRENT_CAP` worker tasks at once, a tiered
//! permission model (`ask-everything` / `workspace` / `full-access`), an
//! ownership guard that keeps the credential store unreachable on every tier,
//! disjoint ownership scopes, the structured `WorkerReport`, and the
//! scope-checked tools (read/write, shell, git, ripgrep, todo, agentgrep).

pub mod agent;
pub mod error;
pub mod guard;
pub mod hooks;
pub mod monitor;
pub mod permission;
pub mod pipeline;
pub mod pool;
pub mod prm;
pub mod report;
pub mod retrace;
pub mod risk;
pub mod scope;
pub mod tools;

pub use agent::{
    default_tool_defs, AllowAllGate, ApprovalDecision, ApprovalGate, ApprovalRequest,
    DecisionFuture, DenyAllGate, ModelClient, ModelTurn, ResolvedToolCall, WorkerAgent,
    DEFAULT_MAX_ITERATIONS, DEFAULT_WORKER_CONTEXT_TOKEN_BUDGET,
};
pub use error::{WorkerError, WorkerResult};
pub use guard::{OwnershipGuard, ToolAccess};
pub use hooks::{run_pre_tool, HookDecision, HookSet};
pub use mindcode_core_tools::bwrap_available;
pub use monitor::{create_git_apply_overlay, MonitorAlert, StepMonitor, StepRecord};
pub use permission::PermissionTier;
pub use pipeline::{
    phase_prompt, run_pipeline, run_pipeline_with_agent, PhaseEvidence, PipelineContext,
    PipelineError, PipelineExecutor, PipelinePhase, PipelineReport, PipelineState, PIPELINE_PHASES,
};
pub use pool::{PoolOutcome, WorkerPool, DEFAULT_MAX_CONCURRENT, MAX_CONCURRENT_CAP};
pub use prm::{triage_worker_report, PrmClass};
pub use report::{CommandRun, TestRun, WorkerReport, WorkerStatus, WorkerUsage};
pub use retrace::{
    reconcile_forward_backward, reconstruct_problem_intent, RetraceReconciliation, RetraceVerdict,
};
pub use risk::{classify, ShellRisk};
pub use scope::{
    assign_worker_scope, task_workspace_dir, ActiveScopes, ScopeAssignmentError, ScopeError,
    ScopeLease, WorkerScope,
};
pub use tools::{
    append_file, default_test_argv, read_file, resolve_path, run_agentgrep, run_git, run_rg,
    run_shell, run_shell_sandboxed, run_tests, write_file, FileReadResult, TestRunResult, TodoItem,
    TodoList,
};
