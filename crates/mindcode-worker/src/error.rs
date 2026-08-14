//! Typed worker errors. Every variant is secret-free and never carries a
//! response body, command output, or credential value.

use mindcode_core_tools::CoreToolError;
use std::fmt;
use std::path::PathBuf;

pub type WorkerResult<T> = Result<T, WorkerError>;

#[derive(Debug)]
pub enum WorkerError {
    /// The path lies outside the worker's ownership scope.
    OutOfScope { path: PathBuf },
    /// The permission guard hard-denied the action (e.g. a credential).
    Denied { path: PathBuf },
    /// The action must be approved by the user before it can run.
    NeedsApproval { path: PathBuf },
    /// The task was cancelled.
    Cancelled,
    /// The request itself is malformed (bad argv, unknown git subcommand).
    InvalidRequest(String),
    /// A local file/process failure; the message never carries secrets.
    Io(String),
    /// A failure from the bounded core tools.
    Core(CoreToolError),
}

impl fmt::Display for WorkerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutOfScope { path } => {
                write!(f, "path is outside the worker scope: {}", path.display())
            }
            Self::Denied { path } => write!(f, "access denied: {}", path.display()),
            Self::NeedsApproval { path } => {
                write!(f, "approval required: {}", path.display())
            }
            Self::Cancelled => f.write_str("worker task cancelled"),
            Self::InvalidRequest(message) => write!(f, "invalid request: {message}"),
            Self::Io(message) => write!(f, "i/o failure: {message}"),
            Self::Core(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for WorkerError {}

impl From<CoreToolError> for WorkerError {
    fn from(error: CoreToolError) -> Self {
        Self::Core(error)
    }
}
