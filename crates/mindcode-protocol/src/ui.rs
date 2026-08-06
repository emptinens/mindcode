//! Bounded MessagePack protocol for the TS-authoritative UI boundary.
//!
//! The UI protocol deliberately keeps the daemon and renderer state separate:
//! TypeScript publishes authoritative render snapshots, while the peer sends
//! input/control messages.  All messages carry the UI protocol version and
//! are encoded with the shared four-byte length-prefixed MessagePack framing.

use serde::de::{SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::marker::PhantomData;

use crate::{decode_frame, encode_frame, ProtocolError};

pub const UI_PROTOCOL_VERSION: u16 = 1;
pub const UI_MAX_FRAME_SIZE: usize = 4 * 1024 * 1024;
pub const UI_MAX_ID_BYTES: usize = 128;
pub const UI_MAX_CLIENT_BYTES: usize = 128;
pub const UI_MAX_CAPABILITIES: usize = 64;
pub const UI_MAX_CAPABILITY_BYTES: usize = 128;
pub const UI_MAX_INPUT_BYTES: usize = 64 * 1024;
pub const UI_MAX_INPUT_MODIFIERS: usize = 8;
pub const UI_MAX_STATUS_BYTES: usize = 64 * 1024;
pub const UI_MAX_TASKS: usize = 1_024;
pub const UI_MAX_TASK_ID_BYTES: usize = 256;
pub const UI_MAX_TASK_TITLE_BYTES: usize = 4 * 1024;
pub const UI_MAX_TRANSCRIPT_ENTRIES: usize = 4_096;
pub const UI_MAX_TRANSCRIPT_ROLE_BYTES: usize = 64;
pub const UI_MAX_TRANSCRIPT_TEXT_BYTES: usize = 64 * 1024;
pub const UI_MAX_SNAPSHOT_BYTES: usize = 3 * 1024 * 1024;
pub const UI_MAX_CODE_BYTES: usize = 128;
pub const UI_MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub const UI_MAX_REASON_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiHandshake {
    pub version: u16,
    pub id: String,
    pub client: String,
    #[serde(deserialize_with = "deserialize_capabilities")]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiCapabilities {
    pub version: u16,
    pub id: String,
    #[serde(deserialize_with = "deserialize_capabilities")]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiTerminalSize {
    pub version: u16,
    pub id: String,
    pub columns: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiKeyInput {
    pub key: String,
    #[serde(deserialize_with = "deserialize_modifiers")]
    pub modifiers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiInputEventKind {
    Key(UiKeyInput),
    Text { text: String },
    Paste { text: String },
    Submit,
    Cancel,
    Interrupt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiInputEvent {
    pub version: u16,
    pub id: String,
    pub sequence: u64,
    pub event: UiInputEventKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiStatusSnapshot {
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiTaskSnapshot {
    pub id: String,
    pub title: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiTranscriptEntry {
    pub sequence: u64,
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiRenderSnapshot {
    pub version: u16,
    pub id: String,
    pub sequence: u64,
    pub status: UiStatusSnapshot,
    #[serde(deserialize_with = "deserialize_tasks")]
    pub tasks: Vec<UiTaskSnapshot>,
    #[serde(deserialize_with = "deserialize_transcript")]
    pub transcript: Vec<UiTranscriptEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiAck {
    pub version: u16,
    pub id: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiError {
    pub version: u16,
    pub id: String,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiShutdown {
    pub version: u16,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// A complete UI wire message.  The `type` tag is encoded as a top-level
/// MessagePack map field so it is directly consumable by TypeScript's
/// MessagePack decoder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiMessage {
    Handshake {
        version: u16,
        id: String,
        client: String,
        #[serde(deserialize_with = "deserialize_capabilities")]
        capabilities: Vec<String>,
    },
    Capabilities {
        version: u16,
        id: String,
        #[serde(deserialize_with = "deserialize_capabilities")]
        capabilities: Vec<String>,
    },
    TerminalSize {
        version: u16,
        id: String,
        columns: u16,
        rows: u16,
    },
    InputEvent {
        version: u16,
        id: String,
        sequence: u64,
        event: UiInputEventKind,
    },
    RenderSnapshot {
        version: u16,
        id: String,
        sequence: u64,
        status: UiStatusSnapshot,
        #[serde(deserialize_with = "deserialize_tasks")]
        tasks: Vec<UiTaskSnapshot>,
        #[serde(deserialize_with = "deserialize_transcript")]
        transcript: Vec<UiTranscriptEntry>,
    },
    Ack {
        version: u16,
        id: String,
        sequence: u64,
    },
    Error {
        version: u16,
        id: String,
        code: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<String>,
    },
    Shutdown {
        version: u16,
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

pub type UiWireMessage = UiMessage;
pub type UiClientMessage = UiMessage;
pub type UiServerMessage = UiMessage;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct UiTextInput {
    text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct UiPasteInput {
    text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StrictUiInputEventKind {
    Key(UiKeyInput),
    Text(UiTextInput),
    Paste(UiPasteInput),
    Submit,
    Cancel,
    Interrupt,
}

impl From<StrictUiInputEventKind> for UiInputEventKind {
    fn from(value: StrictUiInputEventKind) -> Self {
        match value {
            StrictUiInputEventKind::Key(value) => Self::Key(value),
            StrictUiInputEventKind::Text(value) => Self::Text { text: value.text },
            StrictUiInputEventKind::Paste(value) => Self::Paste { text: value.text },
            StrictUiInputEventKind::Submit => Self::Submit,
            StrictUiInputEventKind::Cancel => Self::Cancel,
            StrictUiInputEventKind::Interrupt => Self::Interrupt,
        }
    }
}

impl<'de> Deserialize<'de> for UiInputEventKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        StrictUiInputEventKind::deserialize(deserializer).map(Into::into)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StrictUiMessage {
    Handshake(UiHandshake),
    Capabilities(UiCapabilities),
    TerminalSize(UiTerminalSize),
    InputEvent(UiInputEvent),
    RenderSnapshot(UiRenderSnapshot),
    Ack(UiAck),
    Error(UiError),
    Shutdown(UiShutdown),
}

impl From<StrictUiMessage> for UiMessage {
    fn from(value: StrictUiMessage) -> Self {
        match value {
            StrictUiMessage::Handshake(value) => Self::Handshake {
                version: value.version,
                id: value.id,
                client: value.client,
                capabilities: value.capabilities,
            },
            StrictUiMessage::Capabilities(value) => Self::Capabilities {
                version: value.version,
                id: value.id,
                capabilities: value.capabilities,
            },
            StrictUiMessage::TerminalSize(value) => Self::TerminalSize {
                version: value.version,
                id: value.id,
                columns: value.columns,
                rows: value.rows,
            },
            StrictUiMessage::InputEvent(value) => Self::InputEvent {
                version: value.version,
                id: value.id,
                sequence: value.sequence,
                event: value.event,
            },
            StrictUiMessage::RenderSnapshot(value) => Self::RenderSnapshot {
                version: value.version,
                id: value.id,
                sequence: value.sequence,
                status: value.status,
                tasks: value.tasks,
                transcript: value.transcript,
            },
            StrictUiMessage::Ack(value) => Self::Ack {
                version: value.version,
                id: value.id,
                sequence: value.sequence,
            },
            StrictUiMessage::Error(value) => Self::Error {
                version: value.version,
                id: value.id,
                code: value.code,
                message: value.message,
                details: value.details,
            },
            StrictUiMessage::Shutdown(value) => Self::Shutdown {
                version: value.version,
                id: value.id,
                reason: value.reason,
            },
        }
    }
}

impl<'de> Deserialize<'de> for UiMessage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        StrictUiMessage::deserialize(deserializer).map(Into::into)
    }
}

impl UiMessage {
    pub fn validate(&self) -> Result<(), UiValidationError> {
        match self {
            Self::Handshake {
                version,
                id,
                client,
                capabilities,
            } => {
                validate_version(*version)?;
                validate_id(id)?;
                validate_text(client, UI_MAX_CLIENT_BYTES, "client")?;
                validate_capabilities(capabilities)?;
            }
            Self::Capabilities {
                version,
                id,
                capabilities,
            } => {
                validate_version(*version)?;
                validate_id(id)?;
                validate_capabilities(capabilities)?;
            }
            Self::TerminalSize {
                version,
                id,
                columns,
                rows,
            } => {
                validate_version(*version)?;
                validate_id(id)?;
                if *columns == 0 || *rows == 0 {
                    return Err(UiValidationError::new(
                        "terminal size must have non-zero columns and rows",
                    ));
                }
            }
            Self::InputEvent {
                version, id, event, ..
            } => {
                validate_version(*version)?;
                validate_id(id)?;
                validate_input_event(event)?;
            }
            Self::RenderSnapshot {
                version,
                id,
                status,
                tasks,
                transcript,
                ..
            } => {
                validate_version(*version)?;
                validate_id(id)?;
                validate_status(status)?;
                validate_tasks(tasks)?;
                validate_transcript(transcript)?;
                validate_snapshot_budget(id, status, tasks, transcript)?;
            }
            Self::Ack { version, id, .. } => {
                validate_version(*version)?;
                validate_id(id)?;
            }
            Self::Error {
                version,
                id,
                code,
                message,
                details,
            } => {
                validate_version(*version)?;
                validate_id(id)?;
                validate_text(code, UI_MAX_CODE_BYTES, "error code")?;
                validate_text(message, UI_MAX_MESSAGE_BYTES, "error message")?;
                if let Some(details) = details {
                    validate_text(details, UI_MAX_MESSAGE_BYTES, "error details")?;
                }
            }
            Self::Shutdown {
                version,
                id,
                reason,
            } => {
                validate_version(*version)?;
                validate_id(id)?;
                if let Some(reason) = reason {
                    validate_text(reason, UI_MAX_REASON_BYTES, "shutdown reason")?;
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiValidationError {
    message: String,
}

impl UiValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for UiValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UiValidationError {}

pub fn encode_ui_frame(message: &UiMessage) -> Result<Vec<u8>, ProtocolError> {
    message
        .validate()
        .map_err(|error| ProtocolError::InvalidUiMessage(error.to_string()))?;
    let frame = encode_frame(message)?;
    if frame.len() - 4 > UI_MAX_FRAME_SIZE {
        return Err(ProtocolError::FrameTooLarge {
            size: frame.len() - 4,
            max: UI_MAX_FRAME_SIZE,
        });
    }
    Ok(frame)
}

pub fn decode_ui_frame(frame: &[u8]) -> Result<UiMessage, ProtocolError> {
    if frame.len() >= 4 {
        let payload_size =
            u32::from_be_bytes(frame[..4].try_into().expect("four-byte header")) as usize;
        if payload_size > UI_MAX_FRAME_SIZE {
            return Err(ProtocolError::FrameTooLarge {
                size: payload_size,
                max: UI_MAX_FRAME_SIZE,
            });
        }
    }
    let message: UiMessage = decode_frame(frame)?;
    message
        .validate()
        .map_err(|error| ProtocolError::InvalidUiMessage(error.to_string()))?;
    Ok(message)
}

pub fn encode_message(message: &UiMessage) -> Result<Vec<u8>, ProtocolError> {
    encode_ui_frame(message)
}

pub fn decode_message(frame: &[u8]) -> Result<UiMessage, ProtocolError> {
    decode_ui_frame(frame)
}

fn validate_version(version: u16) -> Result<(), UiValidationError> {
    if version != UI_PROTOCOL_VERSION {
        return Err(UiValidationError::new(format!(
            "unsupported UI protocol version {version}"
        )));
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), UiValidationError> {
    validate_non_empty_text(value, UI_MAX_ID_BYTES, "id")
}

fn validate_capabilities(values: &[String]) -> Result<(), UiValidationError> {
    if values.len() > UI_MAX_CAPABILITIES {
        return Err(UiValidationError::new(format!(
            "capabilities contains {} entries; maximum is {}",
            values.len(),
            UI_MAX_CAPABILITIES
        )));
    }
    for value in values {
        validate_non_empty_text(value, UI_MAX_CAPABILITY_BYTES, "capability")?;
    }
    Ok(())
}

fn validate_input_event(event: &UiInputEventKind) -> Result<(), UiValidationError> {
    match event {
        UiInputEventKind::Key(input) => {
            validate_non_empty_text(&input.key, UI_MAX_INPUT_BYTES, "input key")?;
            if input.modifiers.len() > UI_MAX_INPUT_MODIFIERS {
                return Err(UiValidationError::new(format!(
                    "input modifiers contains {}; maximum is {}",
                    input.modifiers.len(),
                    UI_MAX_INPUT_MODIFIERS
                )));
            }
            for modifier in &input.modifiers {
                validate_non_empty_text(modifier, UI_MAX_INPUT_BYTES, "input modifier")?;
            }
        }
        UiInputEventKind::Text { text } | UiInputEventKind::Paste { text } => {
            validate_text(text, UI_MAX_INPUT_BYTES, "input text")?;
        }
        UiInputEventKind::Submit | UiInputEventKind::Cancel | UiInputEventKind::Interrupt => {}
    }
    Ok(())
}

fn validate_status(status: &UiStatusSnapshot) -> Result<(), UiValidationError> {
    validate_non_empty_text(&status.state, UI_MAX_STATUS_BYTES, "status state")?;
    if let Some(message) = &status.message {
        validate_text(message, UI_MAX_STATUS_BYTES, "status message")?;
    }
    if let Some(detail) = &status.detail {
        validate_text(detail, UI_MAX_STATUS_BYTES, "status detail")?;
    }
    Ok(())
}

fn validate_tasks(tasks: &[UiTaskSnapshot]) -> Result<(), UiValidationError> {
    if tasks.len() > UI_MAX_TASKS {
        return Err(UiValidationError::new(format!(
            "tasks contains {}; maximum is {}",
            tasks.len(),
            UI_MAX_TASKS
        )));
    }
    for task in tasks {
        validate_non_empty_text(&task.id, UI_MAX_TASK_ID_BYTES, "task id")?;
        validate_text(&task.title, UI_MAX_TASK_TITLE_BYTES, "task title")?;
        validate_non_empty_text(&task.status, UI_MAX_STATUS_BYTES, "task status")?;
        if let Some(detail) = &task.detail {
            validate_text(detail, UI_MAX_STATUS_BYTES, "task detail")?;
        }
        if let Some(progress) = task.progress {
            if progress > 100 {
                return Err(UiValidationError::new("task progress must be at most 100"));
            }
        }
    }
    Ok(())
}

fn validate_transcript(entries: &[UiTranscriptEntry]) -> Result<(), UiValidationError> {
    if entries.len() > UI_MAX_TRANSCRIPT_ENTRIES {
        return Err(UiValidationError::new(format!(
            "transcript contains {}; maximum is {}",
            entries.len(),
            UI_MAX_TRANSCRIPT_ENTRIES
        )));
    }
    let mut total_bytes = 0usize;
    for entry in entries {
        validate_non_empty_text(&entry.role, UI_MAX_TRANSCRIPT_ROLE_BYTES, "transcript role")?;
        validate_text(&entry.text, UI_MAX_TRANSCRIPT_TEXT_BYTES, "transcript text")?;
        total_bytes = total_bytes
            .checked_add(entry.text.len())
            .ok_or_else(|| UiValidationError::new("transcript size overflow"))?;
        if total_bytes > UI_MAX_SNAPSHOT_BYTES {
            return Err(UiValidationError::new(format!(
                "transcript exceeds {} bytes",
                UI_MAX_SNAPSHOT_BYTES
            )));
        }
    }
    Ok(())
}

fn validate_snapshot_budget(
    id: &str,
    status: &UiStatusSnapshot,
    tasks: &[UiTaskSnapshot],
    transcript: &[UiTranscriptEntry],
) -> Result<(), UiValidationError> {
    let mut total = 0usize;
    for value in [id, status.state.as_str()] {
        add_snapshot_bytes(&mut total, value)?;
    }
    if let Some(message) = &status.message {
        add_snapshot_bytes(&mut total, message)?;
    }
    if let Some(detail) = &status.detail {
        add_snapshot_bytes(&mut total, detail)?;
    }
    for task in tasks {
        for value in [task.id.as_str(), task.title.as_str(), task.status.as_str()] {
            add_snapshot_bytes(&mut total, value)?;
        }
        if let Some(detail) = &task.detail {
            add_snapshot_bytes(&mut total, detail)?;
        }
    }
    for entry in transcript {
        add_snapshot_bytes(&mut total, &entry.role)?;
        add_snapshot_bytes(&mut total, &entry.text)?;
    }
    if total > UI_MAX_SNAPSHOT_BYTES {
        return Err(UiValidationError::new(format!(
            "snapshot aggregate exceeds {} bytes",
            UI_MAX_SNAPSHOT_BYTES
        )));
    }
    Ok(())
}

fn add_snapshot_bytes(total: &mut usize, value: &str) -> Result<(), UiValidationError> {
    *total = total
        .checked_add(value.len())
        .ok_or_else(|| UiValidationError::new("snapshot size overflow"))?;
    Ok(())
}

fn validate_text(value: &str, max_bytes: usize, field: &str) -> Result<(), UiValidationError> {
    if value.len() > max_bytes {
        return Err(UiValidationError::new(format!(
            "{field} is {} bytes; maximum is {max_bytes}",
            value.len()
        )));
    }
    Ok(())
}

fn validate_non_empty_text(
    value: &str,
    max_bytes: usize,
    field: &str,
) -> Result<(), UiValidationError> {
    if value.is_empty() {
        return Err(UiValidationError::new(format!("{field} must not be empty")));
    }
    validate_text(value, max_bytes, field)
}

fn deserialize_bounded_vec<'de, T, D>(deserializer: D, max: usize) -> Result<Vec<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    struct BoundedVecVisitor<T> {
        max: usize,
        marker: PhantomData<T>,
    }

    impl<'de, T> Visitor<'de> for BoundedVecVisitor<T>
    where
        T: Deserialize<'de>,
    {
        type Value = Vec<T>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(formatter, "an array with at most {} entries", self.max)
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            if let Some(size_hint) = sequence.size_hint() {
                if size_hint > self.max {
                    return Err(serde::de::Error::custom(format!(
                        "array contains at least {size_hint} entries; maximum is {}",
                        self.max
                    )));
                }
            }

            let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(self.max));
            while let Some(value) = sequence.next_element()? {
                if values.len() == self.max {
                    return Err(serde::de::Error::custom(format!(
                        "array contains more than {} entries",
                        self.max
                    )));
                }
                values.push(value);
            }
            Ok(values)
        }
    }

    deserializer.deserialize_seq(BoundedVecVisitor {
        max,
        marker: PhantomData,
    })
}

fn deserialize_capabilities<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec(deserializer, UI_MAX_CAPABILITIES)
}

fn deserialize_modifiers<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec(deserializer, UI_MAX_INPUT_MODIFIERS)
}

fn deserialize_tasks<'de, D>(deserializer: D) -> Result<Vec<UiTaskSnapshot>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec(deserializer, UI_MAX_TASKS)
}

fn deserialize_transcript<'de, D>(deserializer: D) -> Result<Vec<UiTranscriptEntry>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec(deserializer, UI_MAX_TRANSCRIPT_ENTRIES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> UiMessage {
        UiMessage::RenderSnapshot {
            version: UI_PROTOCOL_VERSION,
            id: "render-1".into(),
            sequence: 7,
            status: UiStatusSnapshot {
                state: "running".into(),
                message: Some("working".into()),
                detail: None,
            },
            tasks: vec![UiTaskSnapshot {
                id: "task-1".into(),
                title: "compile".into(),
                status: "running".into(),
                detail: None,
                progress: Some(50),
            }],
            transcript: vec![UiTranscriptEntry {
                sequence: 6,
                role: "assistant".into(),
                text: "hello".into(),
            }],
        }
    }

    #[test]
    fn messagepack_round_trip_preserves_snapshot() {
        let message = snapshot();
        let frame = encode_ui_frame(&message).unwrap();
        assert_eq!(decode_ui_frame(&frame).unwrap(), message);
        assert!(frame.len() <= UI_MAX_FRAME_SIZE + 4);
    }

    #[test]
    fn matches_the_typescript_golden_frames() {
        let golden_frames = [
            "0000005d85a474797065a968616e647368616b65a776657273696f6e01a26964a8636c69656e742d31a6636c69656e74ac6d696e64636f64652d747569ac6361706162696c697469657392af72656e6465725f736e617073686f74a5696e707574",
            "0000005685a474797065ab696e7075745f6576656e74a776657273696f6e01a26964a7696e7075742d31a873657175656e636501a56576656e7483a474797065a36b6579a36b6579a163a96d6f6469666965727391a46374726c",
            "0000006887a474797065af72656e6465725f736e617073686f74a776657273696f6e01a26964a973657373696f6e2d31a873657175656e636501a673746174757382a57374617465a57265616479a76d657373616765a26f6ba57461736b7390aa7472616e73637269707490",
        ];
        for golden in golden_frames {
            let frame = hex(golden);
            let message = decode_ui_frame(&frame).unwrap();
            assert_eq!(encode_ui_frame(&message).unwrap(), frame);
        }
    }

    fn hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let high = (pair[0] as char).to_digit(16).unwrap();
                let low = (pair[1] as char).to_digit(16).unwrap();
                ((high << 4) | low) as u8
            })
            .collect()
    }

    #[test]
    fn handshake_and_control_messages_are_versioned() {
        let messages = [
            UiMessage::Handshake {
                version: UI_PROTOCOL_VERSION,
                id: "hello".into(),
                client: "mindcode".into(),
                capabilities: vec!["render_snapshot".into(), "input".into()],
            },
            UiMessage::Capabilities {
                version: UI_PROTOCOL_VERSION,
                id: "capabilities".into(),
                capabilities: vec!["render_snapshot".into(), "input".into()],
            },
            UiMessage::TerminalSize {
                version: UI_PROTOCOL_VERSION,
                id: "size".into(),
                columns: 120,
                rows: 40,
            },
            UiMessage::InputEvent {
                version: UI_PROTOCOL_VERSION,
                id: "input".into(),
                sequence: 1,
                event: UiInputEventKind::Key(UiKeyInput {
                    key: "c".into(),
                    modifiers: vec!["ctrl".into()],
                }),
            },
            UiMessage::Ack {
                version: UI_PROTOCOL_VERSION,
                id: "ack".into(),
                sequence: 1,
            },
            UiMessage::Error {
                version: UI_PROTOCOL_VERSION,
                id: "error".into(),
                code: "bad_input".into(),
                message: "invalid input".into(),
                details: None,
            },
            UiMessage::Shutdown {
                version: UI_PROTOCOL_VERSION,
                id: "shutdown".into(),
                reason: Some("done".into()),
            },
        ];

        for message in messages {
            assert_eq!(
                decode_ui_frame(&encode_ui_frame(&message).unwrap()).unwrap(),
                message
            );
        }
    }

    #[test]
    fn rejects_unknown_fields() {
        let value = serde_json::json!({
            "type": "handshake",
            "version": UI_PROTOCOL_VERSION,
            "id": "hello",
            "client": "mindcode",
            "capabilities": [],
            "unexpected": true
        });
        let frame = encode_frame(&value).unwrap();
        assert!(matches!(
            decode_ui_frame(&frame),
            Err(ProtocolError::Decode(_))
        ));
    }

    #[test]
    fn rejects_count_and_text_limits_on_encode_and_decode() {
        let too_many_tasks = UiMessage::RenderSnapshot {
            version: UI_PROTOCOL_VERSION,
            id: "render".into(),
            sequence: 1,
            status: UiStatusSnapshot {
                state: "ready".into(),
                message: None,
                detail: None,
            },
            tasks: (0..=UI_MAX_TASKS)
                .map(|index| UiTaskSnapshot {
                    id: format!("task-{index}"),
                    title: "task".into(),
                    status: "pending".into(),
                    detail: None,
                    progress: None,
                })
                .collect(),
            transcript: vec![],
        };
        assert!(matches!(
            encode_ui_frame(&too_many_tasks),
            Err(ProtocolError::InvalidUiMessage(_))
        ));

        let too_long = UiMessage::InputEvent {
            version: UI_PROTOCOL_VERSION,
            id: "input".into(),
            sequence: 1,
            event: UiInputEventKind::Text {
                text: "x".repeat(UI_MAX_INPUT_BYTES + 1),
            },
        };
        assert!(matches!(
            encode_ui_frame(&too_long),
            Err(ProtocolError::InvalidUiMessage(_))
        ));

        let bypass_validation = encode_frame(&too_many_tasks).unwrap();
        assert!(matches!(
            decode_ui_frame(&bypass_validation),
            Err(ProtocolError::Decode(_)) | Err(ProtocolError::InvalidUiMessage(_))
        ));
    }

    #[test]
    fn rejects_aggregate_snapshot_budget() {
        let oversized = UiMessage::RenderSnapshot {
            version: UI_PROTOCOL_VERSION,
            id: "render".into(),
            sequence: 1,
            status: UiStatusSnapshot {
                state: "ready".into(),
                message: None,
                detail: None,
            },
            tasks: (0..UI_MAX_TASKS)
                .map(|index| UiTaskSnapshot {
                    id: format!("task-{index}"),
                    title: "x".repeat(UI_MAX_TASK_TITLE_BYTES),
                    status: "pending".into(),
                    detail: None,
                    progress: None,
                })
                .collect(),
            transcript: vec![],
        };
        assert!(matches!(
            encode_ui_frame(&oversized),
            Err(ProtocolError::InvalidUiMessage(message))
                if message.contains("snapshot aggregate")
        ));
    }

    #[test]
    fn rejects_wrong_version_and_invalid_terminal_size() {
        let wrong_version = UiMessage::Ack {
            version: UI_PROTOCOL_VERSION + 1,
            id: "ack".into(),
            sequence: 1,
        };
        assert!(wrong_version.validate().is_err());

        let invalid_size = UiMessage::TerminalSize {
            version: UI_PROTOCOL_VERSION,
            id: "size".into(),
            columns: 0,
            rows: 40,
        };
        assert!(invalid_size.validate().is_err());
    }
}
