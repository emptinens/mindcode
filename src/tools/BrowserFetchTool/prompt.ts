export const BROWSER_FETCH_TOOL_NAME = 'BrowserFetch'

export const DESCRIPTION = `
- Fetches a URL like WebFetch, but far more capable against protected and JavaScript-heavy pages. Reach for this whenever WebFetch fails, returns a near-empty/garbled body, or a page is behind anti-bot protection or renders its content with JavaScript.
- Two layers of capability:
  1. Real browser network fingerprint (TLS JA3/JA4 + HTTP/2 + correctly-ordered browser headers) — defeats bot/anti-scraping/TLS-fingerprint walls that block generic HTTP clients like WebFetch.
  2. Real browser rendering — drives headless Camoufox (an anti-detect Firefox with engine-level fingerprint spoofing) that executes the page's JavaScript, clears Cloudflare "Just a moment…"/JS challenges, AND clicks the interactive Cloudflare Turnstile "verify you are human" checkbox when present. Being headless, it runs with no visible window and never steals your focus. So it can read Cloudflare-protected sites (including managed-challenge sites) and content that only appears after client-side JS runs (SPAs, lazy-loaded data). (Note: does NOT solve image/picture CAPTCHAs.)
- Takes a URL and an optional prompt
- When a prompt IS provided: the content is converted to markdown and processed by a small, fast model that answers the prompt
- When NO prompt is provided: the content body is returned verbatim (no model is called). Use this when you need the exact HTML/JSON/text, not a summary
- Returns the response with its HTTP status

Usage notes:
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - "mode" controls the strategy: "auto" (default) does a fast impersonated HTTP request and only spins up the headless browser if the page is a Cloudflare/Turnstile challenge or an unrendered JS app; "fast" forces the HTTP-only path (no JS); "render" forces the headless browser (use when you already know the page needs JS or is Cloudflare/Turnstile-gated)
  - Browser rendering uses headless Camoufox, which requires Node.js >= 22 on PATH. The Camoufox engine + browser are downloaded automatically on first use (one-time, into a per-user cache), so the first render call may take longer. If no Node runtime is found, the tool still serves the fast HTTP path and tells you JS rendering was unavailable
  - Choose a "browser" profile (default chrome_142) and "os" (default windows) for the HTTP fingerprint; keep them consistent
  - Pass "headers" only for extras the site needs (auth tokens, a specific Referer); they are merged on top of the auto-generated browser headers
  - Omit "prompt" to get the content back verbatim; provide "prompt" to get an AI-extracted answer about the content
  - This tool is read-only and does not modify any files
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL (fast path)
  - Redirects are followed automatically
`

export function makeSecondaryModelPrompt(
  markdownContent: string,
  prompt: string,
): string {
  return `
Web page content:
---
${markdownContent}
---

${prompt}

Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.
`
}
