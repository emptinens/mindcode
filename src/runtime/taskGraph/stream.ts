import { DaemonCancelledError } from "../daemon/errors.js";
import type { TaskGraphDaemonClient } from "./client.js";
import { TaskGraphProtocolError } from "./errors.js";
import type {
  TaskGraphRequestOptions,
  TaskGraphWatchEvent,
  TaskGraphWatchParams,
  TaskGraphWatchResult,
} from "./protocol.js";

const DEFAULT_MAX_BUFFERED_EVENTS = 32;
const MAX_BUFFERED_EVENTS = 1_024;

export type TaskGraphWatchStreamOptions = Omit<
  TaskGraphRequestOptions,
  "onChunk"
> & {
  maxBufferedEvents?: number;
};

/**
 * A bounded, single-consumer view over one daemon task-graph watch request.
 * Returning from a `for await` loop cancels the underlying RPC immediately.
 */
export class TaskGraphWatchStream
  implements AsyncIterableIterator<TaskGraphWatchEvent>
{
  readonly completion: Promise<TaskGraphWatchResult>;

  private readonly controller = new AbortController();
  private readonly queue: TaskGraphWatchEvent[] = [];
  private readonly maxBufferedEvents: number;
  private externalSignal?: AbortSignal;
  private externalAbortListener?: () => void;
  private pendingRead?: {
    resolve: (result: IteratorResult<TaskGraphWatchEvent>) => void;
    reject: (error: unknown) => void;
  };
  private failure?: unknown;
  private ended = false;
  private iteratorTaken = false;
  private closedByConsumer = false;

  constructor(
    client: TaskGraphDaemonClient,
    params: TaskGraphWatchParams = {},
    options: TaskGraphWatchStreamOptions = {},
  ) {
    this.maxBufferedEvents = boundedBufferSize(options.maxBufferedEvents);
    const {
      maxBufferedEvents: _maxBufferedEvents,
      signal,
      ...requestOptions
    } = options;
    if (signal) {
      this.externalSignal = signal;
      this.externalAbortListener = () => this.controller.abort(signal.reason);
      signal.addEventListener("abort", this.externalAbortListener, {
        once: true,
      });
      if (signal.aborted) this.externalAbortListener();
    }

    this.completion = client
      .watch(params, (event) => this.enqueue(event), {
        ...requestOptions,
        signal: this.controller.signal,
      })
      .then(
        (result) => {
          this.finish();
          return result;
        },
        (error: unknown) => {
          this.fail(error);
          throw error;
        },
      );
    // Consumers may only iterate and never inspect completion. Keep the
    // observable promise while preventing cancellation from becoming an
    // unhandled rejection.
    void this.completion.catch(() => undefined);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<TaskGraphWatchEvent> {
    if (this.iteratorTaken) {
      throw new TypeError("TaskGraphWatchStream can only be iterated once");
    }
    this.iteratorTaken = true;
    return this;
  }

  next(): Promise<IteratorResult<TaskGraphWatchEvent>> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve({ done: false, value: queued });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    if (this.pendingRead) {
      return Promise.reject(
        new TypeError("TaskGraphWatchStream only supports one pending read"),
      );
    }
    return new Promise((resolve, reject) => {
      this.pendingRead = { resolve, reject };
    });
  }

  async return(): Promise<IteratorResult<TaskGraphWatchEvent>> {
    this.close();
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<TaskGraphWatchEvent>> {
    this.close(error);
    throw error;
  }

  close(reason: unknown = new DaemonCancelledError()): void {
    if (this.ended) return;
    this.closedByConsumer = true;
    this.controller.abort(reason);
    this.finish();
  }

  private enqueue(event: TaskGraphWatchEvent): void {
    if (this.ended || this.failure !== undefined) return;
    const pending = this.pendingRead;
    if (pending) {
      this.pendingRead = undefined;
      pending.resolve({ done: false, value: event });
      return;
    }
    if (this.queue.length >= this.maxBufferedEvents) {
      const error = new TaskGraphProtocolError(
        `task graph watch exceeded ${this.maxBufferedEvents} buffered events`,
      );
      this.fail(error);
      this.controller.abort(error);
      throw error;
    }
    this.queue.push(event);
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.cleanupExternalSignal();
    const pending = this.pendingRead;
    this.pendingRead = undefined;
    pending?.resolve({ done: true, value: undefined });
  }

  private fail(error: unknown): void {
    if (this.closedByConsumer) return;
    if (this.failure === undefined) this.failure = error;
    this.ended = true;
    this.cleanupExternalSignal();
    const pending = this.pendingRead;
    this.pendingRead = undefined;
    pending?.reject(this.failure);
  }

  private cleanupExternalSignal(): void {
    if (this.externalSignal && this.externalAbortListener) {
      this.externalSignal.removeEventListener(
        "abort",
        this.externalAbortListener,
      );
    }
    this.externalSignal = undefined;
    this.externalAbortListener = undefined;
  }
}

export function streamTaskGraph(
  client: TaskGraphDaemonClient,
  params: TaskGraphWatchParams = {},
  options: TaskGraphWatchStreamOptions = {},
): TaskGraphWatchStream {
  return new TaskGraphWatchStream(client, params, options);
}

function boundedBufferSize(value: number | undefined): number {
  const size = value ?? DEFAULT_MAX_BUFFERED_EVENTS;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BUFFERED_EVENTS) {
    throw new TypeError(
      `maxBufferedEvents must be a safe integer between 1 and ${MAX_BUFFERED_EVENTS}`,
    );
  }
  return size;
}
