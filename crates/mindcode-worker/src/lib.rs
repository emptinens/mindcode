//! Leader-driven worker orchestration (§10.4).
//!
//! The safety-critical runtime behind the agentic worker loop: a bounded pool
//! that runs at most `MAX_CONCURRENT_CAP` worker tasks at once, a tiered
//! permission model (`ask-everything` / `workspace` / `full-access`), an
//! ownership guard that keeps the credential store unreachable on every tier,
//! disjoint ownership scopes, the structured `WorkerReport`, and the four
//! scope-checked tools (read/write, shell, git, ripgrep).

pub mod error;
pub mod guard;
pub mod permission;
pub mod pool;
pub mod report;
pub mod scope;
pub mod tools;

pub use error::{WorkerError, WorkerResult};
pub use guard::{OwnershipGuard, ToolAccess};
pub use permission::PermissionTier;
pub use pool::{PoolOutcome, WorkerPool, DEFAULT_MAX_CONCURRENT, MAX_CONCURRENT_CAP};
pub use report::{CommandRun, WorkerReport, WorkerStatus, WorkerUsage};
pub use scope::{ScopeError, WorkerScope};
pub use tools::{append_file, read_file, run_git, run_rg, run_shell, write_file, FileReadResult};
