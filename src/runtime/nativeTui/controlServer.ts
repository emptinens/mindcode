import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  NativeTuiInputController,
  type NativeTuiInputControllerOptions,
} from "./inputController.js";
import {
  type NativeTuiProjectionInput,
  NativeTuiProjectionStore,
} from "./projections.js";
import {
  NATIVE_TUI_MAX_CAPABILITIES,
  NATIVE_TUI_MAX_CAPABILITY_BYTES,
  NATIVE_TUI_MAX_FRAME_BYTES,
  NATIVE_TUI_PROTOCOL_VERSION,
  type NativeTuiCapabilities,
  type NativeTuiClientMessage,
  NativeTuiFrameDecoder,
  type NativeTuiInputEvent,
  NativeTuiProtocolError,
  type NativeTuiRenderSnapshot,
  type NativeTuiServerMessage,
  type NativeTuiTerminalSize,
  encodeNativeTuiFrame,
  validateNativeTuiClientMessage,
  validateNativeTuiServerMessage,
} from "./protocol.js";

export const DEFAULT_NATIVE_TUI_RUNTIME_DIRECTORY = join(
  homedir(),
  ".mindcode",
  "run",
);
const DEFAULT_NATIVE_TUI_CLIENT = "mindcode-tui";
const DEFAULT_NATIVE_TUI_CLIENT_CAPABILITIES = [
  "render_snapshot",
  "input",
  "resize",
  "shutdown",
  "mouse",
  "action",
] as const;
export const DEFAULT_NATIVE_TUI_HANDSHAKE_TIMEOUT_MS = 3_000;
export const MAX_NATIVE_TUI_HANDSHAKE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTBOUND_MESSAGES = 256;
const DEFAULT_MAX_OUTBOUND_BYTES = NATIVE_TUI_MAX_FRAME_BYTES * 2;

type OutboundEntry = {
  frame: Buffer;
  message: NativeTuiServerMessage;
  snapshot: boolean;
  sequence?: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type OutboundState = {
  socket: Socket;
  queue: OutboundEntry[];
  queuedBytes: number;
  active?: OutboundEntry;
  running: boolean;
  closed: boolean;
  incoming: Promise<void>;
  handshakeTimer?: ReturnType<typeof setTimeout>;
  handshakeComplete: boolean;
  negotiatedCapabilities: Set<string>;
};

export type NativeTuiControlServerOptions = {
  sessionId?: string;
  socketPath?: string;
  runtimeDirectory?: string;
  serverId?: string;
  capabilities?: readonly string[];
  expectedClient?: string;
  expectedClientCapabilities?: readonly string[];
  handshakeTimeoutMs?: number;
  maxOutboundQueueMessages?: number;
  maxOutboundQueueBytes?: number;
  projectionStore?: NativeTuiProjectionStore;
  inputController?: NativeTuiInputController;
  inputControllerOptions?: Omit<NativeTuiInputControllerOptions, "onIntent">;
  onInput?: (event: NativeTuiInputEvent) => void | Promise<void>;
  onTerminalSize?: (event: NativeTuiTerminalSize) => void | Promise<void>;
  onCapabilities?: (message: NativeTuiCapabilities) => void | Promise<void>;
  onBeforeConnect?: () => void | Promise<void>;
  onConnect?: () => void | Promise<void>;
  onDisconnect?: () => void | Promise<void>;
};

export class NativeTuiControlServerError extends Error {
  readonly code = "NATIVE_TUI_CONTROL_SERVER_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeTuiControlServerError";
  }
}

export function resolveNativeTuiSocketPath(
  sessionId: string,
  runtimeDirectory = DEFAULT_NATIVE_TUI_RUNTIME_DIRECTORY,
): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
    throw new TypeError(
      "sessionId must contain only ASCII path-safe characters",
    );
  }
  return join(runtimeDirectory, `native-tui-${sessionId}.sock`);
}

export const createNativeTuiSocketPath = resolveNativeTuiSocketPath;

export class NativeTuiControlServer {
  private readonly sessionId: string;
  private readonly socketPathValue: string;
  private readonly serverId: string;
  private readonly capabilities: string[];
  private readonly expectedClient: string;
  private readonly expectedClientCapabilities: string[];
  private readonly handshakeTimeoutMs: number;
  private readonly maxOutboundQueueMessages: number;
  private readonly maxOutboundQueueBytes: number;
  private readonly projectionStore: NativeTuiProjectionStore;
  private readonly inputController: NativeTuiInputController;
  private readonly ownsInputController: boolean;
  private readonly onInput?: NativeTuiControlServerOptions["onInput"];
  private readonly onTerminalSize?: NativeTuiControlServerOptions["onTerminalSize"];
  private readonly onCapabilities?: NativeTuiControlServerOptions["onCapabilities"];
  private readonly onBeforeConnect?: NativeTuiControlServerOptions["onBeforeConnect"];
  private readonly onConnect?: NativeTuiControlServerOptions["onConnect"];
  private readonly onDisconnect?: NativeTuiControlServerOptions["onDisconnect"];
  private server?: Server;
  private client?: Socket;
  private outbound?: OutboundState;
  private clientReady = false;
  private lastSentSnapshotSequence?: number;
  private snapshotValue?: NativeTuiRenderSnapshot;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(options: NativeTuiControlServerOptions = {}) {
    const sessionId = options.sessionId ?? randomUUID();
    this.sessionId = sessionId;
    this.socketPathValue =
      options.socketPath ??
      resolveNativeTuiSocketPath(sessionId, options.runtimeDirectory);
    const serverId = options.serverId ?? sessionId;
    if (serverId !== sessionId) {
      throw new NativeTuiControlServerError(
        "serverId must match sessionId for native TUI handshake compatibility",
      );
    }
    this.serverId = sessionId;
    this.expectedClient = boundedConfigurationText(
      options.expectedClient ?? DEFAULT_NATIVE_TUI_CLIENT,
      "expectedClient",
      NATIVE_TUI_MAX_CAPABILITY_BYTES,
    );
    this.expectedClientCapabilities = normalizeCapabilities(
      options.expectedClientCapabilities ??
        DEFAULT_NATIVE_TUI_CLIENT_CAPABILITIES,
      "expectedClientCapabilities",
    );
    this.handshakeTimeoutMs = boundedConfigurationInteger(
      options.handshakeTimeoutMs ?? DEFAULT_NATIVE_TUI_HANDSHAKE_TIMEOUT_MS,
      "handshakeTimeoutMs",
      MAX_NATIVE_TUI_HANDSHAKE_TIMEOUT_MS,
    );
    this.maxOutboundQueueMessages = positiveConfigurationInteger(
      options.maxOutboundQueueMessages ?? DEFAULT_MAX_OUTBOUND_MESSAGES,
      "maxOutboundQueueMessages",
    );
    this.maxOutboundQueueBytes = positiveConfigurationInteger(
      options.maxOutboundQueueBytes ?? DEFAULT_MAX_OUTBOUND_BYTES,
      "maxOutboundQueueBytes",
    );
    const configuredCapabilities = normalizeCapabilities(
      options.capabilities ?? DEFAULT_NATIVE_TUI_CLIENT_CAPABILITIES,
      "capabilities",
      true,
    );
    const capabilityMessage = validateNativeTuiServerMessage({
      type: "capabilities",
      version: NATIVE_TUI_PROTOCOL_VERSION,
      id: this.serverId,
      capabilities: configuredCapabilities,
    });
    if (capabilityMessage.type !== "capabilities") {
      throw new NativeTuiControlServerError("Invalid native TUI capabilities");
    }
    this.capabilities = capabilityMessage.capabilities;
    this.projectionStore =
      options.projectionStore ?? new NativeTuiProjectionStore(sessionId);
    this.snapshotValue = this.projectionStore.snapshot;
    this.onInput = options.onInput;
    this.onTerminalSize = options.onTerminalSize;
    this.onCapabilities = options.onCapabilities;
    this.onBeforeConnect = options.onBeforeConnect;
    this.onConnect = options.onConnect;
    this.onDisconnect = options.onDisconnect;
    this.ownsInputController = options.inputController === undefined;
    this.inputController =
      options.inputController ??
      new NativeTuiInputController({
        ...options.inputControllerOptions,
        onIntent: options.onInput,
      });
  }

  get socketPath(): string {
    return this.socketPathValue;
  }

  get listening(): boolean {
    return this.server?.listening === true;
  }

  get connected(): boolean {
    return this.clientReady && this.client !== undefined;
  }

  get revision(): number {
    return this.projectionStore.revision;
  }

  get snapshot(): NativeTuiRenderSnapshot | undefined {
    return this.snapshotValue;
  }

  get input(): NativeTuiInputController {
    return this.inputController;
  }

  async start(): Promise<void> {
    if (this.listening) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal();
    try {
      await this.closePromise;
    } finally {
      this.closePromise = undefined;
    }
  }

  publish(input: NativeTuiProjectionInput): NativeTuiRenderSnapshot {
    const snapshot = this.projectionStore.update(input);
    this.snapshotValue = snapshot;
    this.sendIfReady(snapshot);
    return snapshot;
  }

  publishSnapshot(snapshot: NativeTuiRenderSnapshot): NativeTuiRenderSnapshot {
    const validated = validateNativeTuiServerMessage(snapshot);
    if (validated.type !== "render_snapshot") {
      throw new NativeTuiControlServerError(
        "Only render snapshots can be published",
      );
    }
    if (validated.version !== NATIVE_TUI_PROTOCOL_VERSION) {
      throw new NativeTuiControlServerError(
        "Snapshot has an unsupported version",
      );
    }
    if (validated.id !== this.sessionId) {
      throw new NativeTuiControlServerError(
        "Snapshot session ID does not match this control server",
      );
    }
    if (validated.sequence !== this.projectionStore.revision + 1) {
      throw new NativeTuiControlServerError(
        "Snapshot revision is not monotonic",
      );
    }
    const projected = this.projectionStore.update({
      sessions: validated.sessions,
      workspaces: validated.workspaces,
      active_session_id: validated.active_session_id ?? null,
      status: validated.status,
      telemetry: validated.telemetry,
      tasks: validated.tasks,
      agents: validated.agents,
      transcript: validated.transcript,
      transcript_window: validated.transcript_window ?? null,
      changes: validated.changes,
      activity: validated.activity,
      permissions: validated.permissions,
      writer: validated.writer,
    });
    this.snapshotValue = projected;
    this.sendIfReady(projected);
    return projected;
  }

  private async startInternal(): Promise<void> {
    if (process.platform === "win32") {
      throw new NativeTuiControlServerError(
        "Unix sockets are unavailable on win32",
      );
    }
    await mkdir(dirname(this.socketPathValue), {
      recursive: true,
      mode: 0o700,
    });
    await removeStaleSocket(this.socketPathValue);
    const server = createServer((socket) => this.acceptSocket(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(
          error instanceof NativeTuiControlServerError
            ? error
            : new NativeTuiControlServerError(
                "Unable to start native TUI socket",
                {
                  cause: error,
                },
              ),
        );
      };
      server.once("error", fail);
      server.listen(this.socketPathValue, () => {
        if (settled) return;
        settled = true;
        void chmod(this.socketPathValue, 0o600).then(resolve).catch(fail);
      });
    }).catch(async (error: unknown) => {
      server.close();
      this.server = undefined;
      throw error;
    });
  }

  private async closeInternal(): Promise<void> {
    this.clientReady = false;
    const client = this.client;
    const state = this.outbound;
    this.client = undefined;
    this.outbound = undefined;
    if (state) {
      this.clearHandshakeTimeout(state);
      this.failOutbound(
        state,
        new NativeTuiControlServerError("Control server closed"),
        false,
      );
    }
    client?.destroy();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    }
    await removeSocketIfPresent(this.socketPathValue);
    if (this.ownsInputController) this.inputController.close();
  }

  private acceptSocket(socket: Socket): void {
    if (this.client) {
      if (this.clientReady) {
        socket.destroy();
        return;
      }
      const previous = this.client;
      this.disconnectSocket(previous);
      previous.destroy();
    }
    const state: OutboundState = {
      socket,
      queue: [],
      queuedBytes: 0,
      running: false,
      closed: false,
      incoming: Promise.resolve(),
      handshakeComplete: false,
      negotiatedCapabilities: new Set(),
    };
    this.client = socket;
    this.outbound = state;
    this.clientReady = false;
    this.lastSentSnapshotSequence = undefined;
    state.handshakeTimer = setTimeout(
      () => this.expireHandshake(socket),
      this.handshakeTimeoutMs,
    );
    const decoder = new NativeTuiFrameDecoder();
    socket.setNoDelay?.(true);
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) {
          state.incoming = state.incoming
            .then(async () => {
              if (!socket.destroyed) await this.handleMessage(socket, message);
            })
            .catch(() => {
              socket.destroy();
            });
        }
      } catch {
        socket.destroy();
      }
    });
    socket.once("error", () => this.disconnectSocket(socket));
    socket.once("close", () => this.disconnectSocket(socket));
  }

  private async handleMessage(
    socket: Socket,
    value: NativeTuiClientMessage | NativeTuiServerMessage,
  ): Promise<void> {
    if (this.client !== socket) return;
    const state = this.outbound;
    if (!state || state.socket !== socket || state.closed) return;
    const message = validateNativeTuiClientMessage(value);
    if (!state.handshakeComplete && message.type !== "handshake") {
      await this.sendError(
        socket,
        message.id,
        "handshake_required",
        "Handshake required",
      );
      socket.destroy();
      return;
    }
    switch (message.type) {
      case "handshake": {
        if (state.handshakeComplete) {
          await this.sendError(
            socket,
            message.id,
            "duplicate_handshake",
            "Handshake already completed",
          );
          socket.destroy();
          return;
        }
        const negotiatedCapabilities = this.negotiateCapabilities(message);
        if (!negotiatedCapabilities) {
          await this.sendError(
            socket,
            message.id,
            "handshake_rejected",
            "Handshake values do not match this native TUI session",
          );
          socket.destroy();
          return;
        }
        await this.onBeforeConnect?.();
        if (
          this.client !== socket ||
          this.outbound !== state ||
          state.closed ||
          socket.destroyed
        ) {
          return;
        }
        this.clearHandshakeTimeout(state);
        state.handshakeComplete = true;
        state.negotiatedCapabilities = new Set(negotiatedCapabilities);
        this.clientReady = true;
        await this.send(socket, {
          type: "capabilities",
          version: NATIVE_TUI_PROTOCOL_VERSION,
          id: this.serverId,
          capabilities: negotiatedCapabilities,
        });
        if (this.snapshotValue) {
          await this.sendSnapshotIfNewer(socket, this.snapshotValue);
        }
        await this.onConnect?.();
        return;
      }
      case "capabilities":
        await this.onCapabilities?.(message);
        return;
      case "terminal_size":
        if (
          !(await this.requireCapability(socket, state, message.id, "resize"))
        ) {
          return;
        }
        await this.onTerminalSize?.(message);
        return;
      case "input_event":
        if (
          !(await this.requireCapability(socket, state, message.id, "input"))
        ) {
          return;
        }
        if (
          message.event.type === "mouse" &&
          !(await this.requireCapability(socket, state, message.id, "mouse"))
        ) {
          return;
        }
        if (
          message.event.type === "action" &&
          !(await this.requireCapability(socket, state, message.id, "action"))
        ) {
          return;
        }
        await this.inputController.accept(message);
        if (!this.ownsInputController) await this.onInput?.(message);
        await this.send(socket, {
          type: "ack",
          version: NATIVE_TUI_PROTOCOL_VERSION,
          id: message.id,
          sequence: message.sequence,
        });
        return;
      case "shutdown":
        if (
          !(await this.requireCapability(socket, state, message.id, "shutdown"))
        ) {
          return;
        }
        await this.send(socket, message);
        await this.close();
        return;
      default:
        throw new NativeTuiProtocolError(
          "Unsupported native TUI client message",
        );
    }
  }

  private negotiateCapabilities(
    message: Extract<NativeTuiClientMessage, { type: "handshake" }>,
  ): string[] | undefined {
    if (
      message.id !== this.sessionId ||
      message.client !== this.expectedClient
    ) {
      return undefined;
    }
    const actual = new Set(message.capabilities);
    if (
      actual.size !== message.capabilities.length ||
      !this.expectedClientCapabilities.every((capability) =>
        actual.has(capability),
      )
    ) {
      return undefined;
    }
    return this.capabilities.filter((capability) => actual.has(capability));
  }

  private async requireCapability(
    socket: Socket,
    state: OutboundState,
    id: string,
    capability: string,
  ): Promise<boolean> {
    if (state.negotiatedCapabilities.has(capability)) return true;
    await this.sendError(
      socket,
      id,
      "capability_required",
      `Capability ${capability} was not negotiated`,
    );
    return false;
  }

  private expireHandshake(socket: Socket): void {
    if (this.client !== socket || this.clientReady) return;
    const state = this.outbound;
    if (!state || state.socket !== socket || state.handshakeComplete) return;
    this.clearHandshakeTimeout(state);
    socket.destroy();
  }

  private clearHandshakeTimeout(state: OutboundState): void {
    if (state.handshakeTimer === undefined) return;
    clearTimeout(state.handshakeTimer);
    state.handshakeTimer = undefined;
  }

  private sendIfReady(message: NativeTuiServerMessage): void {
    const socket = this.client;
    if (!this.clientReady || !socket || socket.destroyed) return;
    if (message.type === "render_snapshot") {
      void this.sendSnapshotIfNewer(socket, message).catch(() => {
        if (this.client === socket) socket.destroy();
      });
      return;
    }
    void this.send(socket, message).catch(() => {
      if (this.client === socket) socket.destroy();
    });
  }

  private async sendSnapshotIfNewer(
    socket: Socket,
    message: NativeTuiRenderSnapshot,
  ): Promise<void> {
    const state = this.outbound;
    if (
      this.client !== socket ||
      !state ||
      !state.negotiatedCapabilities.has("render_snapshot") ||
      socket.destroyed
    ) {
      return;
    }
    if (
      this.lastSentSnapshotSequence !== undefined &&
      message.sequence <= this.lastSentSnapshotSequence
    ) {
      return;
    }
    const pending = this.outbound?.queue.find(
      (entry) => entry.snapshot && entry.sequence !== undefined,
    );
    if (
      pending?.sequence !== undefined &&
      message.sequence <= pending.sequence
    ) {
      return;
    }
    await this.send(socket, message);
  }

  private send(socket: Socket, message: NativeTuiServerMessage): Promise<void> {
    const state = this.outbound;
    if (!state || state.socket !== socket || state.closed || socket.destroyed) {
      return Promise.reject(
        new NativeTuiControlServerError("Native TUI socket is unavailable"),
      );
    }
    const frame = encodeNativeTuiFrame(message);
    const isSnapshot = message.type === "render_snapshot";
    return new Promise<void>((resolve, reject) => {
      const entry: OutboundEntry = {
        frame,
        message,
        snapshot: isSnapshot,
        sequence: isSnapshot ? message.sequence : undefined,
        resolve,
        reject,
      };
      if (!this.enqueueOutbound(state, entry)) {
        reject(
          new NativeTuiControlServerError(
            "Native TUI outbound queue is saturated",
          ),
        );
        return;
      }
      void this.pumpOutbound(state);
    });
  }

  private enqueueOutbound(state: OutboundState, entry: OutboundEntry): boolean {
    const pendingSnapshotIndex = entry.snapshot
      ? state.queue.findIndex((queued) => queued.snapshot)
      : -1;
    if (pendingSnapshotIndex >= 0) {
      const previous = state.queue[pendingSnapshotIndex];
      if (!previous) return false;
      const nextBytes =
        state.queuedBytes - previous.frame.byteLength + entry.frame.byteLength;
      if (nextBytes > this.maxOutboundQueueBytes) return false;
      state.queue[pendingSnapshotIndex] = entry;
      state.queuedBytes = nextBytes;
      previous.resolve();
      return true;
    }
    if (
      state.queue.length >= this.maxOutboundQueueMessages ||
      state.queuedBytes + entry.frame.byteLength > this.maxOutboundQueueBytes
    ) {
      return false;
    }
    state.queue.push(entry);
    state.queuedBytes += entry.frame.byteLength;
    return true;
  }

  private async pumpOutbound(state: OutboundState): Promise<void> {
    if (state.running || state.closed) return;
    state.running = true;
    try {
      while (state.queue.length > 0 && !state.closed) {
        const entry = state.queue.shift();
        if (!entry) break;
        state.queuedBytes -= entry.frame.byteLength;
        state.active = entry;
        try {
          await writeFrameWithBackpressure(state.socket, entry.frame);
          if (
            entry.snapshot &&
            entry.sequence !== undefined &&
            (this.lastSentSnapshotSequence === undefined ||
              entry.sequence > this.lastSentSnapshotSequence)
          ) {
            this.lastSentSnapshotSequence = entry.sequence;
          }
          entry.resolve();
        } catch (error) {
          entry.reject(error);
          this.failOutbound(state, error, true);
          return;
        } finally {
          state.active = undefined;
        }
      }
    } finally {
      state.running = false;
      if (state.queue.length > 0 && !state.closed)
        void this.pumpOutbound(state);
    }
  }

  private async sendError(
    socket: Socket,
    id: string,
    code: string,
    message: string,
  ): Promise<void> {
    await this.send(socket, {
      type: "error",
      version: NATIVE_TUI_PROTOCOL_VERSION,
      id,
      code,
      message,
    });
  }

  private failOutbound(
    state: OutboundState,
    error: unknown,
    destroy: boolean,
  ): void {
    if (state.closed && state.queue.length === 0 && !state.active) return;
    state.closed = true;
    const entries = [
      ...(state.active ? [state.active] : []),
      ...state.queue.splice(0),
    ];
    state.queuedBytes = 0;
    state.active = undefined;
    for (const entry of entries) entry.reject(error);
    if (destroy && !state.socket.destroyed) state.socket.destroy();
  }

  private disconnectSocket(socket: Socket): void {
    if (this.client !== socket) return;
    const state = this.outbound;
    this.client = undefined;
    this.outbound = undefined;
    const wasReady = this.clientReady;
    this.clientReady = false;
    if (state) {
      this.clearHandshakeTimeout(state);
      this.failOutbound(
        state,
        new NativeTuiControlServerError("Native TUI socket disconnected"),
        false,
      );
    }
    if (wasReady) void this.onDisconnect?.();
  }
}

async function writeFrameWithBackpressure(
  socket: Socket,
  frame: Buffer,
): Promise<void> {
  if (socket.destroyed)
    throw new NativeTuiControlServerError("Socket is destroyed");
  await new Promise<void>((resolve, reject) => {
    let callbackDone = false;
    let drained = true;
    let settled = false;
    const cleanup = (): void => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (): void => {
      if (!settled && callbackDone && drained) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const onDrain = (): void => {
      drained = true;
      finish();
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      onError(new NativeTuiControlServerError("Socket closed during write"));
    };
    socket.once("error", onError);
    socket.once("close", onClose);
    try {
      const accepted = socket.write(frame, (error?: Error | null) => {
        if (error) {
          onError(error);
          return;
        }
        callbackDone = true;
        finish();
      });
      if (!accepted) {
        drained = false;
        socket.once("drain", onDrain);
      }
      finish();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function normalizeCapabilities(
  values: readonly string[],
  context: string,
  allowEmpty = false,
): string[] {
  if (
    !Array.isArray(values) ||
    (!allowEmpty && values.length === 0) ||
    values.length > NATIVE_TUI_MAX_CAPABILITIES
  ) {
    throw new NativeTuiControlServerError(
      `${context} must contain ${allowEmpty ? "0" : "1"}-${NATIVE_TUI_MAX_CAPABILITIES} values`,
    );
  }
  const result = values.map((value, index) =>
    boundedConfigurationText(
      value,
      `${context}[${index}]`,
      NATIVE_TUI_MAX_CAPABILITY_BYTES,
    ),
  );
  if (new Set(result).size !== result.length) {
    throw new NativeTuiControlServerError(
      `${context} must not contain duplicates`,
    );
  }
  return result;
}

function boundedConfigurationText(
  value: string,
  context: string,
  maxBytes: number,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new NativeTuiControlServerError(
      `${context} must be a non-empty string`,
    );
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new NativeTuiControlServerError(
      `${context} exceeds ${maxBytes} bytes`,
    );
  }
  return value;
}

function positiveConfigurationInteger(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new NativeTuiControlServerError(
      `${context} must be a positive safe integer`,
    );
  }
  return value;
}

function boundedConfigurationInteger(
  value: number,
  context: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new NativeTuiControlServerError(
      `${context} must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return value;
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isSocket()) {
      throw new NativeTuiControlServerError(
        "Native TUI socket path is not a Unix socket",
      );
    }
    await unlink(path);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function removeSocketIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
