# Changelog

## 0.1.1 — 2026-08-11

- Native TUI now takes its initial PTY size from the host terminal and propagates host resize events through the PTY and hidden Ink bridge.
- Native terminal redraws autoresize before rendering; arrows are covered end-to-end through the native bridge.
- Sakura welcome presentation is smaller, symmetric, and less visually noisy.
- Native startup defers heavy Ink modules until native handoff succeeds.
- `/exit` (`/quit`) and `/settings` have regression coverage; `/settings` remains the future-settings-menu entrypoint.

## 0.1.0 — 2026-08-07

- Initial local MindCode release.
