# Changelog

## 0.1.3 — approved migration (unreleased)

- Rebase the release contract on a Linux x86_64 Rust-first single `mindcode`
  executable with an in-process daemon and Rust TUI.
- Remove Bun/Node from the core dependency graph.  JS plugins/hooks may invoke
  Bun first and Node second, only on demand.
- Keep the release VEXZY-only, using `VEXZY_API_KEY` and the fixed
  `https://api.echogate.one` endpoints with secret-free diagnostics and docs.
- Make the eligible VEXZY Worker model selectable globally across every Worker
  backend, with an optional global Worker-effort lock.
- Remove `/config` and `/submodel`; publish one public CLI/docs/tests
  compatibility fixture covering the supported and removed surfaces.
- Reserve named provider profiles for `0.1.5`; credentials will be env-only and
  profile HTTP will be restricted to localhost.

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
