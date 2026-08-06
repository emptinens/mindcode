import {
  NATIVE_TUI_MAX_SNAPSHOT_BYTES,
  NATIVE_TUI_MAX_STATUS_BYTES,
  NATIVE_TUI_MAX_TASKS,
  NATIVE_TUI_MAX_TASK_ID_BYTES,
  NATIVE_TUI_MAX_TASK_TITLE_BYTES,
  NATIVE_TUI_MAX_TRANSCRIPT_ENTRIES,
  NATIVE_TUI_MAX_TRANSCRIPT_ROLE_BYTES,
  NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES,
  NATIVE_TUI_PROTOCOL_VERSION,
  type NativeTuiRenderSnapshot,
  type NativeTuiStatusSnapshot,
  type NativeTuiTaskSnapshot,
  type NativeTuiTranscriptEntry,
} from "./protocol.js";

export type NativeTuiStatusInput = {
  state: string;
  message?: string | null;
  detail?: string | null;
};

export type NativeTuiTaskInput = {
  id: string;
  title: string;
  status: string;
  detail?: string | null;
  progress?: number | null;
};

export type NativeTuiTranscriptInput = {
  sequence: number;
  role: string;
  text: string;
};

export type NativeTuiProjectionInput = {
  status: NativeTuiStatusInput;
  tasks?: readonly NativeTuiTaskInput[];
  transcript?: readonly NativeTuiTranscriptInput[];
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
  input: NativeTuiStatusInput,
): NativeTuiStatusSnapshot {
  if (!input || typeof input !== "object") {
    throw projection("status must be an object");
  }
  const state = text(
    input.state,
    "status.state",
    NATIVE_TUI_MAX_STATUS_BYTES,
    false,
  );
  const result: NativeTuiStatusSnapshot = { state };
  if (input.message !== undefined && input.message !== null) {
    result.message = text(
      input.message,
      "status.message",
      NATIVE_TUI_MAX_STATUS_BYTES,
      true,
    );
  }
  if (input.detail !== undefined && input.detail !== null) {
    result.detail = text(
      input.detail,
      "status.detail",
      NATIVE_TUI_MAX_STATUS_BYTES,
      true,
    );
  }
  return result;
}

export function projectTasks(
  inputs: readonly NativeTuiTaskInput[] = [],
): NativeTuiTaskSnapshot[] {
  if (!Array.isArray(inputs)) throw projection("tasks must be an array");
  return inputs.slice(0, NATIVE_TUI_MAX_TASKS).map((input, index) => {
    if (!input || typeof input !== "object") {
      throw projection(`tasks[${index}] must be an object`);
    }
    const result: NativeTuiTaskSnapshot = {
      id: text(
        input.id,
        `tasks[${index}].id`,
        NATIVE_TUI_MAX_TASK_ID_BYTES,
        false,
      ),
      title: text(
        input.title,
        `tasks[${index}].title`,
        NATIVE_TUI_MAX_TASK_TITLE_BYTES,
        true,
      ),
      status: text(
        input.status,
        `tasks[${index}].status`,
        NATIVE_TUI_MAX_STATUS_BYTES,
        false,
      ),
    };
    if (input.detail !== undefined && input.detail !== null) {
      result.detail = text(
        input.detail,
        `tasks[${index}].detail`,
        NATIVE_TUI_MAX_STATUS_BYTES,
        true,
      );
    }
    if (input.progress !== undefined && input.progress !== null) {
      if (
        !Number.isSafeInteger(input.progress) ||
        input.progress < 0 ||
        input.progress > 100
      ) {
        throw projection(
          `tasks[${index}].progress must be an integer from 0 to 100`,
        );
      }
      result.progress = input.progress;
    }
    return result;
  });
}

export function projectTranscript(
  inputs: readonly NativeTuiTranscriptInput[] = [],
): NativeTuiTranscriptEntry[] {
  if (!Array.isArray(inputs)) throw projection("transcript must be an array");
  const visible = inputs.filter((input) => !isRawToolEntry(input));
  const bounded = visible.slice(-NATIVE_TUI_MAX_TRANSCRIPT_ENTRIES);
  const entries: NativeTuiTranscriptEntry[] = [];
  let totalBytes = 0;
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const input = bounded[index];
    if (!input || typeof input !== "object") {
      throw projection(`transcript[${index}] must be an object`);
    }
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw projection(
        `transcript[${index}].sequence must be a non-negative integer`,
      );
    }
    const role = text(
      input.role,
      `transcript[${index}].role`,
      NATIVE_TUI_MAX_TRANSCRIPT_ROLE_BYTES,
      false,
    );
    const value = text(
      redactSensitiveText(input.text),
      `transcript[${index}].text`,
      NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES,
      true,
    );
    const bytes = byteLength(value);
    if (totalBytes + bytes > NATIVE_TUI_MAX_SNAPSHOT_BYTES) break;
    totalBytes += bytes;
    entries.push({ sequence: input.sequence, role, text: value });
  }
  entries.reverse();
  return entries;
}

export function projectRenderSnapshot(
  id: string,
  sequence: number,
  input: NativeTuiProjectionInput,
): NativeTuiRenderSnapshot {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw projection("snapshot sequence must be a non-negative safe integer");
  }
  const snapshot: NativeTuiRenderSnapshot = {
    type: "render_snapshot",
    version: NATIVE_TUI_PROTOCOL_VERSION,
    id: text(id, "snapshot.id", 128, false),
    sequence,
    status: projectStatus(input.status),
    tasks: projectTasks(input.tasks),
    transcript: projectTranscript(input.transcript),
  };
  return enforceSnapshotByteBudget(snapshot);
}

export function nativeTuiSnapshotByteLength(
  snapshot: NativeTuiRenderSnapshot,
): number {
  let total = 0;
  const add = (value: string): void => {
    total += byteLength(value);
  };
  add(snapshot.id);
  add(snapshot.status.state);
  if (snapshot.status.message !== undefined) add(snapshot.status.message);
  if (snapshot.status.detail !== undefined) add(snapshot.status.detail);
  for (const task of snapshot.tasks) {
    add(task.id);
    add(task.title);
    add(task.status);
    if (task.detail !== undefined) add(task.detail);
  }
  for (const entry of snapshot.transcript) {
    add(entry.role);
    add(entry.text);
  }
  return total;
}

function enforceSnapshotByteBudget(
  snapshot: NativeTuiRenderSnapshot,
): NativeTuiRenderSnapshot {
  const fixedBytes = nativeTuiSnapshotByteLength({
    ...snapshot,
    transcript: [],
  });
  if (fixedBytes > NATIVE_TUI_MAX_SNAPSHOT_BYTES) {
    throw projection(
      `snapshot aggregate exceeds ${NATIVE_TUI_MAX_SNAPSHOT_BYTES} bytes`,
    );
  }
  let total = fixedBytes;
  const retained: NativeTuiTranscriptEntry[] = [];
  for (let index = snapshot.transcript.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.transcript[index];
    if (!entry) continue;
    const entryBytes = byteLength(entry.role) + byteLength(entry.text);
    if (total + entryBytes > NATIVE_TUI_MAX_SNAPSHOT_BYTES) break;
    total += entryBytes;
    retained.push(entry);
  }
  retained.reverse();
  return retained.length === snapshot.transcript.length
    ? snapshot
    : { ...snapshot, transcript: retained };
}

export class NativeTuiRevisionClock {
  private revisionValue: number;

  constructor(initialRevision = 0) {
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) {
      throw projection("initial revision must be a non-negative safe integer");
    }
    this.revisionValue = initialRevision;
  }

  get current(): number {
    return this.revisionValue;
  }

  next(): number {
    if (this.revisionValue === Number.MAX_SAFE_INTEGER) {
      throw projection("revision exhausted");
    }
    this.revisionValue += 1;
    return this.revisionValue;
  }
}

export class NativeTuiProjectionStore {
  private readonly clock: NativeTuiRevisionClock;
  private readonly sessionId: string;
  private lastSnapshotValue?: NativeTuiRenderSnapshot;

  constructor(sessionId: string, initialRevision = 0) {
    this.sessionId = text(sessionId, "session id", 128, false);
    this.clock = new NativeTuiRevisionClock(initialRevision);
  }

  get revision(): number {
    return this.clock.current;
  }

  get snapshot(): NativeTuiRenderSnapshot | undefined {
    return this.lastSnapshotValue;
  }

  update(input: NativeTuiProjectionInput): NativeTuiRenderSnapshot {
    if (this.clock.current === Number.MAX_SAFE_INTEGER) {
      throw projection("revision exhausted");
    }
    const snapshot = projectRenderSnapshot(
      this.sessionId,
      this.clock.current + 1,
      input,
    );
    this.clock.next();
    this.lastSnapshotValue = snapshot;
    return snapshot;
  }
}

export const buildStatusProjection = projectStatus;
export const buildTasksProjection = projectTasks;
export const buildTranscriptProjection = projectTranscript;
export const buildRenderProjection = projectRenderSnapshot;

function isRawToolEntry(input: NativeTuiTranscriptInput): boolean {
  if (!input || typeof input !== "object") return false;
  const role = typeof input.role === "string" ? input.role.toLowerCase() : "";
  return role === "tool" || role === "tool_result" || role === "function";
}

function redactSensitiveText(value: unknown): string {
  if (typeof value !== "string") {
    throw projection("projection text must be a string");
  }
  return value
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\bforge-[a-z0-9._~-]+\b/gi, "[redacted]")
    .replace(
      /((?:vexzy_api_key|api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted]");
}

function text(
  value: unknown,
  context: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== "string")
    throw projection(`${context} must be a string`);
  if (!allowEmpty && value.length === 0)
    throw projection(`${context} must not be empty`);
  return truncateUtf8(redactSensitiveText(value), maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const bytes = encoder.encode(value);
  let boundary = maxBytes;
  while (boundary > 0) {
    const byte = bytes[boundary - 1];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    boundary -= 1;
  }
  if (boundary > 0) {
    const lead = bytes[boundary - 1];
    if (lead !== undefined) {
      const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
      if (boundary - 1 + width > maxBytes) boundary -= 1;
    }
  }
  return decoder.decode(bytes.subarray(0, boundary));
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function projection(message: string): NativeTuiProjectionError {
  return new NativeTuiProjectionError(message);
}
