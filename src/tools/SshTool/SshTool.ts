import { z } from 'zod/v4'
import { type ToolDef, type ValidationResult, buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  closeSshSession,
  execSshSession,
  listSshSessions,
  openSshSession,
  readSshSession,
  writeSshSession,
} from '../../utils/ssh/sshSessionManager.js'
import { SSH_TOOL_NAME, getSshPrompt } from './prompt.js'

// NOTE: the top-level input schema must be a plain object — the API rejects a
// top-level anyOf/oneOf (which a discriminated union produces). So this is one
// flat object with `action` as the discriminant and every action-specific
// field optional; validateInput enforces per-action requirements. (A nested
// object like `auth` is fine — only the *top level* may not be a union.)
const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['open', 'write', 'read', 'exec', 'list', 'close'])
      .describe(
        'Operation: "open" connects, "write"/"read" drive the interactive shell, "exec" runs one command, "list" shows sessions, "close" disconnects.',
      ),
    sessionId: z
      .string()
      .optional()
      .describe(
        'REQUIRED for every action. On "open" this is the NAME you assign the session — pick a short, memorable, descriptive slug (e.g. "prod", "db-box"), not a random string. Reuse that same name on write/read/exec/close (and in the Sftp tool) to target the session. Shown in the UI, so keep it human-readable.',
      ),
    // open
    host: z.string().optional().describe('[open] Hostname or IP address.'),
    username: z.string().optional().describe('[open] Login username.'),
    port: z.coerce.number().int().positive().optional().describe('[open] Port. Default 22.'),
    auth: z
      .strictObject({
        password: z.string().optional().describe('Password authentication.'),
        privateKey: z
          .string()
          .optional()
          .describe('Inline private key text (PEM / OpenSSH format).'),
        privateKeyPath: z
          .string()
          .optional()
          .describe('Path to a private key file on this machine.'),
        passphrase: z
          .string()
          .optional()
          .describe('Passphrase for an encrypted private key.'),
        agent: z
          .string()
          .optional()
          .describe('ssh-agent socket path, or "pageant" on Windows.'),
      })
      .optional()
      .describe('[open] Authentication material. Provide at least one method.'),
    openShell: z
      .boolean()
      .optional()
      .describe('[open] Open an interactive shell channel. Default true.'),
    readyTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe('[open] Connection timeout in ms. Default 20000.'),
    // write
    data: z
      .string()
      .optional()
      .describe(
        '[write] Text to type into the remote shell. To RUN a command, set enter:true (default) — Enter is appended for you. Do NOT append a literal "\\n" yourself (it types as backslash-n). Send control chars directly, e.g. "\\u0003" for Ctrl-C.',
      ),
    enter: z
      .boolean()
      .optional()
      .describe(
        '[write] When true (default), a newline is appended after data so the command submits. Set false to type without submitting.',
      ),
    // read
    settleMs: z.coerce.number().int().nonnegative().optional().describe('[read] Idle window ms. Default 400.'),
    timeoutMs: z.coerce.number().int().positive().optional().describe('[read] Hard cap ms. Default 15000.'),
    until: z.string().optional().describe('[read] Regex; return as soon as output matches.'),
    untilFlags: z.string().optional().describe('[read] Flags for the "until" regex.'),
    // exec
    command: z.string().optional().describe('[exec] The command line to execute remotely.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type SshOutput =
  | { kind: 'opened'; sessionId: string; host: string; port: number; username: string; hasShell: boolean }
  | { kind: 'wrote'; sessionId: string; bytes: number }
  | {
      kind: 'read'
      sessionId: string
      output: string
      matched: boolean
      timedOut: boolean
      truncated: boolean
      status: string
    }
  | { kind: 'exec'; sessionId: string; stdout: string; stderr: string; code: number | null; signal: string | null }
  | { kind: 'list'; sessions: ReturnType<typeof listSshSessions> }
  | { kind: 'closed'; sessionId: string; existed: boolean }

export const SshTool = buildTool({
  name: SSH_TOOL_NAME,
  searchHint: 'persistent remote ssh session connect shell exec',
  maxResultSizeChars: 300_000,
  async description(input) {
    switch (input.action) {
      case 'open':
        return `SSH connect ${input.username}@${input.host}`
      case 'write':
        return `Send input to SSH ${input.sessionId}`
      case 'read':
        return `Read output from SSH ${input.sessionId}`
      case 'exec':
        return `SSH exec on ${input.sessionId}: ${input.command}`
      case 'list':
        return 'List active SSH sessions'
      case 'close':
        return `Close SSH ${input.sessionId}`
    }
  },
  userFacingName() {
    return 'SSH'
  },
  renderToolUseMessage(input) {
    switch (input.action) {
      case 'open':
        return `open ${input.sessionId ?? '?'} (${input.username ?? '?'}@${input.host ?? '?'}:${input.port ?? 22})`
      case 'write': {
        const preview = (input.data ?? '').replace(/\n/g, '\\n').slice(0, 60)
        return `write ${input.sessionId ?? '?'}: "${preview}"`
      }
      case 'read':
        return `read ${input.sessionId ?? '?'}`
      case 'exec':
        return `exec ${input.sessionId ?? '?'}: ${(input.command ?? '').slice(0, 60)}`
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
            ? 'Error: "sessionId" is required for "open" — assign a short descriptive name (e.g. "prod", "db-box") that you\'ll reuse for write/read/exec/close.'
            : `Error: "sessionId" is required for action "${input.action}". Use the name you gave the session on "open".`,
        errorCode: 1,
      }
    }
    if (input.action === 'open') {
      if (!input.host || !input.username) {
        return {
          result: false,
          message: 'Error: "host" and "username" are required for action "open".',
          errorCode: 1,
        }
      }
      if (!input.auth) {
        return {
          result: false,
          message:
            'Error: "auth" is required for action "open" (provide password, privateKey, privateKeyPath, or agent).',
          errorCode: 1,
        }
      }
    }
    if (input.action === 'write' && input.data === undefined) {
      return {
        result: false,
        message: 'Error: "data" is required for action "write".',
        errorCode: 1,
      }
    }
    if (input.action === 'exec' && !input.command) {
      return {
        result: false,
        message: 'Error: "command" is required for action "exec".',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async prompt() {
    return getSshPrompt()
  },
  async call(input) {
    switch (input.action) {
      case 'open': {
        // validateInput guarantees host, username, and auth are present.
        const info = await openSshSession({
          id: input.sessionId as string,
          host: input.host as string,
          username: input.username as string,
          port: input.port,
          auth: input.auth!,
          openShell: input.openShell,
          readyTimeoutMs: input.readyTimeoutMs,
        })
        return {
          data: {
            kind: 'opened',
            sessionId: info.sessionId,
            host: info.host,
            port: info.port,
            username: info.username,
            hasShell: info.hasShell,
          },
        }
      }
      case 'write': {
        // validateInput guarantees sessionId + data are present here.
        const sessionId = input.sessionId as string
        // Append newline when enter is set (default true) so the command
        // submits — sidesteps the literal-"\n" trap. Remotes are ~always Unix,
        // so "\n" is the correct terminator over SSH.
        const enter = input.enter ?? true
        const data = (input.data as string) + (enter ? '\n' : '')
        writeSshSession(sessionId, data)
        return { data: { kind: 'wrote', sessionId, bytes: data.length } }
      }
      case 'read': {
        const sessionId = input.sessionId as string
        const result = await readSshSession(sessionId, {
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
          },
        }
      }
      case 'exec': {
        const sessionId = input.sessionId as string
        const result = await execSshSession(sessionId, input.command as string)
        return {
          data: {
            kind: 'exec',
            sessionId,
            stdout: result.stdout,
            stderr: result.stderr,
            code: result.code,
            signal: result.signal,
          },
        }
      }
      case 'list': {
        return { data: { kind: 'list', sessions: listSshSessions() } }
      }
      case 'close': {
        const sessionId = input.sessionId as string
        const existed = closeSshSession(sessionId)
        return { data: { kind: 'closed', sessionId, existed } }
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    let content: string
    switch (output.kind) {
      case 'opened':
        content = `SSH connected.\nsessionId: ${output.sessionId}\nhost: ${output.username}@${output.host}:${output.port}\nshell: ${output.hasShell ? 'open' : 'none (use exec)'}\n\nUse "write"/"read" for the interactive shell, "exec" for one-offs, or the Sftp tool with this sessionId for file transfer.`
        break
      case 'wrote':
        content = `Wrote ${output.bytes} chars to ${output.sessionId}. Now "read" to see output.`
        break
      case 'read': {
        const flags: string[] = []
        if (output.matched) flags.push('matched=until')
        if (output.timedOut) flags.push('timed-out')
        if (output.truncated) flags.push('buffer-truncated')
        if (output.status === 'closed') flags.push('connection-closed')
        const suffix = flags.length ? `\n[${flags.join(', ')}]` : ''
        content = `${output.output || '(no new output)'}${suffix}`
        break
      }
      case 'exec': {
        const parts = [`exit code: ${output.code}${output.signal ? ` signal: ${output.signal}` : ''}`]
        if (output.stdout) parts.push(`--- stdout ---\n${output.stdout}`)
        if (output.stderr) parts.push(`--- stderr ---\n${output.stderr}`)
        content = parts.join('\n')
        break
      }
      case 'list': {
        content = output.sessions.length
          ? output.sessions
              .map(
                s =>
                  `${s.sessionId}  ${s.username}@${s.host}:${s.port}  ${s.status}  shell=${s.hasShell}  pending=${s.pendingBytes}B`,
              )
              .join('\n')
          : 'No active SSH sessions.'
        break
      }
      case 'closed':
        content = output.existed
          ? `Closed SSH session ${output.sessionId}.`
          : `No SSH session ${output.sessionId} to close.`
        break
    }
    return { tool_use_id: toolUseID, type: 'tool_result', content }
  },
} satisfies ToolDef<InputSchema, SshOutput>)
