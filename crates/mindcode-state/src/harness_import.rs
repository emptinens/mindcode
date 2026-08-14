//! Cross-harness session import (§12.5).
//!
//! Read-only import of foreign CLI session files into a normalized
//! `role`/`text` transcript for the MindCode session picker. The conversion is
//! in-place only at the MindCode side: the original file is never modified, and
//! no credential-shaped value is ever read out of a foreign format. Every
//! parser is defensive — malformed input fails closed with a typed error rather
//! than panicking.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::{Path, PathBuf};

/// A supported foreign CLI harness (§12.5, Q12=б: all five).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResumeTarget {
    ClaudeCode,
    Codex,
    OpenCode,
    Cursor,
    Pi,
}

impl ResumeTarget {
    pub const ALL: [Self; 5] = [
        Self::ClaudeCode,
        Self::Codex,
        Self::OpenCode,
        Self::Cursor,
        Self::Pi,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::Cursor => "cursor",
            Self::Pi => "pi",
        }
    }

    /// Stable identifier used to prefix the imported session id in the picker.
    pub const fn stable_id(self) -> &'static str {
        self.label()
    }

    pub fn from_label(label: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|target| target.label() == label)
    }
}

impl fmt::Display for ResumeTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedMessage {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedSession {
    pub target: ResumeTarget,
    pub source_path: PathBuf,
    pub messages: Vec<ImportedMessage>,
}

impl ImportedSession {
    /// A MindCode-stable session id derived from the harness + source path,
    /// safe to use in the session picker and on disk.
    pub fn normalized_id(&self) -> String {
        let path_digest = stable_hash(self.source_path.to_string_lossy().as_bytes());
        format!("{}-{path_digest}", self.target.stable_id())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HarnessImportError {
    Io(String),
    Malformed(String),
    Unsupported(String),
    Oversized,
}

impl fmt::Display for HarnessImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) => write!(formatter, "import I/O error: {message}"),
            Self::Malformed(message) => write!(formatter, "malformed harness session: {message}"),
            Self::Unsupported(message) => {
                write!(formatter, "unsupported harness session: {message}")
            }
            Self::Oversized => formatter.write_str("harness session file exceeds the size limit"),
        }
    }
}

impl std::error::Error for HarnessImportError {}

/// Maximum size of a foreign session file we will read.
const MAX_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
/// Maximum messages kept from one import (defense against unbounded files).
const MAX_IMPORTED_MESSAGES: usize = 10_000;
/// Maximum text length per imported message.
const MAX_MESSAGE_BYTES: usize = 256 * 1024;

/// Import one foreign session.  `source` is a file path; the function never
/// writes to it.
pub fn import_session(
    target: ResumeTarget,
    source: &Path,
) -> Result<ImportedSession, HarnessImportError> {
    let raw = read_bounded(source)?;
    let messages = match target {
        ResumeTarget::ClaudeCode => parse_claude_jsonl(&raw)?,
        ResumeTarget::Codex | ResumeTarget::Cursor | ResumeTarget::Pi => {
            parse_role_content_jsonl(&raw)?
        }
        ResumeTarget::OpenCode => parse_opencode(&raw)?,
    };
    Ok(ImportedSession {
        target,
        source_path: source.to_path_buf(),
        messages,
    })
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, HarnessImportError> {
    let metadata =
        std::fs::metadata(path).map_err(|error| HarnessImportError::Io(error.to_string()))?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(HarnessImportError::Oversized);
    }
    std::fs::read(path).map_err(|error| HarnessImportError::Io(error.to_string()))
}

/// Claude Code: JSONL where each line is
/// `{"type":"user"|"assistant","message":{"content":[{type,text},…]}}`.
fn parse_claude_jsonl(raw: &[u8]) -> Result<Vec<ImportedMessage>, HarnessImportError> {
    let mut messages = Vec::new();
    for (line_number, line) in raw.split(|byte| *byte == b'\n').enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let value: serde_json::Value = serde_json::from_slice(line).map_err(|error| {
            HarnessImportError::Malformed(format!("line {}: {error}", line_number + 1))
        })?;
        let Some(kind) = value.get("type").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let role = match kind {
            "user" => "user",
            "assistant" => "assistant",
            _ => continue,
        };
        let Some(text) = claude_content_text(value.get("message")) else {
            continue;
        };
        push_message(&mut messages, role, &text)?;
    }
    Ok(messages)
}

fn claude_content_text(message: Option<&serde_json::Value>) -> Option<String> {
    let content = message?.get("content")?;
    match content {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(blocks) => {
            let mut text = String::new();
            for block in blocks {
                let kind = block.get("type").and_then(serde_json::Value::as_str);
                if kind == Some("text") {
                    if let Some(part) = block.get("text").and_then(serde_json::Value::as_str) {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(part);
                    }
                }
            }
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

/// Codex / Cursor / Pi: JSONL where each line is `{"role","content"}`.
fn parse_role_content_jsonl(raw: &[u8]) -> Result<Vec<ImportedMessage>, HarnessImportError> {
    let mut messages = Vec::new();
    for (line_number, line) in raw.split(|byte| *byte == b'\n').enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let value: serde_json::Value = serde_json::from_slice(line).map_err(|error| {
            HarnessImportError::Malformed(format!("line {}: {error}", line_number + 1))
        })?;
        let Some(role) = value.get("role").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if !matches!(role, "user" | "assistant" | "system") {
            continue;
        }
        let Some(text) = value.get("content").and_then(serde_json::Value::as_str) else {
            continue;
        };
        push_message(&mut messages, role, text)?;
    }
    Ok(messages)
}

/// OpenCode: either a JSON object `{"messages":[…]}` or JSONL role/content.
fn parse_opencode(raw: &[u8]) -> Result<Vec<ImportedMessage>, HarnessImportError> {
    let trimmed: Vec<u8> = raw
        .iter()
        .copied()
        .skip_while(u8::is_ascii_whitespace)
        .collect();
    if trimmed.first() == Some(&b'{') {
        let value: serde_json::Value = serde_json::from_slice(&trimmed)
            .map_err(|error| HarnessImportError::Malformed(error.to_string()))?;
        if let Some(entries) = value.get("messages").and_then(serde_json::Value::as_array) {
            let mut messages = Vec::new();
            for entry in entries {
                let Some(role) = entry.get("role").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                if !matches!(role, "user" | "assistant" | "system") {
                    continue;
                }
                let Some(text) = entry.get("content").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                push_message(&mut messages, role, text)?;
            }
            return Ok(messages);
        }
    }
    parse_role_content_jsonl(raw)
}

fn push_message(
    messages: &mut Vec<ImportedMessage>,
    role: &str,
    text: &str,
) -> Result<(), HarnessImportError> {
    if messages.len() >= MAX_IMPORTED_MESSAGES {
        return Err(HarnessImportError::Oversized);
    }
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Ok(());
    }
    if text.len() > MAX_MESSAGE_BYTES {
        return Err(HarnessImportError::Oversized);
    }
    messages.push(ImportedMessage {
        role: role.to_owned(),
        text,
    });
    Ok(())
}

/// A tiny stable FNV-1a 64-bit hash → hex string, for session id suffixes.
/// Deterministic across runs and machines for the same input bytes.
fn stable_hash(bytes: &[u8]) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn fixture(name: &str, contents: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        let path = dir.path().join(name);
        fs::write(&path, contents).unwrap();
        (dir, path)
    }

    #[test]
    fn imports_claude_code_nested_blocks() {
        let (_dir, path) = fixture(
            "session.jsonl",
            r#"{"type":"user","message":{"content":[{"type":"text","text":"fix the bug"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"looking"},{"type":"text","text":" into it"}]}}
{"type":"tool_result","message":{"content":"ignored"}}
"#,
        );
        let imported = import_session(ResumeTarget::ClaudeCode, &path).unwrap();
        assert_eq!(imported.messages.len(), 2);
        assert_eq!(imported.messages[0].role, "user");
        assert_eq!(imported.messages[0].text, "fix the bug");
        assert_eq!(imported.messages[1].text, "looking\n into it");
        // The original file is untouched.
        assert!(fs::read_to_string(&path).unwrap().contains("tool_result"));
    }

    #[test]
    fn imports_codex_cursor_and_pi_role_content() {
        let contents = "{\"role\":\"user\",\"content\":\"hello\"}\n{\"role\":\"assistant\",\"content\":\"hi\"}\n";
        for target in [ResumeTarget::Codex, ResumeTarget::Cursor, ResumeTarget::Pi] {
            let (_dir, path) = fixture("session.jsonl", contents);
            let imported = import_session(target, &path).unwrap();
            assert_eq!(imported.target, target);
            assert_eq!(imported.messages.len(), 2);
            assert_eq!(imported.messages[0].role, "user");
        }
    }

    #[test]
    fn imports_opencode_messages_array() {
        let (_dir, path) = fixture(
            "session.json",
            r#"{"messages":[{"role":"user","content":"question"},{"role":"assistant","content":"answer"}]}"#,
        );
        let imported = import_session(ResumeTarget::OpenCode, &path).unwrap();
        assert_eq!(imported.messages.len(), 2);
        assert_eq!(imported.messages[1].text, "answer");
    }

    #[test]
    fn malformed_and_oversized_input_fail_closed() {
        let (_dir, path) = fixture("bad.jsonl", "{not json}\n");
        assert!(matches!(
            import_session(ResumeTarget::Codex, &path),
            Err(HarnessImportError::Malformed(_))
        ));
        let (_dir, oversized) = fixture("big.jsonl", "");
        fs::write(&oversized, vec![b'x'; MAX_SOURCE_BYTES as usize + 1]).unwrap();
        assert_eq!(
            import_session(ResumeTarget::Codex, &oversized),
            Err(HarnessImportError::Oversized)
        );
    }

    #[test]
    fn normalized_id_is_stable_and_target_prefixed() {
        let (_dir, path) = fixture("s.jsonl", "{\"role\":\"user\",\"content\":\"x\"}\n");
        let imported = import_session(ResumeTarget::Codex, &path).unwrap();
        let id = imported.normalized_id();
        assert!(id.starts_with("codex-"));
        assert_eq!(id.len(), "codex-".len() + 16);
        // Deterministic.
        assert_eq!(id, imported.normalized_id());
    }

    #[test]
    fn every_target_round_trips_through_label() {
        for target in ResumeTarget::ALL {
            assert_eq!(ResumeTarget::from_label(target.label()), Some(target));
            assert_eq!(target.stable_id(), target.label());
        }
    }
}
