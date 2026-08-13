# Changelog

## 0.1.3 — approved migration (unreleased)

- Approve the target contract for a Linux x86_64 Rust-first single `mindcode`
  executable with an in-process daemon and Rust TUI.
- Add the initial Rust CLI foundation: native help/version, VEXZY env-key
  diagnostics, `setup-token`, `doctor`, `update|upgrade`, and an in-process
  daemon entrypoint. Regular chat deliberately reports that it is not migrated
  yet; this is not full CLI/TUI parity.
- Plan removal of Bun/Node from the final core dependency graph. JS
  plugins/hooks may invoke Bun first and Node second, only on demand.
- Make the eligible Worker model of the active provider selectable globally
  across every Worker backend, with an optional global Worker-effort lock.
- Remove `/config` and `/submodel`; publish one public CLI/docs/tests
  compatibility fixture covering the supported and removed surfaces.
- 2026-08-13 — multi-provider amendment (docs-only contract update): two
  protocols (`openai-compatible` via `/models` + `/chat/completions`,
  `anthropic-compatible` via `/v1/models` + `/v1/messages`); VEXZY as the editable built-in
  `openai-compatible` profile; on-disk secret store
  (`~/.config/mindcode/credentials.json`, 0600/0700) separate from the
  secret-free `settings.json`, with env → store → fail-closed precedence; any
  `https` transport with loopback-only `http`; allowlist eligibility for custom
  profiles; `/provider` and `/settings` surfaces and the `--provider` CLI
  option.  The planning-only `0.1.5` provider-profile boundary is superseded;
  `/config` and `/submodel` stay removed.
- Retire the `/responses` endpoint from the provider contract: the
  `openai-compatible` chat path is `/chat/completions` (with `/models` for the
  catalog).  Legacy `/v1/responses` references are removed during the
  migration.
- Implement provider profiles end-to-end in the native CLI: the secret-free
  `settings.json` provider table with active-provider invariants and
  allowlist eligibility (VEXZY catalog-driven, custom allowlist fail-closed),
  the `provider list|use|add|remove|edit` and `settings show|key|allowlist|
  model|effort` surfaces, `auth status`, and the `--provider <id>` run option.
  Seed the built-in VEXZY profile (active, `VEXZY_API_KEY`) on first run
  without resurrecting it after explicit removal.
- Add the `mindcode-transport` client (reqwest + rustls, no OpenSSL):
  `openai-compatible` `/models` + streaming `/chat/completions`, and
  `anthropic-compatible` `/v1/models` + `/v1/messages`, with any-`https` /
  loopback-only-`http` transport rules.
- Fold the native TUI renderer into the workspace and add
  `mindcode-tui-server`: an in-process Rust port of the UI protocol v2 control
  server (handshake/capability negotiation, backpressure-bounded outbound
  queue, input routing, state-to-snapshot projection).  `mindcode tui` runs
  the renderer and control server in-process over a Unix socket without Bun
  or Node.

## 0.1.2 — checkpointed, untagged

- Linux x64 reliability work is checkpointed in local Git but has no `v0.1.2`
  tag.  The checkpoint remains the migration baseline for `0.1.3`.

## 0.1.1 — 2026-08-11

- Native TUI now takes its initial PTY size from the host terminal and propagates host resize events through the PTY and hidden Ink bridge.
- Native terminal redraws autoresize before rendering; arrows are covered end-to-end through the native bridge.
- Sakura welcome presentation is smaller, symmetric, and less visually noisy.
- Native startup defers heavy Ink modules until native handoff succeeds.
- `/exit` (`/quit`) and `/settings` have regression coverage; `/settings` remains the future-settings-menu entrypoint.

## 0.1.0 — 2026-08-07

- Initial local MindCode release.
