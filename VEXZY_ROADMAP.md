# MindCode VEXZY roadmap

## Release position

- **Current checkpoint:** `0.1.2`, checkpointed locally but **untagged**.
- **Approved target:** `0.1.3`, VEXZY-only migration.
- **Target:** Linux x86_64.
- **Implemented foundation:** Rust `mindcode` binary with native help/version,
  VEXZY env-key status/setup/doctor/update diagnostics, an in-process daemon
  entrypoint and an explicit chat-not-migrated status.
- **Core target:** one Rust-first `mindcode` executable with an in-process daemon
  and Rust TUI; full chat/TUI/CLI parity is still pending.
- **Git:** local-only; no remote, fetch or push.

## 0.1.3 contract

### Core and runtime

1. Package one Linux x64 Rust executable.  Daemon lifecycle and TUI are
   in-process components; no external daemon or sidecar is required.
2. Do not require Bun or Node for build, startup, daemon work, TUI rendering or
   ordinary model requests.
3. Keep JS plugins/hooks optional.  When explicitly requested, resolve Bun first
   and Node second, and spawn only the selected runtime on demand.  Missing both
   produces a bounded extension error, never a core fallback.

### VEXZY boundary

1. Use only `https://api.echogate.one/v1` for `/models`, `/chat/completions` and
   `/responses`, plus `/v1/messages` on the same VEXZY host.
2. Read only `VEXZY_API_KEY` from the environment and redact it from every
   settings file, log, report, snapshot and compatibility fixture.
3. Keep exact model IDs and provider capability metadata from the dynamic
   catalog; do not add aliases, OAuth, marketplace hosts or alternate
   providers in `0.1.3`.

### Worker policy

1. Expose one **global Worker model selection**.  The selected ID must be
   `available` and Worker-capable according to the current VEXZY catalog.
   Every Worker backend (foreground, resume, background, in-process and pane)
   consumes that same selection and fails closed on stale/ineligible IDs.
2. Expose an **optional global Worker-effort lock** with exactly
   `none|low|medium|high|xhigh|max`.  A set lock applies to every Worker; an
   unset lock leaves normal per-task effort resolution and `medium` default.
3. Keep Leader policy separate from Worker policy.

### Command cleanup and compatibility

1. `/model` is the public model surface for catalog inspection and global Worker
   selection.  `/effort` remains the Leader-effort surface; the Worker lock is a
   documented CLI option, not a hidden setting.
2. Remove `/config` and `/submodel` completely, including aliases, completion,
   help text and hidden routes.  Both return the fixture's stable
   `unknown_command` error and leave state unchanged.
3. Maintain the public CLI/docs/tests compatibility fixture.  Canonical vectors
   are embedded in `PLAN.md` and `README.md`; tests and CLI help must consume
   the same versioned shape.  The fixture covers help, model selection,
   eligibility, all effort values, lock set/unset, auth redaction, removed
   commands, missing JS runtimes and exit statuses.

## Milestones and evidence

| Milestone | Acceptance evidence |
|---|---|
| Rust-first packaging | Linux x64 single executable starts and renders TUI with Bun/Node absent; current foundation has CLI only |
| In-process daemon | daemon work and reconnect complete without external `mindcoded` |
| VEXZY-only transport | endpoint/key audit finds no alternate provider or leaked credential |
| Global Worker model | every Worker ingress uses the eligible catalog selection |
| Global effort lock | set/unset behavior is consistent across all Worker backends |
| Command cleanup | `/config` and `/submodel` deterministic `unknown_command` fixture tests |
| Compatibility fixture | CLI help, docs and tests agree on version `0.1.3` vectors |
| Release bookkeeping | `0.1.2` remains untagged checkpoint; local `0.1.3` commit is reviewable |

## Explicitly out of scope for 0.1.3

- Named provider profiles, provider picker, OAuth or non-VEXZY transports.
- Any required Bun/Node installation or external JavaScript core process.
- Reintroducing `/config` or `/submodel` under another name or alias.
- Persisted credentials, remote Git, fetch or push.

## Future 0.1.5 — named provider profiles (planning only)

A separate approval may add named provider profiles in `0.1.5`.  Profiles may
store names and non-secret endpoint metadata, while credentials are resolved
from environment variables only.  Profile HTTP is restricted to **localhost**
(loopback plus explicit port); public or remote provider URLs are forbidden.
This future design must preserve the VEXZY-only `0.1.3` behavior and the removed
command surfaces.

## Verification order

1. Run the compatibility fixture against CLI help, command parsing and docs.
2. Smoke the Linux x64 executable with Bun and Node unavailable.
3. Verify VEXZY catalog/auth/redaction and Worker selection/lock behavior.
4. Run focused tests, then the full test/lint/typecheck/coverage/build/smoke
   pipeline for any code-bearing change.
5. Run `git diff --check`, confirm only local Git state, and commit atomically.
