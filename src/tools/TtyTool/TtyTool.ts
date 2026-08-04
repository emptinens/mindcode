import { z } from 'zod/v4'
import { type ToolDef, type ValidationResult, buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  closePtySession,
  listPtySessions,
  openPtySession,
  readPtySession,
  writePtySession,
} from '../../utils/pty/ptySessionManager.js'
import { TTY_TOOL_NAME, getTtyPrompt } from './prompt.js'

// NOTE: tool input schemas must be a plain object at the top level — the API
// rejects a top-level anyOf/oneOf (which a discriminated union produces). So
// this is one flat object with `action` as the discriminant and every
// action-specific field optional; validateInput enforces which fields are
// required for each action.
const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['open', 'write', 'read', 'list', 'close'])
      .describe(
        'Operation: "open" spawns a session, "write" sends input, "read" drains output, "list" shows sessions, "close" kills one.',
      ),
    sessionId: z
      .string()
      .optional()
      .describe(
        'REQUIRED for every action. On "open" this is the NAME you assign the session — pick a short, memorable, descriptive slug (e.g. "build", "server", "repl"), not a random string. Reuse that same name on write/read/close to target the session. Shown in the UI, so keep it human-readable.',
      ),
    // open
    shell: z
      .string()
      .optional()
      .describe(
        '[open] Shell executable. Defaults to $SHELL (unix) or %ComSpec%/cmd.exe (windows).',
      ),
    cwd: z
      .string()
      .optional()
      .describe('[open] Working directory. Defaults to the current process cwd.'),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('[open] Extra environment variables, merged over the current env.'),
    cols: z.coerce.number().int().positive().optional().describe('[open] Terminal width. Default 120.'),
    rows: z.coerce.number().int().positive().optional().describe('[open] Terminal height. Default 30.'),
    // write
    data: z
      .string()
      .optional()
      .describe(
        '[write] Text to type into the terminal. To RUN a command, set enter:true instead of trying to append a newline yourself (a literal "\\n" in JSON is typed as the two characters backslash-n and will NOT submit). Send control chars directly, e.g. "\\u0003" for Ctrl-C.',
      ),
    enter: z
      .boolean()
      .optional()
      .describe(
        '[write] When true (default), a real Enter/newline is appended after data so the command actually runs. Set false to type without submitting (e.g. answering a prompt char-by-char or sending only control chars).',
      ),
    // read
    settleMs: z.coerce
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('[read] Idle window (ms) — return once output is quiet this long. Default 300.'),
    timeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe('[read] Hard cap (ms) on this read. Default 10000.'),
    until: z
      .string()
      .optional()
      .describe(
        '[read] Regex source; return as soon as buffered output matches (e.g. a shell prompt "\\$ $").',
      ),
    untilFlags: z
      .string()
      .optional()
      .describe('[read] Flags for the "until" regex (e.g. "m", "i").'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type TtyOutput =
  | { kind: 'opened'; sessionId: string; pid: number; shell: string; cwd: string }
  | { kind: 'wrote'; sessionId: string; bytes: number }
  | {
      kind: 'read'
      sessionId: string
      output: string
      matched: boolean
      timedOut: boolean
      truncated: boolean
      status: string
      exitCode: number | null
    }
  | { kind: 'list'; sessions: ReturnType<typeof listPtySessions> }
  | { kind: 'closed'; sessionId: string; existed: boolean }

export const TtyTool = buildTool({
  name: TTY_TOOL_NAME,
  searchHint: 'persistent local terminal pty interactive shell session',
  maxResultSizeChars: 300_000,
  async description(input) {
    switch (input.action) {
      case 'open':
        return `Open a persistent terminal (${input.shell ?? 'default shell'})`
      case 'write':
        return `Send input to terminal ${input.sessionId}`
      case 'read':
        return `Read output from terminal ${input.sessionId}`
      case 'list':
        return 'List active terminal sessions'
      case 'close':
        return `Close terminal ${input.sessionId}`
    }
  },
  userFacingName() {
    return 'Terminal'
  },
  renderToolUseMessage(input) {
    switch (input.action) {
      case 'open':
        return `open ${input.sessionId ?? '?'} (${input.shell ?? 'default shell'})`
      case 'write': {
        const preview = (input.data ?? '').replace(/\n/g, '\\n').slice(0, 60)
        const submit = (input.enter ?? true) ? ' ⏎' : ''
        return `write ${input.sessionId ?? '?'}: "${preview}"${submit}`
      }
      case 'read':
        return `read ${input.sessionId ?? '?'}`
      case 'list':
        return 'list sessions'
      case 'close':
        return `close ${input.sessionId ?? '?'}`
      default:
        return null
    }
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input) {
    return input.action === 'list' || input.action === 'read'
  },
  async validateInput(input): Promise<ValidationResult> {
    if (!input.sessionId) {
      return {
        result: false,
        message:
          input.action === 'open'
            ? 'Error: "sessionId" is required for "open" — assign a short descriptive name (e.g. "build", "repl") that you\'ll reuse for write/read/close.'
            : `Error: "sessionId" is required for action "${input.action}". Use the name you gave the session on "open".`,
        errorCode: 1,
      }
    }
    if (input.action === 'write' && input.data === undefined) {
      return {
        result: false,
        message: 'Error: "data" is required for action "write".',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async prompt() {
    return getTtyPrompt()
  },
  async call(input) {
    switch (input.action) {
      case 'open': {
        const info = await openPtySession({
          id: input.sessionId as string,
          shell: input.shell,
          cwd: input.cwd,
          env: input.env,
          cols: input.cols,
          rows: input.rows,
        })
        return {
          data: {
            kind: 'opened',
            sessionId: info.sessionId,
            pid: info.pid,
            shell: info.shell,
            cwd: info.cwd,
          },
        }
      }
      case 'write': {
        // validateInput guarantees sessionId + data are present here.
        const sessionId = input.sessionId as string
        // Append a newline when enter is set (default true) so the command
        // actually submits. writePtySession normalizes "\n" to the platform's
        // terminator ("\r\n" on Windows cmd.exe). This spares the model from
        // fiddling with newline escapes — the common failure mode where a
        // literal "\n" gets typed as two characters instead of Enter.
        const enter = input.enter ?? true
        const data = (input.data as string) + (enter ? '\n' : '')
        writePtySession(sessionId, data)
        return {
          data: { kind: 'wrote', sessionId, bytes: data.length },
        }
      }
      case 'read': {
        const sessionId = input.sessionId as string
        const result = await readPtySession(sessionId, {
          settleMs: input.settleMs,
          timeoutMs: input.timeoutMs,
          until: input.until,
          untilFlags: input.untilFlags,
        })
        return {
          data: {
            kind: 'read',
            sessionId,
            output: result.output,
            matched: result.matched,
            timedOut: result.timedOut,
            truncated: result.truncated,
            status: result.status,
            exitCode: result.exitCode,
          },
        }
      }
      case 'list': {
        return { data: { kind: 'list', sessions: listPtySessions() } }
      }
      case 'close': {
        const sessionId = input.sessionId as string
        const existed = closePtySession(sessionId)
        return { data: { kind: 'closed', sessionId, existed } }
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    let content: string
    switch (output.kind) {
      case 'opened':
        content = `Terminal opened.\nsessionId: ${output.sessionId}\npid: ${output.pid}\nshell: ${output.shell}\ncwd: ${output.cwd}\n\nUse action "write" to send input and "read" to get output, passing this sessionId.`
        break
      case 'wrote':
        content = `Wrote ${output.bytes} chars to ${output.sessionId}. Now "read" to see output.`
        break
      case 'read': {
        const flags: string[] = []
        if (output.matched) flags.push('matched=until')
        if (output.timedOut) flags.push('timed-out')
        if (output.truncated) flags.push('buffer-truncated')
        if (output.status === 'exited') flags.push(`exited(code=${output.exitCode})`)
        const suffix = flags.length ? `\n[${flags.join(', ')}]` : ''
        content = `${output.output || '(no new output)'}${suffix}`
        break
      }
      case 'list': {
        if (!output.sessions.length) {
          content = 'No active terminal sessions.'
        } else {
          content = output.sessions
            .map(
              s =>
                `${s.sessionId}  pid=${s.pid}  ${s.status}  cwd=${s.cwd}  pending=${s.pendingBytes}B`,
            )
            .join('\n')
        }
        break
      }
      case 'closed':
        content = output.existed
          ? `Closed terminal ${output.sessionId}.`
          : `No terminal ${output.sessionId} to close.`
        break
    }
    return { tool_use_id: toolUseID, type: 'tool_result', content }
  },
} satisfies ToolDef<InputSchema, TtyOutput>)
