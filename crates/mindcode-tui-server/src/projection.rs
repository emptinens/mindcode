//! State-to-snapshot projection for the native TUI.
//!
//! Mirrors the TypeScript `src/runtime/nativeTui/projections.ts` reference:
//! plain input structs are validated, redacted and truncated against the
//! protocol bounds from `mindcode_protocol::ui`, then folded into a
//! monotonically-revisioned [`UiRenderSnapshot`].

use std::fmt;

use mindcode_protocol::ui::{
    UiActivitySnapshot, UiAgentSnapshot, UiChangeSnapshot, UiCodeBlock, UiConnectionSnapshot,
    UiErrorBlock, UiMarkdownBlock, UiPermissionRequest, UiProviderSnapshot, UiRenderSnapshot,
    UiReportBlock, UiSessionSnapshot, UiStatusSnapshot, UiTaskMetadata, UiTaskSnapshot,
    UiTelemetrySnapshot, UiThinkingBlock, UiToolBlock, UiTranscriptBlock, UiTranscriptWindow,
    UiWorkspaceSnapshot, UiWriterState, UI_MAX_ACTIVITY, UI_MAX_ACTIVITY_ID_BYTES,
    UI_MAX_ACTIVITY_MESSAGE_BYTES, UI_MAX_AGENTS, UI_MAX_AGENT_ID_BYTES, UI_MAX_AGENT_NAME_BYTES,
    UI_MAX_CODE_BYTES, UI_MAX_CONNECTION_BYTES, UI_MAX_DEPENDENCIES, UI_MAX_DIFF_BYTES,
    UI_MAX_EFFORT_BYTES, UI_MAX_FILES, UI_MAX_FILE_PATH_BYTES, UI_MAX_ID_BYTES,
    UI_MAX_LANGUAGE_BYTES, UI_MAX_MESSAGE_BYTES, UI_MAX_MODEL_BYTES, UI_MAX_PERMISSIONS,
    UI_MAX_PERMISSION_ID_BYTES, UI_MAX_PERMISSION_TEXT_BYTES, UI_MAX_PROVIDERS,
    UI_MAX_PROVIDER_ID_BYTES, UI_MAX_PROVIDER_NAME_BYTES, UI_MAX_PROVIDER_URL_BYTES,
    UI_MAX_REPORT_EVIDENCE, UI_MAX_REPORT_EVIDENCE_BYTES, UI_MAX_SESSIONS,
    UI_MAX_SESSION_NAME_BYTES, UI_MAX_SNAPSHOT_BYTES, UI_MAX_STATUS_BYTES, UI_MAX_TASKS,
    UI_MAX_TASK_ID_BYTES, UI_MAX_TASK_TITLE_BYTES, UI_MAX_TOOL_ARGUMENTS_BYTES,
    UI_MAX_TOOL_NAME_BYTES, UI_MAX_TOOL_OUTPUT_BYTES, UI_MAX_TRANSCRIPT_BLOCKS,
    UI_MAX_TRANSCRIPT_ID_BYTES, UI_MAX_TRANSCRIPT_ROLE_BYTES, UI_MAX_TRANSCRIPT_TEXT_BYTES,
    UI_MAX_WORKSPACES, UI_MAX_WORKSPACE_BYTES, UI_PROTOCOL_VERSION,
};

const DEFAULT_MODEL: &str = "gpt-5.6-luna";
const DEFAULT_EFFORT: &str = "medium";

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectionError {
    message: String,
}

impl ProjectionError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ProjectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "projection error: {}", self.message)
    }
}

impl std::error::Error for ProjectionError {}

// ---------------------------------------------------------------------------
// Input model (mirrors the TypeScript NativeTui*Input types).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct StatusInput {
    pub state: Option<String>,
    pub message: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ConnectionInput {
    pub state: Option<String>,
    pub reconnect_attempts: Option<u32>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TelemetryInput {
    pub connection: ConnectionInput,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub context_used_tokens: Option<u64>,
    pub context_limit_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub credits: Option<f64>,
    pub active_agents: Option<u16>,
    pub queued_tasks: Option<u16>,
    pub api_requests: Option<u64>,
    pub latency_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct SessionInput {
    pub id: String,
    pub name: Option<String>,
    pub workspace: Option<String>,
    pub status: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub active: Option<bool>,
    pub pinned: Option<bool>,
    pub unread: Option<u32>,
    pub created_at_ms: Option<u64>,
    pub updated_at_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceInput {
    pub id: String,
    pub name: Option<String>,
    pub path: Option<String>,
    pub active: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct TaskMetadataInput {
    pub parent_id: Option<String>,
    pub owner: Option<String>,
    pub agent_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub dependencies: Option<Vec<String>>,
    pub blocked_by: Option<Vec<String>>,
    pub files_touched: Option<Vec<String>>,
    pub isolation: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TaskInput {
    pub id: String,
    pub title: Option<String>,
    pub status: Option<String>,
    pub detail: Option<String>,
    pub progress: Option<u8>,
    pub metadata: TaskMetadataInput,
    // Top-level fallbacks mirroring the TS input's `metadata.X ?? input.X`.
    pub dependencies: Option<Vec<String>>,
    pub blocked_by: Option<Vec<String>>,
    pub files_touched: Option<Vec<String>>,
    pub parent_id: Option<String>,
    pub owner: Option<String>,
    pub agent_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub isolation: Option<String>,
}

impl TaskInput {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: None,
            status: None,
            detail: None,
            progress: None,
            metadata: TaskMetadataInput::default(),
            dependencies: None,
            blocked_by: None,
            files_touched: None,
            parent_id: None,
            owner: None,
            agent_id: None,
            model: None,
            effort: None,
            isolation: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentInput {
    pub id: String,
    pub name: Option<String>,
    pub role: Option<String>,
    pub status: Option<String>,
    pub parent_id: Option<String>,
    pub task_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub progress: Option<u8>,
}

impl AgentInput {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: None,
            role: None,
            status: None,
            parent_id: None,
            task_id: None,
            model: None,
            effort: None,
            progress: None,
        }
    }
}

/// A single transcript input: either a raw `role`/`text` entry or an
/// already-formed protocol block (re-validated on projection).
#[derive(Debug, Clone)]
pub enum TranscriptInput {
    Entry {
        sequence: u64,
        role: String,
        text: String,
    },
    Block(UiTranscriptBlock),
}

#[derive(Debug, Clone)]
pub struct TranscriptWindowInput {
    pub start_sequence: u64,
    pub end_sequence: u64,
    pub has_older: bool,
    pub has_newer: bool,
    pub blocks: Vec<TranscriptInput>,
}

#[derive(Debug, Clone)]
pub struct ChangeInput {
    pub path: String,
    pub kind: Option<String>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub staged: Option<bool>,
    pub language: Option<String>,
    pub diff: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ActivityInput {
    pub id: Option<String>,
    pub timestamp_ms: Option<u64>,
    pub kind: Option<String>,
    pub message: Option<String>,
    pub severity: Option<String>,
    pub task_id: Option<String>,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct PermissionInput {
    pub id: Option<String>,
    pub tool: Option<String>,
    pub action: Option<String>,
    pub resource: Option<String>,
    pub reason: Option<String>,
    pub status: Option<String>,
    pub requested_at_ms: Option<u64>,
    pub expires_at_ms: Option<u64>,
    pub task_id: Option<String>,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct WriterInput {
    pub mode: Option<String>,
    pub writer_id: Option<String>,
    pub lease_expires_at_ms: Option<u64>,
    pub observers: Option<Vec<String>>,
}

/// One provider profile for the setup screen.  `credential` is the
/// secret-free reference (`env:<NAME>` or `store`), never the value.
#[derive(Debug, Clone, Default)]
pub struct ProviderInput {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub active: Option<bool>,
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ProjectionInput {
    pub status: StatusInput,
    pub sessions: Vec<SessionInput>,
    pub workspaces: Vec<WorkspaceInput>,
    pub active_session_id: Option<String>,
    pub telemetry: TelemetryInput,
    pub tasks: Vec<TaskInput>,
    pub agents: Vec<AgentInput>,
    pub transcript: Vec<TranscriptInput>,
    pub transcript_window: Option<TranscriptWindowInput>,
    pub changes: Vec<ChangeInput>,
    pub activity: Vec<ActivityInput>,
    pub permissions: Vec<PermissionInput>,
    pub providers: Vec<ProviderInput>,
    pub writer: WriterInput,
}

// ---------------------------------------------------------------------------
// Validation / redaction / truncation helpers.
// ---------------------------------------------------------------------------

fn projection(message: impl Into<String>) -> ProjectionError {
    ProjectionError::new(message)
}

fn byte_len(value: &str) -> usize {
    value.len()
}

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-' | b'/' | b'+' | b'=')
}

/// Redact secret-shaped text before it reaches a snapshot.  Manual port of the
/// TS `redactSensitiveText` patterns that matter for this repository (no
/// regex dependency): `forge-` keys, `bearer` tokens, and PEM blocks.
fn redact_sensitive(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 6 <= bytes.len() && bytes[i..i + 6].eq_ignore_ascii_case(b"forge-") {
            out.push_str("[redacted]");
            i += 6;
            while i < bytes.len() && is_token_byte(bytes[i]) {
                i += 1;
            }
            continue;
        }
        if i + 6 <= bytes.len() && bytes[i..i + 6].eq_ignore_ascii_case(b"bearer") {
            let followed_by_space_or_end =
                i + 6 >= bytes.len() || bytes[i + 6].is_ascii_whitespace();
            if followed_by_space_or_end {
                out.push_str(&value[i..i + 6]);
                i += 6;
                while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                    out.push(bytes[i] as char);
                    i += 1;
                }
                if i < bytes.len() && is_token_byte(bytes[i]) {
                    out.push_str("[redacted]");
                    while i < bytes.len() && is_token_byte(bytes[i]) {
                        i += 1;
                    }
                }
                continue;
            }
        }
        let ch = value[i..]
            .chars()
            .next()
            .expect("non-empty slice contains a char");
        out.push(ch);
        i += ch.len_utf8();
    }
    redact_pem(&out)
}

fn redact_pem(value: &str) -> String {
    const BEGIN: &str = "-----BEGIN ";
    const END: &str = "-----END ";
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    loop {
        let Some(begin) = find_subslice(rest, BEGIN) else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..begin]);
        let after_begin = &rest[begin..];
        let Some(end_rel) = find_subslice(after_begin, END) else {
            out.push_str(after_begin);
            break;
        };
        // Find the terminating "-----" after "-----END ...-----".
        let tail = &after_begin[end_rel..];
        let Some(dash) = find_subslice(tail, "-----") else {
            out.push_str(after_begin);
            break;
        };
        out.push_str("[redacted]");
        rest = &tail[dash + "-----".len()..];
    }
    out
}

fn find_subslice(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .as_bytes()
        .windows(needle.len())
        .position(|window| window == needle.as_bytes())
}

/// Truncate a UTF-8 string to at most `max_bytes` without splitting a code
/// point.
fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut boundary = max_bytes;
    while boundary > 0 && (value.as_bytes()[boundary - 1] & 0xc0) == 0x80 {
        boundary -= 1;
    }
    value[..boundary].to_owned()
}

fn text(
    value: &str,
    context: &str,
    max_bytes: usize,
    allow_empty: bool,
) -> Result<String, ProjectionError> {
    if !allow_empty && value.is_empty() {
        return Err(projection(format!("{context} must not be empty")));
    }
    Ok(truncate_utf8(&redact_sensitive(value), max_bytes))
}

fn strings(
    values: Option<&[String]>,
    context: &str,
    max: usize,
    max_bytes: usize,
    allow_empty: bool,
) -> Result<Vec<String>, ProjectionError> {
    let Some(values) = values else {
        return Ok(Vec::new());
    };
    if values.len() > max {
        return Err(projection(format!("{context} exceeds its maximum size")));
    }
    values
        .iter()
        .enumerate()
        .map(|(index, item)| text(item, &format!("{context}[{index}]"), max_bytes, allow_empty))
        .collect()
}

fn integer(value: u64, context: &str, min: u64, max: u64) -> Result<u64, ProjectionError> {
    if value < min || value > max {
        return Err(projection(format!("{context} must be an integer in range")));
    }
    Ok(value)
}

fn finite_number(value: f64, context: &str) -> Result<f64, ProjectionError> {
    if !value.is_finite() || value < 0.0 {
        return Err(projection(format!(
            "{context} must be finite and non-negative"
        )));
    }
    Ok(value)
}

// ---------------------------------------------------------------------------
// Projection functions.
// ---------------------------------------------------------------------------

pub fn project_status(input: &StatusInput) -> Result<UiStatusSnapshot, ProjectionError> {
    let mut result = UiStatusSnapshot {
        state: text(
            input.state.as_deref().unwrap_or("ready"),
            "status.state",
            UI_MAX_STATUS_BYTES,
            false,
        )?,
        message: None,
        detail: None,
    };
    if let Some(message) = &input.message {
        result.message = Some(text(message, "status.message", UI_MAX_STATUS_BYTES, true)?);
    }
    if let Some(detail) = &input.detail {
        result.detail = Some(text(detail, "status.detail", UI_MAX_STATUS_BYTES, true)?);
    }
    Ok(result)
}

fn project_connection(input: &ConnectionInput) -> Result<UiConnectionSnapshot, ProjectionError> {
    let mut result = UiConnectionSnapshot {
        state: text(
            input.state.as_deref().unwrap_or("disconnected"),
            "telemetry.connection.state",
            UI_MAX_CONNECTION_BYTES,
            false,
        )?,
        reconnect_attempts: input.reconnect_attempts.unwrap_or(0),
        last_error: None,
    };
    if let Some(last_error) = &input.last_error {
        result.last_error = Some(text(
            last_error,
            "telemetry.connection.last_error",
            UI_MAX_MESSAGE_BYTES,
            true,
        )?);
    }
    Ok(result)
}

pub fn project_telemetry(input: &TelemetryInput) -> Result<UiTelemetrySnapshot, ProjectionError> {
    let context_limit = input.context_limit_tokens.unwrap_or(1_100_000);
    let context_used = input.context_used_tokens.unwrap_or(0);
    if context_used > context_limit {
        return Err(projection("telemetry context usage exceeds context limit"));
    }
    Ok(UiTelemetrySnapshot {
        connection: project_connection(&input.connection)?,
        model: text(
            input.model.as_deref().unwrap_or(DEFAULT_MODEL),
            "telemetry.model",
            UI_MAX_MODEL_BYTES,
            false,
        )?,
        effort: text(
            input.effort.as_deref().unwrap_or(DEFAULT_EFFORT),
            "telemetry.effort",
            UI_MAX_EFFORT_BYTES,
            false,
        )?,
        context_used_tokens: context_used,
        context_limit_tokens: context_limit,
        input_tokens: input.input_tokens.unwrap_or(0),
        output_tokens: input.output_tokens.unwrap_or(0),
        cached_tokens: input.cached_tokens.unwrap_or(0),
        reasoning_tokens: input.reasoning_tokens.unwrap_or(0),
        credits: finite_number(input.credits.unwrap_or(0.0), "telemetry.credits")?,
        active_agents: input.active_agents.unwrap_or(0),
        queued_tasks: input.queued_tasks.unwrap_or(0),
        api_requests: input.api_requests.unwrap_or(0),
        latency_ms: input.latency_ms.unwrap_or(0),
    })
}

pub fn project_sessions(
    inputs: &[SessionInput],
) -> Result<Vec<UiSessionSnapshot>, ProjectionError> {
    if inputs.len() > UI_MAX_SESSIONS {
        return Err(projection("sessions exceeds its maximum size"));
    }
    inputs
        .iter()
        .enumerate()
        .map(|(index, input)| {
            let context = format!("sessions[{index}]");
            let id = text(&input.id, &format!("{context}.id"), UI_MAX_ID_BYTES, false)?;
            Ok(UiSessionSnapshot {
                id: id.clone(),
                name: text(
                    input.name.as_deref().unwrap_or(&id),
                    &format!("{context}.name"),
                    UI_MAX_SESSION_NAME_BYTES,
                    false,
                )?,
                workspace: text(
                    input.workspace.as_deref().unwrap_or("unknown"),
                    &format!("{context}.workspace"),
                    UI_MAX_WORKSPACE_BYTES,
                    false,
                )?,
                status: text(
                    input.status.as_deref().unwrap_or("idle"),
                    &format!("{context}.status"),
                    UI_MAX_STATUS_BYTES,
                    false,
                )?,
                model: text(
                    input.model.as_deref().unwrap_or(DEFAULT_MODEL),
                    &format!("{context}.model"),
                    UI_MAX_MODEL_BYTES,
                    false,
                )?,
                effort: text(
                    input.effort.as_deref().unwrap_or(DEFAULT_EFFORT),
                    &format!("{context}.effort"),
                    UI_MAX_EFFORT_BYTES,
                    false,
                )?,
                active: input.active.unwrap_or(false),
                pinned: input.pinned.unwrap_or(false),
                unread: input.unread.unwrap_or(0),
                created_at_ms: input.created_at_ms.unwrap_or(0),
                updated_at_ms: input.updated_at_ms.unwrap_or(0),
            })
        })
        .collect()
}

pub fn project_providers(
    inputs: &[ProviderInput],
) -> Result<Vec<UiProviderSnapshot>, ProjectionError> {
    if inputs.len() > UI_MAX_PROVIDERS {
        return Err(projection("providers exceeds its maximum size"));
    }
    inputs
        .iter()
        .enumerate()
        .map(|(index, input)| {
            let context = format!("providers[{index}]");
            Ok(UiProviderSnapshot {
                id: text(
                    &input.id,
                    &format!("{context}.id"),
                    UI_MAX_PROVIDER_ID_BYTES,
                    false,
                )?,
                name: text(
                    &input.name,
                    &format!("{context}.name"),
                    UI_MAX_PROVIDER_NAME_BYTES,
                    false,
                )?,
                protocol: text(
                    &input.protocol,
                    &format!("{context}.protocol"),
                    UI_MAX_CODE_BYTES,
                    false,
                )?,
                base_url: text(
                    &input.base_url,
                    &format!("{context}.base_url"),
                    UI_MAX_PROVIDER_URL_BYTES,
                    false,
                )?,
                active: input.active.unwrap_or(false),
                credential: input
                    .credential
                    .as_deref()
                    .map(|value| {
                        text(
                            value,
                            &format!("{context}.credential"),
                            UI_MAX_PROVIDER_ID_BYTES,
                            false,
                        )
                    })
                    .transpose()?,
            })
        })
        .collect()
}

pub fn project_workspaces(
    inputs: &[WorkspaceInput],
) -> Result<Vec<UiWorkspaceSnapshot>, ProjectionError> {
    if inputs.len() > UI_MAX_WORKSPACES {
        return Err(projection("workspaces exceeds its maximum size"));
    }
    inputs
        .iter()
        .enumerate()
        .map(|(index, input)| {
            let context = format!("workspaces[{index}]");
            let id = text(&input.id, &format!("{context}.id"), UI_MAX_ID_BYTES, false)?;
            Ok(UiWorkspaceSnapshot {
                id: id.clone(),
                name: text(
                    input.name.as_deref().unwrap_or(&id),
                    &format!("{context}.name"),
                    UI_MAX_SESSION_NAME_BYTES,
                    false,
                )?,
                path: text(
                    input.path.as_deref().unwrap_or("unknown"),
                    &format!("{context}.path"),
                    UI_MAX_WORKSPACE_BYTES,
                    false,
                )?,
                active: input.active.unwrap_or(false),
            })
        })
        .collect()
}

pub fn project_tasks(inputs: &[TaskInput]) -> Result<Vec<UiTaskSnapshot>, ProjectionError> {
    if inputs.len() > UI_MAX_TASKS {
        return Err(projection("tasks exceeds its maximum size"));
    }
    inputs
        .iter()
        .enumerate()
        .map(|(index, input)| {
            let context = format!("tasks[{index}]");
            let metadata = &input.metadata;
            let mut result = UiTaskSnapshot {
                id: text(
                    &input.id,
                    &format!("{context}.id"),
                    UI_MAX_TASK_ID_BYTES,
                    false,
                )?,
                title: text(
                    input.title.as_deref().unwrap_or(""),
                    &format!("{context}.title"),
                    UI_MAX_TASK_TITLE_BYTES,
                    true,
                )?,
                status: text(
                    input.status.as_deref().unwrap_or("pending"),
                    &format!("{context}.status"),
                    UI_MAX_STATUS_BYTES,
                    false,
                )?,
                detail: None,
                progress: None,
                metadata: UiTaskMetadata {
                    parent_id: None,
                    owner: None,
                    agent_id: None,
                    model: None,
                    effort: None,
                    dependencies: strings(
                        metadata
                            .dependencies
                            .as_deref()
                            .or(input.dependencies.as_deref()),
                        &format!("{context}.metadata.dependencies"),
                        UI_MAX_DEPENDENCIES,
                        UI_MAX_TASK_ID_BYTES,
                        false,
                    )?,
                    blocked_by: strings(
                        metadata
                            .blocked_by
                            .as_deref()
                            .or(input.blocked_by.as_deref()),
                        &format!("{context}.metadata.blocked_by"),
                        UI_MAX_DEPENDENCIES,
                        UI_MAX_TASK_ID_BYTES,
                        false,
                    )?,
                    files_touched: strings(
                        metadata
                            .files_touched
                            .as_deref()
                            .or(input.files_touched.as_deref()),
                        &format!("{context}.metadata.files_touched"),
                        UI_MAX_FILES,
                        UI_MAX_FILE_PATH_BYTES,
                        false,
                    )?,
                    isolation: None,
                },
            };
            if let Some(detail) = &input.detail {
                result.detail = Some(text(
                    detail,
                    &format!("{context}.detail"),
                    UI_MAX_STATUS_BYTES,
                    true,
                )?);
            }
            if let Some(progress) = input.progress {
                result.progress = Some(
                    u8::try_from(integer(
                        progress as u64,
                        &format!("{context}.progress"),
                        0,
                        100,
                    )?)
                    .map_err(|_| projection(format!("{context}.progress must be 0-100")))?,
                );
            }
            let parent_id = metadata.parent_id.as_deref().or(input.parent_id.as_deref());
            let owner = metadata.owner.as_deref().or(input.owner.as_deref());
            let agent_id = metadata.agent_id.as_deref().or(input.agent_id.as_deref());
            let model = metadata.model.as_deref().or(input.model.as_deref());
            let effort = metadata.effort.as_deref().or(input.effort.as_deref());
            let isolation = metadata.isolation.as_deref().or(input.isolation.as_deref());
            result.metadata.parent_id = parent_id
                .map(|value| {
                    text(
                        value,
                        &format!("{context}.metadata.parent_id"),
                        UI_MAX_TASK_ID_BYTES,
                        false,
                    )
                })
                .transpose()?;
            result.metadata.owner = owner
                .map(|value| {
                    text(
                        value,
                        &format!("{context}.metadata.owner"),
                        UI_MAX_AGENT_NAME_BYTES,
                        false,
                    )
                })
                .transpose()?;
            result.metadata.agent_id = agent_id
                .map(|value| {
                    text(
                        value,
                        &format!("{context}.metadata.agent_id"),
                        UI_MAX_AGENT_ID_BYTES,
                        false,
                    )
                })
                .transpose()?;
            result.metadata.model = model
                .map(|value| {
                    text(
                        value,
                        &format!("{context}.metadata.model"),
                        UI_MAX_MODEL_BYTES,
                        false,
                    )
                })
                .transpose()?;
            result.metadata.effort = effort
                .map(|value| {
                    text(
                        value,
                        &format!("{context}.metadata.effort"),
                        UI_MAX_EFFORT_BYTES,
                        false,
                    )
                })
                .transpose()?;
            result.metadata.isolation = isolation
                .map(|value| {
                    text(
                        value,
                        &format!("{context}.metadata.isolation"),
                        UI_MAX_CONNECTION_BYTES,
                        false,
                    )
                })
                .transpose()?;
            Ok(result)
        })
        .collect()
}

pub fn project_agents(inputs: &[AgentInput]) -> Result<Vec<UiAgentSnapshot>, ProjectionError> {
    if inputs.len() > UI_MAX_AGENTS {
        return Err(projection("agents exceeds its maximum size"));
    }
    inputs
        .iter()
        .enumerate()
        .map(|(index, input)| {
            let context = format!("agents[{index}]");
            let id = text(
                &input.id,
                &format!("{context}.id"),
                UI_MAX_AGENT_ID_BYTES,
                false,
            )?;
            let mut result = UiAgentSnapshot {
                id: id.clone(),
                name: text(
                    input.name.as_deref().unwrap_or(&id),
                    &format!("{context}.name"),
                    UI_MAX_AGENT_NAME_BYTES,
                    false,
                )?,
                role: text(
                    input.role.as_deref().unwrap_or("worker"),
                    &format!("{context}.role"),
                    UI_MAX_AGENT_NAME_BYTES,
                    false,
                )?,
                status: text(
                    input.status.as_deref().unwrap_or("idle"),
                    &format!("{context}.status"),
                    UI_MAX_STATUS_BYTES,
                    false,
                )?,
                parent_id: None,
                task_id: None,
                model: text(
                    input.model.as_deref().unwrap_or(DEFAULT_MODEL),
                    &format!("{context}.model"),
                    UI_MAX_MODEL_BYTES,
                    false,
                )?,
                effort: text(
                    input.effort.as_deref().unwrap_or(DEFAULT_EFFORT),
                    &format!("{context}.effort"),
                    UI_MAX_EFFORT_BYTES,
                    false,
                )?,
                progress: None,
            };
            if let Some(parent_id) = &input.parent_id {
                result.parent_id = Some(text(
                    parent_id,
                    &format!("{context}.parent_id"),
                    UI_MAX_AGENT_ID_BYTES,
                    false,
                )?);
            }
            if let Some(task_id) = &input.task_id {
                result.task_id = Some(text(
                    task_id,
                    &format!("{context}.task_id"),
                    UI_MAX_TASK_ID_BYTES,
                    false,
                )?);
            }
            if let Some(progress) = input.progress {
                result.progress = Some(
                    u8::try_from(integer(
                        progress as u64,
                        &format!("{context}.progress"),
                        0,
                        100,
                    )?)
                    .map_err(|_| projection(format!("{context}.progress must be 0-100")))?,
                );
            }
            Ok(result)
        })
        .collect()
}

fn is_raw_tool_entry(role: &str) -> bool {
    matches!(
        role.to_ascii_lowercase().as_str(),
        "tool" | "tool_result" | "function"
    )
}

pub fn project_transcript(
    inputs: &[TranscriptInput],
) -> Result<Vec<UiTranscriptBlock>, ProjectionError> {
    if inputs.len() > UI_MAX_TRANSCRIPT_BLOCKS {
        return Err(projection("transcript exceeds its maximum size"));
    }
    let mut blocks = Vec::with_capacity(inputs.len());
    for (index, input) in inputs.iter().enumerate() {
        let context = format!("transcript[{index}]");
        match input {
            TranscriptInput::Block(block) => {
                blocks.push(project_transcript_block(block, &context)?)
            }
            TranscriptInput::Entry {
                sequence,
                role,
                text: body,
            } => {
                if is_raw_tool_entry(role) {
                    continue;
                }
                let role = text(
                    role,
                    &format!("{context}.role"),
                    UI_MAX_TRANSCRIPT_ROLE_BYTES,
                    false,
                )?;
                blocks.push(UiTranscriptBlock::Markdown(UiMarkdownBlock {
                    id: text(
                        &format!("{role}-{sequence}"),
                        &format!("{context}.id"),
                        UI_MAX_TRANSCRIPT_ID_BYTES,
                        false,
                    )?,
                    sequence: integer(*sequence, &format!("{context}.sequence"), 0, u64::MAX)?,
                    role,
                    text: text(
                        body,
                        &format!("{context}.text"),
                        UI_MAX_TRANSCRIPT_TEXT_BYTES,
                        true,
                    )?,
                    created_at_ms: None,
                }));
            }
        }
    }
    Ok(blocks)
}

fn project_transcript_block(
    input: &UiTranscriptBlock,
    context: &str,
) -> Result<UiTranscriptBlock, ProjectionError> {
    match input {
        UiTranscriptBlock::Markdown(block) => {
            let mut result = UiMarkdownBlock {
                id: text(
                    &block.id,
                    &format!("{context}.id"),
                    UI_MAX_TRANSCRIPT_ID_BYTES,
                    false,
                )?,
                sequence: integer(block.sequence, &format!("{context}.sequence"), 0, u64::MAX)?,
                role: text(
                    &block.role,
                    &format!("{context}.role"),
                    UI_MAX_TRANSCRIPT_ROLE_BYTES,
                    false,
                )?,
                text: text(
                    &block.text,
                    &format!("{context}.text"),
                    UI_MAX_TRANSCRIPT_TEXT_BYTES,
                    true,
                )?,
                created_at_ms: None,
            };
            if let Some(created) = block.created_at_ms {
                result.created_at_ms = Some(integer(
                    created,
                    &format!("{context}.created_at_ms"),
                    0,
                    u64::MAX,
                )?);
            }
            Ok(UiTranscriptBlock::Markdown(result))
        }
        UiTranscriptBlock::Code(block) => {
            let start_line = block.start_line;
            let end_line = block.end_line;
            if let (Some(start), Some(end)) = (start_line, end_line) {
                if start > end {
                    return Err(projection(format!(
                        "{context} start line must not exceed end line"
                    )));
                }
            }
            Ok(UiTranscriptBlock::Code(UiCodeBlock {
                id: text(
                    &block.id,
                    &format!("{context}.id"),
                    UI_MAX_TRANSCRIPT_ID_BYTES,
                    false,
                )?,
                sequence: integer(block.sequence, &format!("{context}.sequence"), 0, u64::MAX)?,
                role: text(
                    &block.role,
                    &format!("{context}.role"),
                    UI_MAX_TRANSCRIPT_ROLE_BYTES,
                    false,
                )?,
                language: text(
                    &block.language,
                    &format!("{context}.language"),
                    UI_MAX_LANGUAGE_BYTES,
                    false,
                )?,
                code: text(
                    &block.code,
                    &format!("{context}.code"),
                    UI_MAX_CODE_BYTES * 4096,
                    true,
                )?,
                file_path: block
                    .file_path
                    .as_deref()
                    .map(|value| {
                        text(
                            value,
                            &format!("{context}.file_path"),
                            UI_MAX_FILE_PATH_BYTES,
                            true,
                        )
                    })
                    .transpose()?,
                start_line,
                end_line,
            }))
        }
        UiTranscriptBlock::Tool(block) => {
            let mut result = UiToolBlock {
                id: text(
                    &block.id,
                    &format!("{context}.id"),
                    UI_MAX_TRANSCRIPT_ID_BYTES,
                    false,
                )?,
                sequence: integer(block.sequence, &format!("{context}.sequence"), 0, u64::MAX)?,
                name: text(
                    &block.name,
                    &format!("{context}.name"),
                    UI_MAX_TOOL_NAME_BYTES,
                    false,
                )?,
                status: text(
                    &block.status,
                    &format!("{context}.status"),
                    UI_MAX_STATUS_BYTES,
                    false,
                )?,
                input: None,
                output: None,
                duration_ms: None,
            };
            if let Some(input) = &block.input {
                result.input = Some(text(
                    input,
                    &format!("{context}.input"),
                    UI_MAX_TOOL_ARGUMENTS_BYTES,
                    true,
                )?);
            }
            if let Some(output) = &block.output {
                result.output = Some(text(
                    output,
                    &format!("{context}.output"),
                    UI_MAX_TOOL_OUTPUT_BYTES,
                    true,
                )?);
            }
            if let Some(duration_ms) = block.duration_ms {
                result.duration_ms = Some(integer(
                    duration_ms,
                    &format!("{context}.duration_ms"),
                    0,
                    u64::MAX,
                )?);
            }
            Ok(UiTranscriptBlock::Tool(result))
        }
        UiTranscriptBlock::Thinking(block) => Ok(UiTranscriptBlock::Thinking(UiThinkingBlock {
            id: text(
                &block.id,
                &format!("{context}.id"),
                UI_MAX_TRANSCRIPT_ID_BYTES,
                false,
            )?,
            sequence: integer(block.sequence, &format!("{context}.sequence"), 0, u64::MAX)?,
            summary: text(
                &block.summary,
                &format!("{context}.summary"),
                UI_MAX_TRANSCRIPT_TEXT_BYTES,
                true,
            )?,
            effort: text(
                &block.effort,
                &format!("{context}.effort"),
                UI_MAX_EFFORT_BYTES,
                false,
            )?,
            elapsed_ms: integer(
                block.elapsed_ms,
                &format!("{context}.elapsed_ms"),
                0,
                u64::MAX,
            )?,
            tokens_used: integer(
                block.tokens_used,
                &format!("{context}.tokens_used"),
                0,
                u64::MAX,
            )?,
        })),
        UiTranscriptBlock::Report(block) => Ok(UiTranscriptBlock::Report(UiReportBlock {
            id: text(
                &block.id,
                &format!("{context}.id"),
                UI_MAX_TRANSCRIPT_ID_BYTES,
                false,
            )?,
            sequence: integer(block.sequence, &format!("{context}.sequence"), 0, u64::MAX)?,
            task_id: text(
                &block.task_id,
                &format!("{context}.task_id"),
                UI_MAX_TASK_ID_BYTES,
                false,
            )?,
            status: text(
                &block.status,
                &format!("{context}.status"),
                UI_MAX_STATUS_BYTES,
                false,
            )?,
            summary: text(
                &block.summary,
                &format!("{context}.summary"),
                UI_MAX_TRANSCRIPT_TEXT_BYTES,
                true,
            )?,
            changed_files: strings(
                Some(&block.changed_files),
                &format!("{context}.changed_files"),
                UI_MAX_FILES,
                UI_MAX_FILE_PATH_BYTES,
                false,
            )?,
            evidence: strings(
                Some(&block.evidence),
                &format!("{context}.evidence"),
                UI_MAX_REPORT_EVIDENCE,
                UI_MAX_REPORT_EVIDENCE_BYTES,
                true,
            )?,
            tokens_used: integer(
                block.tokens_used,
                &format!("{context}.tokens_used"),
                0,
                u64::MAX,
            )?,
            effort_used: text(
                &block.effort_used,
                &format!("{context}.effort_used"),
                UI_MAX_EFFORT_BYTES,
                false,
            )?,
        })),
        UiTranscriptBlock::Error(block) => {
            let mut result = UiErrorBlock {
                id: text(
                    &block.id,
                    &format!("{context}.id"),
                    UI_MAX_TRANSCRIPT_ID_BYTES,
                    false,
                )?,
                sequence: integer(block.sequence, &format!("{context}.sequence"), 0, u64::MAX)?,
                code: text(&block.code, &format!("{context}.code"), 128, false)?,
                message: text(
                    &block.message,
                    &format!("{context}.message"),
                    UI_MAX_MESSAGE_BYTES,
                    true,
                )?,
                detail: None,
                recoverable: block.recoverable,
            };
            if let Some(detail) = &block.detail {
                result.detail = Some(text(
                    detail,
                    &format!("{context}.detail"),
                    UI_MAX_MESSAGE_BYTES,
                    true,
                )?);
            }
            Ok(UiTranscriptBlock::Error(result))
        }
    }
}

fn project_transcript_window(
    input: &Option<TranscriptWindowInput>,
) -> Result<Option<UiTranscriptWindow>, ProjectionError> {
    let Some(input) = input else {
        return Ok(None);
    };
    let start = integer(
        input.start_sequence,
        "transcript_window.start_sequence",
        0,
        u64::MAX,
    )?;
    let end = integer(
        input.end_sequence,
        "transcript_window.end_sequence",
        0,
        u64::MAX,
    )?;
    if start > end {
        return Err(projection(
            "transcript window start sequence must not exceed end sequence",
        ));
    }
    Ok(Some(UiTranscriptWindow {
        start_sequence: start,
        end_sequence: end,
        has_older: input.has_older,
        has_newer: input.has_newer,
        blocks: project_transcript(&input.blocks)?,
    }))
}

pub fn project_changes(inputs: &[ChangeInput]) -> Result<Vec<UiChangeSnapshot>, ProjectionError> {
    if inputs.len() > UI_MAX_FILES {
        return Err(projection("changes exceeds its maximum size"));
    }
    inputs
        .iter()
        .enumerate()
        .map(|(index, input)| {
            let context = format!("changes[{index}]");
            let mut result = UiChangeSnapshot {
                path: text(
                    &input.path,
                    &format!("{context}.path"),
                    UI_MAX_FILE_PATH_BYTES,
                    false,
                )?,
                kind: text(
                    input.kind.as_deref().unwrap_or("modified"),
                    &format!("{context}.kind"),
                    UI_MAX_CONNECTION_BYTES,
                    false,
                )?,
                additions: input.additions.unwrap_or(0),
                deletions: input.deletions.unwrap_or(0),
                staged: input.staged.unwrap_or(false),
                language: None,
                diff: None,
            };
            if let Some(language) = &input.language {
                result.language = Some(text(
                    language,
                    &format!("{context}.language"),
                    UI_MAX_LANGUAGE_BYTES,
                    true,
                )?);
            }
            if let Some(diff) = &input.diff {
                result.diff = Some(text(
                    diff,
                    &format!("{context}.diff"),
                    UI_MAX_DIFF_BYTES,
                    true,
                )?);
            }
            Ok(result)
        })
        .collect()
}

pub fn project_activity(
    inputs: &[ActivityInput],
) -> Result<Vec<UiActivitySnapshot>, ProjectionError> {
    if inputs.len() > UI_MAX_ACTIVITY {
        return Err(projection("activity exceeds its maximum size"));
    }
    inputs
        .iter()
        .enumerate()
        .map(|(index, input)| {
            let context = format!("activity[{index}]");
            let mut result = UiActivitySnapshot {
                id: text(
                    input.id.as_deref().unwrap_or(&format!("activity-{index}")),
                    &format!("{context}.id"),
                    UI_MAX_ACTIVITY_ID_BYTES,
                    false,
                )?,
                timestamp_ms: input.timestamp_ms.unwrap_or(0),
                kind: text(
                    input.kind.as_deref().unwrap_or("info"),
                    &format!("{context}.kind"),
                    UI_MAX_CONNECTION_BYTES,
                    false,
                )?,
                message: text(
                    input.message.as_deref().unwrap_or(""),
                    &format!("{context}.message"),
                    UI_MAX_ACTIVITY_MESSAGE_BYTES,
                    true,
                )?,
                task_id: None,
                agent_id: None,
                severity: text(
                    input.severity.as_deref().unwrap_or("info"),
                    &format!("{context}.severity"),
                    UI_MAX_CONNECTION_BYTES,
                    false,
                )?,
            };
            if let Some(task_id) = &input.task_id {
                result.task_id = Some(text(
                    task_id,
                    &format!("{context}.task_id"),
                    UI_MAX_TASK_ID_BYTES,
                    false,
                )?);
            }
            if let Some(agent_id) = &input.agent_id {
                result.agent_id = Some(text(
                    agent_id,
                    &format!("{context}.agent_id"),
                    UI_MAX_AGENT_ID_BYTES,
                    false,
                )?);
            }
            Ok(result)
        })
        .collect()
}

pub fn project_permissions(
    inputs: &[PermissionInput],
) -> Result<Vec<UiPermissionRequest>, ProjectionError> {
    if inputs.len() > UI_MAX_PERMISSIONS {
        return Err(projection("permissions exceeds its maximum size"));
    }
    inputs
        .iter()
        .enumerate()
        .map(|(index, input)| {
            let context = format!("permissions[{index}]");
            let mut result = UiPermissionRequest {
                id: text(
                    input
                        .id
                        .as_deref()
                        .unwrap_or(&format!("permission-{index}")),
                    &format!("{context}.id"),
                    UI_MAX_PERMISSION_ID_BYTES,
                    false,
                )?,
                tool: text(
                    input.tool.as_deref().unwrap_or("unknown"),
                    &format!("{context}.tool"),
                    UI_MAX_TOOL_NAME_BYTES,
                    false,
                )?,
                action: text(
                    input.action.as_deref().unwrap_or("request"),
                    &format!("{context}.action"),
                    UI_MAX_PERMISSION_TEXT_BYTES,
                    false,
                )?,
                resource: text(
                    input.resource.as_deref().unwrap_or(""),
                    &format!("{context}.resource"),
                    UI_MAX_PERMISSION_TEXT_BYTES,
                    true,
                )?,
                reason: text(
                    input.reason.as_deref().unwrap_or(""),
                    &format!("{context}.reason"),
                    UI_MAX_PERMISSION_TEXT_BYTES,
                    true,
                )?,
                status: text(
                    input.status.as_deref().unwrap_or("pending"),
                    &format!("{context}.status"),
                    UI_MAX_CONNECTION_BYTES,
                    false,
                )?,
                requested_at_ms: input.requested_at_ms.unwrap_or(0),
                expires_at_ms: None,
                task_id: None,
                agent_id: None,
            };
            if let Some(expires_at_ms) = input.expires_at_ms {
                result.expires_at_ms = Some(integer(
                    expires_at_ms,
                    &format!("{context}.expires_at_ms"),
                    0,
                    u64::MAX,
                )?);
            }
            if let Some(task_id) = &input.task_id {
                result.task_id = Some(text(
                    task_id,
                    &format!("{context}.task_id"),
                    UI_MAX_TASK_ID_BYTES,
                    false,
                )?);
            }
            if let Some(agent_id) = &input.agent_id {
                result.agent_id = Some(text(
                    agent_id,
                    &format!("{context}.agent_id"),
                    UI_MAX_AGENT_ID_BYTES,
                    false,
                )?);
            }
            Ok(result)
        })
        .collect()
}

pub fn project_writer(input: &WriterInput) -> Result<UiWriterState, ProjectionError> {
    let mut result = UiWriterState {
        mode: text(
            input.mode.as_deref().unwrap_or("observer"),
            "writer.mode",
            UI_MAX_CONNECTION_BYTES,
            false,
        )?,
        writer_id: None,
        lease_expires_at_ms: None,
        observers: strings(
            input.observers.as_deref(),
            "writer.observers",
            64,
            UI_MAX_ID_BYTES,
            false,
        )?,
    };
    if let Some(writer_id) = &input.writer_id {
        result.writer_id = Some(text(writer_id, "writer.writer_id", UI_MAX_ID_BYTES, false)?);
    }
    if let Some(lease_expires_at_ms) = input.lease_expires_at_ms {
        result.lease_expires_at_ms = Some(integer(
            lease_expires_at_ms,
            "writer.lease_expires_at_ms",
            0,
            u64::MAX,
        )?);
    }
    Ok(result)
}

fn snapshot_byte_length(snapshot: &UiRenderSnapshot) -> usize {
    let mut total = 0usize;
    let mut add = |value: Option<&str>| {
        if let Some(value) = value {
            total += byte_len(value);
        }
    };
    add(Some(&snapshot.id));
    add(snapshot.active_session_id.as_deref());
    add(Some(&snapshot.status.state));
    add(snapshot.status.message.as_deref());
    add(snapshot.status.detail.as_deref());
    add(Some(&snapshot.telemetry.connection.state));
    add(snapshot.telemetry.connection.last_error.as_deref());
    add(Some(&snapshot.telemetry.model));
    add(Some(&snapshot.telemetry.effort));
    for item in &snapshot.sessions {
        for value in [
            &item.id,
            &item.name,
            &item.workspace,
            &item.status,
            &item.model,
            &item.effort,
        ] {
            add(Some(value));
        }
    }
    for item in &snapshot.workspaces {
        for value in [&item.id, &item.name, &item.path] {
            add(Some(value));
        }
    }
    for item in &snapshot.tasks {
        add(Some(&item.id));
        add(Some(&item.title));
        add(Some(&item.status));
        add(item.detail.as_deref());
        for value in [
            item.metadata.parent_id.as_deref(),
            item.metadata.owner.as_deref(),
            item.metadata.agent_id.as_deref(),
            item.metadata.model.as_deref(),
            item.metadata.effort.as_deref(),
            item.metadata.isolation.as_deref(),
        ] {
            add(value);
        }
        for value in item
            .metadata
            .dependencies
            .iter()
            .chain(&item.metadata.blocked_by)
            .chain(&item.metadata.files_touched)
        {
            add(Some(value));
        }
    }
    for item in &snapshot.agents {
        for value in [
            &item.id,
            &item.name,
            &item.role,
            &item.status,
            &item.model,
            &item.effort,
        ] {
            add(Some(value));
        }
        add(item.parent_id.as_deref());
        add(item.task_id.as_deref());
    }
    for block in &snapshot.transcript {
        add_transcript_block_bytes(block, &mut add);
    }
    if let Some(window) = &snapshot.transcript_window {
        for block in &window.blocks {
            add_transcript_block_bytes(block, &mut add);
        }
    }
    for item in &snapshot.changes {
        for value in [&item.path, &item.kind] {
            add(Some(value));
        }
        add(item.language.as_deref());
        add(item.diff.as_deref());
    }
    for item in &snapshot.activity {
        for value in [&item.id, &item.kind, &item.message, &item.severity] {
            add(Some(value));
        }
        add(item.task_id.as_deref());
        add(item.agent_id.as_deref());
    }
    for item in &snapshot.permissions {
        for value in [
            &item.id,
            &item.tool,
            &item.action,
            &item.resource,
            &item.reason,
            &item.status,
        ] {
            add(Some(value));
        }
        add(item.task_id.as_deref());
        add(item.agent_id.as_deref());
    }
    add(Some(&snapshot.writer.mode));
    add(snapshot.writer.writer_id.as_deref());
    for observer in &snapshot.writer.observers {
        add(Some(observer));
    }
    total
}

fn add_transcript_block_bytes(block: &UiTranscriptBlock, add: &mut impl FnMut(Option<&str>)) {
    match block {
        UiTranscriptBlock::Markdown(block) => {
            add(Some(&block.id));
            add(Some(&block.role));
            add(Some(&block.text));
        }
        UiTranscriptBlock::Code(block) => {
            add(Some(&block.id));
            add(Some(&block.role));
            add(Some(&block.language));
            add(Some(&block.code));
            add(block.file_path.as_deref());
        }
        UiTranscriptBlock::Tool(block) => {
            add(Some(&block.id));
            add(Some(&block.name));
            add(Some(&block.status));
            add(block.input.as_deref());
            add(block.output.as_deref());
        }
        UiTranscriptBlock::Thinking(block) => {
            add(Some(&block.id));
            add(Some(&block.summary));
            add(Some(&block.effort));
        }
        UiTranscriptBlock::Report(block) => {
            add(Some(&block.id));
            add(Some(&block.task_id));
            add(Some(&block.status));
            add(Some(&block.summary));
            add(Some(&block.effort_used));
            for value in block.changed_files.iter().chain(&block.evidence) {
                add(Some(value));
            }
        }
        UiTranscriptBlock::Error(block) => {
            add(Some(&block.id));
            add(Some(&block.code));
            add(Some(&block.message));
            add(block.detail.as_deref());
        }
    }
}

fn transcript_block_byte_length(block: &UiTranscriptBlock) -> usize {
    let mut total = 0usize;
    let mut add = |value: Option<&str>| {
        if let Some(value) = value {
            total += byte_len(value);
        }
    };
    add_transcript_block_bytes(block, &mut add);
    total
}

/// Trim transcript blocks from the front until the snapshot fits the
/// `UI_MAX_SNAPSHOT_BYTES` budget, mirroring the TS `enforceSnapshotByteBudget`.
fn enforce_snapshot_byte_budget(
    mut snapshot: UiRenderSnapshot,
) -> Result<UiRenderSnapshot, ProjectionError> {
    let mut fixed = snapshot.clone();
    fixed.transcript = Vec::new();
    if snapshot_byte_length(&fixed) > UI_MAX_SNAPSHOT_BYTES {
        return Err(projection(format!(
            "snapshot aggregate exceeds {UI_MAX_SNAPSHOT_BYTES} bytes"
        )));
    }
    let mut total = snapshot_byte_length(&fixed);
    let mut retained: Vec<UiTranscriptBlock> = Vec::new();
    for block in snapshot.transcript.iter().rev() {
        let size = transcript_block_byte_length(block);
        if total + size > UI_MAX_SNAPSHOT_BYTES {
            break;
        }
        total += size;
        retained.push(block.clone());
    }
    retained.reverse();
    if retained.len() != snapshot.transcript.len() {
        snapshot.transcript = retained;
    }
    Ok(snapshot)
}

pub fn project_render_snapshot(
    id: &str,
    sequence: u64,
    input: &ProjectionInput,
) -> Result<UiRenderSnapshot, ProjectionError> {
    let id = text(id, "snapshot.id", UI_MAX_ID_BYTES, false)?;
    let snapshot = UiRenderSnapshot {
        version: UI_PROTOCOL_VERSION,
        id,
        sequence,
        sessions: project_sessions(&input.sessions)?,
        workspaces: project_workspaces(&input.workspaces)?,
        active_session_id: input
            .active_session_id
            .as_deref()
            .map(|value| text(value, "snapshot.active_session_id", UI_MAX_ID_BYTES, false))
            .transpose()?,
        status: project_status(&input.status)?,
        telemetry: project_telemetry(&input.telemetry)?,
        tasks: project_tasks(&input.tasks)?,
        agents: project_agents(&input.agents)?,
        transcript: project_transcript(&input.transcript)?,
        transcript_window: project_transcript_window(&input.transcript_window)?,
        changes: project_changes(&input.changes)?,
        activity: project_activity(&input.activity)?,
        permissions: project_permissions(&input.permissions)?,
        providers: project_providers(&input.providers)?,
        writer: project_writer(&input.writer)?,
    };
    enforce_snapshot_byte_budget(snapshot)
}

// ---------------------------------------------------------------------------
// Revision clock and projection store.
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct RevisionClock {
    revision: u64,
}

impl RevisionClock {
    pub fn new(initial: u64) -> Self {
        Self { revision: initial }
    }

    pub fn current(&self) -> u64 {
        self.revision
    }

    fn next(&mut self) -> Result<u64, ProjectionError> {
        if self.revision == u64::MAX {
            return Err(projection("revision exhausted"));
        }
        self.revision += 1;
        Ok(self.revision)
    }
}

#[derive(Debug)]
pub struct ProjectionStore {
    clock: RevisionClock,
    session_id: String,
    last_snapshot: Option<UiRenderSnapshot>,
}

impl ProjectionStore {
    pub fn new(session_id: impl Into<String>) -> Result<Self, ProjectionError> {
        let session_id = text(&session_id.into(), "session id", UI_MAX_ID_BYTES, false)?;
        Ok(Self {
            clock: RevisionClock::new(0),
            session_id,
            last_snapshot: None,
        })
    }

    pub fn revision(&self) -> u64 {
        self.clock.current()
    }

    pub fn snapshot(&self) -> Option<&UiRenderSnapshot> {
        self.last_snapshot.as_ref()
    }

    pub fn update(&mut self, input: &ProjectionInput) -> Result<UiRenderSnapshot, ProjectionError> {
        if self.clock.current() == u64::MAX {
            return Err(projection("revision exhausted"));
        }
        let snapshot = project_render_snapshot(&self.session_id, self.clock.current() + 1, input)?;
        self.clock.next()?;
        self.last_snapshot = Some(snapshot.clone());
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(state: &str) -> StatusInput {
        StatusInput {
            state: Some(state.to_owned()),
            ..Default::default()
        }
    }

    #[test]
    fn redacts_forge_bearer_and_pem_secrets() {
        let redacted = redact_sensitive(
            "key forge-abc123secret and Bearer deadbeef plus\n-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----\ndone",
        );
        assert!(!redacted.contains("abc123secret"), "{redacted}");
        assert!(!redacted.contains("deadbeef"), "{redacted}");
        assert!(!redacted.contains("-----BEGIN"), "{redacted}");
        assert!(redacted.contains("[redacted]"));
    }

    #[test]
    fn truncate_utf8_preserves_code_point_boundaries() {
        // 'é' is two bytes; truncating at 3 bytes must keep the whole 'é'.
        let value = truncate_utf8("aé", 3);
        assert_eq!(value, "aé");
    }

    #[test]
    fn status_defaults_to_ready() {
        let snapshot = project_status(&StatusInput::default()).unwrap();
        assert_eq!(snapshot.state, "ready");
        assert!(snapshot.message.is_none());
    }

    #[test]
    fn telemetry_defaults_model_and_effort() {
        let snapshot = project_telemetry(&TelemetryInput::default()).unwrap();
        assert_eq!(snapshot.model, DEFAULT_MODEL);
        assert_eq!(snapshot.effort, DEFAULT_EFFORT);
        assert_eq!(snapshot.connection.state, "disconnected");
    }

    #[test]
    fn telemetry_rejects_context_overflow() {
        let input = TelemetryInput {
            context_used_tokens: Some(10),
            context_limit_tokens: Some(5),
            ..Default::default()
        };
        assert!(project_telemetry(&input).is_err());
    }

    #[test]
    fn transcript_skips_raw_tool_entries_and_projects_entries() {
        let blocks = project_transcript(&[
            TranscriptInput::Entry {
                sequence: 0,
                role: "assistant".into(),
                text: "hello".into(),
            },
            TranscriptInput::Entry {
                sequence: 1,
                role: "tool".into(),
                text: "ignored".into(),
            },
        ])
        .unwrap();
        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            UiTranscriptBlock::Markdown(block) => {
                assert_eq!(block.role, "assistant");
                assert_eq!(block.text, "hello");
            }
            other => panic!("expected markdown block, got {other:?}"),
        }
    }

    #[test]
    fn projection_store_bumps_revision_monotonically() {
        let mut store = ProjectionStore::new("session-1").unwrap();
        assert_eq!(store.revision(), 0);
        assert!(store.snapshot().is_none());
        let first = store.update(&ProjectionInput {
            status: status("ready"),
            ..Default::default()
        });
        let first = first.unwrap();
        assert_eq!(first.sequence, 1);
        assert_eq!(store.revision(), 1);
        let second = store
            .update(&ProjectionInput {
                status: status("working"),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(second.sequence, 2);
        assert_eq!(store.snapshot().unwrap().status.state, "working");
    }

    #[test]
    fn sessions_reject_duplicate_or_oversized_input() {
        let input = vec![
            SessionInput {
                id: "s1".into(),
                name: None,
                workspace: None,
                status: None,
                model: None,
                effort: None,
                active: None,
                pinned: None,
                unread: None,
                created_at_ms: None,
                updated_at_ms: None,
            },
            SessionInput {
                id: "s2".into(),
                name: None,
                workspace: None,
                status: None,
                model: None,
                effort: None,
                active: None,
                pinned: None,
                unread: None,
                created_at_ms: None,
                updated_at_ms: None,
            },
        ];
        let sessions = project_sessions(&input).unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].name, "s1");
    }
}
