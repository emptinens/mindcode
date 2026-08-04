/**
 * PTY backend selector.
 *
 * The CLI ships as standalone binaries compiled with `bun --compile`, so the
 * shipped product runs on the Bun runtime; local dev runs on Node. These two
 * runtimes need different PTY libraries:
 *
 *   - Node   → node-pty (the standard, mature choice)
 *   - Bun    → bun-pty  (Rust-backed; correct PTY read/write on all platforms,
 *              including Windows, where node-pty's write path relies on
 *              node:net named pipes that Bun does not fully implement)
 *
 * This module picks the right one at runtime and hides the choice behind a
 * single `spawnPty()`. Both libraries expose an API-compatible
 * `spawn(file, args, opts)` returning { pid, onData, onExit, write, resize,
 * kill }, so callers never need to know which backend is active.
 */

/** The subset of the PTY handle both backends provide and the manager uses. */
export type PtyHandle = {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export type SpawnPtyOptions = {
  name?: string
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string | undefined>
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

type PtyBackendModule = {
  spawn: (file: string, args: string[], opts: SpawnPtyOptions) => PtyHandle
}

/**
 * Spawn a PTY using the backend appropriate for the current runtime.
 *
 * The backend is loaded via dynamic `import()` with LITERAL module specifiers,
 * not require(). This matters for the shipped binary: `bun --compile` only
 * traces literal static/dynamic `import`s when deciding what to embed into the
 * standalone exe — any form of `require()` (including esbuild's `__require`
 * interop shim, which is a `createRequire` alias in the ESM bundle) is
 * invisible to that tracer. So a require-based load leaves bun-pty (and its
 * rust dll) out of the exe, and it fails at runtime with "Cannot find package".
 * Dynamic import keeps each specifier literal (so bun embeds bun-pty) while
 * still only loading the one branch the runtime actually needs. Async as a
 * result — callers await it.
 */
export async function spawnPty(
  file: string,
  args: string[],
  options: SpawnPtyOptions,
): Promise<PtyHandle> {
  const backend = (
    isBun ? await import('bun-pty') : await import('node-pty')
  ) as unknown as PtyBackendModule
  return backend.spawn(file, args, options)
}

/** Which backend will be used — for diagnostics/messages. */
export function ptyBackendName(): 'bun-pty' | 'node-pty' {
  return isBun ? 'bun-pty' : 'node-pty'
}
