import { type Socket, createConnection } from "node:net";
import {
  DaemonCancelledError,
  DaemonClientError,
  DaemonDisconnectedError,
  DaemonRemoteError,
  DaemonTimeoutError,
  classifyDaemonFallback,
} from "./errors.js";
import { resolveDaemonSocketPath } from "./path.js";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonHandshake,
  DaemonProtocolError,
  type DaemonWireMessage,
  FrameDecoder,
  encodeFrame,
} from "./protocol.js";
import type {
  DaemonCallResult,
  DaemonClientOptions,
  DaemonClientState,
  DaemonPingResult,
  DaemonRequestOptions,
  DaemonShutdownResult,
  DaemonStatus,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 1_500;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1_500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class DaemonClient {
  private readonly options: Required<
    Pick<
      DaemonClientOptions,
      | "clientName"
      | "connectTimeoutMs"
      | "handshakeTimeoutMs"
      | "requestTimeoutMs"
      | "maxFrameBytes"
    >
  > &
    Pick<DaemonClientOptions, "socketPath" | "socketFactory">;
  private activeConnection?: Connection;
  private connectionGeneration = 0;
  private connectPromise?: Promise<void>;
  private requestCounter = 0;
  private stateValue: DaemonClientState = "disconnected";
  private permanentlyClosed = false;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: DaemonClientOptions = {}) {
    this.options = {
      socketPath: options.socketPath,
      socketFactory: options.socketFactory,
      clientName: options.clientName ?? "mindcode-ts-client",
      connectTimeoutMs: boundedTimeout(
        options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      ),
      handshakeTimeoutMs: boundedTimeout(
        options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      ),
      requestTimeoutMs: boundedTimeout(
        options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ),
      maxFrameBytes: options.maxFrameBytes ?? 16 * 1024 * 1024,
    };
  }

  get state(): DaemonClientState {
    return this.stateValue;
  }

  get socketPath(): string {
    return this.options.socketPath ?? resolveDaemonSocketPath();
  }

  async connect(): Promise<void> {
    if (this.stateValue === "ready") return;
    if (this.permanentlyClosed) {
      throw new DaemonClientError(
        "DAEMON_CLIENT_CLOSED",
        "Daemon client is closed",
      );
    }
    if (this.connectPromise) return this.connectPromise;

    this.stateValue = "connecting";
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timers: { connect?: ReturnType<typeof setTimeout> } = {};
      let socket: Socket | undefined;

      try {
        socket = (this.options.socketFactory ?? createConnection)(
          this.socketPath,
        );
      } catch (error) {
        settled = true;
        if (this.stateValue !== "closed") this.stateValue = "disconnected";
        reject(error);
        return;
      }

      const connection: Connection = {
        generation: ++this.connectionGeneration,
        socket,
        decoder: new FrameDecoder(this.options.maxFrameBytes),
      };
      this.activeConnection = connection;
      socket.setNoDelay?.(true);

      const rejectConnection = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (timers.connect) clearTimeout(timers.connect);
        this.handleDisconnect(connection, error);
        reject(error);
      };

      timers.connect = unrefTimer(
        setTimeout(() => {
          rejectConnection(
            new DaemonTimeoutError("connect", this.options.connectTimeoutMs),
          );
          socket?.destroy();
        }, this.options.connectTimeoutMs),
      );

      socket.on("data", (chunk: Buffer) => {
        if (!this.owns(connection)) return;
        try {
          for (const message of connection.decoder.push(chunk)) {
            this.handleMessage(message, connection.generation);
          }
        } catch (error) {
          rejectConnection(error);
          socket?.destroy();
        }
      });
      socket.once("error", (error) => {
        if (!settled) rejectConnection(error);
        else this.handleDisconnect(connection, error);
      });
      socket.once("close", () => {
        if (!settled) rejectConnection(new DaemonDisconnectedError());
        else this.handleDisconnect(connection, new DaemonDisconnectedError());
      });
      socket.once("connect", () => {
        if (settled || !this.owns(connection)) return;
        if (timers.connect) clearTimeout(timers.connect);
        const id = this.nextRequestId("handshake");
        const handshake: DaemonHandshake = {
          type: "handshake",
          id,
          version: DAEMON_PROTOCOL_VERSION,
          client: this.options.clientName,
          capabilities: [
            "request",
            "stream",
            "cancel",
            "ping",
            "status",
            "shutdown",
          ],
        };
        const handshakePromise = new Promise<DaemonWireMessage>(
          (resolveHandshake, rejectHandshake) => {
            const pending: PendingRequest = {
              kind: "handshake",
              id,
              generation: connection.generation,
              resolve: (value) => resolveHandshake(value as DaemonWireMessage),
              reject: rejectHandshake,
              timer: unrefTimer(
                setTimeout(() => {
                  this.settlePending(
                    id,
                    new DaemonTimeoutError(
                      "handshake",
                      this.options.handshakeTimeoutMs,
                    ),
                    undefined,
                    connection.generation,
                  );
                  socket?.destroy();
                }, this.options.handshakeTimeoutMs),
              ),
            };
            this.pending.set(id, pending);
          },
        );
        try {
          this.send(connection, handshake);
        } catch (error) {
          this.settlePending(id, error, undefined, connection.generation);
          rejectConnection(error);
          socket.destroy();
          return;
        }
        void handshakePromise.then(
          (message) => {
            if (settled || !this.owns(connection)) return;
            if (
              message.type !== "handshake_ack" ||
              !message.accepted ||
              message.version !== DAEMON_PROTOCOL_VERSION
            ) {
              rejectConnection(
                new DaemonProtocolError(
                  "Invalid daemon handshake acknowledgement",
                ),
              );
              socket.destroy();
              return;
            }
            settled = true;
            this.stateValue = "ready";
            resolve();
          },
          (error) => rejectConnection(error),
        );
      });
    });

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  async request<T>(
    method: string,
    params?: unknown,
    options: DaemonRequestOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted) throw new DaemonCancelledError();
    if (this.stateValue !== "ready") await this.connect();
    if (options.signal?.aborted) throw new DaemonCancelledError();
    const connection = this.activeConnection;
    if (this.stateValue !== "ready" || !connection) {
      throw new DaemonDisconnectedError();
    }

    const id = this.nextRequestId("request");
    const timeoutMs = boundedTimeout(
      options.timeoutMs ?? this.options.requestTimeoutMs,
    );
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        kind: "request",
        id,
        generation: connection.generation,
        expectedSequence: 0,
        onChunk: options.onChunk,
        signal: options.signal,
        resolve: (value) => resolve(value as T),
        reject,
        timer: unrefTimer(
          setTimeout(() => {
            this.sendCancel(id, connection.generation);
            this.settlePending(
              id,
              new DaemonTimeoutError("request", timeoutMs),
              undefined,
              connection.generation,
            );
          }, timeoutMs),
        ),
      };
      const onAbort = (): void => {
        if (!this.isPending(id, connection.generation)) return;
        this.sendCancel(id, connection.generation);
        this.settlePending(
          id,
          new DaemonCancelledError(),
          undefined,
          connection.generation,
        );
      };
      pending.onAbort = onAbort;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, pending);
      try {
        this.send(connection, {
          type: "request",
          id,
          method,
          ...(params === undefined ? {} : { params }),
          ...(options.onChunk ? { stream: true } : {}),
        });
      } catch (error) {
        this.settlePending(id, error, undefined, connection.generation);
      }
    });
  }

  async requestWithFallback<T>(
    method: string,
    params: unknown,
    fallback: T | (() => T | Promise<T>),
    options: DaemonRequestOptions = {},
  ): Promise<DaemonCallResult<T>> {
    try {
      return {
        source: "daemon",
        value: await this.request<T>(method, params, options),
      };
    } catch (error) {
      const value =
        typeof fallback === "function"
          ? await (fallback as () => T | Promise<T>)()
          : fallback;
      return {
        source: "fallback",
        value,
        reason: classifyDaemonFallback(error),
        error,
      };
    }
  }

  ping(options?: DaemonRequestOptions): Promise<DaemonPingResult> {
    return this.request<DaemonPingResult>("ping", undefined, options);
  }

  status(options?: DaemonRequestOptions): Promise<DaemonStatus> {
    return this.request<DaemonStatus>("status", undefined, options);
  }

  async shutdown(
    options?: DaemonRequestOptions,
  ): Promise<DaemonShutdownResult> {
    try {
      return await this.request<DaemonShutdownResult>(
        "shutdown",
        undefined,
        options,
      );
    } finally {
      this.disconnect();
    }
  }

  disconnect(): void {
    this.permanentlyClosed = false;
    const connection = this.activeConnection;
    this.activeConnection = undefined;
    this.stateValue = "disconnected";
    if (connection) {
      connection.decoder.reset();
      this.rejectPending(connection.generation, new DaemonDisconnectedError());
      connection.socket.destroy();
    } else {
      this.rejectAllPending(new DaemonDisconnectedError());
    }
  }

  close(): void {
    this.permanentlyClosed = true;
    const connection = this.activeConnection;
    this.activeConnection = undefined;
    this.stateValue = "closed";
    if (connection) {
      connection.decoder.reset();
      this.rejectPending(connection.generation, new DaemonDisconnectedError());
      connection.socket.destroy();
    } else {
      this.rejectAllPending(new DaemonDisconnectedError());
    }
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1;
    return `${prefix}-${this.requestCounter.toString(36)}`;
  }

  private send(connection: Connection, message: DaemonWireMessage): void {
    if (!this.owns(connection) || this.stateValue === "closed") {
      throw new DaemonDisconnectedError();
    }
    connection.socket.write(encodeFrame(message, this.options.maxFrameBytes));
  }

  private sendCancel(id: string, generation: number): void {
    try {
      const connection = this.activeConnection;
      if (
        connection?.generation === generation &&
        this.stateValue === "ready"
      ) {
        this.send(connection, { type: "cancel", id });
      }
    } catch {
      // The original request error is the useful failure when a socket is already gone.
    }
  }

  private handleMessage(message: DaemonWireMessage, generation: number): void {
    if (message.type === "stream") {
      const pending = this.pending.get(message.id);
      if (
        !pending ||
        pending.kind !== "request" ||
        pending.generation !== generation
      )
        return;
      if (message.seq !== pending.expectedSequence) {
        this.sendCancel(message.id, generation);
        this.settlePending(
          message.id,
          new DaemonProtocolError(
            `Invalid stream sequence for ${message.id}: expected ${pending.expectedSequence}, got ${message.seq}`,
          ),
          undefined,
          generation,
        );
        return;
      }
      pending.expectedSequence += 1;
      if (!pending.onChunk) return;
      try {
        const result = pending.onChunk(message.data, message.seq);
        if (result && typeof (result as Promise<void>).then === "function") {
          void Promise.resolve(result).catch((error) => {
            if (!this.isPending(message.id, generation)) return;
            this.sendCancel(message.id, generation);
            this.settlePending(message.id, error, undefined, generation);
          });
        }
      } catch (error) {
        if (!this.isPending(message.id, generation)) return;
        this.sendCancel(message.id, generation);
        this.settlePending(message.id, error, undefined, generation);
      }
      return;
    }

    if (message.type === "handshake_ack") {
      const pending = this.pending.get(message.id);
      if (pending?.kind === "handshake" && pending.generation === generation) {
        this.settlePending(message.id, undefined, message, generation);
      }
      return;
    }

    if (message.type !== "response") return;
    const pending = this.pending.get(message.id);
    if (!pending || pending.generation !== generation) return;
    if (!message.ok) {
      const remote = message.error;
      this.settlePending(
        message.id,
        new DaemonRemoteError(
          remote?.message ?? "Daemon request failed",
          remote?.code,
          remote?.details,
        ),
        undefined,
        generation,
      );
      return;
    }
    this.settlePending(message.id, undefined, message.result, generation);
  }

  private settlePending(
    id: string,
    error?: unknown,
    value?: unknown,
    generation?: number,
  ): void {
    const pending = this.pending.get(id);
    if (
      !pending ||
      (generation !== undefined && pending.generation !== generation)
    )
      return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.onAbort &&
      pending.signal?.removeEventListener("abort", pending.onAbort);
    if (error === undefined) pending.resolve(value);
    else pending.reject(error);
  }

  private rejectPending(generation: number, error: unknown): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation === generation) {
        this.settlePending(id, error, undefined, generation);
      }
    }
  }

  private rejectAllPending(error: unknown): void {
    for (const id of [...this.pending.keys()]) this.settlePending(id, error);
  }

  private handleDisconnect(
    connection: Connection | undefined,
    cause: unknown,
  ): void {
    if (!connection || !this.owns(connection)) return;
    this.activeConnection = undefined;
    connection.decoder.reset();
    if (this.stateValue !== "closed") this.stateValue = "disconnected";
    this.rejectPending(
      connection.generation,
      cause instanceof DaemonClientError
        ? cause
        : new DaemonDisconnectedError(cause),
    );
  }

  private owns(connection: Connection | undefined): connection is Connection {
    return connection !== undefined && this.activeConnection === connection;
  }

  private isPending(id: string, generation: number): boolean {
    return this.pending.get(id)?.generation === generation;
  }
}

type Connection = {
  generation: number;
  socket: Socket;
  decoder: FrameDecoder;
};

type PendingRequest = {
  kind: "handshake" | "request";
  id: string;
  generation: number;
  expectedSequence?: number;
  onChunk?: (data: unknown, sequence: number) => void | Promise<void>;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(Math.floor(value), 2 ** 31 - 1);
}

function unrefTimer<T extends ReturnType<typeof setTimeout>>(timer: T): T {
  (timer as T & { unref?: () => void }).unref?.();
  return timer;
}
