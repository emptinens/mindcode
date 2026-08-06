import { PassThrough, Writable } from "node:stream";
import stripAnsi from "strip-ansi";
import type { RenderOptions } from "../../ink.js";
import type { AppState } from "../../state/AppStateStore.js";
import type { TaskState } from "../../tasks/types.js";
import type { NativeTuiControlServer } from "./controlServer.js";
import type {
  NativeTuiInputEvent,
  NativeTuiInputEventKind,
} from "./protocol.js";

const MAX_CAPTURED_FRAGMENTS = 64;
const MAX_CAPTURED_TEXT_BYTES = 128 * 1024;

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
  private publishScheduled = false;
  private closed = false;
  private transcriptSequence = 0;

  constructor(
    control: NativeTuiControlServer,
    columns = process.stdout.columns || 120,
    rows = process.stdout.rows || 40,
  ) {
    this.control = control;
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
    const bytes = inputBytes(message.event);
    if (bytes.length > 0) this.inputStream.write(bytes);
  };

  resize = (columns: number, rows: number): void => {
    if (this.closed) return;
    this.outputStream.columns = columns;
    this.outputStream.rows = rows;
    this.outputStream.emit("resize");
  };

  publishState(
    state: Pick<
      AppState,
      "tasks" | "statusLineText" | "mainLoopModel" | "effortValue"
    >,
  ): void {
    if (this.closed) return;
    this.latestState = state;
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

  private publish(): void {
    const state = this.latestState;
    const tasks = state
      ? (Object.values(state.tasks) as readonly TaskState[])
      : [];
    const working = tasks.some(
      (task) => task.status === "running" || task.status === "pending",
    );
    const transcriptText = this.fragments.join("\n");
    this.transcriptSequence += 1;
    try {
      this.control.publish({
        status: {
          state: working ? "working" : "ready",
          message: state?.statusLineText,
          detail: [state?.mainLoopModel, state?.effortValue]
            .filter(Boolean)
            .join(" · "),
        },
        tasks: tasks.map((task) => ({
          id: task.id,
          title: task.description,
          status: task.status,
          detail: task.type,
        })),
        transcript: transcriptText
          ? [
              {
                sequence: this.transcriptSequence,
                role: "session",
                text: transcriptText,
              },
            ]
          : [],
      });
    } catch {
      // Projection limits are a display boundary: dropping one frame must not
      // terminate the authoritative Ink REPL or the user's terminal session.
    }
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
  }
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
