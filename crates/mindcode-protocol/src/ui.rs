//! Bounded MessagePack protocol for the native UI boundary.
//!
//! UI protocol v2 exposes a typed render snapshot to native clients while the
//! daemon remains the authoritative state owner.  Wire input is strictly
//! deserialized and all bounded values are validated again before encoding.

use serde::de::{SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::marker::PhantomData;

use crate::{decode_frame, encode_frame, ProtocolError};

pub const UI_PROTOCOL_VERSION: u16 = 2;
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
pub const UI_MAX_SESSIONS: usize = 256;
pub const UI_MAX_SESSION_NAME_BYTES: usize = 256;
pub const UI_MAX_WORKSPACES: usize = 128;
pub const UI_MAX_WORKSPACE_BYTES: usize = 1_024;
pub const UI_MAX_MODEL_BYTES: usize = 128;
pub const UI_MAX_EFFORT_BYTES: usize = 16;
pub const UI_MAX_CONNECTION_BYTES: usize = 64;
pub const UI_MAX_AGENTS: usize = 256;
pub const UI_MAX_AGENT_ID_BYTES: usize = 256;
pub const UI_MAX_AGENT_NAME_BYTES: usize = 256;
pub const UI_MAX_DEPENDENCIES: usize = 128;
pub const UI_MAX_FILES: usize = 4_096;
pub const UI_MAX_FILE_PATH_BYTES: usize = 2_048;
pub const UI_MAX_TRANSCRIPT_BLOCKS: usize = 8_192;
pub const UI_MAX_TRANSCRIPT_ID_BYTES: usize = 256;
pub const UI_MAX_LANGUAGE_BYTES: usize = 64;
pub const UI_MAX_TOOL_NAME_BYTES: usize = 128;
pub const UI_MAX_TOOL_ARGUMENTS_BYTES: usize = 64 * 1024;
pub const UI_MAX_TOOL_OUTPUT_BYTES: usize = 64 * 1024;
pub const UI_MAX_REPORT_EVIDENCE: usize = 256;
pub const UI_MAX_REPORT_EVIDENCE_BYTES: usize = 2_048;
pub const UI_MAX_DIFF_BYTES: usize = 256 * 1024;
pub const UI_MAX_ACTIVITY: usize = 4_096;
pub const UI_MAX_ACTIVITY_ID_BYTES: usize = 256;
pub const UI_MAX_ACTIVITY_MESSAGE_BYTES: usize = 4 * 1024;
pub const UI_MAX_PERMISSIONS: usize = 256;
pub const UI_MAX_PERMISSION_ID_BYTES: usize = 256;
pub const UI_MAX_PERMISSION_TEXT_BYTES: usize = 4 * 1024;
pub const UI_MAX_WRITERS: usize = 64;
pub const UI_MAX_PROVIDERS: usize = 64;
pub const UI_MAX_PROVIDER_ID_BYTES: usize = 128;
pub const UI_MAX_PROVIDER_NAME_BYTES: usize = 256;
pub const UI_MAX_PROVIDER_URL_BYTES: usize = 2_048;
pub const UI_MAX_ACTION_BYTES: usize = 128;
pub const UI_MAX_ACTION_VALUE_BYTES: usize = 64 * 1024;

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
#[serde(rename_all = "snake_case")]
pub enum UiMouseButton {
    None,
    Left,
    Middle,
    Right,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiMouseEventKind {
    Move,
    Down,
    Up,
    Drag,
    ScrollUp,
    ScrollDown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiMouseInput {
    pub x: u16,
    pub y: u16,
    pub button: UiMouseButton,
    pub kind: UiMouseEventKind,
    #[serde(deserialize_with = "deserialize_modifiers")]
    pub modifiers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiActionInput {
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiInputEventKind {
    Key(UiKeyInput),
    Text { text: String },
    Paste { text: String },
    Mouse(UiMouseInput),
    Action(UiActionInput),
    Submit,
    Cancel,
    Interrupt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiKeyInput {
    pub key: String,
    #[serde(deserialize_with = "deserialize_modifiers")]
    pub modifiers: Vec<String>,
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
pub struct UiConnectionSnapshot {
    pub state: String,
    pub reconnect_attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiTelemetrySnapshot {
    pub connection: UiConnectionSnapshot,
    pub model: String,
    pub effort: String,
    pub context_used_tokens: u64,
    pub context_limit_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Token usage of the most recent request, for per-turn counters (§10.3).
    #[serde(default)]
    pub last_input_tokens: u64,
    #[serde(default)]
    pub last_output_tokens: u64,
    /// Estimated USD cost of the most recent request (§10.3).
    #[serde(default)]
    pub last_cost: f64,
    pub cached_tokens: u64,
    pub reasoning_tokens: u64,
    pub credits: f64,
    pub active_agents: u16,
    pub queued_tasks: u16,
    pub api_requests: u64,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiWorkspaceSnapshot {
    pub id: String,
    pub name: String,
    pub path: String,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiSessionSnapshot {
    pub id: String,
    pub name: String,
    pub workspace: String,
    pub status: String,
    pub model: String,
    pub effort: String,
    pub active: bool,
    pub pinned: bool,
    pub unread: u32,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiTaskMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_dependencies",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub dependencies: Vec<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_dependencies",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub blocked_by: Vec<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_files",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub files_touched: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolation: Option<String>,
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
    pub metadata: UiTaskMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiAgentSnapshot {
    pub id: String,
    pub name: String,
    pub role: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub model: String,
    pub effort: String,
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
pub struct UiMarkdownBlock {
    pub id: String,
    pub sequence: u64,
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<u64>,
    /// True while this assistant turn is still being streamed (§10.2);
    /// the renderer shows the in-progress text with a shimmer and cursor.
    #[serde(default)]
    pub streaming: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiCodeBlock {
    pub id: String,
    pub sequence: u64,
    pub role: String,
    pub language: String,
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiToolBlock {
    pub id: String,
    pub sequence: u64,
    pub name: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiThinkingBlock {
    pub id: String,
    pub sequence: u64,
    pub summary: String,
    pub effort: String,
    pub elapsed_ms: u64,
    pub tokens_used: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiReportBlock {
    pub id: String,
    pub sequence: u64,
    pub task_id: String,
    pub status: String,
    pub summary: String,
    #[serde(
        default,
        deserialize_with = "deserialize_report_files",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub changed_files: Vec<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_report_evidence",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub evidence: Vec<String>,
    pub tokens_used: u64,
    pub effort_used: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiErrorBlock {
    pub id: String,
    pub sequence: u64,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub recoverable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiTranscriptBlock {
    Markdown(UiMarkdownBlock),
    Code(UiCodeBlock),
    Tool(UiToolBlock),
    Thinking(UiThinkingBlock),
    Report(UiReportBlock),
    Error(UiErrorBlock),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StrictUiTranscriptBlock {
    Markdown(UiMarkdownBlock),
    Code(UiCodeBlock),
    Tool(UiToolBlock),
    Thinking(UiThinkingBlock),
    Report(UiReportBlock),
    Error(UiErrorBlock),
}

impl From<StrictUiTranscriptBlock> for UiTranscriptBlock {
    fn from(value: StrictUiTranscriptBlock) -> Self {
        match value {
            StrictUiTranscriptBlock::Markdown(value) => Self::Markdown(value),
            StrictUiTranscriptBlock::Code(value) => Self::Code(value),
            StrictUiTranscriptBlock::Tool(value) => Self::Tool(value),
            StrictUiTranscriptBlock::Thinking(value) => Self::Thinking(value),
            StrictUiTranscriptBlock::Report(value) => Self::Report(value),
            StrictUiTranscriptBlock::Error(value) => Self::Error(value),
        }
    }
}

impl<'de> Deserialize<'de> for UiTranscriptBlock {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        StrictUiTranscriptBlock::deserialize(deserializer).map(Into::into)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiTranscriptWindow {
    pub start_sequence: u64,
    pub end_sequence: u64,
    pub has_older: bool,
    pub has_newer: bool,
    #[serde(deserialize_with = "deserialize_transcript")]
    pub blocks: Vec<UiTranscriptBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiChangeSnapshot {
    pub path: String,
    pub kind: String,
    pub additions: u64,
    pub deletions: u64,
    pub staged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiActivitySnapshot {
    pub id: String,
    pub timestamp_ms: u64,
    pub kind: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub severity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiPermissionRequest {
    pub id: String,
    pub tool: String,
    pub action: String,
    pub resource: String,
    pub reason: String,
    pub status: String,
    pub requested_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// One provider profile, projected secret-free for the setup screen.  Only
/// the credential *reference* (`env:<NAME>` or `store`) is carried; a
/// credential value never enters a snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiProviderSnapshot {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    #[serde(default)]
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
    /// Whether the profile's credential currently resolves (env → store →
    /// fail-closed).  Only a bool; the value never enters a snapshot.
    #[serde(default)]
    pub configured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiWriterState {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writer_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_expires_at_ms: Option<u64>,
    #[serde(
        default,
        deserialize_with = "deserialize_writers",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub observers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiRenderSnapshot {
    pub version: u16,
    pub id: String,
    pub sequence: u64,
    #[serde(deserialize_with = "deserialize_sessions")]
    pub sessions: Vec<UiSessionSnapshot>,
    #[serde(deserialize_with = "deserialize_workspaces")]
    pub workspaces: Vec<UiWorkspaceSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_session_id: Option<String>,
    pub status: UiStatusSnapshot,
    pub telemetry: UiTelemetrySnapshot,
    #[serde(deserialize_with = "deserialize_tasks")]
    pub tasks: Vec<UiTaskSnapshot>,
    #[serde(deserialize_with = "deserialize_agents")]
    pub agents: Vec<UiAgentSnapshot>,
    #[serde(deserialize_with = "deserialize_transcript")]
    pub transcript: Vec<UiTranscriptBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_window: Option<UiTranscriptWindow>,
    #[serde(deserialize_with = "deserialize_changes")]
    pub changes: Vec<UiChangeSnapshot>,
    #[serde(deserialize_with = "deserialize_activity")]
    pub activity: Vec<UiActivitySnapshot>,
    #[serde(deserialize_with = "deserialize_permissions")]
    pub permissions: Vec<UiPermissionRequest>,
    #[serde(
        default,
        deserialize_with = "deserialize_providers",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub providers: Vec<UiProviderSnapshot>,
    pub writer: UiWriterState,
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

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize)]
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
        #[serde(deserialize_with = "deserialize_sessions")]
        sessions: Vec<UiSessionSnapshot>,
        #[serde(deserialize_with = "deserialize_workspaces")]
        workspaces: Vec<UiWorkspaceSnapshot>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        status: UiStatusSnapshot,
        telemetry: UiTelemetrySnapshot,
        #[serde(deserialize_with = "deserialize_tasks")]
        tasks: Vec<UiTaskSnapshot>,
        #[serde(deserialize_with = "deserialize_agents")]
        agents: Vec<UiAgentSnapshot>,
        #[serde(deserialize_with = "deserialize_transcript")]
        transcript: Vec<UiTranscriptBlock>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transcript_window: Option<UiTranscriptWindow>,
        #[serde(deserialize_with = "deserialize_changes")]
        changes: Vec<UiChangeSnapshot>,
        #[serde(deserialize_with = "deserialize_activity")]
        activity: Vec<UiActivitySnapshot>,
        #[serde(deserialize_with = "deserialize_permissions")]
        permissions: Vec<UiPermissionRequest>,
        #[serde(
            default,
            deserialize_with = "deserialize_providers",
            skip_serializing_if = "Vec::is_empty"
        )]
        providers: Vec<UiProviderSnapshot>,
        writer: UiWriterState,
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
    Mouse(UiMouseInput),
    Action(UiActionInput),
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
            StrictUiInputEventKind::Mouse(value) => Self::Mouse(value),
            StrictUiInputEventKind::Action(value) => Self::Action(value),
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

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Deserialize)]
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
                sessions: value.sessions,
                workspaces: value.workspaces,
                active_session_id: value.active_session_id,
                status: value.status,
                telemetry: value.telemetry,
                tasks: value.tasks,
                agents: value.agents,
                transcript: value.transcript,
                transcript_window: value.transcript_window,
                changes: value.changes,
                activity: value.activity,
                permissions: value.permissions,
                providers: value.providers,
                writer: value.writer,
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
                sequence: _,
                sessions,
                workspaces,
                active_session_id,
                status,
                telemetry,
                tasks,
                agents,
                transcript,
                transcript_window,
                changes,
                activity,
                permissions,
                providers,
                writer,
            } => {
                validate_render_snapshot(
                    *version,
                    id,
                    sessions,
                    workspaces,
                    active_session_id.as_deref(),
                    status,
                    telemetry,
                    tasks,
                    agents,
                    transcript,
                    transcript_window.as_ref(),
                    changes,
                    activity,
                    permissions,
                    providers,
                    writer,
                )?;
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

impl UiRenderSnapshot {
    pub fn validate(&self) -> Result<(), UiValidationError> {
        validate_render_snapshot(
            self.version,
            &self.id,
            &self.sessions,
            &self.workspaces,
            self.active_session_id.as_deref(),
            &self.status,
            &self.telemetry,
            &self.tasks,
            &self.agents,
            &self.transcript,
            self.transcript_window.as_ref(),
            &self.changes,
            &self.activity,
            &self.permissions,
            &self.providers,
            &self.writer,
        )
    }
}

pub fn encode_ui_frame(message: &UiMessage) -> Result<Vec<u8>, ProtocolError> {
    message
        .validate()
        .map_err(|e| ProtocolError::InvalidUiMessage(e.to_string()))?;
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
        .map_err(|e| ProtocolError::InvalidUiMessage(e.to_string()))?;
    Ok(message)
}

pub fn encode_message(message: &UiMessage) -> Result<Vec<u8>, ProtocolError> {
    encode_ui_frame(message)
}
pub fn decode_message(frame: &[u8]) -> Result<UiMessage, ProtocolError> {
    decode_ui_frame(frame)
}

#[allow(clippy::too_many_arguments)]
fn validate_render_snapshot(
    version: u16,
    id: &str,
    sessions: &[UiSessionSnapshot],
    workspaces: &[UiWorkspaceSnapshot],
    active_session_id: Option<&str>,
    status: &UiStatusSnapshot,
    telemetry: &UiTelemetrySnapshot,
    tasks: &[UiTaskSnapshot],
    agents: &[UiAgentSnapshot],
    transcript: &[UiTranscriptBlock],
    transcript_window: Option<&UiTranscriptWindow>,
    changes: &[UiChangeSnapshot],
    activity: &[UiActivitySnapshot],
    permissions: &[UiPermissionRequest],
    providers: &[UiProviderSnapshot],
    writer: &UiWriterState,
) -> Result<(), UiValidationError> {
    validate_version(version)?;
    validate_id(id)?;
    validate_sessions(sessions)?;
    validate_workspaces(workspaces)?;
    if let Some(value) = active_session_id {
        validate_id(value)?;
    }
    validate_status(status)?;
    validate_telemetry(telemetry)?;
    validate_tasks(tasks)?;
    validate_agents(agents)?;
    validate_transcript(transcript)?;
    if let Some(value) = transcript_window {
        validate_transcript_window(value)?;
    }
    validate_changes(changes)?;
    validate_activity(activity)?;
    validate_permissions(permissions)?;
    validate_providers(providers)?;
    validate_writer(writer)?;
    validate_snapshot_budget(
        id,
        sessions,
        workspaces,
        active_session_id,
        status,
        telemetry,
        tasks,
        agents,
        transcript,
        transcript_window,
        changes,
        activity,
        permissions,
        providers,
        writer,
    )
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
fn validate_count(count: usize, max: usize, field: &str) -> Result<(), UiValidationError> {
    if count > max {
        Err(UiValidationError::new(format!(
            "{field} contains {count}; maximum is {max}"
        )))
    } else {
        Ok(())
    }
}
fn validate_text(value: &str, max: usize, field: &str) -> Result<(), UiValidationError> {
    if value.len() > max {
        Err(UiValidationError::new(format!(
            "{field} is {} bytes; maximum is {max}",
            value.len()
        )))
    } else {
        Ok(())
    }
}
fn validate_non_empty_text(value: &str, max: usize, field: &str) -> Result<(), UiValidationError> {
    if value.is_empty() {
        return Err(UiValidationError::new(format!("{field} must not be empty")));
    }
    validate_text(value, max, field)
}
fn validate_string_list(
    values: &[String],
    max_count: usize,
    max_bytes: usize,
    field: &str,
) -> Result<(), UiValidationError> {
    validate_count(values.len(), max_count, field)?;
    for value in values {
        validate_non_empty_text(value, max_bytes, field)?;
    }
    Ok(())
}
fn validate_capabilities(values: &[String]) -> Result<(), UiValidationError> {
    validate_string_list(
        values,
        UI_MAX_CAPABILITIES,
        UI_MAX_CAPABILITY_BYTES,
        "capability",
    )
}
fn validate_modifiers(values: &[String]) -> Result<(), UiValidationError> {
    validate_string_list(
        values,
        UI_MAX_INPUT_MODIFIERS,
        UI_MAX_INPUT_BYTES,
        "input modifier",
    )
}

fn validate_input_event(event: &UiInputEventKind) -> Result<(), UiValidationError> {
    match event {
        UiInputEventKind::Key(value) => {
            validate_non_empty_text(&value.key, UI_MAX_INPUT_BYTES, "input key")?;
            validate_modifiers(&value.modifiers)?;
        }
        UiInputEventKind::Text { text } | UiInputEventKind::Paste { text } => {
            validate_text(text, UI_MAX_INPUT_BYTES, "input text")?
        }
        UiInputEventKind::Mouse(value) => validate_modifiers(&value.modifiers)?,
        UiInputEventKind::Action(value) => {
            validate_non_empty_text(&value.action, UI_MAX_ACTION_BYTES, "input action")?;
            if let Some(target) = &value.target {
                validate_text(target, UI_MAX_ACTION_BYTES, "input action target")?;
            }
            if let Some(data) = &value.value {
                validate_text(data, UI_MAX_ACTION_VALUE_BYTES, "input action value")?;
            }
        }
        UiInputEventKind::Submit | UiInputEventKind::Cancel | UiInputEventKind::Interrupt => {}
    }
    Ok(())
}

fn validate_sessions(values: &[UiSessionSnapshot]) -> Result<(), UiValidationError> {
    validate_count(values.len(), UI_MAX_SESSIONS, "sessions")?;
    for value in values {
        validate_id(&value.id)?;
        validate_non_empty_text(&value.name, UI_MAX_SESSION_NAME_BYTES, "session name")?;
        validate_non_empty_text(
            &value.workspace,
            UI_MAX_WORKSPACE_BYTES,
            "session workspace",
        )?;
        validate_non_empty_text(&value.status, UI_MAX_STATUS_BYTES, "session status")?;
        validate_non_empty_text(&value.model, UI_MAX_MODEL_BYTES, "session model")?;
        validate_non_empty_text(&value.effort, UI_MAX_EFFORT_BYTES, "session effort")?;
    }
    Ok(())
}
fn validate_workspaces(values: &[UiWorkspaceSnapshot]) -> Result<(), UiValidationError> {
    validate_count(values.len(), UI_MAX_WORKSPACES, "workspaces")?;
    for value in values {
        validate_id(&value.id)?;
        validate_non_empty_text(&value.name, UI_MAX_SESSION_NAME_BYTES, "workspace name")?;
        validate_non_empty_text(&value.path, UI_MAX_WORKSPACE_BYTES, "workspace path")?;
    }
    Ok(())
}
fn validate_status(value: &UiStatusSnapshot) -> Result<(), UiValidationError> {
    validate_non_empty_text(&value.state, UI_MAX_STATUS_BYTES, "status state")?;
    if let Some(text) = &value.message {
        validate_text(text, UI_MAX_STATUS_BYTES, "status message")?;
    }
    if let Some(text) = &value.detail {
        validate_text(text, UI_MAX_STATUS_BYTES, "status detail")?;
    }
    Ok(())
}
fn validate_telemetry(value: &UiTelemetrySnapshot) -> Result<(), UiValidationError> {
    validate_non_empty_text(
        &value.connection.state,
        UI_MAX_CONNECTION_BYTES,
        "connection state",
    )?;
    if let Some(text) = &value.connection.last_error {
        validate_text(text, UI_MAX_MESSAGE_BYTES, "connection error")?;
    }
    validate_non_empty_text(&value.model, UI_MAX_MODEL_BYTES, "telemetry model")?;
    validate_non_empty_text(&value.effort, UI_MAX_EFFORT_BYTES, "telemetry effort")?;
    if value.context_limit_tokens == 0 {
        return Err(UiValidationError::new(
            "telemetry context limit must be non-zero",
        ));
    }
    if value.context_used_tokens > value.context_limit_tokens {
        return Err(UiValidationError::new(
            "telemetry context usage exceeds context limit",
        ));
    }
    if !value.credits.is_finite() || value.credits < 0.0 {
        return Err(UiValidationError::new(
            "telemetry credits must be finite and non-negative",
        ));
    }
    Ok(())
}
fn validate_tasks(values: &[UiTaskSnapshot]) -> Result<(), UiValidationError> {
    validate_count(values.len(), UI_MAX_TASKS, "tasks")?;
    for value in values {
        validate_non_empty_text(&value.id, UI_MAX_TASK_ID_BYTES, "task id")?;
        validate_text(&value.title, UI_MAX_TASK_TITLE_BYTES, "task title")?;
        validate_non_empty_text(&value.status, UI_MAX_STATUS_BYTES, "task status")?;
        if let Some(text) = &value.detail {
            validate_text(text, UI_MAX_STATUS_BYTES, "task detail")?;
        }
        if value.progress.is_some_and(|progress| progress > 100) {
            return Err(UiValidationError::new("task progress must be at most 100"));
        }
        validate_task_metadata(&value.metadata)?;
    }
    Ok(())
}
fn validate_task_metadata(value: &UiTaskMetadata) -> Result<(), UiValidationError> {
    if let Some(text) = &value.parent_id {
        validate_non_empty_text(text, UI_MAX_TASK_ID_BYTES, "task parent id")?;
    }
    if let Some(text) = &value.owner {
        validate_non_empty_text(text, UI_MAX_AGENT_NAME_BYTES, "task owner")?;
    }
    if let Some(text) = &value.agent_id {
        validate_non_empty_text(text, UI_MAX_AGENT_ID_BYTES, "task agent id")?;
    }
    if let Some(text) = &value.model {
        validate_non_empty_text(text, UI_MAX_MODEL_BYTES, "task model")?;
    }
    if let Some(text) = &value.effort {
        validate_non_empty_text(text, UI_MAX_EFFORT_BYTES, "task effort")?;
    }
    validate_string_list(
        &value.dependencies,
        UI_MAX_DEPENDENCIES,
        UI_MAX_TASK_ID_BYTES,
        "task dependency",
    )?;
    validate_string_list(
        &value.blocked_by,
        UI_MAX_DEPENDENCIES,
        UI_MAX_TASK_ID_BYTES,
        "task blocker",
    )?;
    validate_string_list(
        &value.files_touched,
        UI_MAX_FILES,
        UI_MAX_FILE_PATH_BYTES,
        "task file",
    )?;
    if let Some(text) = &value.isolation {
        validate_non_empty_text(text, UI_MAX_CONNECTION_BYTES, "task isolation")?;
    }
    Ok(())
}
fn validate_agents(values: &[UiAgentSnapshot]) -> Result<(), UiValidationError> {
    validate_count(values.len(), UI_MAX_AGENTS, "agents")?;
    for value in values {
        validate_non_empty_text(&value.id, UI_MAX_AGENT_ID_BYTES, "agent id")?;
        validate_non_empty_text(&value.name, UI_MAX_AGENT_NAME_BYTES, "agent name")?;
        validate_non_empty_text(&value.role, UI_MAX_AGENT_NAME_BYTES, "agent role")?;
        validate_non_empty_text(&value.status, UI_MAX_STATUS_BYTES, "agent status")?;
        if let Some(text) = &value.parent_id {
            validate_non_empty_text(text, UI_MAX_AGENT_ID_BYTES, "agent parent id")?;
        }
        if let Some(text) = &value.task_id {
            validate_non_empty_text(text, UI_MAX_TASK_ID_BYTES, "agent task id")?;
        }
        validate_non_empty_text(&value.model, UI_MAX_MODEL_BYTES, "agent model")?;
        validate_non_empty_text(&value.effort, UI_MAX_EFFORT_BYTES, "agent effort")?;
        if value.progress.is_some_and(|progress| progress > 100) {
            return Err(UiValidationError::new("agent progress must be at most 100"));
        }
    }
    Ok(())
}

fn validate_transcript(values: &[UiTranscriptBlock]) -> Result<(), UiValidationError> {
    validate_count(values.len(), UI_MAX_TRANSCRIPT_BLOCKS, "transcript")?;
    for value in values {
        validate_transcript_block(value)?;
    }
    Ok(())
}
fn validate_transcript_block(value: &UiTranscriptBlock) -> Result<(), UiValidationError> {
    match value {
        UiTranscriptBlock::Markdown(value) => {
            validate_block_identity(&value.id, &value.role)?;
            validate_text(&value.text, UI_MAX_TRANSCRIPT_TEXT_BYTES, "markdown text")?;
        }
        UiTranscriptBlock::Code(value) => {
            validate_block_identity(&value.id, &value.role)?;
            validate_non_empty_text(&value.language, UI_MAX_LANGUAGE_BYTES, "code language")?;
            validate_text(&value.code, UI_MAX_CODE_BYTES * 4_096, "code block")?;
            if let Some(text) = &value.file_path {
                validate_text(text, UI_MAX_FILE_PATH_BYTES, "code file path")?;
            }
            if let (Some(start), Some(end)) = (value.start_line, value.end_line) {
                if start > end {
                    return Err(UiValidationError::new(
                        "code block start line must not exceed end line",
                    ));
                }
            }
        }
        UiTranscriptBlock::Tool(value) => {
            validate_non_empty_text(&value.id, UI_MAX_TRANSCRIPT_ID_BYTES, "tool block id")?;
            validate_non_empty_text(&value.name, UI_MAX_TOOL_NAME_BYTES, "tool name")?;
            validate_non_empty_text(&value.status, UI_MAX_STATUS_BYTES, "tool status")?;
            if let Some(text) = &value.input {
                validate_text(text, UI_MAX_TOOL_ARGUMENTS_BYTES, "tool input")?;
            }
            if let Some(text) = &value.output {
                validate_text(text, UI_MAX_TOOL_OUTPUT_BYTES, "tool output")?;
            }
        }
        UiTranscriptBlock::Thinking(value) => {
            validate_non_empty_text(&value.id, UI_MAX_TRANSCRIPT_ID_BYTES, "thinking block id")?;
            validate_text(
                &value.summary,
                UI_MAX_TRANSCRIPT_TEXT_BYTES,
                "thinking summary",
            )?;
            validate_non_empty_text(&value.effort, UI_MAX_EFFORT_BYTES, "thinking effort")?;
        }
        UiTranscriptBlock::Report(value) => {
            validate_non_empty_text(&value.id, UI_MAX_TRANSCRIPT_ID_BYTES, "report block id")?;
            validate_non_empty_text(&value.task_id, UI_MAX_TASK_ID_BYTES, "report task id")?;
            validate_non_empty_text(&value.status, UI_MAX_STATUS_BYTES, "report status")?;
            validate_text(
                &value.summary,
                UI_MAX_TRANSCRIPT_TEXT_BYTES,
                "report summary",
            )?;
            validate_string_list(
                &value.changed_files,
                UI_MAX_FILES,
                UI_MAX_FILE_PATH_BYTES,
                "report file",
            )?;
            validate_string_list(
                &value.evidence,
                UI_MAX_REPORT_EVIDENCE,
                UI_MAX_REPORT_EVIDENCE_BYTES,
                "report evidence",
            )?;
            validate_non_empty_text(&value.effort_used, UI_MAX_EFFORT_BYTES, "report effort")?;
        }
        UiTranscriptBlock::Error(value) => {
            validate_non_empty_text(&value.id, UI_MAX_TRANSCRIPT_ID_BYTES, "error block id")?;
            validate_non_empty_text(&value.code, UI_MAX_CODE_BYTES, "block error code")?;
            validate_text(&value.message, UI_MAX_MESSAGE_BYTES, "block error message")?;
            if let Some(text) = &value.detail {
                validate_text(text, UI_MAX_MESSAGE_BYTES, "block error detail")?;
            }
        }
    }
    Ok(())
}
fn validate_block_identity(id: &str, role: &str) -> Result<(), UiValidationError> {
    validate_non_empty_text(id, UI_MAX_TRANSCRIPT_ID_BYTES, "transcript block id")?;
    validate_non_empty_text(role, UI_MAX_TRANSCRIPT_ROLE_BYTES, "transcript role")
}
fn validate_transcript_window(value: &UiTranscriptWindow) -> Result<(), UiValidationError> {
    if value.start_sequence > value.end_sequence {
        return Err(UiValidationError::new(
            "transcript window start sequence must not exceed end sequence",
        ));
    }
    validate_transcript(&value.blocks)
}
fn validate_changes(values: &[UiChangeSnapshot]) -> Result<(), UiValidationError> {
    validate_count(values.len(), UI_MAX_FILES, "changes")?;
    for value in values {
        validate_non_empty_text(&value.path, UI_MAX_FILE_PATH_BYTES, "change path")?;
        validate_non_empty_text(&value.kind, UI_MAX_CONNECTION_BYTES, "change kind")?;
        if let Some(text) = &value.language {
            validate_text(text, UI_MAX_LANGUAGE_BYTES, "change language")?;
        }
        if let Some(text) = &value.diff {
            validate_text(text, UI_MAX_DIFF_BYTES, "change diff")?;
        }
    }
    Ok(())
}
fn validate_activity(values: &[UiActivitySnapshot]) -> Result<(), UiValidationError> {
    validate_count(values.len(), UI_MAX_ACTIVITY, "activity")?;
    for value in values {
        validate_non_empty_text(&value.id, UI_MAX_ACTIVITY_ID_BYTES, "activity id")?;
        validate_non_empty_text(&value.kind, UI_MAX_CONNECTION_BYTES, "activity kind")?;
        validate_text(
            &value.message,
            UI_MAX_ACTIVITY_MESSAGE_BYTES,
            "activity message",
        )?;
        if let Some(text) = &value.task_id {
            validate_non_empty_text(text, UI_MAX_TASK_ID_BYTES, "activity task id")?;
        }
        if let Some(text) = &value.agent_id {
            validate_non_empty_text(text, UI_MAX_AGENT_ID_BYTES, "activity agent id")?;
        }
        validate_non_empty_text(
            &value.severity,
            UI_MAX_CONNECTION_BYTES,
            "activity severity",
        )?;
    }
    Ok(())
}
fn validate_permissions(values: &[UiPermissionRequest]) -> Result<(), UiValidationError> {
    validate_count(values.len(), UI_MAX_PERMISSIONS, "permissions")?;
    for value in values {
        validate_non_empty_text(&value.id, UI_MAX_PERMISSION_ID_BYTES, "permission id")?;
        validate_non_empty_text(&value.tool, UI_MAX_TOOL_NAME_BYTES, "permission tool")?;
        validate_non_empty_text(
            &value.action,
            UI_MAX_PERMISSION_TEXT_BYTES,
            "permission action",
        )?;
        validate_text(
            &value.resource,
            UI_MAX_PERMISSION_TEXT_BYTES,
            "permission resource",
        )?;
        validate_text(
            &value.reason,
            UI_MAX_PERMISSION_TEXT_BYTES,
            "permission reason",
        )?;
        validate_non_empty_text(&value.status, UI_MAX_CONNECTION_BYTES, "permission status")?;
        if let Some(text) = &value.task_id {
            validate_non_empty_text(text, UI_MAX_TASK_ID_BYTES, "permission task id")?;
        }
        if let Some(text) = &value.agent_id {
            validate_non_empty_text(text, UI_MAX_AGENT_ID_BYTES, "permission agent id")?;
        }
    }
    Ok(())
}
fn validate_providers(values: &[UiProviderSnapshot]) -> Result<(), UiValidationError> {
    validate_count(values.len(), UI_MAX_PROVIDERS, "providers")?;
    for value in values {
        validate_non_empty_text(&value.id, UI_MAX_PROVIDER_ID_BYTES, "provider id")?;
        validate_non_empty_text(&value.name, UI_MAX_PROVIDER_NAME_BYTES, "provider name")?;
        validate_non_empty_text(&value.protocol, UI_MAX_CODE_BYTES, "provider protocol")?;
        validate_non_empty_text(
            &value.base_url,
            UI_MAX_PROVIDER_URL_BYTES,
            "provider base url",
        )?;
        if let Some(reference) = &value.credential {
            validate_non_empty_text(reference, UI_MAX_PROVIDER_ID_BYTES, "provider credential")?;
        }
    }
    Ok(())
}
fn validate_writer(value: &UiWriterState) -> Result<(), UiValidationError> {
    validate_non_empty_text(&value.mode, UI_MAX_CONNECTION_BYTES, "writer mode")?;
    if let Some(text) = &value.writer_id {
        validate_non_empty_text(text, UI_MAX_ID_BYTES, "writer id")?;
    }
    validate_string_list(
        &value.observers,
        UI_MAX_WRITERS,
        UI_MAX_ID_BYTES,
        "writer observer",
    )
}

#[allow(clippy::too_many_arguments)]
fn validate_snapshot_budget(
    id: &str,
    sessions: &[UiSessionSnapshot],
    workspaces: &[UiWorkspaceSnapshot],
    active_session_id: Option<&str>,
    status: &UiStatusSnapshot,
    telemetry: &UiTelemetrySnapshot,
    tasks: &[UiTaskSnapshot],
    agents: &[UiAgentSnapshot],
    transcript: &[UiTranscriptBlock],
    transcript_window: Option<&UiTranscriptWindow>,
    changes: &[UiChangeSnapshot],
    activity: &[UiActivitySnapshot],
    permissions: &[UiPermissionRequest],
    providers: &[UiProviderSnapshot],
    writer: &UiWriterState,
) -> Result<(), UiValidationError> {
    let mut total = 0usize;
    add_bytes(&mut total, id)?;
    add_optional_bytes(&mut total, active_session_id)?;
    add_bytes(&mut total, &status.state)?;
    add_optional_bytes(&mut total, status.message.as_deref())?;
    add_optional_bytes(&mut total, status.detail.as_deref())?;
    add_bytes(&mut total, &telemetry.connection.state)?;
    add_optional_bytes(&mut total, telemetry.connection.last_error.as_deref())?;
    add_bytes(&mut total, &telemetry.model)?;
    add_bytes(&mut total, &telemetry.effort)?;
    for value in sessions {
        for text in [
            &value.id,
            &value.name,
            &value.workspace,
            &value.status,
            &value.model,
            &value.effort,
        ] {
            add_bytes(&mut total, text)?;
        }
    }
    for value in workspaces {
        for text in [&value.id, &value.name, &value.path] {
            add_bytes(&mut total, text)?;
        }
    }
    for value in tasks {
        add_bytes(&mut total, &value.id)?;
        add_bytes(&mut total, &value.title)?;
        add_bytes(&mut total, &value.status)?;
        add_optional_bytes(&mut total, value.detail.as_deref())?;
        add_metadata_bytes(&mut total, &value.metadata)?;
    }
    for value in agents {
        for text in [
            &value.id,
            &value.name,
            &value.role,
            &value.status,
            &value.model,
            &value.effort,
        ] {
            add_bytes(&mut total, text)?;
        }
        add_optional_bytes(&mut total, value.parent_id.as_deref())?;
        add_optional_bytes(&mut total, value.task_id.as_deref())?;
    }
    add_transcript_bytes(&mut total, transcript)?;
    if let Some(value) = transcript_window {
        add_transcript_bytes(&mut total, &value.blocks)?;
    }
    for value in changes {
        add_bytes(&mut total, &value.path)?;
        add_bytes(&mut total, &value.kind)?;
        add_optional_bytes(&mut total, value.language.as_deref())?;
        add_optional_bytes(&mut total, value.diff.as_deref())?;
    }
    for value in activity {
        add_bytes(&mut total, &value.id)?;
        add_bytes(&mut total, &value.kind)?;
        add_bytes(&mut total, &value.message)?;
        add_optional_bytes(&mut total, value.task_id.as_deref())?;
        add_optional_bytes(&mut total, value.agent_id.as_deref())?;
        add_bytes(&mut total, &value.severity)?;
    }
    for value in permissions {
        for text in [
            &value.id,
            &value.tool,
            &value.action,
            &value.resource,
            &value.reason,
            &value.status,
        ] {
            add_bytes(&mut total, text)?;
        }
        add_optional_bytes(&mut total, value.task_id.as_deref())?;
        add_optional_bytes(&mut total, value.agent_id.as_deref())?;
    }
    for value in providers {
        for text in [&value.id, &value.name, &value.protocol, &value.base_url] {
            add_bytes(&mut total, text)?;
        }
        add_optional_bytes(&mut total, value.credential.as_deref())?;
    }
    add_bytes(&mut total, &writer.mode)?;
    add_optional_bytes(&mut total, writer.writer_id.as_deref())?;
    for value in &writer.observers {
        add_bytes(&mut total, value)?;
    }
    if total > UI_MAX_SNAPSHOT_BYTES {
        return Err(UiValidationError::new(format!(
            "snapshot aggregate exceeds {} bytes",
            UI_MAX_SNAPSHOT_BYTES
        )));
    }
    Ok(())
}
fn add_metadata_bytes(total: &mut usize, value: &UiTaskMetadata) -> Result<(), UiValidationError> {
    for text in [
        value.parent_id.as_deref(),
        value.owner.as_deref(),
        value.agent_id.as_deref(),
        value.model.as_deref(),
        value.effort.as_deref(),
        value.isolation.as_deref(),
    ] {
        add_optional_bytes(total, text)?;
    }
    for text in value
        .dependencies
        .iter()
        .chain(value.blocked_by.iter())
        .chain(value.files_touched.iter())
    {
        add_bytes(total, text)?;
    }
    Ok(())
}
fn add_transcript_bytes(
    total: &mut usize,
    values: &[UiTranscriptBlock],
) -> Result<(), UiValidationError> {
    for value in values {
        match value {
            UiTranscriptBlock::Markdown(value) => {
                add_bytes(total, &value.id)?;
                add_bytes(total, &value.role)?;
                add_bytes(total, &value.text)?;
            }
            UiTranscriptBlock::Code(value) => {
                add_bytes(total, &value.id)?;
                add_bytes(total, &value.role)?;
                add_bytes(total, &value.language)?;
                add_bytes(total, &value.code)?;
                add_optional_bytes(total, value.file_path.as_deref())?;
            }
            UiTranscriptBlock::Tool(value) => {
                add_bytes(total, &value.id)?;
                add_bytes(total, &value.name)?;
                add_bytes(total, &value.status)?;
                add_optional_bytes(total, value.input.as_deref())?;
                add_optional_bytes(total, value.output.as_deref())?;
            }
            UiTranscriptBlock::Thinking(value) => {
                add_bytes(total, &value.id)?;
                add_bytes(total, &value.summary)?;
                add_bytes(total, &value.effort)?;
            }
            UiTranscriptBlock::Report(value) => {
                add_bytes(total, &value.id)?;
                add_bytes(total, &value.task_id)?;
                add_bytes(total, &value.status)?;
                add_bytes(total, &value.summary)?;
                add_bytes(total, &value.effort_used)?;
                for text in value.changed_files.iter().chain(value.evidence.iter()) {
                    add_bytes(total, text)?;
                }
            }
            UiTranscriptBlock::Error(value) => {
                add_bytes(total, &value.id)?;
                add_bytes(total, &value.code)?;
                add_bytes(total, &value.message)?;
                add_optional_bytes(total, value.detail.as_deref())?;
            }
        }
    }
    Ok(())
}
fn add_optional_bytes(total: &mut usize, value: Option<&str>) -> Result<(), UiValidationError> {
    if let Some(value) = value {
        add_bytes(total, value)?;
    }
    Ok(())
}
fn add_bytes(total: &mut usize, value: &str) -> Result<(), UiValidationError> {
    *total = total
        .checked_add(value.len())
        .ok_or_else(|| UiValidationError::new("snapshot size overflow"))?;
    Ok(())
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
    impl<'de, T: Deserialize<'de>> Visitor<'de> for BoundedVecVisitor<T> {
        type Value = Vec<T>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(formatter, "an array with at most {} entries", self.max)
        }
        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            if sequence.size_hint().is_some_and(|hint| hint > self.max) {
                return Err(serde::de::Error::custom(format!(
                    "array exceeds maximum of {} entries",
                    self.max
                )));
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
fn deserialize_capabilities<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<String>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_CAPABILITIES)
}
fn deserialize_modifiers<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_INPUT_MODIFIERS)
}
fn deserialize_sessions<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<UiSessionSnapshot>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_SESSIONS)
}
fn deserialize_workspaces<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<UiWorkspaceSnapshot>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_WORKSPACES)
}
fn deserialize_tasks<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<UiTaskSnapshot>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_TASKS)
}
fn deserialize_agents<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<UiAgentSnapshot>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_AGENTS)
}
fn deserialize_transcript<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<UiTranscriptBlock>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_TRANSCRIPT_BLOCKS)
}
fn deserialize_changes<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<UiChangeSnapshot>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_FILES)
}
fn deserialize_activity<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<UiActivitySnapshot>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_ACTIVITY)
}
fn deserialize_permissions<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<UiPermissionRequest>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_PERMISSIONS)
}
fn deserialize_providers<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<UiProviderSnapshot>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_PROVIDERS)
}
fn deserialize_dependencies<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<String>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_DEPENDENCIES)
}
fn deserialize_files<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_FILES)
}
fn deserialize_report_files<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<String>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_FILES)
}
fn deserialize_report_evidence<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<String>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_REPORT_EVIDENCE)
}
fn deserialize_writers<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    deserialize_bounded_vec(d, UI_MAX_WRITERS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn telemetry() -> UiTelemetrySnapshot {
        UiTelemetrySnapshot {
            connection: UiConnectionSnapshot {
                state: "connected".into(),
                reconnect_attempts: 0,
                last_error: None,
            },
            model: "gpt-5.6-luna".into(),
            effort: "high".into(),
            context_used_tokens: 1,
            context_limit_tokens: 1_100_000,
            input_tokens: 1,
            output_tokens: 1,
            last_input_tokens: 0,
            last_output_tokens: 0,
            last_cost: 0.0,
            cached_tokens: 0,
            reasoning_tokens: 0,
            credits: 4.419,
            active_agents: 1,
            queued_tasks: 0,
            api_requests: 1,
            latency_ms: 2,
        }
    }
    fn snapshot() -> UiMessage {
        UiMessage::RenderSnapshot {
            version: UI_PROTOCOL_VERSION,
            id: "render-1".into(),
            sequence: 7,
            sessions: vec![UiSessionSnapshot {
                id: "session-1".into(),
                name: "MindCode".into(),
                workspace: "/workspace".into(),
                status: "active".into(),
                model: "gpt-5.6-luna".into(),
                effort: "high".into(),
                active: true,
                pinned: true,
                unread: 0,
                created_at_ms: 1,
                updated_at_ms: 2,
            }],
            workspaces: vec![UiWorkspaceSnapshot {
                id: "workspace-1".into(),
                name: "MindCode".into(),
                path: "/workspace".into(),
                active: true,
            }],
            active_session_id: Some("session-1".into()),
            status: UiStatusSnapshot {
                state: "running".into(),
                message: Some("working".into()),
                detail: None,
            },
            telemetry: telemetry(),
            tasks: vec![UiTaskSnapshot {
                id: "task-1".into(),
                title: "compile".into(),
                status: "running".into(),
                detail: None,
                progress: Some(50),
                metadata: UiTaskMetadata {
                    parent_id: None,
                    owner: Some("leader".into()),
                    agent_id: Some("agent-luna".into()),
                    model: Some("gpt-5.6-luna".into()),
                    effort: Some("high".into()),
                    dependencies: vec![],
                    blocked_by: vec![],
                    files_touched: vec!["src/ui.rs".into()],
                    isolation: Some("shared".into()),
                },
            }],
            agents: vec![UiAgentSnapshot {
                id: "agent-luna".into(),
                name: "Luna".into(),
                role: "worker".into(),
                status: "running".into(),
                parent_id: None,
                task_id: Some("task-1".into()),
                model: "gpt-5.6-luna".into(),
                effort: "high".into(),
                progress: Some(50),
            }],
            transcript: vec![
                UiTranscriptBlock::Markdown(UiMarkdownBlock {
                    id: "message-1".into(),
                    sequence: 1,
                    role: "assistant".into(),
                    text: "hello".into(),
                    created_at_ms: None,
                    streaming: true,
                }),
                UiTranscriptBlock::Code(UiCodeBlock {
                    id: "code-1".into(),
                    sequence: 2,
                    role: "assistant".into(),
                    language: "rust".into(),
                    code: "fn main() {}".into(),
                    file_path: None,
                    start_line: None,
                    end_line: None,
                }),
                UiTranscriptBlock::Tool(UiToolBlock {
                    id: "tool-1".into(),
                    sequence: 3,
                    name: "cargo".into(),
                    status: "done".into(),
                    input: Some("test".into()),
                    output: Some("ok".into()),
                    duration_ms: Some(1),
                }),
                UiTranscriptBlock::Thinking(UiThinkingBlock {
                    id: "thinking-1".into(),
                    sequence: 4,
                    summary: "plan".into(),
                    effort: "high".into(),
                    elapsed_ms: 1,
                    tokens_used: 1,
                }),
                UiTranscriptBlock::Report(UiReportBlock {
                    id: "report-1".into(),
                    sequence: 5,
                    task_id: "task-1".into(),
                    status: "completed".into(),
                    summary: "done".into(),
                    changed_files: vec!["src/ui.rs".into()],
                    evidence: vec!["cargo test".into()],
                    tokens_used: 1,
                    effort_used: "high".into(),
                }),
                UiTranscriptBlock::Error(UiErrorBlock {
                    id: "error-1".into(),
                    sequence: 6,
                    code: "warning".into(),
                    message: "retrying".into(),
                    detail: None,
                    recoverable: true,
                }),
            ],
            transcript_window: None,
            changes: vec![UiChangeSnapshot {
                path: "src/ui.rs".into(),
                kind: "modified".into(),
                additions: 1,
                deletions: 0,
                staged: false,
                language: Some("rust".into()),
                diff: Some("+fn main() {}".into()),
            }],
            activity: vec![UiActivitySnapshot {
                id: "activity-1".into(),
                timestamp_ms: 1,
                kind: "task_completed".into(),
                message: "done".into(),
                task_id: Some("task-1".into()),
                agent_id: Some("agent-luna".into()),
                severity: "info".into(),
            }],
            permissions: vec![UiPermissionRequest {
                id: "permission-1".into(),
                tool: "Bash".into(),
                action: "run".into(),
                resource: "cargo test".into(),
                reason: "verification".into(),
                status: "pending".into(),
                requested_at_ms: 1,
                expires_at_ms: None,
                task_id: Some("task-1".into()),
                agent_id: Some("agent-luna".into()),
            }],
            providers: vec![UiProviderSnapshot {
                id: "vexzy".into(),
                name: "VEXZY".into(),
                protocol: "openai-compatible".into(),
                base_url: "https://api.echogate.one/v1".into(),
                active: true,
                credential: Some("env:VEXZY_API_KEY".into()),
                configured: true,
            }],
            writer: UiWriterState {
                mode: "writer".into(),
                writer_id: Some("client-1".into()),
                lease_expires_at_ms: Some(100),
                observers: vec!["client-2".into()],
            },
        }
    }

    #[test]
    fn rich_v2_round_trip() {
        let message = snapshot();
        let frame = encode_ui_frame(&message).unwrap();
        assert_eq!(decode_ui_frame(&frame).unwrap(), message);
    }
    #[test]
    fn handshake_mouse_and_action_round_trip() {
        let messages = [
            UiMessage::Handshake {
                version: UI_PROTOCOL_VERSION,
                id: "hello".into(),
                client: "mindcode-tui".into(),
                capabilities: vec!["render_snapshot_v2".into(), "mouse".into()],
            },
            UiMessage::InputEvent {
                version: UI_PROTOCOL_VERSION,
                id: "mouse".into(),
                sequence: 1,
                event: UiInputEventKind::Mouse(UiMouseInput {
                    x: 1,
                    y: 2,
                    button: UiMouseButton::Left,
                    kind: UiMouseEventKind::Down,
                    modifiers: vec!["shift".into()],
                }),
            },
            UiMessage::InputEvent {
                version: UI_PROTOCOL_VERSION,
                id: "action".into(),
                sequence: 2,
                event: UiInputEventKind::Action(UiActionInput {
                    action: "open_inspector".into(),
                    target: Some("task-1".into()),
                    value: None,
                }),
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
    fn nested_unknown_fields_are_rejected() {
        let value = serde_json::json!({ "type": "render_snapshot", "version": UI_PROTOCOL_VERSION, "id": "render", "sequence": 1, "sessions": [], "workspaces": [], "status": {"state":"ready"}, "telemetry": {"connection":{"state":"connected","reconnect_attempts":0},"model":"luna","effort":"medium","context_used_tokens":0,"context_limit_tokens":1,"input_tokens":0,"output_tokens":0,"cached_tokens":0,"reasoning_tokens":0,"credits":0.0,"active_agents":0,"queued_tasks":0,"api_requests":0,"latency_ms":0}, "tasks": [], "agents": [], "transcript": [{"type":"markdown","id":"m","sequence":1,"role":"assistant","text":"ok","unexpected":true}], "changes": [], "activity": [], "permissions": [], "writer": {"mode":"writer","observers":[]} });
        assert!(matches!(
            decode_ui_frame(&encode_frame(&value).unwrap()),
            Err(ProtocolError::Decode(_))
        ));
    }
    #[test]
    fn bounded_decode_and_validation_reject_bad_values() {
        let value = serde_json::json!({ "type":"handshake", "version":UI_PROTOCOL_VERSION, "id":"hello", "client":"mindcode", "capabilities":(0..=UI_MAX_CAPABILITIES).map(|_| "x").collect::<Vec<_>>() });
        assert!(matches!(
            decode_ui_frame(&encode_frame(&value).unwrap()),
            Err(ProtocolError::Decode(_))
        ));
        let mut message = snapshot();
        if let UiMessage::RenderSnapshot { telemetry, .. } = &mut message {
            telemetry.context_used_tokens = 2;
            telemetry.context_limit_tokens = 1;
        }
        assert!(matches!(
            encode_ui_frame(&message),
            Err(ProtocolError::InvalidUiMessage(_))
        ));
        let wrong = UiMessage::Ack {
            version: 1,
            id: "ack".into(),
            sequence: 1,
        };
        assert!(wrong.validate().is_err());
    }
}
