import {
  NATIVE_TUI_MAX_ACTION_BYTES,
  NATIVE_TUI_MAX_ACTION_VALUE_BYTES,
  NATIVE_TUI_MAX_ACTIVITY,
  NATIVE_TUI_MAX_ACTIVITY_ID_BYTES,
  NATIVE_TUI_MAX_ACTIVITY_MESSAGE_BYTES,
  NATIVE_TUI_MAX_AGENT_ID_BYTES,
  NATIVE_TUI_MAX_AGENT_NAME_BYTES,
  NATIVE_TUI_MAX_AGENTS,
  NATIVE_TUI_MAX_CONNECTION_BYTES,
  NATIVE_TUI_MAX_CODE_BYTES,
  NATIVE_TUI_MAX_DEPENDENCIES,
  NATIVE_TUI_MAX_DIFF_BYTES,
  NATIVE_TUI_MAX_EFFORT_BYTES,
  NATIVE_TUI_MAX_FILES,
  NATIVE_TUI_MAX_FILE_PATH_BYTES,
  NATIVE_TUI_MAX_ID_BYTES,
  NATIVE_TUI_MAX_LANGUAGE_BYTES,
  NATIVE_TUI_MAX_MESSAGE_BYTES,
  NATIVE_TUI_MAX_MODEL_BYTES,
  NATIVE_TUI_MAX_PERMISSION_ID_BYTES,
  NATIVE_TUI_MAX_PERMISSION_TEXT_BYTES,
  NATIVE_TUI_MAX_PERMISSIONS,
  NATIVE_TUI_MAX_REPORT_EVIDENCE,
  NATIVE_TUI_MAX_REPORT_EVIDENCE_BYTES,
  NATIVE_TUI_MAX_SESSIONS,
  NATIVE_TUI_MAX_SESSION_NAME_BYTES,
  NATIVE_TUI_MAX_SNAPSHOT_BYTES,
  NATIVE_TUI_MAX_STATUS_BYTES,
  NATIVE_TUI_MAX_TASK_ID_BYTES,
  NATIVE_TUI_MAX_TASK_TITLE_BYTES,
  NATIVE_TUI_MAX_TASKS,
  NATIVE_TUI_MAX_TOOL_ARGUMENTS_BYTES,
  NATIVE_TUI_MAX_TOOL_NAME_BYTES,
  NATIVE_TUI_MAX_TOOL_OUTPUT_BYTES,
  NATIVE_TUI_MAX_TRANSCRIPT_BLOCKS,
  NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES,
  NATIVE_TUI_MAX_TRANSCRIPT_ROLE_BYTES,
  NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES,
  NATIVE_TUI_MAX_WORKSPACES,
  NATIVE_TUI_MAX_WORKSPACE_BYTES,
  NATIVE_TUI_PROTOCOL_VERSION,
  type NativeTuiActivitySnapshot,
  type NativeTuiAgentSnapshot,
  type NativeTuiChangeSnapshot,
  type NativeTuiCodeBlock,
  type NativeTuiConnectionSnapshot,
  type NativeTuiErrorBlock,
  type NativeTuiMarkdownBlock,
  type NativeTuiPermissionRequest,
  type NativeTuiRenderSnapshot,
  type NativeTuiSessionSnapshot,
  type NativeTuiStatusSnapshot,
  type NativeTuiTaskMetadata,
  type NativeTuiTaskSnapshot,
  type NativeTuiTelemetrySnapshot,
  type NativeTuiThinkingBlock,
  type NativeTuiToolBlock,
  type NativeTuiTranscriptBlock,
  type NativeTuiTranscriptWindow,
  type NativeTuiWriterState,
  type NativeTuiWorkspaceSnapshot,
} from "./protocol.js";

export type NativeTuiStatusInput = {
  state?: string;
  message?: string | null;
  detail?: string | null;
};

export type NativeTuiConnectionInput = {
  state?: string;
  reconnect_attempts?: number;
  last_error?: string | null;
};

export type NativeTuiTelemetryInput = {
  connection?: NativeTuiConnectionInput;
  model?: string;
  effort?: string;
  context_used_tokens?: number;
  context_limit_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  credits?: number;
  active_agents?: number;
  queued_tasks?: number;
  api_requests?: number;
  latency_ms?: number;
};

export type NativeTuiSessionInput = Partial<NativeTuiSessionSnapshot> & {
  id: string;
};

export type NativeTuiWorkspaceInput = Partial<NativeTuiWorkspaceSnapshot> & {
  id: string;
};

export type NativeTuiTaskInput = {
  id: string;
  title?: string;
  status?: string;
  detail?: string | null;
  progress?: number | null;
  metadata?: Partial<NativeTuiTaskMetadata>;
  parent_id?: string | null;
  owner?: string | null;
  agent_id?: string | null;
  model?: string | null;
  effort?: string | null;
  dependencies?: readonly string[];
  blocked_by?: readonly string[];
  files_touched?: readonly string[];
  isolation?: string | null;
};

export type NativeTuiAgentInput = Partial<NativeTuiAgentSnapshot> & {
  id: string;
};

export type NativeTuiTranscriptInput = {
  sequence: number;
  role: string;
  text: string;
};

export type NativeTuiTranscriptWindowInput = {
  start_sequence: number;
  end_sequence: number;
  has_older: boolean;
  has_newer: boolean;
  blocks: readonly NativeTuiTranscriptBlock[];
};

export type NativeTuiChangeInput = Partial<NativeTuiChangeSnapshot> & {
  path: string;
};

export type NativeTuiActivityInput = Partial<NativeTuiActivitySnapshot> & {
  id?: string;
};

export type NativeTuiPermissionInput = Partial<NativeTuiPermissionRequest> & {
  id?: string;
};

export type NativeTuiWriterInput = Partial<NativeTuiWriterState>;

export type NativeTuiProjectionInput = {
  status?: NativeTuiStatusInput;
  sessions?: readonly NativeTuiSessionInput[];
  workspaces?: readonly NativeTuiWorkspaceInput[];
  active_session_id?: string | null;
  telemetry?: NativeTuiTelemetryInput;
  tasks?: readonly NativeTuiTaskInput[];
  agents?: readonly NativeTuiAgentInput[];
  transcript?: readonly (NativeTuiTranscriptInput | NativeTuiTranscriptBlock)[];
  transcript_window?: NativeTuiTranscriptWindowInput | null;
  changes?: readonly NativeTuiChangeInput[];
  activity?: readonly NativeTuiActivityInput[];
  permissions?: readonly NativeTuiPermissionInput[];
  writer?: NativeTuiWriterInput;
};

export class NativeTuiProjectionError extends Error {
  readonly code = "NATIVE_TUI_PROJECTION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "NativeTuiProjectionError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function projectStatus(
  input: NativeTuiStatusInput = {},
): NativeTuiStatusSnapshot {
  const result: NativeTuiStatusSnapshot = {
    state: text(input.state ?? "ready", "status.state", NATIVE_TUI_MAX_STATUS_BYTES, false),
  };
  if (input.message !== undefined && input.message !== null) {
    result.message = text(input.message, "status.message", NATIVE_TUI_MAX_STATUS_BYTES, true);
  }
  if (input.detail !== undefined && input.detail !== null) {
    result.detail = text(input.detail, "status.detail", NATIVE_TUI_MAX_STATUS_BYTES, true);
  }
  return result;
}

export function projectTelemetry(
  input: NativeTuiTelemetryInput = {},
): NativeTuiTelemetrySnapshot {
  const connectionInput = input.connection ?? {};
  const contextLimit = integer(
    input.context_limit_tokens ?? 1_100_000,
    "telemetry.context_limit_tokens",
    1,
  );
  const contextUsed = integer(
    input.context_used_tokens ?? 0,
    "telemetry.context_used_tokens",
    0,
  );
  if (contextUsed > contextLimit) {
    throw projection("telemetry context usage exceeds context limit");
  }
  return {
    connection: projectConnection(connectionInput),
    model: text(input.model ?? "gpt-5.6-luna", "telemetry.model", NATIVE_TUI_MAX_MODEL_BYTES, false),
    effort: text(input.effort ?? "medium", "telemetry.effort", NATIVE_TUI_MAX_EFFORT_BYTES, false),
    context_used_tokens: contextUsed,
    context_limit_tokens: contextLimit,
    input_tokens: integer(input.input_tokens ?? 0, "telemetry.input_tokens", 0),
    output_tokens: integer(input.output_tokens ?? 0, "telemetry.output_tokens", 0),
    cached_tokens: integer(input.cached_tokens ?? 0, "telemetry.cached_tokens", 0),
    reasoning_tokens: integer(input.reasoning_tokens ?? 0, "telemetry.reasoning_tokens", 0),
    credits: finiteNumber(input.credits ?? 0, "telemetry.credits"),
    active_agents: integer(input.active_agents ?? 0, "telemetry.active_agents", 0, 65_535),
    queued_tasks: integer(input.queued_tasks ?? 0, "telemetry.queued_tasks", 0, 65_535),
    api_requests: integer(input.api_requests ?? 0, "telemetry.api_requests", 0),
    latency_ms: integer(input.latency_ms ?? 0, "telemetry.latency_ms", 0),
  };
}

function projectConnection(input: NativeTuiConnectionInput): NativeTuiConnectionSnapshot {
  const result: NativeTuiConnectionSnapshot = {
    state: text(input.state ?? "disconnected", "telemetry.connection.state", NATIVE_TUI_MAX_CONNECTION_BYTES, false),
    reconnect_attempts: integer(input.reconnect_attempts ?? 0, "telemetry.connection.reconnect_attempts", 0),
  };
  if (input.last_error !== undefined && input.last_error !== null) {
    result.last_error = text(input.last_error, "telemetry.connection.last_error", NATIVE_TUI_MAX_MESSAGE_BYTES, true);
  }
  return result;
}

export function projectSessions(
  inputs: readonly NativeTuiSessionInput[] = [],
): NativeTuiSessionSnapshot[] {
  if (!Array.isArray(inputs) || inputs.length > NATIVE_TUI_MAX_SESSIONS) throw projection("sessions exceeds its maximum size");
  return inputs.map((input, index) => {
    if (!input || typeof input !== "object") throw projection(`sessions[${index}] must be an object`);
    const id = text(input.id, `sessions[${index}].id`, NATIVE_TUI_MAX_ID_BYTES, false);
    return {
      id,
      name: text(input.name ?? id, `sessions[${index}].name`, NATIVE_TUI_MAX_SESSION_NAME_BYTES, false),
      workspace: text(input.workspace ?? "unknown", `sessions[${index}].workspace`, NATIVE_TUI_MAX_WORKSPACE_BYTES, false),
      status: text(input.status ?? "idle", `sessions[${index}].status`, NATIVE_TUI_MAX_STATUS_BYTES, false),
      model: text(input.model ?? "gpt-5.6-luna", `sessions[${index}].model`, NATIVE_TUI_MAX_MODEL_BYTES, false),
      effort: text(input.effort ?? "medium", `sessions[${index}].effort`, NATIVE_TUI_MAX_EFFORT_BYTES, false),
      active: input.active ?? false,
      pinned: input.pinned ?? false,
      unread: integer(input.unread ?? 0, `sessions[${index}].unread`, 0, 0xffff_ffff),
      created_at_ms: integer(input.created_at_ms ?? 0, `sessions[${index}].created_at_ms`, 0),
      updated_at_ms: integer(input.updated_at_ms ?? 0, `sessions[${index}].updated_at_ms`, 0),
    };
  });
}

export function projectWorkspaces(
  inputs: readonly NativeTuiWorkspaceInput[] = [],
): NativeTuiWorkspaceSnapshot[] {
  if (!Array.isArray(inputs) || inputs.length > NATIVE_TUI_MAX_WORKSPACES) throw projection("workspaces exceeds its maximum size");
  return inputs.map((input, index) => {
    if (!input || typeof input !== "object") throw projection(`workspaces[${index}] must be an object`);
    const id = text(input.id, `workspaces[${index}].id`, NATIVE_TUI_MAX_ID_BYTES, false);
    return {
      id,
      name: text(input.name ?? id, `workspaces[${index}].name`, NATIVE_TUI_MAX_SESSION_NAME_BYTES, false),
      path: text(input.path ?? "unknown", `workspaces[${index}].path`, NATIVE_TUI_MAX_WORKSPACE_BYTES, false),
      active: input.active ?? false,
    };
  });
}

export function projectTasks(
  inputs: readonly NativeTuiTaskInput[] = [],
): NativeTuiTaskSnapshot[] {
  if (!Array.isArray(inputs) || inputs.length > NATIVE_TUI_MAX_TASKS) throw projection("tasks exceeds its maximum size");
  return inputs.map((input, index) => {
    if (!input || typeof input !== "object") throw projection(`tasks[${index}] must be an object`);
    const metadata = input.metadata ?? {};
    const result: NativeTuiTaskSnapshot = {
      id: text(input.id, `tasks[${index}].id`, NATIVE_TUI_MAX_TASK_ID_BYTES, false),
      title: text(input.title ?? "", `tasks[${index}].title`, NATIVE_TUI_MAX_TASK_TITLE_BYTES, true),
      status: text(input.status ?? "pending", `tasks[${index}].status`, NATIVE_TUI_MAX_STATUS_BYTES, false),
      metadata: {
        dependencies: strings(metadata.dependencies ?? input.dependencies ?? [], `tasks[${index}].metadata.dependencies`, NATIVE_TUI_MAX_DEPENDENCIES, NATIVE_TUI_MAX_TASK_ID_BYTES, false),
        blocked_by: strings(metadata.blocked_by ?? input.blocked_by ?? [], `tasks[${index}].metadata.blocked_by`, NATIVE_TUI_MAX_DEPENDENCIES, NATIVE_TUI_MAX_TASK_ID_BYTES, false),
        files_touched: strings(metadata.files_touched ?? input.files_touched ?? [], `tasks[${index}].metadata.files_touched`, NATIVE_TUI_MAX_FILES, NATIVE_TUI_MAX_FILE_PATH_BYTES, false),
      },
    };
    if (input.detail !== undefined && input.detail !== null) result.detail = text(input.detail, `tasks[${index}].detail`, NATIVE_TUI_MAX_STATUS_BYTES, true);
    if (input.progress !== undefined && input.progress !== null) result.progress = integer(input.progress, `tasks[${index}].progress`, 0, 100);
    const metadataFields = {
      parent_id: metadata.parent_id ?? input.parent_id,
      owner: metadata.owner ?? input.owner,
      agent_id: metadata.agent_id ?? input.agent_id,
      model: metadata.model ?? input.model,
      effort: metadata.effort ?? input.effort,
      isolation: metadata.isolation ?? input.isolation,
    };
    for (const [field, value] of Object.entries(metadataFields) as Array<[keyof typeof metadataFields, string | null | undefined]>) {
      if (value !== undefined && value !== null) {
        const max = field === "parent_id" ? NATIVE_TUI_MAX_TASK_ID_BYTES : field === "agent_id" ? NATIVE_TUI_MAX_AGENT_ID_BYTES : field === "model" ? NATIVE_TUI_MAX_MODEL_BYTES : field === "effort" ? NATIVE_TUI_MAX_EFFORT_BYTES : field === "isolation" ? NATIVE_TUI_MAX_CONNECTION_BYTES : NATIVE_TUI_MAX_AGENT_NAME_BYTES;
        result.metadata[field] = text(value, `tasks[${index}].metadata.${field}`, max, false);
      }
    }
    return result;
  });
}

export function projectAgents(
  inputs: readonly NativeTuiAgentInput[] = [],
): NativeTuiAgentSnapshot[] {
  if (!Array.isArray(inputs) || inputs.length > NATIVE_TUI_MAX_AGENTS) throw projection("agents exceeds its maximum size");
  return inputs.map((input, index) => {
    if (!input || typeof input !== "object") throw projection(`agents[${index}] must be an object`);
    const result: NativeTuiAgentSnapshot = {
      id: text(input.id, `agents[${index}].id`, NATIVE_TUI_MAX_AGENT_ID_BYTES, false),
      name: text(input.name ?? input.id, `agents[${index}].name`, NATIVE_TUI_MAX_AGENT_NAME_BYTES, false),
      role: text(input.role ?? "worker", `agents[${index}].role`, NATIVE_TUI_MAX_AGENT_NAME_BYTES, false),
      status: text(input.status ?? "idle", `agents[${index}].status`, NATIVE_TUI_MAX_STATUS_BYTES, false),
      model: text(input.model ?? "gpt-5.6-luna", `agents[${index}].model`, NATIVE_TUI_MAX_MODEL_BYTES, false),
      effort: text(input.effort ?? "medium", `agents[${index}].effort`, NATIVE_TUI_MAX_EFFORT_BYTES, false),
    };
    for (const field of ["parent_id", "task_id"] as const) if (input[field] !== undefined && input[field] !== null) result[field] = text(input[field], `agents[${index}].${field}`, field === "parent_id" ? NATIVE_TUI_MAX_AGENT_ID_BYTES : NATIVE_TUI_MAX_TASK_ID_BYTES, false);
    if (input.progress !== undefined && input.progress !== null) result.progress = integer(input.progress, `agents[${index}].progress`, 0, 100);
    return result;
  });
}

export function projectTranscript(
  inputs: readonly (NativeTuiTranscriptInput | NativeTuiTranscriptBlock)[] = [],
): NativeTuiTranscriptBlock[] {
  if (!Array.isArray(inputs)) throw projection("transcript must be an array");
  if (inputs.length > NATIVE_TUI_MAX_TRANSCRIPT_BLOCKS) {
    throw projection("transcript exceeds its maximum size");
  }
  const blocks: NativeTuiTranscriptBlock[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    if (!input || typeof input !== "object") throw projection(`transcript[${index}] must be an object`);
    if (isTranscriptBlock(input)) {
      blocks.push(projectTranscriptBlock(input, `transcript[${index}]`));
      continue;
    }
    if (isRawToolEntry(input)) continue;
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw projection(`transcript[${index}].sequence must be a non-negative integer`);
    const role = text(input.role, `transcript[${index}].role`, NATIVE_TUI_MAX_TRANSCRIPT_ROLE_BYTES, false);
    const sequence = input.sequence;
    blocks.push({
      type: "markdown",
      id: text(`${role}-${sequence}`, `transcript[${index}].id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
      sequence,
      role,
      text: text(input.text, `transcript[${index}].text`, NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES, true),
    });
  }
  return blocks;
}

function projectTranscriptBlock(
  input: NativeTuiTranscriptBlock,
  context: string,
): NativeTuiTranscriptBlock {
  switch (input.type) {
    case "markdown":
      return {
        type: "markdown",
        id: text(input.id, `${context}.id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
        sequence: integer(input.sequence, `${context}.sequence`, 0),
        role: text(input.role, `${context}.role`, NATIVE_TUI_MAX_TRANSCRIPT_ROLE_BYTES, false),
        text: text(input.text, `${context}.text`, NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES, true),
        ...(input.created_at_ms === undefined ? {} : { created_at_ms: integer(input.created_at_ms, `${context}.created_at_ms`, 0) }),
      } satisfies NativeTuiMarkdownBlock;
    case "code": {
      const startLine = input.start_line === undefined
        ? undefined
        : integer(input.start_line, `${context}.start_line`, 0, 0xffff_ffff);
      const endLine = input.end_line === undefined
        ? undefined
        : integer(input.end_line, `${context}.end_line`, 0, 0xffff_ffff);
      if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
        throw projection(`${context} start line must not exceed end line`);
      }
      return {
        type: "code",
        id: text(input.id, `${context}.id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
        sequence: integer(input.sequence, `${context}.sequence`, 0),
        role: text(input.role, `${context}.role`, NATIVE_TUI_MAX_TRANSCRIPT_ROLE_BYTES, false),
        language: text(input.language, `${context}.language`, NATIVE_TUI_MAX_LANGUAGE_BYTES, false),
        code: text(input.code, `${context}.code`, NATIVE_TUI_MAX_CODE_BYTES * 4_096, true),
        ...(input.file_path === undefined ? {} : { file_path: text(input.file_path, `${context}.file_path`, NATIVE_TUI_MAX_FILE_PATH_BYTES, true) }),
        ...(startLine === undefined ? {} : { start_line: startLine }),
        ...(endLine === undefined ? {} : { end_line: endLine }),
      } satisfies NativeTuiCodeBlock;
    }
    case "tool":
      return {
        type: "tool",
        id: text(input.id, `${context}.id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
        sequence: integer(input.sequence, `${context}.sequence`, 0),
        name: text(input.name, `${context}.name`, NATIVE_TUI_MAX_TOOL_NAME_BYTES, false),
        status: text(input.status, `${context}.status`, NATIVE_TUI_MAX_STATUS_BYTES, false),
        ...(input.input === undefined ? {} : { input: text(input.input, `${context}.input`, NATIVE_TUI_MAX_TOOL_ARGUMENTS_BYTES, true) }),
        ...(input.output === undefined ? {} : { output: text(input.output, `${context}.output`, NATIVE_TUI_MAX_TOOL_OUTPUT_BYTES, true) }),
        ...(input.duration_ms === undefined ? {} : { duration_ms: integer(input.duration_ms, `${context}.duration_ms`, 0) }),
      } satisfies NativeTuiToolBlock;
    case "thinking":
      return {
        type: "thinking",
        id: text(input.id, `${context}.id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
        sequence: integer(input.sequence, `${context}.sequence`, 0),
        summary: text(input.summary, `${context}.summary`, NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES, true),
        effort: text(input.effort, `${context}.effort`, NATIVE_TUI_MAX_EFFORT_BYTES, false),
        elapsed_ms: integer(input.elapsed_ms, `${context}.elapsed_ms`, 0),
        tokens_used: integer(input.tokens_used, `${context}.tokens_used`, 0),
      } satisfies NativeTuiThinkingBlock;
    case "report":
      return {
        type: "report",
        id: text(input.id, `${context}.id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
        sequence: integer(input.sequence, `${context}.sequence`, 0),
        task_id: text(input.task_id, `${context}.task_id`, NATIVE_TUI_MAX_TASK_ID_BYTES, false),
        status: text(input.status, `${context}.status`, NATIVE_TUI_MAX_STATUS_BYTES, false),
        summary: text(input.summary, `${context}.summary`, NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES, true),
        changed_files: strings(input.changed_files, `${context}.changed_files`, NATIVE_TUI_MAX_FILES, NATIVE_TUI_MAX_FILE_PATH_BYTES, false),
        evidence: strings(input.evidence, `${context}.evidence`, NATIVE_TUI_MAX_REPORT_EVIDENCE, NATIVE_TUI_MAX_REPORT_EVIDENCE_BYTES, true),
        tokens_used: integer(input.tokens_used, `${context}.tokens_used`, 0),
        effort_used: text(input.effort_used, `${context}.effort_used`, NATIVE_TUI_MAX_EFFORT_BYTES, false),
      };
    case "error":
      return {
        type: "error",
        id: text(input.id, `${context}.id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
        sequence: integer(input.sequence, `${context}.sequence`, 0),
        code: text(input.code, `${context}.code`, 128, false),
        message: text(input.message, `${context}.message`, NATIVE_TUI_MAX_MESSAGE_BYTES, true),
        ...(input.detail === undefined ? {} : { detail: text(input.detail, `${context}.detail`, NATIVE_TUI_MAX_MESSAGE_BYTES, true) }),
        recoverable: input.recoverable,
      } satisfies NativeTuiErrorBlock;
  }
}

export function projectTranscriptWindow(
  input: NativeTuiTranscriptWindowInput | null | undefined,
): NativeTuiTranscriptWindow | undefined {
  if (input === undefined || input === null) return undefined;
  const start = integer(input.start_sequence, "transcript_window.start_sequence", 0);
  const end = integer(input.end_sequence, "transcript_window.end_sequence", 0);
  if (start > end) throw projection("transcript window start sequence must not exceed end sequence");
  return {
    start_sequence: start,
    end_sequence: end,
    has_older: input.has_older,
    has_newer: input.has_newer,
    blocks: projectTranscript(input.blocks),
  };
}

export function projectChanges(
  inputs: readonly NativeTuiChangeInput[] = [],
): NativeTuiChangeSnapshot[] {
  if (!Array.isArray(inputs) || inputs.length > NATIVE_TUI_MAX_FILES) throw projection("changes exceeds its maximum size");
  return inputs.map((input, index) => {
    if (!input || typeof input !== "object") throw projection(`changes[${index}] must be an object`);
    const result: NativeTuiChangeSnapshot = {
      path: text(input.path, `changes[${index}].path`, NATIVE_TUI_MAX_FILE_PATH_BYTES, false),
      kind: text(input.kind ?? "modified", `changes[${index}].kind`, NATIVE_TUI_MAX_CONNECTION_BYTES, false),
      additions: integer(input.additions ?? 0, `changes[${index}].additions`, 0),
      deletions: integer(input.deletions ?? 0, `changes[${index}].deletions`, 0),
      staged: input.staged ?? false,
    };
    if (input.language !== undefined && input.language !== null) result.language = text(input.language, `changes[${index}].language`, NATIVE_TUI_MAX_LANGUAGE_BYTES, true);
    if (input.diff !== undefined && input.diff !== null) result.diff = text(input.diff, `changes[${index}].diff`, NATIVE_TUI_MAX_DIFF_BYTES, true);
    return result;
  });
}

export function projectActivity(
  inputs: readonly NativeTuiActivityInput[] = [],
): NativeTuiActivitySnapshot[] {
  if (!Array.isArray(inputs) || inputs.length > NATIVE_TUI_MAX_ACTIVITY) throw projection("activity exceeds its maximum size");
  return inputs.map((input, index) => {
    if (!input || typeof input !== "object") throw projection(`activity[${index}] must be an object`);
    const result: NativeTuiActivitySnapshot = {
      id: text(input.id ?? `activity-${index}`, `activity[${index}].id`, NATIVE_TUI_MAX_ACTIVITY_ID_BYTES, false),
      timestamp_ms: integer(input.timestamp_ms ?? 0, `activity[${index}].timestamp_ms`, 0),
      kind: text(input.kind ?? "info", `activity[${index}].kind`, NATIVE_TUI_MAX_CONNECTION_BYTES, false),
      message: text(input.message ?? "", `activity[${index}].message`, NATIVE_TUI_MAX_ACTIVITY_MESSAGE_BYTES, true),
      severity: text(input.severity ?? "info", `activity[${index}].severity`, NATIVE_TUI_MAX_CONNECTION_BYTES, false),
    };
    for (const field of ["task_id", "agent_id"] as const) if (input[field] !== undefined && input[field] !== null) result[field] = text(input[field], `activity[${index}].${field}`, field === "task_id" ? NATIVE_TUI_MAX_TASK_ID_BYTES : NATIVE_TUI_MAX_AGENT_ID_BYTES, false);
    return result;
  });
}

export function projectPermissions(
  inputs: readonly NativeTuiPermissionInput[] = [],
): NativeTuiPermissionRequest[] {
  if (!Array.isArray(inputs) || inputs.length > NATIVE_TUI_MAX_PERMISSIONS) throw projection("permissions exceeds its maximum size");
  return inputs.map((input, index) => {
    if (!input || typeof input !== "object") throw projection(`permissions[${index}] must be an object`);
    const result: NativeTuiPermissionRequest = {
      id: text(input.id ?? `permission-${index}`, `permissions[${index}].id`, NATIVE_TUI_MAX_PERMISSION_ID_BYTES, false),
      tool: text(input.tool ?? "unknown", `permissions[${index}].tool`, NATIVE_TUI_MAX_TOOL_NAME_BYTES, false),
      action: text(input.action ?? "request", `permissions[${index}].action`, NATIVE_TUI_MAX_PERMISSION_TEXT_BYTES, false),
      resource: text(input.resource ?? "", `permissions[${index}].resource`, NATIVE_TUI_MAX_PERMISSION_TEXT_BYTES, true),
      reason: text(input.reason ?? "", `permissions[${index}].reason`, NATIVE_TUI_MAX_PERMISSION_TEXT_BYTES, true),
      status: text(input.status ?? "pending", `permissions[${index}].status`, NATIVE_TUI_MAX_CONNECTION_BYTES, false),
      requested_at_ms: integer(input.requested_at_ms ?? 0, `permissions[${index}].requested_at_ms`, 0),
    };
    if (input.expires_at_ms !== undefined && input.expires_at_ms !== null) result.expires_at_ms = integer(input.expires_at_ms, `permissions[${index}].expires_at_ms`, 0);
    for (const field of ["task_id", "agent_id"] as const) if (input[field] !== undefined && input[field] !== null) result[field] = text(input[field], `permissions[${index}].${field}`, field === "task_id" ? NATIVE_TUI_MAX_TASK_ID_BYTES : NATIVE_TUI_MAX_AGENT_ID_BYTES, false);
    return result;
  });
}

export function projectWriter(
  input: NativeTuiWriterInput = {},
): NativeTuiWriterState {
  const result: NativeTuiWriterState = {
    mode: text(input.mode ?? "observer", "writer.mode", NATIVE_TUI_MAX_CONNECTION_BYTES, false),
    observers: strings(input.observers ?? [], "writer.observers", 64, NATIVE_TUI_MAX_ID_BYTES, false),
  };
  if (input.writer_id !== undefined && input.writer_id !== null) result.writer_id = text(input.writer_id, "writer.writer_id", NATIVE_TUI_MAX_ID_BYTES, false);
  if (input.lease_expires_at_ms !== undefined && input.lease_expires_at_ms !== null) result.lease_expires_at_ms = integer(input.lease_expires_at_ms, "writer.lease_expires_at_ms", 0);
  return result;
}

export function projectRenderSnapshot(
  id: string,
  sequence: number,
  input: NativeTuiProjectionInput = {},
): NativeTuiRenderSnapshot {
  const snapshot: NativeTuiRenderSnapshot = {
    type: "render_snapshot",
    version: NATIVE_TUI_PROTOCOL_VERSION,
    id: text(id, "snapshot.id", NATIVE_TUI_MAX_ID_BYTES, false),
    sequence: integer(sequence, "snapshot sequence", 0),
    sessions: projectSessions(input.sessions),
    workspaces: projectWorkspaces(input.workspaces),
    status: projectStatus(input.status),
    telemetry: projectTelemetry(input.telemetry),
    tasks: projectTasks(input.tasks),
    agents: projectAgents(input.agents),
    transcript: projectTranscript(input.transcript),
    changes: projectChanges(input.changes),
    activity: projectActivity(input.activity),
    permissions: projectPermissions(input.permissions),
    writer: projectWriter(input.writer),
  };
  if (input.active_session_id !== null) snapshot.active_session_id = text(input.active_session_id ?? snapshot.id, "snapshot.active_session_id", NATIVE_TUI_MAX_ID_BYTES, false);
  const window = projectTranscriptWindow(input.transcript_window);
  if (window) snapshot.transcript_window = window;
  return enforceSnapshotByteBudget(snapshot);
}

export function nativeTuiSnapshotByteLength(
  snapshot: NativeTuiRenderSnapshot,
): number {
  let total = 0;
  const add = (value: string | undefined): void => {
    if (value !== undefined) total += byteLength(value);
  };
  add(snapshot.id); add(snapshot.active_session_id); add(snapshot.status.state); add(snapshot.status.message); add(snapshot.status.detail);
  add(snapshot.telemetry.connection.state); add(snapshot.telemetry.connection.last_error); add(snapshot.telemetry.model); add(snapshot.telemetry.effort);
  for (const item of snapshot.sessions) for (const value of [item.id, item.name, item.workspace, item.status, item.model, item.effort]) add(value);
  for (const item of snapshot.workspaces) for (const value of [item.id, item.name, item.path]) add(value);
  for (const item of snapshot.tasks) {
    add(item.id); add(item.title); add(item.status); add(item.detail);
    for (const value of [item.metadata.parent_id, item.metadata.owner, item.metadata.agent_id, item.metadata.model, item.metadata.effort, item.metadata.isolation]) add(value);
    for (const value of [...item.metadata.dependencies, ...item.metadata.blocked_by, ...item.metadata.files_touched]) add(value);
  }
  for (const item of snapshot.agents) for (const value of [item.id, item.name, item.role, item.status, item.parent_id, item.task_id, item.model, item.effort]) add(value);
  for (const block of snapshot.transcript) addTranscriptBlockBytes(block, add);
  if (snapshot.transcript_window) for (const block of snapshot.transcript_window.blocks) addTranscriptBlockBytes(block, add);
  for (const item of snapshot.changes) for (const value of [item.path, item.kind, item.language, item.diff]) add(value);
  for (const item of snapshot.activity) for (const value of [item.id, item.kind, item.message, item.task_id, item.agent_id, item.severity]) add(value);
  for (const item of snapshot.permissions) for (const value of [item.id, item.tool, item.action, item.resource, item.reason, item.status, item.task_id, item.agent_id]) add(value);
  add(snapshot.writer.mode); add(snapshot.writer.writer_id); for (const observer of snapshot.writer.observers) add(observer);
  return total;
}

function enforceSnapshotByteBudget(snapshot: NativeTuiRenderSnapshot): NativeTuiRenderSnapshot {
  const fixed = nativeTuiSnapshotByteLength({ ...snapshot, transcript: [] });
  if (fixed > NATIVE_TUI_MAX_SNAPSHOT_BYTES) throw projection(`snapshot aggregate exceeds ${NATIVE_TUI_MAX_SNAPSHOT_BYTES} bytes`);
  let total = fixed;
  const retained: NativeTuiTranscriptBlock[] = [];
  for (let index = snapshot.transcript.length - 1; index >= 0; index -= 1) {
    const block = snapshot.transcript[index];
    if (!block) continue;
    const size = transcriptBlockByteLength(block);
    if (total + size > NATIVE_TUI_MAX_SNAPSHOT_BYTES) break;
    total += size;
    retained.push(block);
  }
  retained.reverse();
  return retained.length === snapshot.transcript.length ? snapshot : { ...snapshot, transcript: retained };
}

export class NativeTuiRevisionClock {
  private revisionValue: number;

  constructor(initialRevision = 0) {
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) throw projection("initial revision must be a non-negative safe integer");
    this.revisionValue = initialRevision;
  }

  get current(): number { return this.revisionValue; }

  next(): number {
    if (this.revisionValue === Number.MAX_SAFE_INTEGER) throw projection("revision exhausted");
    this.revisionValue += 1;
    return this.revisionValue;
  }
}

export class NativeTuiProjectionStore {
  private readonly clock: NativeTuiRevisionClock;
  private readonly sessionId: string;
  private lastSnapshotValue?: NativeTuiRenderSnapshot;

  constructor(sessionId: string, initialRevision = 0) {
    this.sessionId = text(sessionId, "session id", NATIVE_TUI_MAX_ID_BYTES, false);
    this.clock = new NativeTuiRevisionClock(initialRevision);
  }

  get revision(): number { return this.clock.current; }
  get snapshot(): NativeTuiRenderSnapshot | undefined { return this.lastSnapshotValue; }

  update(input: NativeTuiProjectionInput): NativeTuiRenderSnapshot {
    if (this.clock.current === Number.MAX_SAFE_INTEGER) throw projection("revision exhausted");
    const snapshot = projectRenderSnapshot(this.sessionId, this.clock.current + 1, input);
    this.clock.next();
    this.lastSnapshotValue = snapshot;
    return snapshot;
  }
}

export const buildStatusProjection = projectStatus;
export const buildTelemetryProjection = projectTelemetry;
export const buildSessionsProjection = projectSessions;
export const buildWorkspacesProjection = projectWorkspaces;
export const buildTasksProjection = projectTasks;
export const buildAgentsProjection = projectAgents;
export const buildTranscriptProjection = projectTranscript;
export const buildChangesProjection = projectChanges;
export const buildActivityProjection = projectActivity;
export const buildPermissionsProjection = projectPermissions;
export const buildWriterProjection = projectWriter;
export const buildRenderProjection = projectRenderSnapshot;

function isTranscriptBlock(value: NativeTuiTranscriptInput | NativeTuiTranscriptBlock): value is NativeTuiTranscriptBlock {
  if (!("type" in value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "markdown":
    case "code":
    case "tool":
    case "thinking":
    case "report":
    case "error":
      return true;
    default:
      return false;
  }
}

function isRawToolEntry(value: NativeTuiTranscriptInput): boolean {
  const role = typeof value.role === "string" ? value.role.toLowerCase() : "";
  return role === "tool" || role === "tool_result" || role === "function";
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\bforge-[a-z0-9._~-]+\b/gi, "[redacted]")
    .replace(/((?:vexzy_api_key|api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted]");
}

function text(value: unknown, context: string, maxBytes: number, allowEmpty: boolean): string {
  if (typeof value !== "string") throw projection(`${context} must be a string`);
  if (!allowEmpty && value.length === 0) throw projection(`${context} must not be empty`);
  return truncateUtf8(redactSensitiveText(value), maxBytes);
}

function strings(value: readonly string[] | undefined, context: string, max: number, maxBytes: number, allowEmpty: boolean): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw projection(`${context} exceeds its maximum size`);
  return value.map((item, index) => text(item, `${context}[${index}]`, maxBytes, allowEmpty));
}

function integer(value: unknown, context: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw projection(`${context} must be a safe integer in range`);
  return value as number;
}

function finiteNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw projection(`${context} must be finite and non-negative`);
  return value;
}

function transcriptBlockByteLength(block: NativeTuiTranscriptBlock): number {
  let total = byteLength(block.id);
  const add = (value: string | undefined): void => { if (value !== undefined) total += byteLength(value); };
  switch (block.type) {
    case "markdown": add(block.role); add(block.text); break;
    case "code": add(block.role); add(block.language); add(block.code); add(block.file_path); break;
    case "tool": add(block.name); add(block.status); add(block.input); add(block.output); break;
    case "thinking": add(block.summary); add(block.effort); break;
    case "report": add(block.task_id); add(block.status); add(block.summary); add(block.effort_used); for (const item of [...block.changed_files, ...block.evidence]) add(item); break;
    case "error": add(block.code); add(block.message); add(block.detail); break;
  }
  return total;
}

function addTranscriptBlockBytes(block: NativeTuiTranscriptBlock, add: (value: string | undefined) => void): void {
  add(block.id);
  switch (block.type) {
    case "markdown": add(block.role); add(block.text); break;
    case "code": add(block.role); add(block.language); add(block.code); add(block.file_path); break;
    case "tool": add(block.name); add(block.status); add(block.input); add(block.output); break;
    case "thinking": add(block.summary); add(block.effort); break;
    case "report": add(block.task_id); add(block.status); add(block.summary); add(block.effort_used); for (const item of [...block.changed_files, ...block.evidence]) add(item); break;
    case "error": add(block.code); add(block.message); add(block.detail); break;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const bytes = encoder.encode(value);
  let boundary = maxBytes;
  while (boundary > 0 && (bytes[boundary - 1]! & 0xc0) === 0x80) boundary -= 1;
  if (boundary > 0) {
    const lead = bytes[boundary - 1]!;
    const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (boundary - 1 + width > maxBytes) boundary -= 1;
  }
  return decoder.decode(bytes.subarray(0, boundary));
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function projection(message: string): NativeTuiProjectionError {
  return new NativeTuiProjectionError(message);
}
