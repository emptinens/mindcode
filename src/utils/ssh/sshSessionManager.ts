/**
 * Persistent SSH session manager.
 *
 * Mirrors ptySessionManager: a module-level singleton of live ssh2 Client
 * connections, each with an interactive shell channel and a bounded ring
 * buffer, exposed through a poll-based (write/read) interface plus one-shot
 * exec and an SFTP accessor shared over the same connection.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2'

const MAX_BUFFER_BYTES = 256 * 1024
const DEFAULT_SETTLE_MS = 400
const DEFAULT_READ_TIMEOUT_MS = 15_000
const READ_POLL_MS = 50
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000

export type SshStatus = 'connecting' | 'ready' | 'closed'

export type SshSessionInfo = {
  sessionId: string
  host: string
  port: number
  username: string
  status: SshStatus
  hasShell: boolean
  createdAt: number
  pendingBytes: number
}

export type SshAuth = {
  /** Password auth. */
  password?: string
  /** Private key: inline PEM/OpenSSH text. */
  privateKey?: string
  /** Private key: path on the local disk (read at connect time). */
  privateKeyPath?: string
  /** Passphrase for an encrypted private key. */
  passphrase?: string
  /** Use ssh-agent. Pass the agent socket path, or "pageant" on Windows. */
  agent?: string
}

export type OpenSshOptions = {
  /** Caller-supplied session id (a short human-readable name). Must be unique. */
  id?: string
  host: string
  port?: number
  username: string
  auth: SshAuth
  /** Connect timeout in ms. Default 20000. */
  readyTimeoutMs?: number
  /** Open an interactive shell channel immediately. Default true. */
  openShell?: boolean
}

export type SshReadOptions = {
  settleMs?: number
  timeoutMs?: number
  until?: string
  untilFlags?: string
}

export type SshReadResult = {
  output: string
  matched: boolean
  timedOut: boolean
  truncated: boolean
  status: SshStatus
}

export type SshExecResult = {
  stdout: string
  stderr: string
  code: number | null
  signal: string | null
}

type SshSession = {
  id: string
  client: Client
  host: string
  port: number
  username: string
  status: SshStatus
  createdAt: number
  shell: ClientChannel | null
  buffer: string
  truncated: boolean
  sftp: SFTPWrapper | null
}

const sessions = new Map<string, SshSession>()
let exitHandlerRegistered = false

function registerExitHandler(): void {
  if (exitHandlerRegistered) return
  exitHandlerRegistered = true
  const closeAll = () => {
    for (const session of sessions.values()) {
      try {
        session.client.end()
      } catch {
        // best effort
      }
    }
    sessions.clear()
  }
  process.once('exit', closeAll)
  process.once('SIGINT', closeAll)
  process.once('SIGTERM', closeAll)
}

function appendToBuffer(session: SshSession, chunk: string): void {
  session.buffer += chunk
  if (session.buffer.length > MAX_BUFFER_BYTES) {
    session.buffer = session.buffer.slice(-MAX_BUFFER_BYTES)
    session.truncated = true
  }
}

function toInfo(session: SshSession): SshSessionInfo {
  return {
    sessionId: session.id,
    host: session.host,
    port: session.port,
    username: session.username,
    status: session.status,
    hasShell: session.shell !== null,
    createdAt: session.createdAt,
    pendingBytes: session.buffer.length,
  }
}

function getSessionOrThrow(sessionId: string): SshSession {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error(
      `No SSH session with id "${sessionId}". Use action "open" first, or "list" to see active sessions.`,
    )
  }
  return session
}

function buildConnectConfig(options: OpenSshOptions) {
  const { auth } = options
  const config: Record<string, unknown> = {
    host: options.host,
    port: options.port ?? 22,
    username: options.username,
    readyTimeout: options.readyTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    // Trust-on-first-use: accept any host key. Full access by design — no
    // known_hosts gate. (hostVerifier returning true accepts the key.)
    hostVerifier: () => true,
    keepaliveInterval: 15_000,
  }
  if (auth.password !== undefined) config.password = auth.password
  if (auth.privateKey !== undefined) config.privateKey = auth.privateKey
  if (auth.privateKeyPath !== undefined) {
    config.privateKey = readFileSync(auth.privateKeyPath)
  }
  if (auth.passphrase !== undefined) config.passphrase = auth.passphrase
  if (auth.agent !== undefined) config.agent = auth.agent
  // Allow keyboard-interactive fallback (many servers use it for passwords).
  if (auth.password !== undefined) config.tryKeyboard = true
  return config
}

/** Connect a new SSH session and (optionally) open an interactive shell. */
export async function openSshSession(
  options: OpenSshOptions,
): Promise<SshSessionInfo> {
  registerExitHandler()

  // Prefer a caller-supplied id (short human-readable name) over a UUID. Check
  // for collisions before connecting so we don't open a wasted connection.
  const id = options.id ?? randomUUID()
  if (options.id && sessions.has(options.id)) {
    throw new Error(
      `An SSH session named "${options.id}" already exists. Pick a different name or close the existing one.`,
    )
  }

  // Dynamic import (not require) with a literal specifier so `bun --compile`
  // traces and embeds ssh2 into the standalone exe — require() is invisible to
  // bun's embedder in the ESM bundle. See ptyBackend.ts for the full rationale.
  const ssh2 = await import('ssh2')

  const client = new ssh2.Client()
  const session: SshSession = {
    id,
    client,
    host: options.host,
    port: options.port ?? 22,
    username: options.username,
    status: 'connecting',
    createdAt: Date.now(),
    shell: null,
    buffer: '',
    truncated: false,
    sftp: null,
  }

  const config = buildConnectConfig(options)

  await new Promise<void>((resolve, reject) => {
    // keyboard-interactive: answer every prompt with the password.
    client.on('keyboard-interactive', (_name, _instr, _lang, _prompts, cb) => {
      cb(options.auth.password ? [options.auth.password] : [])
    })
    client.once('ready', () => {
      session.status = 'ready'
      resolve()
    })
    client.once('error', err => {
      session.status = 'closed'
      reject(new Error(`SSH connection to ${options.host} failed: ${err.message}`))
    })
    client.on('close', () => {
      session.status = 'closed'
      session.shell = null
    })
    try {
      client.connect(config)
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })

  sessions.set(id, session)

  if (options.openShell !== false) {
    await openShellChannel(session)
  }

  return toInfo(session)
}

function openShellChannel(session: SshSession): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    session.client.shell(
      { term: 'xterm-256color', cols: 120, rows: 30 },
      (err, channel) => {
        if (err) {
          reject(new Error(`Failed to open shell channel: ${err.message}`))
          return
        }
        session.shell = channel
        channel.on('data', (chunk: Buffer) =>
          appendToBuffer(session, chunk.toString('utf8')),
        )
        channel.stderr?.on('data', (chunk: Buffer) =>
          appendToBuffer(session, chunk.toString('utf8')),
        )
        channel.on('close', () => {
          session.shell = null
        })
        resolve()
      },
    )
  })
}

/** Write raw data to the interactive shell channel. */
export function writeSshSession(sessionId: string, data: string): SshSessionInfo {
  const session = getSessionOrThrow(sessionId)
  if (session.status !== 'ready') {
    throw new Error(`SSH session "${sessionId}" is not ready (status: ${session.status}).`)
  }
  if (!session.shell) {
    throw new Error(
      `SSH session "${sessionId}" has no shell channel. Reopen with openShell, or use "exec".`,
    )
  }
  session.shell.write(data)
  return toInfo(session)
}

/** Smart-blocking read of shell output accumulated since the last read. */
export async function readSshSession(
  sessionId: string,
  options: SshReadOptions = {},
): Promise<SshReadResult> {
  const session = getSessionOrThrow(sessionId)
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS
  const untilRe = options.until ? new RegExp(options.until, options.untilFlags) : null

  const startedAt = Date.now()
  let lastLen = session.buffer.length
  let lastChangeAt = Date.now()

  while (true) {
    const matched = untilRe ? untilRe.test(session.buffer) : false
    const timedOut = Date.now() - startedAt >= timeoutMs
    const idleEnough = Date.now() - lastChangeAt >= settleMs
    const closed = session.status === 'closed'

    if (matched || closed || timedOut || (idleEnough && !untilRe)) {
      const output = session.buffer
      const truncated = session.truncated
      session.buffer = ''
      session.truncated = false
      return {
        output,
        matched,
        timedOut: timedOut && !matched && !closed,
        truncated,
        status: session.status,
      }
    }

    await new Promise(resolve => setTimeout(resolve, READ_POLL_MS))

    if (session.buffer.length !== lastLen) {
      lastLen = session.buffer.length
      lastChangeAt = Date.now()
    }
  }
}

/** Run a one-shot command on its own channel (no interactive shell state). */
export async function execSshSession(
  sessionId: string,
  command: string,
): Promise<SshExecResult> {
  const session = getSessionOrThrow(sessionId)
  if (session.status !== 'ready') {
    throw new Error(`SSH session "${sessionId}" is not ready (status: ${session.status}).`)
  }
  return new Promise<SshExecResult>((resolve, reject) => {
    session.client.exec(command, (err, channel) => {
      if (err) {
        reject(new Error(`exec failed: ${err.message}`))
        return
      }
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      let signal: string | null = null
      channel.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      channel.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      channel.on('exit', (exitCode: number | null, exitSignal?: string) => {
        code = exitCode
        signal = exitSignal ?? null
      })
      channel.on('close', () => {
        resolve({ stdout, stderr, code, signal })
      })
    })
  })
}

/** Get (and cache) an SFTP wrapper over this connection. */
export async function getSftp(sessionId: string): Promise<SFTPWrapper> {
  const session = getSessionOrThrow(sessionId)
  if (session.status !== 'ready') {
    throw new Error(`SSH session "${sessionId}" is not ready (status: ${session.status}).`)
  }
  if (session.sftp) return session.sftp
  return new Promise<SFTPWrapper>((resolve, reject) => {
    session.client.sftp((err, sftp) => {
      if (err) {
        reject(new Error(`Failed to open SFTP subsystem: ${err.message}`))
        return
      }
      session.sftp = sftp
      sftp.on('close', () => {
        session.sftp = null
      })
      resolve(sftp)
    })
  })
}

/** Close and forget an SSH session. Returns false if it didn't exist. */
export function closeSshSession(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  try {
    session.client.end()
  } catch {
    // already closed
  }
  sessions.delete(sessionId)
  return true
}

/** List all known SSH sessions. */
export function listSshSessions(): SshSessionInfo[] {
  return Array.from(sessions.values()).map(toInfo)
}

/** Shutdown helper. */
export function closeAllSshSessions(): void {
  for (const id of Array.from(sessions.keys())) {
    closeSshSession(id)
  }
}
