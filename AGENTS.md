# MindCode repository rules

- Treat `PLAN.md` as the implementation contract.
- Keep the repository local: do not add remotes or push. Commit completed work
  to local Git in small, buildable logical commits.
- Use `gpt-5.6-luna` subagents for every substantial investigation,
  implementation, review, or verification task. Give each worker an explicit
  `none|low|medium|high|xhigh|max` effort and disjoint file ownership.
- The Leader model may vary; every Worker model is fixed to
  `gpt-5.6-luna`. Missing Worker effort defaults to `medium`.
- VEXZY is the only model API. Use `VEXZY_API_KEY` and the fixed
  `https://api.echogate.one` endpoints. Never add another model-provider auth
  or transport fallback.
- Keep source code organized by domain. Do not mix unrelated moves or
  formatting with behavior changes. Sort imports with the repository formatter.
- Do not commit generated binaries, credentials, local settings, task databases,
  transcripts, coverage output, caches, or inline data source maps.
- Before each commit run the focused tests for its scope, `git diff --check`,
  and at least a smoke build. Before completion run the full test, lint,
  typecheck, coverage, build, and smoke pipeline.
- Workers return the structured `WorkerReport` contract only; full worker
  transcripts never enter Leader context.
