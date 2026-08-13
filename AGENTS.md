# MindCode repository rules

`PLAN.md` is the implementation contract.  The approved migration in this
checkout is the `0.1.3` contract, amended `2026-08-13` with the approved
multi-provider contract update; release notes must continue to distinguish
it from the checkpointed, but untagged, `0.1.2`.

## Repository and ownership

- Keep the repository local: do not add remotes and do not fetch or push.
- Commit completed work locally in small, buildable logical commits.
- Do not commit generated binaries, credentials, local settings, task
  databases, transcripts, coverage output, caches, or inline data source maps.
- Keep source code organized by domain and avoid unrelated moves or formatting.
- Give every Worker an explicit, disjoint file-ownership scope in its task.
  Do not expand that scope without first coordinating the change.

## Target runtime contract for 0.1.3

- Target **Linux x86_64**.
- Ship one Rust-first `mindcode` executable.  The daemon and TUI will be
  in-process components of that executable; an external daemon or a second core
  process will not be required.  See `PLAN.md` for the implemented migration
  slices versus this release target.
- The core must not depend on Bun or Node at startup, build time, or runtime.
  JavaScript plugins and hooks are optional extensions: resolve **Bun first,
  then Node**, and start either runtime only on demand for the selected plugin
  or hook.  Never use Bun/Node as a silent core fallback.
- `0.1.3` is multi-provider (amendment `2026-08-13`).  Two protocols are
  supported: `openai-compatible` (`/models`, `/chat/completions`) and
  `anthropic-compatible` (`/v1/messages`).  There are no provider presets: the
  user supplies `name`, `base_url`, `protocol`, and key for each custom
  profile.  VEXZY is the built-in `openai-compatible` profile at
  `https://api.echogate.one/v1` with the environment credential
  `VEXZY_API_KEY`; it is editable and removable like any other profile.  Never
  add OAuth, marketplace, presets, or transport fallbacks.
- Credentials resolve environment-first, then from the on-disk secret store
  `~/.config/mindcode/credentials.json` (0600 file, 0700 directory), and fail
  closed when neither is present.  The store is separate from `settings.json`,
  which stays secret-free (metadata plus the profile allowlist).  A secret
  never enters settings, fixtures, logs, reports, Git, or status output.
- Transport permits any `https` endpoint, including public remote hosts; `http`
  is allowed only on loopback, and any other `http` use is a warning.
- Worker-model eligibility depends on the active provider: VEXZY stays
  catalog-driven (`available` plus the required Worker capabilities and
  supported reasoning efforts), while custom profiles use a per-profile
  allowlist of model IDs that fails closed when empty.  The Worker model is
  selected globally from the eligible models; a hard-coded vendor alias is
  never used.  A global Worker-effort lock is optional; when set it applies to
  every Worker, and when unset the normal per-task Worker effort policy
  applies.
- `/model` selects the global Worker model, `/provider` switches the active
  provider, `/settings` manages profiles (add/edit/remove), the key and the
  allowlist, and `/effort` manages Leader effort.  Remove the `/config` and
  `/submodel` command surfaces.  Do not retain aliases, hidden compatibility
  routes, or documentation that implies they still work.
- Preserve a public CLI/docs/tests compatibility fixture.  The fixture is the
  canonical, secret-free record of supported commands, options, exit/error
  behavior, Worker selection, effort-lock semantics, and removed commands.

## Future boundary (superseded by the 0.1.3 multi-provider amendment)

The planning-only `0.1.5` provider-profile boundary (profiles deferred to
`0.1.5`, environment-only credentials, profile HTTP restricted to loopback)
was superseded on `2026-08-13` by the approved multi-provider amendment:
profiles and public remote endpoints are part of `0.1.3`.  No separate
`0.1.5` profile gate remains in the contract.

## Worker process

- Use `gpt-5.6-luna` workers for repository implementation, investigation,
  review, and verification tasks unless the active `0.1.3` global Worker model
  selection explicitly resolves another eligible model of the active provider.
- Give each worker an explicit `none|low|medium|high|xhigh|max` effort and a
  disjoint file ownership scope.  A global Worker-effort lock, when enabled,
  overrides per-task choices; otherwise an omitted effort defaults to `medium`.
- Workers return the structured `WorkerReport` contract only; full transcripts
  never enter Leader context.

## Verification

Before each commit run the focused checks for the changed scope and
`git diff --check`.  Before completion run the repository's full test, lint,
typecheck, coverage, build, and smoke pipeline when code is involved.  For this
docs-only migration, at minimum verify the six-file scope, `git diff --check`,
and that no secret, remote, Bun/Node core dependency, or removed-command claim
was introduced.
