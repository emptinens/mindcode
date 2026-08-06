import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import type { DaemonWireMessage } from "./protocol.js";

export type DaemonClientState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "closed";

export type DaemonTimeoutKind = "connect" | "handshake" | "request";

export type DaemonFallbackReason =
  | "disabled"
  | "connect_timeout"
  | "handshake_timeout"
  | "request_timeout"
  | "unavailable"
  | "protocol_error"
  | "cancelled"
  | "remote_error";

export type DaemonCallResult<T> =
  | { source: "daemon"; value: T }
  | {
      source: "fallback";
      value: T;
      reason: DaemonFallbackReason;
      error?: unknown;
    };

export type DaemonRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  onChunk?: (data: unknown, sequence: number) => void | Promise<void>;
  /** Called exactly once after the request frame is accepted by the socket. */
  onDispatch?: () => void;
};

export type DaemonClientOptions = {
  socketPath?: string;
  clientName?: string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  socketFactory?: (path: string) => Socket;
};

export type DaemonStatus = Record<string, unknown>;
export type DaemonPingResult = Record<string, unknown>;
export type DaemonShutdownResult = Record<string, unknown>;

export type DaemonSpawnOptions = {
  socketPath?: string;
  executablePath?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type DaemonSpawnResult = {
  executablePath: string;
  socketPath: string;
  process: ChildProcess;
};

export type DaemonMessageHandler = (message: DaemonWireMessage) => void;

export type DaemonManagerRequestOptions = DaemonRequestOptions;
