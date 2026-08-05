# MindCode — VEXZY Build

MindCode is a VEXZY-only agentic coding CLI, version `0.1.0`. It is a reconstructed TypeScript build with custom workflow, privacy, agent, and observability features.

Everything runs locally in your terminal through the VEXZY API.

Configuration is stored under `~/.mindcode`. Environment variables use the `MINDCODE_` prefix; the API credential is `VEXZY_API_KEY`.

---

## Highlight: Jailbreak

The main feature. A built-in jailbreak system that unlocks the model's behavior — works across all models, **GPT-5.6 Luna and other configured VEXZY models**.

It's controlled by the `/jailbreak` command with three levels:

| Level | Behavior |
|-------|----------|
| `disabled` | No content-handling section, no priming — stock behavior |
| `lowered` | Softer content-handling section, no synthetic history *(default)* |
| `full` | Strongest content-handling section + full synthetic conversation-history priming |

Under the hood it works by injecting an operator content-handling section into the system prompt and (at `full`) prepending a synthetic conversation history that primes the model. It's wired into the main chat, subagents, session-title generation, and the WebFetch/WebSearch helper models, so the unlock is consistent everywhere rather than just the top-level chat.

Switch levels any time with `/jailbreak`; the change takes effect immediately.
The selected level is persisted per session, restored when that session is
resumed, and surfaced in both the status row and session picker.

---

## Features

### Privacy
- **Telemetry fully removed** — GrowthBook, Datadog, and the 1P event-logging pipeline are stripped out. No usage data, device IDs, or session attributes are sent anywhere.
- **Feedback surveys disabled** — no rating prompts, memory surveys, or post-compact surveys.
- **Auto-updater removed** — no background version checks against npm or GCS.
- **Model attribution stripped** — no `Co-Authored-By` / "Generated with" trailer added to your commits or PRs.

### Permissions & guards
- **Permission bypass on by default** — starts in "Allow Everything" mode, no need for `--dangerously-skip-permissions`. Toggleable from the first tab in `/permissions`.
- **Bypass warning dialog removed** — no confirmation prompt on first use.
- **Trust prompt skipped** — no "do you trust this folder" gate.
- **Root/sudo guard removed** — runs under root without complaint.
- **Malware / binary-scan bypass** — internal binary scanning is disabled.
- **WebFetch domain blocklist removed** — no preflight check against the upstream provider before fetching a URL.

### Accounts & models
- **In-session account switching** — manage multiple VEXZY API accounts and API configs (key + optional base URL + auth token) and swap between them on the fly with `/account`. Switching is instant, no restart. Also reachable from the rate-limit menu.
- **VEXZY model catalog** — the `/model` picker loads VEXZY models, capabilities, aliases, account capability data, and availability restrictions from the VEXZY API.

### Extra tools
- **BrowserFetch** — fetches URLs with a real browser network fingerprint (JA3/JA4 TLS + HTTP/2 + correctly-ordered headers) to reach sites that block generic HTTP clients. Has a render tier driven by headless Camoufox (anti-detect Firefox) that runs the page's JavaScript and clears Cloudflare "Just a moment…" / Turnstile challenges. Modes: `auto`, `fast`, `render`.
- **GrokSearch** — web research tool that queries Grok over HTTP/2 and returns answers with cited sources. Sign in with `/grok-login`; once signed in it loads up front and the model prefers it over WebSearch for live lookups.

### Commands & UX
- **Live thinking display** — thinking deltas appear as they arrive in a themed left-rail card with streaming Markdown, a live indicator, and `tok/s` generation-rate feedback. Completed thoughts collapse cleanly and remain available through transcript expansion.
- **`/thinking`** — toggle extended thinking on or off directly. Its command description and the status row always reflect the active state and effort level.
- **Pinned conversation context** — `/pin` opens a searchable picker for recent user and assistant messages. Pins persist with the session, are injected into subsequent context, and can be reviewed or removed with `Ctrl+P`.
- **Improved compaction flow** — compaction has a dedicated progress display and a short summary preview when it completes. Large-context sessions use a deeper continuity-focused prompt and carry the previous compact summary forward.
- **Usage-credit confirmation** — `/usage-credits` provides an explicit interactive confirmation flow before enabling extra usage billing. The legacy `/extra-usage` alias remains available for compatibility.
- **`/folder`** — open the current working directory in your file explorer.
- **`.` prompt shortcuts** — type `.<name> <text>` to expand a saved template ahead of your message (e.g. a saved "answer only, don't edit code" instruction). Templates live in an editable `shortcuts.json` and support an `{input}` placeholder. Manage them with `/shortcut`.
- **Paste-again-to-expand** — large pastes (>800 chars) collapse to a placeholder; paste again within 800ms to expand inline.
- **Session-aware status indicators** — shows source, model, thinking level, compaction depth, and the persisted jailbreak level at a glance.
- **Injected-tag handling** — server-side reminder tags are treated as ordinary text and ignored, so they can't steer behavior.

---

## Build

Requires **Bun ≥ 1.1** and **Node ≥ 22** (Node is used for the build script; Bun for compilation).

```bash
bun install
npm run build
```

`npm run build` bundles the source with esbuild and cross-compiles standalone executables for all platforms into `dist/`:

| File | Platform |
|------|----------|
| `dist/mindcode.exe` | Windows x64 |
| `dist/mindcode-linux-x64` | Linux x64 |
| `dist/mindcode-linux-arm64` | Linux arm64 |
| `dist/mindcode-darwin-x64` | macOS Intel |
| `dist/mindcode-darwin-arm64` | macOS Apple Silicon |

Other build scripts:

```bash
npm run build:prod     # minified build
npm run build:watch    # rebuild on change
npm run typecheck      # tsc --noEmit
npm run check          # biome + typecheck
```

## Run

Run the compiled binary for your platform:

```bash
# Windows
./dist/mindcode.exe

# Linux
./dist/mindcode-linux-x64

# macOS (Apple Silicon)
./dist/mindcode-darwin-arm64
```

Or run from source directly with Bun (no build needed):

```bash
bun src/entrypoints/cli.tsx
```

On first launch configure `VEXZY_API_KEY` (or the local VEXZY credential store). Then `cd` into a project and start a session, or pass a prompt directly:

```bash
./dist/mindcode.exe "explain what this repo does"
```

## First steps

```
/jailbreak     # set the unlock level (disabled / lowered / full)
/account       # add and switch between accounts / API keys
/model         # pick a model
/thinking      # toggle extended thinking
/pin           # pin conversation messages into future context
/usage-credits # review and confirm extra usage billing
/permissions   # Allow Everything is on by default
```

While chatting, press `Ctrl+P` to open the pinned-context viewer. Use the arrow
keys (or `j`/`k`) to move, `u` to unpin the selected entry, and `Esc` to close.
