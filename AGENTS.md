# MindCode repository rules

`PLAN.md` is the implementation contract.  The approved migration in this
checkout is the `0.1.3` contract; release notes must continue to distinguish
it from the checkpointed, but untagged, `0.1.2`.

## Repository and ownership

- Keep the repository local: do not add remotes and do not fetch or push.
- Commit completed work locally in small, buildable logical commits.
- Do not commit generated binaries, credentials, local settings, task
  databases, transcripts, coverage output, caches, or inline data source maps.
- Keep source code organized by domain and avoid unrelated moves or formatting.
- For the current contract-doc migration, the owned files are exactly
  `AGENTS.md`, `PLAN.md`, `README.md`, `VEXZY_ROADMAP.md`, and `CHANGELOG.md`.
  Do not inspect or modify files outside that set.

## Runtime contract for 0.1.3

- Target **Linux x86_64**.
- Ship one Rust-first `mindcode` executable.  The daemon and TUI are in-process
  components of that executable; an external daemon or a second core process is
  not required.
- The core must not depend on Bun or Node at startup, build time, or runtime.
  JavaScript plugins and hooks are optional extensions: resolve **Bun first,
  then Node**, and start either runtime only on demand for the selected plugin
  or hook.  Never use Bun/Node as a silent core fallback.
- `0.1.3` is VEXZY-only.  Use the fixed VEXZY base
  `https://api.echogate.one` and the single environment credential
  `VEXZY_API_KEY`; never add provider, OAuth, marketplace, or transport
  fallbacks.
- The Worker model is selected globally from the eligible models in the live
  VEXZY catalog.  Eligibility is provider metadata (`available` plus the
  required Worker capabilities), not a hard-coded vendor alias.  A global
  Worker-effort lock is optional; when set it applies to every Worker, and when
  unset the normal per-task Worker effort policy applies.
- Remove the `/config` and `/submodel` command surfaces.  Do not retain aliases,
  hidden compatibility routes, or documentation that implies they still work.
- Preserve a public CLI/docs/tests compatibility fixture.  The fixture is the
  canonical, secret-free record of supported commands, options, exit/error
  behavior, Worker selection, effort-lock semantics, and removed commands.

## Future boundary (0.1.5, not part of 0.1.3)

Named provider profiles may be introduced in `0.1.5` only.  Profile
credentials remain environment-only (never settings, fixtures, logs, or
reports), and profile HTTP is permitted only over `localhost`.  This future
boundary must not weaken the VEXZY-only `0.1.3` contract.

## Worker process

- Use `gpt-5.6-luna` workers for repository implementation, investigation,
  review, and verification tasks unless the active `0.1.3` global Worker model
  selection explicitly resolves another eligible VEXZY model.
- Give each worker an explicit `none|low|medium|high|xhigh|max` effort and a
  disjoint file ownership scope.  A global Worker-effort lock, when enabled,
  overrides per-task choices; otherwise an omitted effort defaults to `medium`.
- Workers return the structured `WorkerReport` contract only; full transcripts
  never enter Leader context.

## Verification

Before each commit run the focused checks for the changed scope and
`git diff --check`.  Before completion run the repository's full test, lint,
typecheck, coverage, build, and smoke pipeline when code is involved.  For this
docs-only migration, at minimum verify the five-file scope, `git diff --check`,
and that no secret, remote, Bun/Node core dependency, or removed-command claim
was introduced.
