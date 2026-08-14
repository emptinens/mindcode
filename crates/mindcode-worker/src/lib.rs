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
pub mod permission;
pub mod pool;
pub mod report;
pub mod risk;
pub mod scope;
pub mod tools;

pub use agent::{
    default_tool_defs, AllowAllGate, ApprovalDecision, ApprovalGate, ApprovalRequest,
    DecisionFuture, DenyAllGate, ModelClient, ModelTurn, ResolvedToolCall, WorkerAgent,
    DEFAULT_MAX_ITERATIONS,
};
pub use error::{WorkerError, WorkerResult};
pub use guard::{OwnershipGuard, ToolAccess};
pub use hooks::{run_pre_tool, HookDecision, HookSet};
pub use mindcode_core_tools::bwrap_available;
pub use permission::PermissionTier;
pub use pool::{PoolOutcome, WorkerPool, DEFAULT_MAX_CONCURRENT, MAX_CONCURRENT_CAP};
pub use report::{CommandRun, WorkerReport, WorkerStatus, WorkerUsage};
pub use risk::{classify, ShellRisk};
pub use scope::{ScopeError, WorkerScope};
pub use tools::{
    append_file, read_file, resolve_path, run_agentgrep, run_git, run_rg, run_shell,
    run_shell_sandboxed, write_file, FileReadResult, TodoItem, TodoList,
};
