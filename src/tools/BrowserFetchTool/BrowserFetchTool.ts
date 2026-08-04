import { z } from 'zod/v4'
import { getOperatingSystems, getProfiles } from 'wreq-js'
import type { BrowserProfile, EmulationOS } from 'wreq-js'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import { logError } from '../../utils/log.js'
import { formatFileSize } from '../../utils/format.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { getRuleByContentsForTool } from '../../utils/permissions/permissions.js'
import { BROWSER_FETCH_TOOL_NAME, DESCRIPTION } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
import {
  applyPromptToMarkdown,
  DEFAULT_BROWSER,
  DEFAULT_OS,
  getURLContentImpersonated,
  htmlToMarkdown,
  isBrowserEngineAvailable,
  isCloudflareChallenge,
  looksLikeUnrenderedShell,
  MAX_MARKDOWN_LENGTH,
  renderWithBrowser,
} from './utils.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().url().describe('The URL to fetch content from'),
    prompt: z
      .string()
      .optional()
      .describe(
        'Optional. When provided, the content is summarized by a fast model to answer this prompt. When omitted, the raw response body is returned verbatim with no model call.',
      ),
    browser: z
      .string()
      .optional()
      .describe(
        `Browser profile to impersonate (TLS + HTTP/2 + headers). Default ${DEFAULT_BROWSER}. Examples: chrome_142, firefox_149, safari_18, edge_140.`,
      ),
    os: z
      .string()
      .optional()
      .describe(
        `Operating system to emulate. Default ${DEFAULT_OS}. One of: windows, macos, linux, android, ios. Keep consistent with the browser profile.`,
      ),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Optional extra headers (e.g. Authorization, Referer) merged on top of the auto-generated browser headers.',
      ),
    mode: z
      .enum(['auto', 'fast', 'render'])
      .optional()
      .describe(
        "Fetch strategy. 'auto' (default): try a fast impersonated HTTP request, escalate to a real headless browser only if the page is a Cloudflare/JS challenge or unrendered JS app. 'fast': impersonated HTTP only (no JS). 'render': go straight to the headless browser (executes JS, clears Cloudflare JS challenges).",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    bytes: z.number().describe('Size of the fetched content in bytes'),
    code: z.number().describe('HTTP response code'),
    codeText: z.string().describe('HTTP response code text'),
    result: z.string().describe('Raw body, or the model answer when a prompt was given'),
    durationMs: z.number().describe('Time taken to fetch and process the content'),
    url: z.string().describe('The final URL that was fetched (after redirects)'),
    browser: z.string().describe('The browser profile that was impersonated'),
    os: z.string().describe('The operating system that was emulated'),
    raw: z.boolean().describe('True when the raw body was returned (no model call)'),
    rendered: z
      .boolean()
      .describe('True when a real headless browser rendered the page (JS executed)'),
    challengeSolved: z
      .boolean()
      .describe(
        'True when a Cloudflare challenge was cleared during rendering (so the HTTP code reflects the pre-solve challenge response, not the real page)',
      ),
    note: z
      .string()
      .optional()
      .describe('Diagnostic note, e.g. when JS rendering was needed but unavailable'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// Progress emitted while the render tier runs, so the UI can show what's
// happening during the long first-use Camoufox install.
export type BrowserFetchProgress = {
  type: 'browserfetch_phase'
  phase: 'installing' | 'rendering'
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function browserFetchToolInputToPermissionRuleContent(input: {
  [k: string]: unknown
}): string {
  try {
    const parsedInput = BrowserFetchTool.inputSchema.safeParse(input)
    if (!parsedInput.success) {
      return `input:${input.toString()}`
    }
    const { url } = parsedInput.data
    const hostname = new URL(url).hostname
    return `domain:${hostname}`
  } catch {
    return `input:${input.toString()}`
  }
}

export const BrowserFetchTool = buildTool({
  name: BROWSER_FETCH_TOOL_NAME,
  searchHint: 'fetch a URL with a real browser, runs JS, bypasses Cloudflare',
  // 100K chars - tool result persistence threshold
  maxResultSizeChars: 100_000,
  // Always-loaded (not deferred): the model must see BrowserFetch up front so
  // it can choose it over WebFetch for anti-bot / Cloudflare / JS-rendered
  // pages without a ToolSearch round-trip.
  alwaysLoad: true,
  async description(input) {
    const { url } = input as { url: string }
    try {
      const hostname = new URL(url).hostname
      return `Claude wants to fetch content from ${hostname} using a browser fingerprint`
    } catch {
      return `Claude wants to fetch content from this URL using a browser fingerprint`
    }
  },
  userFacingName() {
    return 'BrowserFetch'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Fetching ${summary}` : 'Fetching web page'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.prompt ? `${input.url}: ${input.prompt}` : input.url
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    const permissionContext = appState.toolPermissionContext

    const ruleContent = browserFetchToolInputToPermissionRuleContent(input)

    const denyRule = getRuleByContentsForTool(
      permissionContext,
      BrowserFetchTool,
      'deny',
    ).get(ruleContent)
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `${BrowserFetchTool.name} denied access to ${ruleContent}.`,
        decisionReason: { type: 'rule', rule: denyRule },
      }
    }

    const askRule = getRuleByContentsForTool(
      permissionContext,
      BrowserFetchTool,
      'ask',
    ).get(ruleContent)
    if (askRule) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to use ${BrowserFetchTool.name}, but you haven't granted it yet.`,
        decisionReason: { type: 'rule', rule: askRule },
        suggestions: buildSuggestions(ruleContent),
      }
    }

    const allowRule = getRuleByContentsForTool(
      permissionContext,
      BrowserFetchTool,
      'allow',
    ).get(ruleContent)
    if (allowRule) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'rule', rule: allowRule },
      }
    }

    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${BrowserFetchTool.name}, but you haven't granted it yet.`,
      suggestions: buildSuggestions(ruleContent),
    }
  },
  async prompt() {
    return DESCRIPTION
  },
  async validateInput(input) {
    const { url, browser, os } = input
    try {
      new URL(url)
    } catch {
      return {
        result: false,
        message: `Error: Invalid URL "${url}". The URL provided could not be parsed.`,
        meta: { reason: 'invalid_url' },
        errorCode: 1,
      }
    }
    if (browser && !getProfiles().includes(browser as BrowserProfile)) {
      return {
        result: false,
        message: `Error: Unknown browser profile "${browser}". Use one of the supported profiles (e.g. ${DEFAULT_BROWSER}, firefox_149, safari_18).`,
        meta: { reason: 'invalid_browser' },
        errorCode: 1,
      }
    }
    if (os && !getOperatingSystems().includes(os as EmulationOS)) {
      return {
        result: false,
        message: `Error: Unknown os "${os}". Use one of: ${getOperatingSystems().join(', ')}.`,
        meta: { reason: 'invalid_os' },
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  async call(
    { url, prompt, browser, os, headers, mode },
    { abortController, options: { isNonInteractiveSession } },
    _canUseTool,
    _parentMessage,
    onProgress,
  ) {
    const start = Date.now()
    const resolvedBrowser = (browser as BrowserProfile | undefined) ?? DEFAULT_BROWSER
    const resolvedOs = (os as EmulationOS | undefined) ?? DEFAULT_OS
    const resolvedMode = mode ?? 'auto'

    // Working content + metadata, populated by whichever tier we land on.
    let rawContent: string
    let bytes: number
    let code: number
    let codeText: string
    let contentType: string
    let finalUrl: string
    let responseHeaders: Record<string, string> = {}
    let persistedPath: string | undefined
    let persistedSize: number | undefined
    let rendered = false
    let challengeSolved = false
    let note: string | undefined

    const engineAvailable = isBrowserEngineAvailable()

    const fetchTier1 = async (): Promise<void> => {
      const t1 = await getURLContentImpersonated(
        url,
        { browser: resolvedBrowser, os: resolvedOs, headers },
        abortController,
      )
      ;({
        rawContent,
        bytes,
        code,
        codeText,
        contentType,
        finalUrl,
        headers: responseHeaders,
        persistedPath,
        persistedSize,
      } = t1)
    }

    const doRender = async (): Promise<void> => {
      const r = await renderWithBrowser(url, {
        browser: resolvedBrowser,
        os: resolvedOs,
        headers,
        signal: abortController.signal,
        onPhase: phase =>
          onProgress?.({
            toolUseID: `browserfetch-${phase}`,
            data: { type: 'browserfetch_phase', phase },
          }),
      })
      rawContent = r.rawContent
      bytes = r.bytes
      code = r.code
      codeText = r.codeText
      contentType = r.contentType
      finalUrl = r.finalUrl
      rendered = true
      // Only flag a challenge if the LIVE DOM was still an interstitial at
      // capture time (authoritative — set by renderWithBrowser from the real
      // DOM, not the HTTP status, which stays 403 even after a successful
      // client-side Turnstile click). Avoids falsely warning on a real page
      // that merely references cloudflare in its markup.
      if (r.stillChallenged) {
        note =
          'The site is still serving a Cloudflare bot-protection challenge after rendering and attempting the Turnstile checkbox. This is an aggressively protected endpoint (network-layer/IP fingerprinting) that could not be cleared. The returned content is the challenge page, not the real page.'
      } else if (r.code === 403 || r.code === 429 || r.code === 503) {
        // We captured the real page, but `code` is the pre-solve challenge
        // status (the solve was client-side, no new top-level navigation). Flag
        // it so the UI shows "challenge solved" instead of a misleading 403.
        challengeSolved = true
      }
    }

    if (resolvedMode === 'render') {
      // Go straight to the browser when available; otherwise fall back to the
      // impersonated fetch and explain why JS rendering didn't run.
      if (engineAvailable) {
        try {
          await doRender()
        } catch (e) {
          // Render/install failed (network, npm missing, launch error, …).
          // Don't fail the whole call — fall back to the impersonated fetch.
          if (abortController.signal.aborted) throw e
          logError(e)
          await fetchTier1()
          note = `Camoufox rendering failed (${errMessage(e)}); returned a non-rendered fetch instead.`
        }
      } else {
        note =
          'JS rendering requested but unavailable (the Camoufox engine needs Node.js >= 22 on PATH, which was not found); returned a non-rendered fetch instead.'
        await fetchTier1()
      }
    } else {
      // 'auto' and 'fast' both start with the cheap impersonated fetch.
      await fetchTier1()

      // In auto mode, escalate to the browser when the cheap pass came back as
      // a Cloudflare challenge or an unrendered JS app shell.
      if (resolvedMode === 'auto' && !persistedPath) {
        const needsRender =
          isCloudflareChallenge(code, responseHeaders, rawContent) ||
          looksLikeUnrenderedShell(contentType, rawContent)
        if (needsRender) {
          if (engineAvailable) {
            try {
              await doRender()
            } catch (e) {
              // Keep the Tier-1 body we already have; just annotate the failure.
              if (abortController.signal.aborted) throw e
              logError(e)
              note = `Camoufox rendering failed (${errMessage(e)}); returned the non-rendered response.`
            }
          } else {
            note =
              'Page looks like a Cloudflare challenge or JS-rendered app, but JS rendering is unavailable (the Camoufox engine needs Node.js >= 22 on PATH, which was not found). Returned the non-rendered response.'
          }
        }
      }
    }

    const wantsRaw = prompt === undefined || prompt.trim() === ''

    let result: string
    if (wantsRaw) {
      // Raw mode: return the body verbatim, no model call at all. For rendered
      // pages this is the rendered DOM; cap to protect the context window.
      result =
        rawContent.length > MAX_MARKDOWN_LENGTH
          ? rawContent.slice(0, MAX_MARKDOWN_LENGTH) +
            '\n\n[Content truncated due to length...]'
          : rawContent
    } else {
      // Summarize mode: HTML -> markdown, then run the prompt through Haiku.
      const markdown = contentType.includes('text/html')
        ? await htmlToMarkdown(rawContent)
        : rawContent
      result = await applyPromptToMarkdown(
        prompt,
        markdown,
        abortController.signal,
        isNonInteractiveSession,
      )
    }

    if (persistedPath) {
      result += `\n\n[Binary content (${contentType}, ${formatFileSize(persistedSize ?? bytes)}) also saved to ${persistedPath}]`
    }
    if (note) {
      result += `\n\n[${note}]`
    }

    const output: Output = {
      bytes,
      code,
      codeText,
      result,
      durationMs: Date.now() - start,
      url: finalUrl,
      browser: resolvedBrowser,
      os: resolvedOs,
      raw: wantsRaw,
      rendered,
      challengeSolved,
      note,
    }

    return { data: output }
  },
  mapToolResultToToolResultBlockParam({ result }, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
} satisfies ToolDef<InputSchema, Output, BrowserFetchProgress>)

function buildSuggestions(ruleContent: string): PermissionUpdate[] {
  return [
    {
      type: 'addRules',
      destination: 'localSettings',
      rules: [{ toolName: BROWSER_FETCH_TOOL_NAME, ruleContent }],
      behavior: 'allow',
    },
  ]
}
