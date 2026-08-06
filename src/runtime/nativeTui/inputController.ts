import {
  NATIVE_TUI_MAX_PENDING_INPUTS,
  NATIVE_TUI_PROTOCOL_VERSION,
  type NativeTuiInputEvent,
  type NativeTuiInputEventKind,
  validateNativeTuiMessage,
} from "./protocol.js";

export type NativeTuiInputIntent = Omit<
  NativeTuiInputEvent,
  "version" | "type"
>;

export type NativeTuiInputControllerOptions = {
  initialSequence?: number;
  maxPendingInputs?: number;
  onIntent?: (intent: NativeTuiInputEvent) => void | Promise<void>;
};

type PendingIntent = {
  intent: NativeTuiInputEvent;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class NativeTuiInputController {
  private readonly onIntent?: NativeTuiInputControllerOptions["onIntent"];
  private readonly queue: PendingIntent[] = [];
  private expectedSequenceValue: number;
  private outboundSequenceValue: number;
  private readonly maxPendingInputs: number;
  private processing = false;
  private closed = false;

  constructor(options: NativeTuiInputControllerOptions = {}) {
    const initialSequence = options.initialSequence ?? 0;
    const maxPendingInputs =
      options.maxPendingInputs ?? NATIVE_TUI_MAX_PENDING_INPUTS;
    if (
      !Number.isSafeInteger(initialSequence) ||
      initialSequence < 0 ||
      initialSequence >= Number.MAX_SAFE_INTEGER
    ) {
      throw new TypeError(
        "initialSequence must be a non-negative safe integer",
      );
    }
    if (
      !Number.isSafeInteger(maxPendingInputs) ||
      maxPendingInputs <= 0 ||
      maxPendingInputs > NATIVE_TUI_MAX_PENDING_INPUTS
    ) {
      throw new TypeError(
        `maxPendingInputs must be a positive safe integer no greater than ${NATIVE_TUI_MAX_PENDING_INPUTS}`,
      );
    }
    this.expectedSequenceValue = initialSequence + 1;
    this.outboundSequenceValue = initialSequence + 1;
    this.maxPendingInputs = maxPendingInputs;
    this.onIntent = options.onIntent;
  }

  get expectedSequence(): number {
    return this.expectedSequenceValue;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  accept(event: NativeTuiInputEvent): Promise<void> {
    const validated = validateNativeTuiMessage(event);
    if (validated.type !== "input_event") {
      throw new TypeError("Input controller accepts input_event messages only");
    }
    if (validated.sequence !== this.expectedSequenceValue) {
      throw new TypeError(
        `Input sequence must be ${this.expectedSequenceValue}; received ${validated.sequence}`,
      );
    }
    if (this.closed) throw new TypeError("Input controller is closed");
    if (this.queue.length >= this.maxPendingInputs) {
      throw new TypeError("Input controller queue is full");
    }
    if (this.expectedSequenceValue === Number.MAX_SAFE_INTEGER) {
      this.closed = true;
      throw new TypeError("Input sequence exhausted");
    }
    this.expectedSequenceValue += 1;
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ intent: validated, resolve, reject });
      void this.process();
    });
  }

  enqueue(event: NativeTuiInputEvent): Promise<void> {
    return this.accept(event);
  }

  createIntent(
    id: string,
    event: NativeTuiInputEventKind,
  ): NativeTuiInputEvent {
    if (this.closed) throw new TypeError("Input controller is closed");
    const sequence = this.outboundSequenceValue;
    if (sequence >= Number.MAX_SAFE_INTEGER) {
      throw new TypeError("Input sequence exhausted");
    }
    this.outboundSequenceValue += 1;
    return {
      type: "input_event",
      version: NATIVE_TUI_PROTOCOL_VERSION,
      id,
      sequence,
      event,
    };
  }

  close(reason = new Error("Input controller is closed")): void {
    if (this.closed) return;
    this.closed = true;
    const queued = this.queue.splice(0);
    for (const pending of queued) pending.reject(reason);
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const pending = this.queue.shift();
        if (!pending) continue;
        try {
          await this.onIntent?.(pending.intent);
          pending.resolve();
        } catch (error) {
          pending.reject(error);
        }
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) void this.process();
    }
  }
}

export const InputController = NativeTuiInputController;
