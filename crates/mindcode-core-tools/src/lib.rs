#![forbid(unsafe_op_in_unsafe_fn)]

mod error;
mod git;
mod js_runtime;
mod process;

pub use error::{CoreToolError, CoreToolErrorCode, CoreToolResult};
pub use git::{
    git_diff, git_rev_parse, git_root, git_status, GitDiffRequest, GitDiffResult,
    GitRevParseRequest, GitRevParseResult, GitRootRequest, GitRootResult, GitStatusChange,
    GitStatusRequest, GitStatusResult,
};
pub use js_runtime::{JsRuntime, JsRuntimeKind};
pub use process::{process_run, ProcessRunRequest, ProcessRunResult};
