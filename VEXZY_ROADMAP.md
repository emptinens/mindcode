# MindCode roadmap — VEXZY built-in and multi-provider

## Release position

- **Current checkpoint:** `0.1.2`, checkpointed locally but **untagged**.
- **Approved target:** `0.1.3`, multi-provider migration (amendment
  `2026-08-13`); VEXZY is the built-in `openai-compatible` profile.
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

### Provider boundary

1. Two protocols: `openai-compatible` (`/models`, `/chat/completions`) and
   `anthropic-compatible` (`/v1/messages`).  No provider presets: custom
   profiles require user-supplied `name`, `base_url`, `protocol` and key.
2. VEXZY is the built-in `openai-compatible` profile at
   `https://api.echogate.one/v1` with env credential `VEXZY_API_KEY`; it is
   editable and removable like any other profile.
3. Credential precedence: environment → on-disk secret store
   (`~/.config/mindcode/credentials.json`, 0600 file / 0700 directory) →
   fail-closed.  The store is separate from the secret-free `settings.json`
   (metadata plus the profile allowlist).  Secrets never enter settings,
   fixtures, logs, reports, Git or status output.
4. Transport: any `https` endpoint is allowed, including public remote hosts;
   `http` is loopback-only, and any other `http` use produces a warning.

### Worker policy

1. Expose one **global Worker model selection** for the active provider.  VEXZY
   eligibility is catalog-driven (`available` + Worker capabilities +
   `supported_reasoning_efforts`); custom profiles use a per-profile allowlist
   that fails closed when empty.  Every Worker backend (foreground, resume,
   background, in-process and pane) consumes the same selection and fails
   closed on stale/ineligible IDs.
2. Expose an **optional global Worker-effort lock** with exactly
   `none|low|medium|high|xhigh|max`.  A set lock applies to every Worker; an
   unset lock leaves normal per-task effort resolution and `medium` default.
3. Keep Leader policy separate from Worker policy.

### Command surface and compatibility

1. `/model` — global Worker model selection; `/provider` — switch the active
   provider; `/settings` — add/edit/remove providers, key, allowlist and prefs;
   `/effort` — Leader effort.  Documented non-interactive options:
   `--provider <id>`, `--worker-model <eligible-id>`,
   `--worker-effort-lock <effort|off>`.
2. `/config` and `/submodel` stay removed, including aliases, completion, help
   text and hidden routes.  Both return the fixture's stable `unknown_command`
   error and leave state unchanged.
3. Maintain the public CLI/docs/tests compatibility fixture
   (`tests/fixtures/compatibility.json`).  Canonical vectors are embedded in
   `PLAN.md` and `README.md`; tests and CLI help must consume the same
   versioned shape.  The fixture covers providers/protocols, credential
   precedence and redaction, transport rules, eligibility, model selection, all
   effort values, lock set/unset, removed commands, missing JS runtimes and
   exit statuses.

## Milestones and evidence

| Milestone | Acceptance evidence |
|---|---|
| Rust-first packaging | Linux x64 single executable starts and renders TUI with Bun/Node absent; current foundation has CLI only |
| In-process daemon | daemon work and reconnect complete without external `mindcoded` |
| Provider boundary | custom https profile and built-in VEXZY both complete model requests; credential precedence env → store → fail-closed; no leaked credential |
| Transport rules | any-https allowed; loopback http works; non-loopback http warns |
| Eligibility | VEXZY catalog-driven; custom allowlist fails closed when empty |
| Global Worker model | every Worker ingress uses the active provider's eligible selection |
| Global effort lock | set/unset behavior is consistent across all Worker backends |
| Command cleanup | `/config` and `/submodel` deterministic `unknown_command` fixture tests |
| Compatibility fixture | CLI help, docs and tests agree on version `0.1.3` vectors |
| Release bookkeeping | `0.1.2` remains untagged checkpoint; local `0.1.3` commit is reviewable |

## Explicitly out of scope for 0.1.3

- Provider presets, provider picker, OAuth, marketplace or any protocol beyond
  the two fixed ones.
- Any required Bun/Node installation or external JavaScript core process.
- Reintroducing `/config` or `/submodel` under another name or alias.
- Secrets in settings, fixtures, reports, logs, Git or status output.
- Remote Git, fetch or push.

## Future 0.1.5 (superseded planning)

The planning-only `0.1.5` provider-profile boundary (environment-only
credentials, loopback-only profile HTTP) was superseded on `2026-08-13` by the
multi-provider amendment to `0.1.3`; profiles and public remote endpoints are
part of `0.1.3` now.  Future `0.1.5` work must preserve the `0.1.3` provider
contract and the removed command surfaces.

## Verification order

1. Run the compatibility fixture against CLI help, command parsing and docs.
2. Smoke the Linux x64 executable with Bun and Node unavailable.
3. Verify provider auth/redaction, credential precedence, transport rules,
   eligibility and Worker selection/lock behavior.
4. Run focused tests, then the full test/lint/typecheck/coverage/build/smoke
   pipeline for any code-bearing change.
5. Run `git diff --check`, confirm only local Git state, and commit atomically.
