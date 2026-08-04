import { LRUCache } from 'lru-cache'
import { fetch as wreqFetch } from 'wreq-js'
import type { BrowserProfile, EmulationOS } from 'wreq-js'
import { getContentHandlingSection, getInjectionHandlingSection } from '../../constants/prompts.js'
import { queryHaiku } from '../../services/api/claude.js'
import { AbortError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import {
  isBinaryContentType,
  persistBinaryContent,
} from '../../utils/mcpOutputStorage.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { isCamoufoxRuntimeAvailable, renderWithCamoufox } from './camoufox.js'
import { makeSecondaryModelPrompt } from './prompt.js'

export const DEFAULT_BROWSER: BrowserProfile = 'chrome_142'
export const DEFAULT_OS: EmulationOS = 'windows'

export type ImpersonateOptions = {
  browser: BrowserProfile
  os: EmulationOS
  headers?: Record<string, string>
}

// Match WebFetch's resource limits for parity.
const MAX_URL_LENGTH = 2000
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024 // 10MB
const FETCH_TIMEOUT_MS = 60_000
export const MAX_MARKDOWN_LENGTH = 100_000

// 15-minute TTL, 50MB cap. Keyed by url + fingerprint, since the response can
// differ per browser/os/header set.
const CACHE_TTL_MS = 15 * 60 * 1000
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024

type CacheEntry = {
  rawContent: string
  bytes: number
  code: number
  codeText: string
  contentType: string
  finalUrl: string
  headers: Record<string, string>
  persistedPath?: string
  persistedSize?: number
}

const URL_CACHE = new LRUCache<string, CacheEntry>({
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
})

export function clearBrowserFetchCache(): void {
  URL_CACHE.clear()
}

function cacheKey(url: string, opts: ImpersonateOptions): string {
  return `${opts.browser}|${opts.os}|${opts.headers ? JSON.stringify(opts.headers) : ''}|${url}`
}

// Lazy turndown singleton — same rationale as WebFetchTool: defer the ~1.4MB
// domino import until the first HTML body and reuse one stateless instance.
type TurndownCtor = typeof import('turndown')
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then(m => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default
    return new Turndown()
  }))
}

export async function htmlToMarkdown(html: string): Promise<string> {
  return (await getTurndownService()).turndown(html)
}

export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username || parsed.password) {
    return false
  }
  const parts = parsed.hostname.split('.')
  if (parts.length < 2) {
    return false
  }
  return true
}

export type FetchedContent = CacheEntry

export async function getURLContentImpersonated(
  url: string,
  opts: ImpersonateOptions,
  abortController: AbortController,
): Promise<FetchedContent> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }

  const key = cacheKey(url, opts)
  const cached = URL_CACHE.get(key)
  if (cached) {
    return cached
  }

  // Upgrade http -> https, mirroring WebFetch behavior.
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

  const response = await wreqFetch(requestUrl, {
    browser: opts.browser,
    os: opts.os,
    headers: opts.headers,
    timeout: FETCH_TIMEOUT_MS,
    redirect: 'follow',
    signal: abortController.signal,
  })

  const arrayBuffer = await response.arrayBuffer()
  if (abortController.signal.aborted) {
    throw new AbortError()
  }

  const rawBuffer = Buffer.from(arrayBuffer)
  if (rawBuffer.length > MAX_HTTP_CONTENT_LENGTH) {
    throw new Error(
      `Response exceeds maximum content length (${MAX_HTTP_CONTENT_LENGTH} bytes)`,
    )
  }

  const contentType = response.headers.get('content-type') ?? ''

  // Snapshot response headers (lowercased) so Tier-2 escalation can inspect
  // Cloudflare signals (cf-mitigated, server: cloudflare) on the cheap pass.
  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value: string, name: string) => {
    responseHeaders[name.toLowerCase()] = value
  })

  // Binary content (PDFs, images, etc.): persist to disk so it can be inspected
  // later, same as WebFetch.
  let persistedPath: string | undefined
  let persistedSize: number | undefined
  if (isBinaryContentType(contentType)) {
    const persistId = `browserfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = await persistBinaryContent(rawBuffer, contentType, persistId)
    if (!('error' in result)) {
      persistedPath = result.filepath
      persistedSize = result.size
    }
  }

  const entry: CacheEntry = {
    rawContent: rawBuffer.toString('utf-8'),
    bytes: rawBuffer.length,
    code: response.status,
    codeText: response.statusText,
    contentType,
    finalUrl: response.url || requestUrl,
    headers: responseHeaders,
    persistedPath,
    persistedSize,
  }

  URL_CACHE.set(key, entry, { size: Math.max(1, entry.bytes) })
  return entry
}

export async function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<string> {
  const truncatedContent =
    markdownContent.length > MAX_MARKDOWN_LENGTH
      ? markdownContent.slice(0, MAX_MARKDOWN_LENGTH) +
        '\n\n[Content truncated due to length...]'
      : markdownContent

  const modelPrompt = makeSecondaryModelPrompt(truncatedContent, prompt)
  const assistantMessage = await queryHaiku({
    systemPrompt: asSystemPrompt([
      getInjectionHandlingSection(),
      getContentHandlingSection(),
    ]),
    userPrompt: modelPrompt,
    signal,
    options: {
      querySource: 'web_fetch_apply',
      agents: [],
      isNonInteractiveSession,
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })

  if (signal.aborted) {
    throw new AbortError()
  }

  const { content } = assistantMessage.message
  if (content.length > 0) {
    const contentBlock = content[0]
    if (contentBlock && 'text' in contentBlock) {
      return contentBlock.text
    }
  }
  return 'No response from model'
}

// ---------------------------------------------------------------------------
// Tier 2: JS rendering + Cloudflare/Turnstile clearing.
//
// The wreq-js fetch above wins the passive-fingerprint fight (TLS/JA3/HTTP2)
// but never executes JavaScript, so it can't clear a Cloudflare challenge or
// render client-side content. When Tier 1 comes back as a challenge page or an
// unrendered SPA shell, we escalate to the Camoufox engine (see camoufox.ts):
// headless anti-detect Firefox that passes managed Turnstile without a visible
// window, installed on demand into a per-user cache dir on first use. The engine
// self-disables when no Node runtime is available — Tier 1 still serves then.
//
// The heuristics below (isCloudflareChallenge / looksLikeUnrenderedShell) decide
// when the cheap Tier-1 pass warrants that escalation.
// ---------------------------------------------------------------------------

/** True when the Camoufox render tier can run (a Node.js runtime exists). */
export const isBrowserEngineAvailable = isCamoufoxRuntimeAvailable

const CLOUDFLARE_MARKERS = [
  'Just a moment',
  'Checking your browser',
  'cf-browser-verification',
  'cf-challenge',
  '__cf_chl',
  'challenge-platform',
  'Enable JavaScript and cookies to continue',
]

/** Heuristic: does this Tier-1 response look like a Cloudflare interstitial? */
export function isCloudflareChallenge(
  status: number,
  headers: Record<string, string>,
  body: string,
): boolean {
  const h = (name: string) => (headers[name.toLowerCase()] ?? '').toLowerCase()
  if (h('cf-mitigated') === 'challenge') return true
  const isCfServer = h('server').includes('cloudflare')
  const challengeStatus = status === 403 || status === 429 || status === 503
  const hasMarker = CLOUDFLARE_MARKERS.some(m => body.includes(m))
  if (hasMarker && (isCfServer || challengeStatus)) return true
  // Explicit Turnstile / challenge script even on a 200.
  return body.includes('challenges.cloudflare.com/turnstile')
}

/** Heuristic: HTML parsed fine but the body is an empty JS-app shell. */
export function looksLikeUnrenderedShell(
  contentType: string,
  body: string,
): boolean {
  if (!contentType.includes('text/html')) return false
  // Strip script/style/markup, see how much actual prose is left.
  const visible = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const hasAppRoot =
    /<div[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(body) ||
    body.includes('__NEXT_DATA__') ||
    body.includes('data-reactroot') ||
    body.includes('ng-version')
  // App-root present + almost no visible text => unrendered shell.
  return hasAppRoot && visible.length < 200
}

export type RenderedContent = {
  rawContent: string // rendered DOM (outerHTML)
  bytes: number
  code: number
  codeText: string
  contentType: string
  finalUrl: string
  // True if, at capture time, the live DOM was STILL a Cloudflare challenge
  // (we tried to clear it and couldn't). Authoritative — computed from the
  // rendered DOM, not the HTTP status (which stays 403 even after a successful
  // client-side Turnstile click since there's no new top-level navigation).
  stillChallenged: boolean
}

/**
 * Render a URL in headless Camoufox, executing the page's JS and clearing
 * Cloudflare/Turnstile challenges, then return the rendered DOM. The engine is
 * installed on demand on first use (see camoufox.ts).
 *
 * Throws if no Node runtime is available — callers must gate on
 * isBrowserEngineAvailable() first.
 */
export const renderWithBrowser = renderWithCamoufox
