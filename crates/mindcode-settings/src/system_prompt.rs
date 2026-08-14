//! Secret-free system prompt management (§13.3).
//!
//! The Leader and Worker system prompts are editable, versioned metadata that
//! lives in `settings.json` — never a credential, never compiled in.  An unset
//! prompt falls back to the built-in default; the worker prefix stays stable
//! by default so provider prompt caching is not invalidated by an edit to the
//! Leader prompt.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Maximum UTF-8 byte length of a single system prompt override.
pub const MAX_SYSTEM_PROMPT_BYTES: usize = 32 * 1024;

/// The built-in Leader prompt (kept intentionally minimal; §10.0.4).
pub const DEFAULT_LEADER_PROMPT: &str = "You are MindCode, a Rust-first coding assistant. \
Answer in the user's terms, make the smallest change that addresses the request, \
and never read or echo credentials.";

/// The built-in Worker prefix.  This prefix is kept stable so provider prompt
/// caching is not invalidated between runs.
pub const DEFAULT_WORKER_PROMPT: &str = "You are a MindCode worker agent. Complete the task by \
calling the available tools. Touch only files inside your ownership scope, never read credentials, \
and finish with a concise summary of what you changed and why.";

/// User overrides for the two system prompts.  `None` means "use the default".
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SystemPromptOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leader: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<String>,
}

impl SystemPromptOverrides {
    /// The effective Leader prompt (override or default).
    pub fn leader_prompt(&self) -> &str {
        self.leader.as_deref().unwrap_or(DEFAULT_LEADER_PROMPT)
    }

    /// The effective Worker prompt (override or default).
    pub fn worker_prompt(&self) -> &str {
        self.worker.as_deref().unwrap_or(DEFAULT_WORKER_PROMPT)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SystemPromptError {
    TooLong { field: &'static str },
    ControlCharacter { field: &'static str },
}

impl fmt::Display for SystemPromptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLong { field } => {
                write!(
                    formatter,
                    "{field} system prompt exceeds {MAX_SYSTEM_PROMPT_BYTES} bytes"
                )
            }
            Self::ControlCharacter { field } => {
                write!(
                    formatter,
                    "{field} system prompt contains a control character"
                )
            }
        }
    }
}

impl std::error::Error for SystemPromptError {}

/// Validate one override.  A valid prompt is bounded and free of NUL/control
/// characters (which could be used to smuggle terminal escapes into the TUI).
pub fn validate_prompt(field: &'static str, prompt: Option<&str>) -> Result<(), SystemPromptError> {
    let Some(prompt) = prompt else {
        return Ok(());
    };
    if prompt.len() > MAX_SYSTEM_PROMPT_BYTES {
        return Err(SystemPromptError::TooLong { field });
    }
    if prompt.chars().any(char::is_control) {
        return Err(SystemPromptError::ControlCharacter { field });
    }
    Ok(())
}

impl SystemPromptOverrides {
    pub fn validate(&self) -> Result<(), SystemPromptError> {
        validate_prompt("leader", self.leader.as_deref())?;
        validate_prompt("worker", self.worker.as_deref())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_prompts_fall_back_to_defaults() {
        let overrides = SystemPromptOverrides::default();
        assert_eq!(overrides.leader_prompt(), DEFAULT_LEADER_PROMPT);
        assert_eq!(overrides.worker_prompt(), DEFAULT_WORKER_PROMPT);
    }

    #[test]
    fn overrides_take_precedence_and_are_stable() {
        let overrides = SystemPromptOverrides {
            leader: Some("leader override".to_owned()),
            worker: Some("worker override".to_owned()),
        };
        assert_eq!(overrides.leader_prompt(), "leader override");
        assert_eq!(overrides.worker_prompt(), "worker override");
        // The built-in defaults are untouched.
        assert_eq!(DEFAULT_WORKER_PROMPT, DEFAULT_WORKER_PROMPT);
    }

    #[test]
    fn rejects_oversized_and_control_character_prompts() {
        assert!(matches!(
            validate_prompt("leader", Some(&"x".repeat(MAX_SYSTEM_PROMPT_BYTES + 1))),
            Err(SystemPromptError::TooLong { field: "leader" })
        ));
        assert!(matches!(
            validate_prompt("worker", Some("bad\u{1b}[31mprompt")),
            Err(SystemPromptError::ControlCharacter { field: "worker" })
        ));
        assert!(validate_prompt("leader", None).is_ok());
    }

    #[test]
    fn serde_round_trips_and_rejects_unknown_fields() {
        let overrides: SystemPromptOverrides =
            serde_json::from_str(r#"{"leader":"L","worker":"W"}"#).unwrap();
        assert_eq!(overrides.leader.as_deref(), Some("L"));
        let json = serde_json::to_string(&overrides).unwrap();
        assert!(serde_json::from_str::<SystemPromptOverrides>(&json).is_ok());
        assert!(serde_json::from_str::<SystemPromptOverrides>(r#"{"nope":1}"#).is_err());
    }
}
