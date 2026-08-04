# VEXZY Claude Code Roadmap

## P0 — Runtime diagnostics

- `/vexzy-status`
  - `BASE_URL`
  - auth source without secret disclosure
  - main model
  - fixed subagent model
  - compact model
  - context-window size
  - thinking mode and effort
  - Agent/Task/Team tool availability
- `/agent-smoke`
  - spawn one isolated Agent
  - verify effective model is `gpt-5.6-luna`
  - verify inherited thinking/effort
  - verify TaskCreate/TaskUpdate/SendMessage
- `/compact-status`
  - last compact model
  - input/output token counts
  - elapsed time
  - retries and timeout reason
  - preserved-tail size

## P1 — Reliability

- VEXZY-specific request timeout, retry, and circuit breaker settings.
- Atomic `/compact`: retain old context until summary validation succeeds.
- Compact watchdog with cancel/retry instead of indefinite 97% state.
- Agent crash recovery and automatic replacement.
- Team task reconciliation when task state lags behind teammate state.
- Session resume that reconstructs in-process teammates from persisted task metadata.

## P1 — Model controls

- Dynamic VEXZY model capability registry:
  - context window
  - max output tokens
  - adaptive thinking
  - effort levels
  - tool support
  - image support
- `/model` detail panel with capability table.
- Separate selectors:
  - main model
  - main thinking mode
  - main effort
  - subagent thinking policy
  - compact model
- Per-agent reasoning policy: `inherit`, `adaptive`, `low`, `medium`, `high`, `xhigh`.

## P1 — Authentication

- macOS Keychain storage for `VEXZY_API_KEY`.
- `claude vexzy login` and `claude vexzy logout`.
- Gateway health check before REPL startup.
- API-key rotation without restarting the terminal.
- Sanitized auth diagnostics with endpoint and source only.

## P2 — Agent UX

- Agent panel columns: NAME, MODEL, EFFORT, TOKENS, STATE, TASK.
- Live Agent transcript search.
- One-key restart, stop, redirect, and clone.
- Team presets: review, research, debug, implementation.
- Automatic task partitioning with file-ownership conflict detection.
- Shared artifact/evidence store between teammates.

## P2 — Observability

- `/usage-live` per-model and per-agent token accounting.
- Request latency histogram.
- Compact duration and compression-ratio history.
- Agent tool-call timeline.
- Structured JSON debug log with automatic secret redaction.
- Exportable session diagnostic bundle.

## P2 — Build and update

- `./install-vexzy.sh`:
  - build current architecture
  - verify binary markers
  - atomically update `~/.local/bin/claude`
  - preserve rollback binary
- `./rollback-vexzy.sh`.
- Build metadata in `claude --version`: commit, target, build time.
- CI smoke matrix for macOS x64/arm64 and Linux x64/arm64.

## P3 — Tests

- Unit tests for fixed subagent model resolution.
- Unit tests for custom-gateway auth status.
- Integration test for Agent spawn and Task tools.
- Integration test for `/compact` on 200k and 1M contexts.
- Regression test for `CLAUDE_CODE_SIMPLE` disabling Agent tools.
- Golden test for launcher environment propagation.

## Recommended implementation order

1. `/vexzy-status`
2. `/agent-smoke`
3. Compact watchdog and atomic summary validation
4. Keychain-backed VEXZY login
5. Dynamic model capability registry
6. Agent panel telemetry
7. Install/rollback scripts
8. Integration test suite
