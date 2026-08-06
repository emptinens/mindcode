use serde::{Deserialize, Serialize};
use std::fmt;

pub type CoreToolResult<T> = Result<T, CoreToolError>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoreToolErrorCode {
    InvalidRequest,
    InvalidArgv,
    InvalidCwd,
    InvalidEnvironment,
    InvalidInput,
    InvalidGitPath,
    Cancelled,
    ProcessSpawn,
    ProcessIo,
    ProcessFailed,
    GitCommandFailed,
    GitOutputTruncated,
    GitStatusParse,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CoreToolError {
    pub code: CoreToolErrorCode,
    pub message: String,
}

impl CoreToolError {
    pub(crate) fn new(code: CoreToolErrorCode, message: &'static str) -> Self {
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

impl fmt::Display for CoreToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CoreToolError {}

impl fmt::Display for CoreToolErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::InvalidRequest => "INVALID_REQUEST",
            Self::InvalidArgv => "INVALID_ARGV",
            Self::InvalidCwd => "INVALID_CWD",
            Self::InvalidEnvironment => "INVALID_ENVIRONMENT",
            Self::InvalidInput => "INVALID_INPUT",
            Self::InvalidGitPath => "INVALID_GIT_PATH",
            Self::Cancelled => "CANCELLED",
            Self::ProcessSpawn => "PROCESS_SPAWN",
            Self::ProcessIo => "PROCESS_IO",
            Self::ProcessFailed => "PROCESS_FAILED",
            Self::GitCommandFailed => "GIT_COMMAND_FAILED",
            Self::GitOutputTruncated => "GIT_OUTPUT_TRUNCATED",
            Self::GitStatusParse => "GIT_STATUS_PARSE",
        };
        f.write_str(value)
    }
}
