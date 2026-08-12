import { basename } from "node:path";
import { PassThrough, Writable } from "node:stream";
import stripAnsi from "strip-ansi";
import {
  getCwdState,
  getModelUsage,
  getSessionId,
  getTotalAPIDuration,
  getTotalRequestCount,
} from "../../bootstrap/state.js";
import type { RenderOptions } from "../../ink.js";
import { getSessionCreditTotals } from "../../services/credits/accounting.js";
import type { AppState } from "../../state/AppStateStore.js";
import type { TaskState } from "../../tasks/types.js";
import {
  WORKER_REPORT_EFFORTS,
  WORKER_REPORT_STATUSES,
  type WorkerReport,
  workerEvidenceSchema,
  parseWorkerReport,
} from "../../tools/AgentTool/workerReport.js";
import { getConfiguredSubagentModel } from "../../utils/model/subagentModel.js";
import type { NativeTuiControlServer } from "./controlServer.js";
import type {
  NativeTuiConnectionSnapshot,
  NativeTuiInputEvent,
  NativeTuiInputEventKind,
  NativeTuiTranscriptBlock,
} from "./protocol.js";

const MAX_CAPTURED_FRAGMENTS = 64;
const MAX_CAPTURED_TEXT_BYTES = 128 * 1024;
const MAX_TYPED_TRANSCRIPT_BLOCKS = 512;
const MAX_TRANSCRIPT_TEXT_BYTES = 64 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const MAX_CODE_BYTES = 128 * 4096;

// AppState deliberately keeps the concrete task union out of the native-TUI
// protocol. These narrow records let this adapter read optional task metadata
// without coupling the bridge to a particular worker backend.
type TaskRecord = Record<string, unknown> & {
  id: string;
  type: string;
  status: string;
  description?: string;
};

type WorkerReportLike = Pick<
  WorkerReport,
  | "task_id"
  | "status"
  | "summary"
  | "changed_files"
  | "evidence"
  | "tokens_used"
  | "effort_used"
> & {
  model?: string;
  report_id?: string;
  run_id?: string;
};

type WorkerProjection = {
  task: TaskState;
  model: string;
  effort: string;
  progress?: number;
};

export type NativeTuiTranscriptPage = {
  start_sequence: number;
  end_sequence: number;
  has_older: boolean;
  has_newer: boolean;
  blocks: readonly NativeTuiTranscriptBlock[];
};

export type NativeTuiBridgeConnectionState = Pick<
  NativeTuiConnectionSnapshot,
  "state" | "reconnect_attempts"
> & {
  last_error?: string;
};

type MutableTtyInput = PassThrough & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(raw: boolean): MutableTtyInput;
};

type MutableTtyOutput = Writable & {
  isTTY: boolean;
  columns: number;
  rows: number;
};

/**
 * Adapts the existing Ink REPL into a headless state/input engine while the
 * Rust renderer owns the real terminal. No captured bytes are persisted.
 */
export class NativeTuiInkBridge {
  private readonly control: NativeTuiControlServer;
  private readonly inputStream: MutableTtyInput;
  private readonly outputStream: MutableTtyOutput;
  private readonly fragments: string[] = [];
  private latestState?: Pick<
    AppState,
    "tasks" | "statusLineText" | "mainLoopModel" | "effortValue"
  >;
  private connectionState: NativeTuiBridgeConnectionState = {
    state: "connected",
    reconnect_attempts: 0,
  };
  private publishScheduled = false;
  private closed = false;
  private transcriptSequence = 0;
  private readonly startedAt = Date.now();
  private readonly transcriptBlocks: NativeTuiTranscriptBlock[] = [];
  private transcriptPagingRequest?: "older" | "newer";
  /** Optional session authority; the renderer never persists transcript data. */
  private readonly transcriptPageLoader?: (
    direction: "older" | "newer",
    current: NativeTuiTranscriptPage,
  ) =>
    | NativeTuiTranscriptPage
    | undefined
    | Promise<NativeTuiTranscriptPage | undefined>;
  private transcriptPage?: NativeTuiTranscriptPage;
  private transcriptWindowStart = 0;
  private transcriptWindowEnd = 0;
  private transcriptHasOlder = false;
  private transcriptHasNewer = false;
  private transcriptPageOffset = 0;

  constructor(
    control: NativeTuiControlServer,
    columns = process.stdout.columns || 120,
    rows = process.stdout.rows || 40,
    options: {
      transcriptPageLoader?: (
        direction: "older" | "newer",
        current: NativeTuiTranscriptPage,
      ) =>
        | NativeTuiTranscriptPage
        | undefined
        | Promise<NativeTuiTranscriptPage | undefined>;
    } = {},
  ) {
    this.control = control;
    this.transcriptPageLoader = options.transcriptPageLoader;
    const input = new PassThrough() as MutableTtyInput;
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (raw: boolean): MutableTtyInput => {
      input.isRaw = raw;
      return input;
    };
    this.inputStream = input;

    const output = new Writable({
      write: (chunk, _encoding, callback) => {
        this.captureOutput(Buffer.from(chunk).toString("utf8"));
        callback();
      },
    }) as MutableTtyOutput;
    output.isTTY = true;
    output.columns = columns;
    output.rows = rows;
    this.outputStream = output;
  }

  get renderOptions(): RenderOptions {
    return {
      stdin: this.inputStream as unknown as NodeJS.ReadStream,
      stdout: this.outputStream as unknown as NodeJS.WriteStream,
      stderr: this.outputStream as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      // Keep console.* and direct stderr writes from corrupting the Rust-owned
      // alternate screen; Ink restores both patches when this root unmounts.
      patchConsole: true,
    };
  }

  handleInput = (message: NativeTuiInputEvent): void => {
    if (this.closed) return;
    if (message.event.type === "action") {
      if (message.event.action === "transcript_page") {
        const direction =
          message.event.value === "older" || message.event.value === "newer"
            ? message.event.value
            : undefined;
        if (direction) {
          this.transcriptPagingRequest = direction;
          void Promise.resolve(
            this.transcriptPageLoader?.(
              direction,
              this.currentTranscriptPage(),
            ),
          )
            .then(
              (page) => {
                if (page) {
                  this.transcriptPage = {
                    ...page,
                    blocks: page.blocks.slice(-MAX_TYPED_TRANSCRIPT_BLOCKS),
                  };
                  this.transcriptPageOffset = 0;
                }
              },
              () => undefined,
            )
            .finally(() => this.schedulePublish());
          this.schedulePublish();
        }
        return;
      }
    }
    const bytes = inputBytes(message.event);
    if (bytes.length > 0) this.inputStream.write(bytes);
  };

  resize = (columns: number, rows: number): void => {
    if (this.closed) return;
    this.outputStream.columns = columns;
    this.outputStream.rows = rows;
    this.outputStream.emit("resize");
  };

  setConnectionState = (
    state: Partial<NativeTuiBridgeConnectionState>,
  ): void => {
    if (this.closed) return;
    const reconnectAttempts = finiteInteger(state.reconnect_attempts);
    const next: NativeTuiBridgeConnectionState = {
      state: nonEmptyString(state.state) ?? this.connectionState.state,
      reconnect_attempts:
        reconnectAttempts === undefined
          ? this.connectionState.reconnect_attempts
          : reconnectAttempts,
    };
    const lastError = nonEmptyString(state.last_error);
    if (lastError !== undefined) next.last_error = lastError;
    this.connectionState = next;
    this.schedulePublish();
  };

  publishState(
    state: Pick<
      AppState,
      "tasks" | "statusLineText" | "mainLoopModel" | "effortValue"
    >,
  ): void {
    if (this.closed) return;
    this.latestState = state;
    this.transcriptPage = undefined;
    this.transcriptPageOffset = 0;
    this.schedulePublish();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inputStream.end();
    this.outputStream.end();
    this.fragments.length = 0;
  }

  private captureOutput(value: string): void {
    if (this.closed) return;
    const text = stripAnsi(value)
      .replaceAll("\u0000", "")
      .replace(/\r(?!\n)/gu, "\n")
      .trim();
    if (!text || this.fragments.at(-1) === text) return;
    this.fragments.push(text);
    while (
      this.fragments.length > MAX_CAPTURED_FRAGMENTS ||
      Buffer.byteLength(this.fragments.join("\n"), "utf8") >
        MAX_CAPTURED_TEXT_BYTES
    ) {
      this.fragments.shift();
    }
    this.schedulePublish();
  }

  private schedulePublish(): void {
    if (this.publishScheduled || this.closed) return;
    this.publishScheduled = true;
    setImmediate(() => {
      this.publishScheduled = false;
      if (this.closed) return;
      this.publish();
    });
  }

  private nextTranscriptSequence(): number {
    this.transcriptSequence += 1;
    return this.transcriptSequence;
  }

  private currentTranscriptPage(): NativeTuiTranscriptPage {
    return (
      this.transcriptPage ?? {
        start_sequence: this.transcriptWindowStart,
        end_sequence: this.transcriptWindowEnd,
        has_older: this.transcriptHasOlder,
        has_newer: this.transcriptHasNewer,
        blocks: this.transcriptBlocks.slice(),
      }
    );
  }

  private publish(): void {
    const state = this.latestState;
    const tasks = state
      ? (Object.values(state.tasks) as readonly TaskState[])
      : [];
    const working = tasks.some(
      (task) => task.status === "running" || task.status === "pending",
    );
    const model = state?.mainLoopModel ?? "gpt-5.6-luna";
    const effort = state?.effortValue ?? "medium";
    const workerProjections = tasks
      .filter(isWorkerTask)
      .map((task) => workerProjection(task));
    const workspace = getCwdState();
    const sessionId = getSessionId();
    const now = Date.now();
    const transcriptText = this.fragments.join("\n");
    const typedTranscript = this.buildTypedTranscript(tasks);
    const nextTranscript: NativeTuiTranscriptBlock[] =
      typedTranscript.length > 0
        ? typedTranscript
        : transcriptText
          ? [
              {
                type: "markdown",
                id: `session:${this.transcriptSequence + 1}`,
                sequence: this.nextTranscriptSequence(),
                role: "session",
                text: transcriptText,
              },
            ]
          : [];
    for (const block of nextTranscript) {
      const existing = this.transcriptBlocks.findIndex(
        (item) => item.id === block.id,
      );
      if (existing >= 0) this.transcriptBlocks[existing] = block;
      else this.transcriptBlocks.push(block);
    }
    while (this.transcriptBlocks.length > MAX_TYPED_TRANSCRIPT_BLOCKS)
      this.transcriptBlocks.shift();
    const loadedPage = this.transcriptPage;
    let transcript: NativeTuiTranscriptBlock[];
    if (loadedPage) {
      this.transcriptWindowStart = loadedPage.start_sequence;
      this.transcriptWindowEnd = loadedPage.end_sequence;
      this.transcriptHasOlder = loadedPage.has_older;
      this.transcriptHasNewer = loadedPage.has_newer;
      transcript = [...loadedPage.blocks];
    } else {
      const pageSize = Math.min(128, Math.max(1, this.transcriptBlocks.length));
      const maxOffset = Math.max(0, this.transcriptBlocks.length - pageSize);
      const paging = this.transcriptPagingRequest;
      this.transcriptPagingRequest = undefined;
      if (paging === "older")
        this.transcriptPageOffset = Math.min(
          maxOffset,
          this.transcriptPageOffset + pageSize,
        );
      if (paging === "newer")
        this.transcriptPageOffset = Math.max(
          0,
          this.transcriptPageOffset - pageSize,
        );
      const end = this.transcriptBlocks.length - this.transcriptPageOffset;
      const start = Math.max(0, end - pageSize);
      this.transcriptWindowStart = this.transcriptBlocks[start]?.sequence ?? 0;
      this.transcriptWindowEnd = this.transcriptBlocks[end - 1]?.sequence ?? 0;
      this.transcriptHasOlder = start > 0;
      this.transcriptHasNewer = this.transcriptPageOffset > 0;
      transcript = this.transcriptBlocks.slice(start, end);
    }
    try {
      this.control.publish({
        status: {
          state: working ? "working" : "ready",
          message: state?.statusLineText,
          detail: `${model} · ${effort}`,
        },
        sessions: [
          {
            id: sessionId,
            name: "Current session",
            workspace,
            status: working ? "running" : "idle",
            model,
            effort,
            active: true,
            pinned: false,
            unread: 0,
            created_at_ms: this.startedAt,
            updated_at_ms: now,
          },
        ],
        workspaces: [
          {
            id: workspace,
            name: basename(workspace) || workspace,
            path: workspace,
            active: true,
          },
        ],
        active_session_id: sessionId,
        telemetry: {
          ...telemetryFor(model, effort, tasks),
          connection: this.connectionState,
        },
        tasks: tasks.map((task) => ({
          id: task.id,
          title: task.description ?? task.id,
          status: task.status,
          detail: task.type,
          progress: taskProgress(task),
          metadata: {
            model: taskModel(task, model),
            effort: taskEffort(task, effort),
            owner: taskOwner(task),
            agent_id: taskAgentId(task),
            parent_id: taskParentId(task),
            dependencies: stringArray(taskRecord(task).dependencies),
            blocked_by: stringArray(taskRecord(task).blocked_by),
            files_touched: stringArray(taskRecord(task).files_touched),
            isolation: stringValue(taskRecord(task).isolation),
          },
        })),
        agents: workerProjections.map(
          ({ task, model: workerModel, effort: workerEffort, progress }) => ({
            id: taskAgentId(task) ?? task.id,
            name: taskName(task),
            role: task.type === "in_process_teammate" ? "teammate" : "worker",
            status: taskStatusForProjection(task),
            parent_id: taskParentId(task),
            task_id: task.id,
            model: workerModel,
            effort: workerEffort,
            progress,
          }),
        ),
        transcript,
        transcript_window: {
          start_sequence: this.transcriptWindowStart,
          end_sequence: this.transcriptWindowEnd,
          has_older: this.transcriptHasOlder,
          has_newer: this.transcriptHasNewer,
          blocks: transcript,
        },
      });
    } catch {
      // Projection limits are a display boundary: dropping one frame must not
      // terminate the authoritative Ink REPL or the user's terminal session.
    }
  }

  private buildTypedTranscript(
    tasks: readonly TaskState[],
  ): NativeTuiTranscriptBlock[] {
    const blocks: NativeTuiTranscriptBlock[] = [];
    for (const task of tasks) {
      const record = taskRecord(task);
      const messages = Array.isArray(record.messages) ? record.messages : [];
      for (const [messageIndex, message] of messages.entries()) {
        appendMessageBlocks(blocks, task, message, messageIndex, () =>
          this.nextTranscriptSequence(),
        );
        if (blocks.length >= MAX_TYPED_TRANSCRIPT_BLOCKS) {
          return blocks.slice(-MAX_TYPED_TRANSCRIPT_BLOCKS);
        }
      }
      const report = workerReportFor(task);
      if (
        report &&
        !blocks.some(
          (block) =>
            block.type === "report" && block.task_id === report.task_id,
        )
      ) {
        blocks.push(
          reportBlock(report, task.id, () => this.nextTranscriptSequence()),
        );
        if (blocks.length >= MAX_TYPED_TRANSCRIPT_BLOCKS) {
          return blocks.slice(-MAX_TYPED_TRANSCRIPT_BLOCKS);
        }
      }
    }
    return blocks;
  }
}

function inputBytes(event: NativeTuiInputEventKind): string {
  switch (event.type) {
    case "text":
    case "paste":
      return event.text;
    case "submit":
      return "\r";
    case "cancel":
      return "\u001b";
    case "interrupt":
      return "\u0003";
    case "key":
      return keyBytes(event.key, event.modifiers);
    case "mouse":
      return "";
    case "action":
      return actionBytes(event.action, event.value);
  }
}

function actionBytes(action: string, value: string | undefined): string {
  switch (action) {
    case "new_session":
      return "/clear\r";
    case "attach_session":
      return "/resume\r";
    case "open_workspace":
      return "/add-dir\r";
    case "permission_decision":
      return value === "once"
        ? "o"
        : value === "project"
          ? "p"
          : value === "deny"
            ? "d"
            : "";
    default:
      return "";
  }
}

function telemetryFor(
  selectedModel: string,
  effort: string,
  tasks: readonly TaskState[],
): {
  connection: { state: string; reconnect_attempts: number };
  model: string;
  effort: string;
  context_used_tokens: number;
  context_limit_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  credits: number;
  active_agents: number;
  queued_tasks: number;
  api_requests: number;
  latency_ms: number;
} {
  const usage = getModelUsage() as Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      reasoningTokens?: number;
      contextWindow?: number;
    }
  >;
  const values = Object.values(usage);
  const total = (field: keyof (typeof values)[number]): number =>
    values.reduce((sum, value) => sum + finite(value[field]), 0);
  const selected = usage[selectedModel];
  const contextLimit = Math.max(
    1,
    finite(selected?.contextWindow) || 1_100_000,
  );
  const contextUsed = Math.min(
    contextLimit,
    finite(selected?.inputTokens) +
      finite(selected?.cacheReadInputTokens) +
      finite(selected?.cacheCreationInputTokens),
  );
  const requests = getTotalRequestCount();
  return {
    connection: { state: "connected", reconnect_attempts: 0 },
    model: selectedModel,
    effort,
    context_used_tokens: Math.floor(contextUsed),
    context_limit_tokens: Math.floor(contextLimit),
    input_tokens: Math.floor(total("inputTokens")),
    output_tokens: Math.floor(total("outputTokens")),
    cached_tokens: Math.floor(
      total("cacheReadInputTokens") + total("cacheCreationInputTokens"),
    ),
    reasoning_tokens: Math.floor(total("reasoningTokens")),
    credits: getSessionCreditTotals().totalCredits ?? 0,
    active_agents: tasks.filter(
      (task) =>
        isWorkerTask(task) &&
        task.status === "running" &&
        taskRecord(task).isIdle !== true,
    ).length,
    queued_tasks: tasks.filter((task) => task.status === "pending").length,
    api_requests: requests,
    latency_ms:
      requests === 0 ? 0 : Math.floor(getTotalAPIDuration() / requests),
  };
}

function taskRecord(task: TaskState): TaskRecord {
  return task as unknown as TaskRecord;
}

function isWorkerTask(task: TaskState): boolean {
  const record = taskRecord(task);
  if (task.type === "in_process_teammate" || task.type === "remote_agent") {
    return true;
  }
  return task.type === "local_agent" && record.agentType !== "main-session";
}

function workerProjection(task: TaskState): WorkerProjection {
  return {
    task,
    model: taskModel(task, getConfiguredSubagentModel()),
    effort: taskEffort(task, "medium"),
    progress: taskProgress(task),
  };
}

function workerReportFor(task: TaskState): WorkerReportLike | undefined {
  const record = taskRecord(task);
  const result = asRecord(record.result);
  const candidates = [
    result?.workerReport,
    record.workerReport,
    result?.report,
  ];
  for (const candidate of candidates) {
    const parsed = parseWorkerReport(candidate);
    if (parsed) return parsed;
    const fallback = reportLike(candidate);
    if (fallback) return fallback;
  }
  return undefined;
}

function reportLike(value: unknown): WorkerReportLike | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const taskId = nonEmptyString(record.task_id);
  const status = workerReportStatus(record.status);
  const summary = nonEmptyString(record.summary);
  const effort = workerReportEffort(record.effort_used);
  const changedFiles = record.changed_files;
  const evidence = record.evidence;
  const tokens = finiteInteger(record.tokens_used);
  if (
    taskId === undefined ||
    status === undefined ||
    summary === undefined ||
    effort === undefined ||
    !Array.isArray(changedFiles) ||
    changedFiles.length > 256 ||
    !Array.isArray(evidence) ||
    evidence.length > 32 ||
    tokens === undefined
  ) {
    return undefined;
  }

  const normalizedChangedFiles: string[] = [];
  for (const file of changedFiles) {
    if (typeof file !== "string" || file.trim().length === 0) {
      return undefined;
    }
    normalizedChangedFiles.push(file);
  }

  const normalizedEvidence: WorkerReport["evidence"] = [];
  for (const item of evidence) {
    const parsed = workerEvidenceSchema.safeParse(item);
    if (!parsed.success) return undefined;
    normalizedEvidence.push(parsed.data);
  }

  const model = nonEmptyString(record.model);
  const reportId = nonEmptyString(record.report_id);
  const runId = nonEmptyString(record.run_id);
  return {
    task_id: taskId,
    status,
    summary,
    changed_files: normalizedChangedFiles,
    evidence: normalizedEvidence,
    tokens_used: tokens,
    effort_used: effort,
    ...(model === undefined ? {} : { model }),
    ...(reportId === undefined ? {} : { report_id: reportId }),
    ...(runId === undefined ? {} : { run_id: runId }),
  };
}

function workerReportStatus(
  value: unknown,
): WorkerReport["status"] | undefined {
  return typeof value === "string"
    ? WORKER_REPORT_STATUSES.find((status) => status === value)
    : undefined;
}

function workerReportEffort(
  value: unknown,
): WorkerReport["effort_used"] | undefined {
  return typeof value === "string"
    ? WORKER_REPORT_EFFORTS.find((effort) => effort === value)
    : undefined;
}

function taskModel(task: TaskState, fallback: string): string {
  const report = workerReportFor(task);
  const record = taskRecord(task);
  const selectedAgent = asRecord(record.selectedAgent);
  return (
    nonEmptyString(report?.model) ??
    stringValue(record.model) ??
    stringValue(selectedAgent?.model) ??
    (isWorkerTask(task) ? getConfiguredSubagentModel() : fallback)
  );
}

function taskEffort(task: TaskState, fallback: string): string {
  const report = workerReportFor(task);
  const record = taskRecord(task);
  const selectedAgent = asRecord(record.selectedAgent);
  return (
    nonEmptyString(report?.effort_used) ??
    stringValue(record.effort) ??
    stringValue(selectedAgent?.effort) ??
    (isWorkerTask(task) ? "medium" : fallback)
  );
}

function taskProgress(task: TaskState): number | undefined {
  const record = taskRecord(task);
  const progress = record.progress;
  const direct = numberValue(progress);
  if (direct !== undefined) return clampProgress(direct);
  const progressRecord = asRecord(progress);
  for (const key of ["progress", "percentage", "percent"]) {
    const value = numberValue(progressRecord?.[key]);
    if (value !== undefined) return clampProgress(value);
  }
  if (task.status === "completed") return 100;
  return undefined;
}

function taskStatusForProjection(task: TaskState): string {
  const record = taskRecord(task);
  return task.type === "in_process_teammate" && record.isIdle === true
    ? "idle"
    : task.status;
}

function taskName(task: TaskState): string {
  const record = taskRecord(task);
  const identity = asRecord(record.identity);
  return (
    stringValue(identity?.agentName) ??
    stringValue(record.agentId) ??
    task.description ??
    task.id
  );
}

function taskOwner(task: TaskState): string | undefined {
  const record = taskRecord(task);
  const identity = asRecord(record.identity);
  return stringValue(record.owner) ?? stringValue(identity?.agentName);
}

function taskAgentId(task: TaskState): string | undefined {
  const record = taskRecord(task);
  const identity = asRecord(record.identity);
  return stringValue(record.agentId) ?? stringValue(identity?.agentId);
}

function taskParentId(task: TaskState): string | undefined {
  const record = taskRecord(task);
  const identity = asRecord(record.identity);
  return (
    stringValue(record.parent_id) ??
    stringValue(record.parentId) ??
    stringValue(identity?.parentSessionId)
  );
}

export function createSessionTranscriptPageLoader(): (
  direction: "older" | "newer",
  current: NativeTuiTranscriptPage,
) => Promise<NativeTuiTranscriptPage | undefined> {
  return async (direction, current) => {
    try {
      const { getTranscriptPath, loadTranscriptFile } = await import(
        "../../utils/sessionStorage.js"
      );
      const loaded = await loadTranscriptFile(getTranscriptPath(), {
        keepAllLeaves: true,
      });
      const blocks: NativeTuiTranscriptBlock[] = [];
      for (const [index, message] of Array.from(
        loaded.messages.values(),
      ).entries()) {
        appendStoredMessageBlocks(
          blocks,
          message,
          index,
          () => blocks.length + 1,
        );
        if (blocks.length >= MAX_TYPED_TRANSCRIPT_BLOCKS) break;
      }
      if (blocks.length === 0) return;
      const pageSize = Math.max(1, Math.min(128, current.blocks.length || 128));
      const currentStart = Math.max(1, current.start_sequence || blocks.length);
      const currentEnd = Math.min(
        blocks.length,
        current.end_sequence || blocks.length,
      );
      const start =
        direction === "older"
          ? Math.max(0, currentStart - 1 - pageSize)
          : Math.min(Math.max(0, blocks.length - pageSize), currentEnd);
      const end = Math.min(blocks.length, start + pageSize);
      return {
        start_sequence: blocks[start]?.sequence ?? 0,
        end_sequence: blocks[end - 1]?.sequence ?? 0,
        has_older: start > 0,
        has_newer: end < blocks.length,
        blocks: blocks.slice(start, end),
      };
    } catch {
      return;
    }
  };
}

function appendStoredMessageBlocks(
  blocks: NativeTuiTranscriptBlock[],
  value: unknown,
  messageIndex: number,
  nextSequence: () => number,
): void {
  const message = asRecord(value);
  if (!message) return;
  const messageId = boundedText(
    `session:${stringValue(message.uuid) ?? messageIndex}`,
    256,
  );
  const role = messageRole(stringValue(message.type) ?? "session");
  const content = messageContent(message);
  if (content.length === 0) {
    const text = contentText(message.content ?? message.text);
    if (text) {
      blocks.push({
        type: "markdown",
        id: `${messageId}:text`,
        sequence: nextSequence(),
        role,
        text: boundedText(text, MAX_TRANSCRIPT_TEXT_BYTES),
      });
    }
    return;
  }
  for (const [contentIndex, item] of content.entries()) {
    const block = asRecord(item);
    const blockType = stringValue(block?.type) ?? "text";
    const id = `${messageId}:${contentIndex}`;
    if (
      blockType === "tool_use" ||
      blockType === "server_tool_use" ||
      blockType === "mcp_tool_use"
    ) {
      blocks.push({
        type: "tool",
        id,
        sequence: nextSequence(),
        name: boundedText(stringValue(block?.name) ?? "tool", 128),
        status: "completed",
        input: boundedText(
          typeof block?.input === "string"
            ? block.input
            : safeJson(block?.input),
          MAX_TOOL_ARGUMENT_BYTES,
        ),
      });
      continue;
    }
    if (blockType === "tool_result") {
      blocks.push({
        type: "tool",
        id,
        sequence: nextSequence(),
        name: boundedText(stringValue(block?.name) ?? "tool", 128),
        status: block?.is_error === true ? "failed" : "completed",
        output: boundedText(
          contentText(block?.content ?? block?.text ?? block),
          MAX_TOOL_OUTPUT_BYTES,
        ),
      });
      continue;
    }
    const text = contentText(
      block?.text ?? block?.thinking ?? block?.content ?? item,
    );
    if (text) {
      blocks.push({
        type: "markdown",
        id,
        sequence: nextSequence(),
        role,
        text: boundedText(text, MAX_TRANSCRIPT_TEXT_BYTES),
      });
    }
  }
}

function appendMessageBlocks(
  blocks: NativeTuiTranscriptBlock[],
  task: TaskState,
  value: unknown,
  messageIndex: number,
  nextSequence: () => number,
): void {
  const message = asRecord(value);
  if (!message) return;
  const messageType = stringValue(message.type) ?? "message";
  const content = messageContent(message);
  if (content.length === 0) {
    const fallbackText = contentText(message.content ?? message.text);
    if (fallbackText) {
      appendMarkdownOrCode(
        blocks,
        fallbackText,
        task.id,
        messageIndex,
        0,
        messageRole(messageType),
        nextSequence,
      );
    }
    return;
  }
  for (const [contentIndex, item] of content.entries()) {
    const block = asRecord(item);
    const blockType = stringValue(block?.type) ?? "text";
    const idPrefix = `${task.id}:${messageIndex}:${contentIndex}`;
    switch (blockType) {
      case "text":
        appendMarkdownOrCode(
          blocks,
          contentText(block?.text ?? item),
          task.id,
          messageIndex,
          contentIndex,
          messageRole(messageType),
          nextSequence,
        );
        break;
      case "thinking":
      case "redacted_thinking": {
        const usage = asRecord(asRecord(message.message)?.usage);
        blocks.push({
          type: "thinking",
          id: boundedText(idPrefix, 256),
          sequence: nextSequence(),
          summary: boundedText(
            contentText(block?.thinking ?? block?.summary ?? block?.text) ||
              "redacted thinking",
            MAX_TRANSCRIPT_TEXT_BYTES,
          ),
          effort: taskEffort(task, "medium"),
          elapsed_ms: nonNegativeNumber(block?.elapsed_ms) ?? 0,
          tokens_used:
            nonNegativeNumber(block?.tokens_used) ??
            nonNegativeNumber(usage?.output_tokens) ??
            0,
        });
        break;
      }
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use":
        blocks.push({
          type: "tool",
          id: boundedText(idPrefix, 256),
          sequence: nextSequence(),
          name: boundedText(stringValue(block?.name) ?? "tool", 128),
          status: toolUseStatus(task, block?.id),
          input: boundedText(
            typeof block?.input === "string"
              ? block.input
              : safeJson(block?.input),
            MAX_TOOL_ARGUMENT_BYTES,
          ),
        });
        break;
      case "tool_result":
        blocks.push({
          type: "tool",
          id: boundedText(idPrefix, 256),
          sequence: nextSequence(),
          name: boundedText(
            stringValue(block?.name) ?? stringValue(block?.tool_name) ?? "tool",
            128,
          ),
          status: block?.is_error === true ? "failed" : "completed",
          output: boundedText(
            contentText(block?.content ?? block?.text ?? block),
            MAX_TOOL_OUTPUT_BYTES,
          ),
        });
        break;
      case "code":
        blocks.push({
          type: "code",
          id: boundedText(idPrefix, 256),
          sequence: nextSequence(),
          role: messageRole(messageType),
          language: boundedText(stringValue(block?.language) ?? "text", 64),
          code: boundedText(
            contentText(block?.code ?? block?.text),
            MAX_CODE_BYTES,
          ),
        });
        break;
      default: {
        const text = contentText(block?.text ?? block?.content ?? item);
        const report = reportFromText(text);
        if (report) {
          blocks.push(reportBlock(report, task.id, nextSequence));
        } else if (text) {
          appendMarkdownOrCode(
            blocks,
            text,
            task.id,
            messageIndex,
            contentIndex,
            messageRole(messageType),
            nextSequence,
          );
        }
      }
    }
  }
}

function appendMarkdownOrCode(
  blocks: NativeTuiTranscriptBlock[],
  text: string,
  taskId: string,
  messageIndex: number,
  contentIndex: number,
  role: string,
  nextSequence: () => number,
): void {
  const normalized = text.trim();
  if (!normalized) return;
  const fenced = normalized.match(/^```([^\n]*)\n([\s\S]*?)\n?```$/u);
  if (fenced) {
    blocks.push({
      type: "code",
      id: boundedText(`${taskId}:${messageIndex}:${contentIndex}:code`, 256),
      sequence: nextSequence(),
      role,
      language: boundedText(fenced[1]?.trim() || "text", 64),
      code: boundedText(fenced[2] ?? "", MAX_CODE_BYTES),
    });
    return;
  }
  blocks.push({
    type: "markdown",
    id: boundedText(`${taskId}:${messageIndex}:${contentIndex}:markdown`, 256),
    sequence: nextSequence(),
    role,
    text: boundedText(normalized, MAX_TRANSCRIPT_TEXT_BYTES),
    created_at_ms: Date.now(),
  });
}

function reportBlock(
  report: WorkerReportLike,
  fallbackTaskId: string,
  nextSequence: () => number,
): NativeTuiTranscriptBlock {
  const reportId = report.report_id ?? report.run_id ?? fallbackTaskId;
  return {
    type: "report",
    id: boundedText(`report:${fallbackTaskId}:${reportId}`, 256),
    sequence: nextSequence(),
    task_id: boundedText(report.task_id || fallbackTaskId, 256),
    status: boundedText(report.status, 64),
    summary: boundedText(report.summary, MAX_TRANSCRIPT_TEXT_BYTES),
    changed_files: report.changed_files
      .filter((file): file is string => typeof file === "string")
      .slice(0, 256)
      .map((file) => boundedText(file, 2_048)),
    evidence: report.evidence
      .slice(0, 32)
      .map(formatEvidence)
      .filter((item): item is string => item !== undefined),
    tokens_used: Math.max(0, Math.floor(report.tokens_used)),
    effort_used: boundedText(report.effort_used, 16),
  };
}

function reportFromText(value: string): WorkerReportLike | undefined {
  const source = value
    .trim()
    .replace(/^```json\s*/iu, "")
    .replace(/\s*```$/u, "");
  if (!source.startsWith("{")) return undefined;
  try {
    const candidate = JSON.parse(source) as unknown;
    return parseWorkerReport(candidate) ?? reportLike(candidate);
  } catch {
    return undefined;
  }
}

function toolUseStatus(task: TaskState, toolUseId: unknown): string {
  const id = stringValue(toolUseId);
  if (!id) return "completed";
  const active = taskRecord(task).inProgressToolUseIDs;
  if (active instanceof Set && active.has(id)) return "running";
  return "completed";
}

function formatEvidence(value: unknown): string | undefined {
  if (typeof value === "string") return boundedText(value, 2_048);
  const record = asRecord(value);
  if (!record) return undefined;
  const parts = [
    stringValue(record.type),
    stringValue(record.path),
    stringValue(record.command),
    stringValue(record.digest),
  ].filter((item): item is string => item !== undefined);
  return boundedText(parts.join(" · ") || safeJson(record), 2_048);
}

function messageContent(message: Record<string, unknown>): unknown[] {
  const nested = asRecord(message.message);
  const content = nested?.content ?? message.content;
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [content];
  return [];
}

function messageRole(type: string): string {
  switch (type) {
    case "assistant":
      return "assistant";
    case "user":
      return "user";
    case "system":
      return "system";
    case "progress":
      return "progress";
    default:
      return type || "session";
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(contentText).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.thinking === "string") return record.thinking;
  if (record.content !== undefined) return contentText(record.content);
  return "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = numberValue(value);
  return number === undefined || number < 0 ? undefined : number;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function safeJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function keyBytes(key: string, modifiers: readonly string[]): string {
  const named: Record<string, string> = {
    backspace: "\u007f",
    delete: "\u001b[3~",
    down: "\u001b[B",
    end: "\u001b[F",
    home: "\u001b[H",
    left: "\u001b[D",
    page_down: "\u001b[6~",
    page_up: "\u001b[5~",
    right: "\u001b[C",
    tab: "\t",
    back_tab: "\u001b[Z",
    up: "\u001b[A",
  };
  let value = named[key] ?? (key.length === 1 ? key : "");
  if (modifiers.includes("ctrl") && /^[A-Za-z]$/u.test(key)) {
    value = String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64);
  }
  if (modifiers.includes("alt") && value) value = `\u001b${value}`;
  return value;
}
