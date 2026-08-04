// ---------------------------------------------------------------------------
// Tier 2 engine: Camoufox (anti-detect Firefox) via an out-of-process driver.
//
// The wreq-js Tier-1 fetch wins the passive-fingerprint fight (TLS/JA3/JA4,
// HTTP/2) but never runs JS, so it can't clear a Cloudflare challenge or render
// client-side content. When Tier 1 comes back as a challenge page or an
// unrendered SPA shell, we escalate here.
//
// Why Camoufox instead of headed Chrome+puppeteer: Camoufox spoofs the
// fingerprint at the C++ engine level (canvas/WebGL/fonts/navigator before any
// JS runs) and, crucially, passes Cloudflare's managed Turnstile *headless* —
// where headless Chrome is explicitly rejected. That means no visible window
// and no OS focus-stealing, which the old Chrome path could never achieve on
// macOS (the window-server clamps off-screen windows back on-screen).
//
// Why a subprocess instead of an in-process import: camoufox-js pulls in native
// addons (better-sqlite3, impit), which cannot be embedded into the bun-compiled
// standalone binary (a compiled binary resolves only from its virtual FS, never
// an on-disk node_modules). So we install camoufox-js + playwright-core + the
// Camoufox browser on demand into a per-user cache dir on first render, then run
// the actual browsing in a real Node process and read the rendered DOM back.
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AbortError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import type { ImpersonateOptions, RenderedContent } from './utils.js'

// Per-user, on-demand install location. Override with CLAUDE_BROWSERFETCH_DIR
// (useful for containers/CI with an ephemeral home).
const HOME =
  process.env.CLAUDE_BROWSERFETCH_DIR ??
  join(homedir(), '.cache', 'claude-browserfetch')
const NODE_MODULES = join(HOME, 'node_modules')
const CAMOUFOX_MAIN = join(NODE_MODULES, 'camoufox-js', 'dist', '__main__.js')
const CAMOUFOX_PKG = join(NODE_MODULES, 'camoufox-js', 'package.json')
const PLAYWRIGHT_PKG = join(NODE_MODULES, 'playwright-core', 'package.json')
// Camoufox browser binary location (its own env var, like PLAYWRIGHT_BROWSERS_PATH).
const BROWSER_DIR = join(HOME, 'camoufox-browser')
// Persistent profile so cf_clearance survives across fetches/runs.
const PROFILE_DIR = join(HOME, 'profile')
const DRIVER_PATH = join(HOME, 'driver.mjs')
// Bump the suffix to force a reinstall when the driver/layout/versions change.
const READY_MARKER = join(HOME, '.ready-v2')

// Pin camoufox-js and a COMPATIBLE playwright-core. camoufox-js declares its
// peer as `playwright-core: *`, but the Camoufox browser build ships a specific
// Juggler protocol version — a too-new playwright-core breaks at launch
// (e.g. "Browser.setDefaultViewport ... isMobile ... not described in scheme").
// camoufox-js@0.11.x is built/tested against playwright-core ^1.53.1, so we pin
// to that. Both overridable via env for forward-compat.
const CAMOUFOX_JS_VERSION =
  process.env.CLAUDE_BROWSERFETCH_CAMOUFOX_VERSION ?? '0.11.1'
const PLAYWRIGHT_VERSION =
  process.env.CLAUDE_BROWSERFETCH_PLAYWRIGHT_VERSION ?? '1.53.1'

const RENDER_NAV_TIMEOUT_MS = 30_000
const RENDER_NETWORK_IDLE_MS = 20_000
const CLOUDFLARE_CLEAR_TIMEOUT_MS = 45_000
// Generous: first run also npm-installs and downloads the ~150MB Camoufox build.
const INSTALL_TIMEOUT_MS = 10 * 60_000

const MIN_NODE_MAJOR = 22

// Cached node-runtime probe: undefined = not probed, null = none, string = path.
let cachedNode: string | null | undefined
/** Locate a Node.js >= 22 runtime to host the Camoufox driver. */
export function findNodeRuntime(): string | null {
  if (cachedNode !== undefined) return cachedNode
  const candidates = [process.env.CLAUDE_BROWSERFETCH_NODE, 'node'].filter(
    (c): c is string => !!c,
  )
  for (const cand of candidates) {
    try {
      const r = spawnSync(cand, ['--version'], { encoding: 'utf8' })
      if (r.status === 0 && r.stdout) {
        const major = Number.parseInt(
          r.stdout.trim().replace(/^v/, '').split('.')[0] ?? '',
          10,
        )
        if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
          cachedNode = cand
          return cachedNode
        }
      }
    } catch {
      /* try next candidate */
    }
  }
  cachedNode = null
  return cachedNode
}

/** True when a Node runtime capable of hosting the Camoufox engine exists. */
export function isCamoufoxRuntimeAvailable(): boolean {
  return findNodeRuntime() !== null
}

type ProcResult = { code: number; stdout: string; stderr: string }

function runProcess(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    signal: AbortSignal
    timeoutMs: number
    // Required on Windows for .cmd/.bat targets (e.g. npm.cmd): since the
    // CVE-2024-27980 fix, Node throws EINVAL when spawning a batch file without
    // shell. Only set this for trusted, space-free argv (no injection surface).
    shell?: boolean
  },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(new AbortError())
      return
    }
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: opts.shell ?? false,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => {
      child.kill('SIGKILL')
      finish(() => reject(new AbortError()))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() =>
        reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`)),
      )
    }, opts.timeoutMs)
    opts.signal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', d => {
      stdout += d.toString()
    })
    child.stderr?.on('data', d => {
      stderr += d.toString()
    })
    child.on('error', err => finish(() => reject(err)))
    child.on('close', code =>
      finish(() => resolve({ code: code ?? -1, stdout, stderr })),
    )
  })
}

function isInstalled(): boolean {
  return (
    existsSync(READY_MARKER) &&
    existsSync(CAMOUFOX_PKG) &&
    existsSync(PLAYWRIGHT_PKG) &&
    existsSync(DRIVER_PATH)
  )
}

// In-process guard so concurrent render calls don't race the first install.
let installPromise: Promise<void> | undefined

async function ensureInstalled(node: string, signal: AbortSignal): Promise<void> {
  if (isInstalled()) return
  if (!installPromise) {
    installPromise = doInstall(node, signal).catch(err => {
      // Allow a retry on the next call rather than caching the failure.
      installPromise = undefined
      throw err
    })
  }
  return installPromise
}

async function doInstall(node: string, signal: AbortSignal): Promise<void> {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(
    join(HOME, 'package.json'),
    JSON.stringify(
      { name: 'claude-browserfetch-camoufox', version: '1.0.0', private: true },
      null,
      2,
    ),
  )

  // On Windows npm resolves to npm.cmd, which since the CVE-2024-27980 fix must
  // be spawned with shell:true (Node throws EINVAL otherwise). Our argv is fixed
  // and space-free, so there's no injection surface. POSIX runs npm directly.
  const isWin = process.platform === 'win32'
  const npm = isWin ? 'npm.cmd' : 'npm'
  // 1) Install camoufox-js and a compatible playwright-core into the cache dir.
  const install = await runProcess(
    npm,
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      `camoufox-js@${CAMOUFOX_JS_VERSION}`,
      `playwright-core@${PLAYWRIGHT_VERSION}`,
    ],
    {
      cwd: HOME,
      env: process.env,
      signal,
      timeoutMs: INSTALL_TIMEOUT_MS,
      shell: isWin,
    },
  )
  if (install.code !== 0) {
    throw new Error(
      `npm install for Camoufox failed (code ${install.code}). Is npm on PATH? ${install.stderr.slice(-600)}`,
    )
  }

  // 2) Download the Camoufox browser into BROWSER_DIR.
  const fetch = await runProcess(node, [CAMOUFOX_MAIN, 'fetch'], {
    cwd: HOME,
    env: { ...process.env, CAMOUFOX_INSTALL_DIR: BROWSER_DIR },
    signal,
    timeoutMs: INSTALL_TIMEOUT_MS,
  })
  if (fetch.code !== 0) {
    throw new Error(
      `Camoufox browser download failed (code ${fetch.code}): ${fetch.stderr.slice(-600)}`,
    )
  }

  writeFileSync(DRIVER_PATH, DRIVER_SOURCE)
  writeFileSync(READY_MARKER, new Date().toISOString())
}

// Camoufox fingerprint OS is desktop-only; map our EmulationOS, letting mobile
// fall through to a randomly-picked desktop OS.
function mapOs(os: string | undefined): string | undefined {
  if (os === 'windows' || os === 'macos' || os === 'linux') return os
  return undefined
}

export type RenderPhase = 'installing' | 'rendering'

/**
 * Render a URL in headless Camoufox (anti-detect Firefox), clearing Cloudflare
 * challenges (including clicking the interactive Turnstile checkbox), and return
 * the rendered DOM. Installs the engine on first use.
 *
 * Throws if no Node runtime is available — callers gate on
 * isCamoufoxRuntimeAvailable() first.
 */
export async function renderWithCamoufox(
  url: string,
  opts: ImpersonateOptions & {
    signal: AbortSignal
    // Called when entering a phase, so the UI can explain a long first-use wait
    // (the 'installing' phase downloads the ~150MB Camoufox engine + browser).
    onPhase?: (phase: RenderPhase) => void
  },
): Promise<RenderedContent> {
  const node = findNodeRuntime()
  if (!node) {
    throw new Error(
      `Camoufox render engine requires Node.js >= ${MIN_NODE_MAJOR} on PATH, which was not found.`,
    )
  }
  // First use installs camoufox-js + playwright-core and downloads the Camoufox
  // browser (~150MB). Surface that so the first render doesn't look like a hang.
  const needsInstall = !isInstalled()
  if (needsInstall) opts.onPhase?.('installing')
  await ensureInstalled(node, opts.signal)
  opts.onPhase?.('rendering')

  // Upgrade http -> https for parity with Tier 1.
  let requestUrl = url
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:'
      requestUrl = parsed.toString()
    }
  } catch (e) {
    logError(e)
  }

  mkdirSync(PROFILE_DIR, { recursive: true })
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const reqFile = join(tmpdir(), `cf-req-${tag}.json`)
  const resFile = join(tmpdir(), `cf-res-${tag}.json`)
  writeFileSync(
    reqFile,
    JSON.stringify({
      url: requestUrl,
      os: mapOs(opts.os),
      headers: opts.headers ?? {},
      profileDir: PROFILE_DIR,
      navTimeout: RENDER_NAV_TIMEOUT_MS,
      idleTimeout: RENDER_NETWORK_IDLE_MS,
      clearTimeout: CLOUDFLARE_CLEAR_TIMEOUT_MS,
    }),
  )

  try {
    const totalTimeout =
      RENDER_NAV_TIMEOUT_MS +
      RENDER_NETWORK_IDLE_MS +
      CLOUDFLARE_CLEAR_TIMEOUT_MS +
      30_000
    const run = await runProcess(node, [DRIVER_PATH, reqFile, resFile], {
      cwd: HOME,
      env: { ...process.env, CAMOUFOX_INSTALL_DIR: BROWSER_DIR },
      signal: opts.signal,
      timeoutMs: totalTimeout,
    })

    if (!existsSync(resFile)) {
      throw new Error(
        `Camoufox render produced no output (code ${run.code}): ${run.stderr.slice(-600)}`,
      )
    }
    const parsed = JSON.parse(readFileSync(resFile, 'utf8')) as {
      html?: string
      finalUrl?: string
      status?: number
      statusText?: string
      contentType?: string
      stillChallenged?: boolean
      error?: string
    }
    if (parsed.error || parsed.html === undefined) {
      throw new Error(
        `Camoufox render failed: ${parsed.error ?? 'no HTML returned'}`,
      )
    }
    const html = parsed.html
    return {
      rawContent: html,
      bytes: Buffer.byteLength(html, 'utf-8'),
      code: parsed.status ?? 200,
      codeText: parsed.statusText ?? '',
      contentType: parsed.contentType ?? 'text/html',
      finalUrl: parsed.finalUrl ?? requestUrl,
      stillChallenged: parsed.stillChallenged ?? false,
    }
  } finally {
    try {
      rmSync(reqFile, { force: true })
    } catch {
      /* best-effort cleanup */
    }
    try {
      rmSync(resFile, { force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
}

// The Node driver, written to disk at install time and run in a real Node
// process. Reads a request JSON (argv[2]), writes a result JSON (argv[3]).
// Kept free of template literals / ${} so it embeds cleanly as a string here.
const DRIVER_SOURCE = `import { Camoufox } from 'camoufox-js'
import { readFileSync, writeFileSync } from 'node:fs'

const reqPath = process.argv[2]
const resPath = process.argv[3]
const req = JSON.parse(readFileSync(reqPath, 'utf8'))

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

async function isChallenge(page) {
  try {
    return await page.evaluate(function () {
      var t = document.title || ''
      var b = document.body ? document.body.innerText : ''
      return (
        t.indexOf('Just a moment') >= 0 ||
        t.indexOf('Attention Required') >= 0 ||
        b.indexOf('Verify you are human') >= 0 ||
        b.indexOf('Checking your browser') >= 0 ||
        b.indexOf('Performing security verification') >= 0
      )
    })
  } catch (e) { return false }
}

async function main() {
  const launchOpts = {
    headless: true,
    humanize: true,
    block_images: false,
    enable_cache: true,
    user_data_dir: req.profileDir,
  }
  if (req.os) launchOpts.os = req.os
  const ctx = await Camoufox(launchOpts)
  try {
    const page = await ctx.newPage()
    if (req.headers && Object.keys(req.headers).length > 0) {
      await page.setExtraHTTPHeaders(req.headers)
    }
    const resp = await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: req.navTimeout })
    try { await page.waitForLoadState('networkidle', { timeout: req.idleTimeout }) } catch (e) {}

    const deadline = Date.now() + req.clearTimeout
    while (Date.now() < deadline) {
      if (!(await isChallenge(page))) break
      var frame = null
      var frames = page.frames()
      for (var i = 0; i < frames.length; i++) {
        if (/challenges\\.cloudflare\\.com/.test(frames[i].url())) { frame = frames[i]; break }
      }
      var box = null
      if (frame) {
        try {
          var el = await frame.frameElement()
          box = await el.boundingBox()
        } catch (e) { box = null }
      }
      if (box) {
        var tx = box.x + 30 + Math.random() * 6
        var ty = box.y + box.height / 2 + (Math.random() * 6 - 3)
        try {
          await page.mouse.move(box.x - 40, box.y - 20)
          await sleep(120 + Math.random() * 120)
          await page.mouse.move(tx - 10, ty + 3, { steps: 10 })
          await sleep(90 + Math.random() * 100)
          await page.mouse.move(tx, ty, { steps: 5 })
          await sleep(140 + Math.random() * 180)
          await page.mouse.click(tx, ty)
        } catch (e) {}
        await sleep(4000)
        continue
      }
      await sleep(1500)
    }

    const stillChallenged = await isChallenge(page)
    const html = await page.content()
    const finalUrl = page.url()
    const status = resp ? resp.status() : 200
    const statusText = resp ? resp.statusText() : ''
    const headers = resp ? resp.headers() : {}
    const contentType = headers['content-type'] || 'text/html'
    writeFileSync(resPath, JSON.stringify({
      html: html,
      finalUrl: finalUrl,
      status: status,
      statusText: statusText,
      contentType: contentType,
      stillChallenged: stillChallenged
    }))
  } finally {
    try { await ctx.close() } catch (e) {}
  }
}

main().then(function () { process.exit(0) }).catch(function (e) {
  try { writeFileSync(resPath, JSON.stringify({ error: String(e && e.stack ? e.stack : e) })) } catch (x) {}
  process.exit(1)
})
`
