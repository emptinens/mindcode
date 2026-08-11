# MindCode 0.1.1 — план и статус реализации

Дата аудита: `2026-08-07`
Каталог проекта: `/Users/x32db/PROJECTS/mindcode`

Документ является текущим implementation plan и фактическим статусом. Разделы
`3.1–3.15` фиксируют foundation-фазу; TUI v2, VEXZY-only cleanup и release gates
перепроверены на текущем worktree 2026-08-07. Все изменения фиксируются только
локальными атомарными коммитами; remote и push не используются.

## 1. Контракт handoff

| Параметр | Обязательное значение |
|---|---|
| Проект | `MindCode` |
| Версия | `0.1.1` |
| Провайдер | только `VEXZY` |
| Leader | выбирается динамически из доступного каталога VEXZY |
| Worker | только `gpt-5.6-luna` |
| Worker fallback | отсутствует; другая модель не подставляется |
| Worker effort | `none | low | medium | high | xhigh | max` |
| Worker effort по умолчанию | `medium` |
| Веса effort | `none=1`, `low=1`, `medium=2`, `high=4`, `xhigh=6`, `max=8` |
| Worker budget | `MINDCODE_AGENT_COST_BUDGET`, default `32` |
| Compact warning | `85%` |
| Auto-compact trigger | `95%` |
| Compact watchdog | `120s` (`120000ms`) |
| Git | локальный, без remote |

### 1.1 VEXZY transport

- OpenAI-compatible base URL: `https://api.echogate.one/v1`.
- OpenAI-compatible endpoints: `/chat/completions`, `/responses`, `/models`.
- Messages-compatible base URL: `https://api.echogate.one`.
- Messages endpoint: `/v1/messages`.
- Единственный credential: `VEXZY_API_KEY`, ожидается формат `forge-...`.
- Авторизация: `Authorization: Bearer $VEXZY_API_KEY`.
- Ключ не попадает в settings, отчёты, диагностические сообщения и логи.
- Каталог VEXZY загружается через `/v1/models`; ID моделей передаются без alias/remap.
- `available`, capabilities, status и provider metadata принимаются из ответа каталога.
- Worker допускается только после готового каталога, наличия `gpt-5.6-luna`, `available=true` и capabilities `tools=true`.

### 1.2 Разделение ролей

- Leader использует exact ID из динамического каталога VEXZY и не наследует worker policy.
- Worker получает exact ID `gpt-5.6-luna` во всех путях: AgentTool, fork, resume, background, in-process, tmux и iTerm.
- `model`/legacy aliases, переданные в worker input, не имеют права изменить worker model.
- Недоступность Luna является ошибкой конфигурации/ожиданием, а не поводом выбрать Sonnet, Haiku, Claude или другую модель.
- Worker effort не наследуется от Leader effort; отсутствие worker effort разрешается в `medium`.

## 1.3 Local release history

- `0.1.1` добавляет native-TUI resize propagation, keyboard-arrow forwarding,
  компактную Sakura welcome presentation, deferred Ink loading on native startup,
  а также regression coverage для `/exit` и `/settings`.
- Версия поддерживается только локально: после полного набора gates создаются
  atomic release commit и local annotated tag `v0.1.1`; remote/push не используются.

## 2. Аудит текущего дерева

### 2.1 Зафиксированные факты

- `package.json` содержит `name: "mindcode"`, `version: "0.1.0"`, bin
  `mindcode` и Bun scripts.
- `tsconfig.json` существует, содержит `strict: true`, `noEmit: true` и
  включает `src/**/*` и `scripts/**/*.ts`.
- Команда `/copycon` существует и зарегистрирована в `src/commands.ts`.
- До текущей серии локальных commits `HEAD` — `fe24b51 feat(tui): add visual foundation modules`.
- `git remote -v` пуст; remote, fetch и push не используются.
- TUI v2, VEXZY-only cleanup, локальный credit `/cost` и Linux AMD64 packaging
  входят в текущую локальную commit series.
- Исторические значения baseline не используются как результат current-worktree
  verification: ниже перечислены только реально выполненные gates.

### 2.2 Проверки, выполненные на current worktree

| Проверка | Результат |
|---|---|
| `cargo fmt --all -- --check` и standalone TUI fmt | PASS |
| root Rust workspace tests | PASS: core-tools, protocol, state, daemon и multiprocess SQLite tests |
| standalone `mindcode-tui` tests | PASS: `63` lib + `4` clipboard + `8` interaction; `0` fail |
| Rust clippy `-D warnings` (root + standalone TUI) | PASS |
| Native-TUI TypeScript/repl/cleanup focused suite | PASS: `99` tests, `0` fail |
| Full Bun coverage suite | PASS: `653` tests, `0` fail; `93.41%` (`8069/8638`) on 31 allowlisted modules, threshold `85%` |
| `bun run lint` / `bun run typecheck` | PASS against refreshed local baseline: lint `7882`, typecheck `4050` diagnostics; no new TUI/VEXZY cleanup diagnostics |
| Rust↔TypeScript daemon interop | PASS |
| Linux AMD64 bundle | PASS: fresh `mindcode`, `mindcoded`, `mindcode-tui` ELF x86-64 artifacts generated |
| Linux AMD64 native/package validation | PASS: `5` native-TUI packaging tests; daemon execution intentionally skipped on non-Linux host |
| `bun run smoke` | PASS: `mindcode --help` |
| `git diff --check`, diff secret scan, `git remote -v` | PASS; no remote |

`typecheck:strict` still emits the repository's pre-existing diagnostics. The
checked-in baseline is refreshed only after confirming that changed native-TUI
and VEXZY-only paths add none; it is not treated as a claim that the inherited
repository has zero diagnostics.

### 2.3 Главные расхождения старого плана

Устарели следующие утверждения и исправлены в этой версии документа:

- планирование переименования проекта вместо уже существующего `mindcode@0.1.0`;
- утверждение, что `PLAN.md`, `/copycon` или `tsconfig.json` отсутствуют;
- предположение, что scheduler, task graph, WorkerReport и compact watchdog ещё
  не созданы;
- описание Leader и Worker как будущей миграции вместо фактических runtime
  boundaries;
- требование заменить локальный Git: remote уже отсутствует, переписывание
  истории не является частью этого плана;
- перенос исторических full-suite/build/coverage результатов в текущий
  незакоммиченный TUI v2 status;
- утверждение, что текущий `typecheck` не выполнялся: baseline current-worktree
  подтверждён `PASS` с `4050` унаследованными diagnostics без новых diagnostics
  в изменённых TUI/VEXZY путях.

## 3. Статус реализации по подсистемам

### 3.1 Identity и запуск — DONE

Реализовано:

- `package.json`: `mindcode`, `0.1.0`, CLI bin `mindcode`;
- `src/main.tsx`: имя CLI, MindCode environment namespace и VEXZY-only startup path;
- `MINDCODE_*` environment namespace;
- `~/.mindcode` configuration/state paths;
- `tsconfig.json`, Bun test/build/typecheck scripts;
- branding и startup regression tests.

Оставшийся контроль: при новых изменениях не возвращать `claude`/Anthropic branding в пользовательские идентификаторы, runtime errors, model labels и отчёты.

### 3.2 VEXZY API и limits — DONE

Реализовано в `src/services/api/vexzy/`:

- `config.ts`: endpoint constants, `forge-` key validation и Bearer config;
- `auth.ts`: auth headers без утечки ключа;
- `messagesClient.ts` и `messagesProtocol.ts`: non-stream/stream Messages-compatible protocol, SSE framing, abort и timeout;
- `modelClient.ts`: `/v1/models`, retry, timeout, abort и last-successful snapshot;
- `modelCatalog.ts`: loading/ready/error state, deduplicated load/refresh, stale snapshot отдельно от ready registry;
- `modelRegistry.ts`: exact provider IDs, availability, status, modalities, capabilities, reasoning efforts и output limits;
- `sdkAdapter.ts`: runtime-compatible adapter без обязательного импорта старого provider SDK;
- `errors.ts`: retry/status policy без сохранения response body или API key.

Контроль:

- `modelRegistry.ts` сохраняет exact-ID output-limit overrides только как
  fallback; динамические provider fields имеют приоритет;
- production bundle проверен на отсутствие старых endpoints, credential names,
  SDK package names и marketplace hosts;
- runtime provider/OAuth/remote modules и неиспользуемые зависимости удалены.

### 3.3 Dynamic Leader model — DONE

Текущее поведение:

- `src/utils/model/model.ts` сохраняет exact `MINDCODE_MODEL`/settings value и проверяет его через VEXZY catalog, когда каталог готов;
- `getCatalogDefaultModel()` выбирает первую доступную модель в provider-owned
  порядке live registry без worker-specific preference;
- `src/services/api/vexzy/modelCatalog.ts` строит UI options по фактическим registry IDs;
- catalog state не считается ready при ошибке refresh;
- `src/utils/model/agent.ts` не используется для Leader: его fixed resolver
  относится только к worker;
- regression test доказывает, что provider catalog order определяет Leader
  default, даже если Luna присутствует вторым элементом.

### 3.4 Fixed Worker runtime — DONE

Реализовано:

- `src/utils/model/subagentModel.ts`: `FIXED_SUBAGENT_MODEL = 'gpt-5.6-luna'`;
- `src/utils/model/agent.ts`: catalog-gated `resolveFixedSubagentModel()` с fail-closed checks;
- `src/utils/swarm/backends/types.ts`: worker runtime model/effort resolution;
- `src/tools/AgentTool/AgentTool.tsx`: worker model boundary, runtime metadata и report metadata;
- `src/tools/AgentTool/forkSubagent.ts`, `resumeAgent.ts`, `runAgent.ts`;
- `src/tools/shared/spawnMultiAgent.ts` и `src/utils/swarm/teammateModel.ts`;
- `src/utils/swarm/spawnUtils.ts`: pane environment forces Luna instead of inherited Leader model;
- `PaneBackendExecutor.ts`: spawned CLI receives `--model gpt-5.6-luna`;
- `inProcessRunner.ts`: worker runtime resolves Luna before the loop;
- worker completion and resolver tests.

Завершено в финальном проходе:

- публичные Worker ingress больше не принимают legacy model aliases; внутренние
  `model` metadata формируются только из результата `resolveWorkerRuntime()`;
- AgentTool, Workflow, fork/resume, background, in-process и pane routes
  используют общий catalog-gated runtime assertion;
- route integration tests проверяют fixed Luna, policy identity и отсутствие
  наследования Leader model во всех backend paths.

### 3.5 Worker effort — DONE

Worker boundary использует только:

```text
none | low | medium | high | xhigh | max
```

`resolveWorkerEffort()` из `src/utils/swarm/backends/types.ts` нормализует неизвестное/отсутствующее значение в `medium`. `TaskGraph`, WorkerReport и worker tests используют тот же enum.

В общей `src/utils/effort.ts` по-прежнему присутствуют provider-level `minimal`,
`auto` и numeric compatibility values. Они допустимы только для Leader/provider
UI. Worker ingress отклоняет их до scheduler/runtime/WorkerReport; `/effort`
явно описан как Leader-only, а Worker `max` сохраняется без понижения. Прямые
Workflow/AgentTool/backend tests покрывают default `medium`, все шесть значений
и invalid Leader/provider values.

### 3.6 Weighted scheduler и budget — DONE

`src/utils/swarm/concurrencyPolicy.ts` реализует:

- `MINDCODE_AGENT_COST_BUDGET` с default `32`;
- веса `1/1/2/4/6/8` для шести worker efforts;
- weighted leases вместо статического count limit;
- queued weight, active weight, available weight и scheduler snapshot;
- cancellation queued requests и idempotent release;
- FIFO с максимум двумя fit-bypass и aging gate для starvation prevention;
- effective budget как минимум из configured budget и известных resource ceilings;
- немедленный downscale и применение upscale после двух стабильных окон;
- lifecycle integration через `acquireWorkerExecution()`.

Предыдущий budget alias удалён: scheduler читает только canonical
`MINDCODE_AGENT_COST_BUDGET`.

### 3.7 Task graph, leases и overlap — DONE

Реализовано в `src/tasks/graph/` и `src/tasks/validation/`:

- SQLite schema для tasks, leases, idempotency и graph metadata;
- statuses `pending|claimed|running|completed|failed|blocked|cancelled`;
- kinds `research|implement|verify|integrate`;
- task effort enum handoff;
- `files_touched`, `read_set`, `write_set`, `isolation`, dependencies, priority, policy epoch и report ID;
- route + overlap validation до claim;
- atomic claim с version/dependency/lease checks;
- optimistic CAS updates;
- lease TTL, release, expiration и recovery;
- immutable graph snapshot;
- `src/tools/AgentTool/workerLifecycle.ts`: route → claim → weighted scheduler lease → running → complete/fail/release.

Финальный проход завершил persistent lifecycle: AgentTool, resume, in-process и
pane backends используют daemon-backed graph boundary, policy epoch/digest и
validated WorkerReport. Multi-process SQLite contention, abrupt-process lease
recovery, concurrent claim и completion-without-report покрыты Rust/TypeScript
integration tests.

### 3.8 WorkerReport и Leader context — DONE

`src/tools/AgentTool/workerReport.ts` и `src/utils/swarm/workerTeamReport.ts` реализуют `worker-report/1`:

- exact Luna model и exact worker effort;
- runtime-owned task/run/worker IDs;
- `policy_epoch`, status, bounded summary, changed files, structured evidence, tokens, validation и blockers;
- workspace-relative normalized paths;
- free-form output не становится успешным evidence;
- completion требует valid report, `validation.verdict=pass` и отсутствия blockers;
- assistant usage deduplicated по request/message ID;
- transcript и tool dump не передаются как report.

Session-scoped monotonic policy epoch, snapshot digest, stale-report rejection
и terminal persistence подключены в AgentTool, resume и daemon-backed lifecycle.
Focused policy/report/lifecycle tests пройдены.

### 3.9 Prompt policy и `/jailbreak` — DONE

Реализовано:

- `PromptCompiler` для Leader, Worker, compact и resume sections;
- bounded worker prompt, injection handling и validated content policy;
- AgentTool, fork/resume, in-process и pane paths добавляют worker snapshot;
- `src/utils/jailbreak.ts` использует enum `disabled|lowered|full`, sidecar persistence и validated environment forwarding;
- policy epoch связан со snapshot digest и наследуется worker ingress;
- stale reports после изменения policy отклоняются.

Focused policy tests пройдены.

### 3.10 Compact — DONE (fully revalidated)

Реализовано:

- `DEFAULT_WARNING_PERCENTAGE = 85`;
- `DEFAULT_AUTO_COMPACT_PERCENTAGE = 95`;
- hard limit `95%`;
- exact threshold comparison `>=`;
- `compactWatchdog.ts`: default `120000ms`, override `MINDCODE_COMPACT_TIMEOUT_MS`, child abort scope;
- единая state transaction для manual, auto, reactive и session-memory compact paths;
- rollback при timeout, abort и fallback;
- commit только после успешного результата/hooks;
- auto-compact failure circuit breaker и warning state suppression/clear.

Focused compact tests относятся к foundation baseline; полный Bun/coverage/build verification для текущего diff успешно повторён в gates из разделов 2.2 и 4.

### 3.11 `/copy`, `/copycon`, `/status` — DONE

- `/copy` зарегистрирован и покрыт tests.
- `/copycon` зарегистрирован в `src/commands.ts`.
- `/copycon` строит bounded structured source, redacts VEXZY/Bearer secrets, запрашивает только `gpt-5.6-luna` с `medium`, копирует результат и сохраняет fallback file.
- `/status` HTML report self-contained, локальный, без external assets/network upload.
- Status report показывает model usage, token/cache metrics, scheduler active/queued weights, budget и compact thresholds.
- Sakura/MindCode report branding покрыт tests.

Privacy suite подтверждает, что report fields не сериализуют `VEXZY_API_KEY`,
Bearer credentials, raw response body или абсолютные секретные пути.

### 3.12 Локальный Git — DONE как runtime constraint, bootstrap migration не нужна

Фактическое состояние:

- repository локальный;
- `git remote -v` пуст;
- remote/push/deployment path не нужен для `0.1.0`;
- реализация ведётся атомарными локальными коммитами; remote/push запрещены.

Правила:

- не создавать remote;
- не выполнять `git push`, remote fetch или remote Git automation;
- не переписывать историю и не удалять существующие рабочие изменения без отдельного запроса;
- логически завершённые будущие изменения коммитить только по явному запросу пользователя;
- перед merge проверять diff, targeted tests и отсутствие секретов.

### 3.13 Legacy command cleanup — DONE

Удалены provider-specific command surfaces и UI для mobile, voice, upgrade,
usage, rate-limit-options, install-slack-app, install-github-app, fast и
thinkback. Compatibility-only state/exports не возвращают legacy behavior.
Focused command/cleanup tests и полный Bun test/build для текущего объединённого worktree прошли; результаты зафиксированы в разделах 2.2 и 4.

### 3.14 Rust TaskGraph/session SQLite RPC — DONE

Завершена Rust foundation-фаза:

- `mindcode-state`: SQLite/WAL TaskGraph, schema migration, CAS claims, dependencies, leases и overlap checks;
- daemon RPC: MessagePack framing, request IDs, replay/connection limits, cancellation и authority pinning;
- TS client и `taskGraphAdapter`: daemon-backed state path с fallback boundary без смешивания authority в одной операции;
- structural patch выполняется до claim/run;
- `workerLifecycle.ts` и `resumeAgent.ts` мигрированы на daemon-backed `workerGraph` с сохранением report/policy semantics.
- `mindcode-state`: отдельный SQLite/WAL `sessions.db` с metadata-only
  session index, monotonic concurrent upsert и private permissions;
- daemon RPC: `session_index.upsert|get|list|search|remove`;
- `src/runtime/sessionIndex/`: strict TypeScript wire/client boundary с
  availability-only read fallback;
- `src/utils/sessionIndexBridge.ts` и `sessionStorage.ts`: index-first list,
  filesystem bootstrap, stat refresh после flush, metadata refresh после
  enrich, stale-path removal, secret redaction и filesystem fallback;
- Rust↔TypeScript interop проверяет полный SessionIndex lifecycle.

Исторический CI-equivalent baseline до текущего TUI v2 diff: Rust workspace —
`99 pass`, native TUI — `9 pass`, Bun — `933 pass`, `4 skip`; daemon/TaskGraph/
SessionIndex interop, build, smoke и native packaging — pass. Эти числа не
заменяют повторный current-worktree gate.

### 3.15 Model-native VEXZY broker и immutable request snapshots — DONE

- `mindcoded` хранит только keyless normalized model catalog в bounded
  immutable memory snapshot; RPC `vexzy.catalog.get|put|status` не принимает
  credential, provider raw payload, prompts или model responses;
- TypeScript `runtime/modelBroker` валидирует exact wire schema, canonical
  SHA-256, monotonic publication, deep-freeze и availability-only fallback;
- `modelClient.ts` немедленно использует daemon snapshot и параллельно
  обновляет `/v1/models`; успешный live result публикуется обратно без key/raw;
- explicit refresh всегда ожидает VEXZY, timestamps монотонны, а snapshots с
  timestamp дальше пяти минут в будущем отклоняются в Rust и TypeScript;
- Messages requests получают memory-only defensive snapshot до JSON dispatch;
  snapshots не персистятся, не отправляются daemon и не кэшируют completion,
  stream или tool responses;
- cross-language digest и Rust↔TypeScript RPC покрыты реальным interop test.

## 4. Итоговый статус реализации

### Фаза A — contract gaps — DONE

1. Все worker ingress сведены к `resolveWorkerRuntime()` и закрыты runtime tests.
2. `policy_epoch` и SHA-256 `policy_digest` проходят через task graph, Worker
   run/report, daemon RPC, compact/resume; stale run/report отклоняются.
3. Output-limit policy использует provider dynamic field first; exact overrides
   остаются только подтверждённым fallback.

### Фаза B — unified runtime boundaries — DONE

1. VEXZY transport interface не протаскивает provider-specific imports в domain modules.
2. Leader/Worker model и Worker effort имеют отдельные public resolver boundaries.
3. Pure `PromptCompiler` применяется к Leader, Worker, compact и resume.
4. Daemon-backed task graph adapter является persistent task authority.
5. Completion teammate backends требует validated WorkerReport.
6. Integration lifecycle tests покрывают AgentTool, fork, resume, in-process,
   tmux/iTerm и background routes.

### Фаза C — legacy cleanup — DONE

1. Import/dependency inventory выполнен.
2. Старые OAuth/remote/provider paths удалены либо изолированы как локальные
   compatibility boundaries.
3. Неиспользуемые package dependencies удалены; canonical lockfile — `bun.lock`.
4. Messages-compatible protocol types находятся в VEXZY boundary без старого
   provider SDK.
5. Production bundle проверен на old endpoints, stale branding, home path и
   credentials.

### Фаза D — quality gates — PASS (2026-08-07)

1. `bun run lint`: PASS against checked-in local baseline `7882` diagnostics,
   hash `f58c7d5849fb5db81df3222f91e8d64b76cd6d8b2b36160bde88f8709047a1e9`.
2. `bun run typecheck`: PASS against checked-in local baseline `4050` diagnostics,
   hash `ddfc618f57cab2e9f1aa3b859b1273ce753ea02e4b5141c497c794de859a458c`.
3. Full isolated Bun suite + LCOV gate: `653` pass, `0` fail, coverage `93.41%`.
4. Rust root/standalone TUI fmt, test and clippy gates: PASS.
5. Daemon interop, Linux AMD64 package validation, smoke, diff/secret/remote
   checks: PASS.

### Фаза E — release acceptance — LOCALLY COMMITTED

Release `0.1.0` остаётся условно готовым только после выполнения всех пунктов:

- package identity и CLI binary — `mindcode@0.1.0`;
- transport — только VEXZY endpoints и `VEXZY_API_KEY`;
- Leader — exact available model из dynamic catalog без fixed worker default;
- каждый Worker — `gpt-5.6-luna`, включая resume/background/pane/in-process;
- worker effort — только шесть handoff values, default `medium`;
- scheduler weights и budget совпадают с контрактом;
- task graph claim/lease/overlap/report completion atomic;
- compact warning `85%`, trigger `95%`, watchdog `120s`;
- `/copy`, `/copycon`, `/status` зарегистрированы и не раскрывают secrets;
- текущие Rust/TypeScript TUI v2 integration, packaging, full tests, coverage,
  typecheck, lint, build и smoke проходят;
- `git remote -v` пуст;
- diff содержит только заявленные изменения.

Текущих release blockers нет. Открытые product-level follow-ups перечислены в
разделе `8.2`; они не блокируют текущий local build/test/package acceptance.

## 5. Запрещённые изменения для этого плана

- Не менять handoff contract без отдельного решения.
- Не выбирать другую модель для Worker при недоступности Luna.
- Не передавать Leader model или Leader effort в Worker scheduler/runtime.
- Не добавлять статический count-only limit вместо weighted budget.
- Не хранить VEXZY key в файлах проекта, settings, reports или logs.
- Не подключать remote и не выполнять push.
- Не менять файлы, кроме явно затронутых текущей задачей.

## 6. Файлы-источники статуса

```text
package.json
tsconfig.json
src/main.tsx
src/services/api/vexzy/
src/utils/model/model.ts
src/utils/model/agent.ts
src/utils/model/subagentModel.ts
src/utils/swarm/backends/types.ts
src/utils/swarm/concurrencyPolicy.ts
src/tools/AgentTool/workerLifecycle.ts
src/tools/AgentTool/workerReport.ts
src/utils/swarm/workerTeamReport.ts
src/tasks/graph/
src/tasks/validation/
src/runtime/sessionIndex/
src/utils/sessionIndexBridge.ts
src/utils/sessionStorage.ts
src/constants/prompts.ts
src/utils/jailbreak.ts
src/services/compact/
src/commands/copy/
src/commands/copycon/
src/commands/status/
src/commands.ts
crates/mindcode-protocol/src/ui.rs
crates/mindcode-tui/Cargo.toml
crates/mindcode-tui/src/lib.rs
crates/mindcode-tui/src/render.rs
crates/mindcode-tui/src/interaction.rs
crates/mindcode-tui/src/clipboard.rs
crates/mindcode-tui/src/preferences.rs
crates/mindcode-tui/src/ui/layout.rs
crates/mindcode-tui/src/ui/theme.rs
crates/mindcode-tui/src/ui/animation.rs
src/runtime/nativeTui/protocol.ts
src/runtime/nativeTui/projections.ts
src/runtime/nativeTui/controlServer.ts
src/runtime/nativeTui/inkBridge.ts
docs/tui/mindcode-tui-mockup.html
```

## 7. Rust acceleration program — FOUNDATION COMPLETE (2026-08-06)

Цель: уменьшить локальный p95 Agent dispatch до `<100ms` для первого запуска и
`<50ms` для тёплого, сделать поле ввода доступным за `<500ms`, не увеличивая
число model calls. При конфликте latency и стоимости действует credits-first.

Зафиксированная архитектура:

- macOS/Linux x64+arm64; Windows остаётся на TS fallback;
- `mindcoded` — lazy Rust daemon с idle timeout 30 минут;
- Unix socket protocol v1: 4-byte big-endian length + MessagePack, максимум 16MiB;
- `VEXZY_API_KEY` разрешён только в памяти процесса и не входит в IPC status/logs;
- последний валидный каталог VEXZY используется сразу, refresh выполняется в фоне;
- low/medium используют тёплый pool, high/max и write-overlap требуют изоляции;
- общий project pool имеет session namespaces и глобальный overlap guard;
- hard cap 64 поверх weighted adaptive scheduler;
- весь validated DAG может продолжаться после закрытия TUI, но новые задачи без
  Leader не создаются и расход останавливается на 2x от прогноза;
- TS fallback сохраняется два стабильных релиза.

Текущий статус:

1. `DONE`: повторяемый p50/p95 benchmark harness.
2. `DONE`: shared Rust protocol, hardened daemon lifecycle и TS IPC adapter.
   Protocol v1 использует 4-byte big-endian framing + MessagePack, handshake
   timeout, concurrent cancellation, duplicate-ID protection, socket/runtime
   permissions `0600/0700`, generation-safe reconnect и sanitized spawn env.
   Проверки: `17` Rust tests, `17` TS daemon tests и реальный Rust↔TS interop.
3. `DONE`: lazy daemon manager, post-render warm-up, foreground/background
   liveness, graceful client cleanup и TS fallback. Native sidecar packaging
   выпускает совпадающие macOS/Linux x64+arm64 bundles, Windows остаётся на TS;
   CI проверяет Rust quality, interop и target-aware layout. Проверки: `28`
   daemon/manager/path tests, `10` packaging tests и native handshake smoke.
4. `DONE`: Rust TaskGraph/session SQLite RPC, `mindcode-state`, daemon RPC,
   TS client/authority pinning и worker lifecycle migration.
5. `DONE`: Rust session index, TS client, sessionStorage bridge, native
   core tools (Git/process), adaptive MCP stdio transport и interop. Rust
   authority pinning исключает fallback после dispatch; SDK fallback получает
   только explicit MCP credentials и никогда не наследует `VEXZY_API_KEY`.
6. `DONE`: model-native VEXZY catalog broker/cache, keyless daemon snapshots,
   background refresh и memory-only immutable request/prompt snapshots.
7. `DONE`: streaming DAG, credits-first tuning и тёплый worker pool.
   `task_graph.watch` передаёт bounded snapshot/changed/resync stream; TS
   coordinator восстанавливает authoritative DAG после reconnect и продолжает
   уже validated работу без Leader. Scheduler учитывает predictive credits,
   weighted budget и hard cap `64`. Low/medium направляются в bounded тёплый
   in-process pool, а high/xhigh/max, overlap и explicit isolation — в холодный
   изолированный runtime. Lifecycle освобождает lease по событиям abort/idle без
   polling и возвращает usage-aware стоимость через `releaseWithCost`.
8. `DONE`: Ratatui input/status/tasks migration и release performance gates.
   Зафиксирован отдельный Unix control socket с MessagePack, PTY только для
   terminal stdin/stdout, TypeScript как единственный state authority,
   `MINDCODE_NATIVE_TUI=auto|on|off` и Ink fallback на Windows, startup failure
   и раннем завершении native process. Проверки: `58` native TS tests, `3` REPL
   integration tests, `9` Rust TUI tests, `4` target/layout packaging tests,
   native sidecar packaging smoke и реальный Rust TUI + TS control/session smoke.
   Финальный performance gate (`20` запусков): input-ready p95 `151.59ms`
   (`<500ms`), cold dispatch p95 `5.05ms` (`<100ms`), warm dispatch p95
   `3.01ms` (`<50ms`). Полный Bun suite: `933 pass`, `4 skip`, `0 fail`;
   architectural coverage с native TUI allowlist: `93.79%` (`10926/11650`).


## 8. Текущий TUI v2 — implementation status (2026-08-07)

### 8.1 Completed foundation

Реализация ниже фактически присутствует в текущем worktree; focused и full
release gates прошли, результаты зафиксированы в разделах 2.2 и 4.

1. **Protocol v2 и rich snapshots — IMPLEMENTED**
   - `crates/mindcode-protocol/src/ui.rs` поднят до `UI_PROTOCOL_VERSION = 2`.
   - Snapshot содержит `sessions`, `workspaces`, `status`, `telemetry`, `tasks`,
     `agents`, typed transcript blocks (`markdown`, `code`, `tool`, `thinking`,
     `report`, `error`), `transcript_window`, `changes`, `activity`,
     `permissions` и `writer` state.
   - Input boundary содержит key/text/paste/submit/cancel/interrupt, mouse и
     action events.
   - Rust и TypeScript boundaries имеют одинаковые bounds, UTF-8 truncation,
     aggregate snapshot budget, strict unknown-field/version validation и
     monotonic sequence checks.
   - `src/runtime/nativeTui/controlServer.ts` сохраняет все v2 snapshot fields
     при publish/forward; protocol/projection/control-server tests это проверяют.

2. **Rust TUI visual shell — IMPLEMENTED**
   - `crates/mindcode-tui/src/render.rs` реализует welcome dashboard, Chat,
     Agents, Tasks, Changes, Logs, Inspector, composer, permission/activity/
     reconnect/palette/help overlays.
   - `crates/mindcode-tui/src/ui/theme.rs` содержит Graphite Sakura, Light и
     Monochrome palettes с TrueColor/ANSI256/ANSI16 fallback.
   - `crates/mindcode-tui/src/ui/layout.rs` содержит responsive breakpoints
     `140/100/72`, three-pane ratios и overlay collapse для узких терминалов.
   - `crates/mindcode-tui/src/ui/animation.rs` содержит deterministic Sakura
     petals и adaptive redraw `30/5/event-driven` с reduced-motion mode.

3. **Interaction — IMPLEMENTED foundation**
   - `crates/mindcode-tui/src/interaction.rs` мапит keyboard, mouse, paste,
     resize, focus, scrolling, drag и local intents.
   - `crates/mindcode-tui/src/lib.rs` подключает contextualized input, modal
     focus trapping, Alt view navigation, composer editing, permission
     decisions, observer request-control, reconnect cancellation и pane resize.
   - `crates/mindcode-tui/src/clipboard.rs` реализует bounded OSC52 clipboard
     payload без хранения session transcript.

4. **Preferences — IMPLEMENTED foundation**
   - `crates/mindcode-tui/src/preferences.rs` сохраняет только theme,
     reduced-motion override и per-workspace pane ratios.
   - Запись bounded и atomic: temporary file, `sync_all`, rename; secret/session
     fields в формате отсутствуют.
   - `App` загружает/сохраняет preferences и применяет workspace-specific ratios.

5. **HTML mockup и visual fixtures — IMPLEMENTED**
   - `docs/tui/mindcode-tui-mockup.html` — self-contained Graphite Sakura mockup
     с Light/Monochrome themes, motion toggle, dialogs, focus/clipboard flows и
     accessibility semantics.
   - `crates/mindcode-tui/tests/golden/` содержит `6` responsive/theme fixtures:
     wide, medium, compact, narrow, light и monochrome.
   - Текущий inline script прошёл `node --check`.

### 8.2 Current acceptance and remaining follow-ups

**Completed in this pass**

- Luna/max read-only review нашёл P1 issues, все они исправлены и покрыты
  Rust tests: sidebar toggle, welcome overlays, per-pane scrolling,
  composer navigation, clamp transcript, task/change selection, reconnect
  write path и pending permission recovery.
- `InkStatePublisher`/`inkBridge` публикует worker model/effort/progress,
  typed transcript/report blocks и connection reconnect telemetry; fixed
  runtime normalizes report status/effort/evidence before protocol emission.
- Legacy overage/rate-limit/OAuth surfaces удалены. Limits module renamed to
  `vexzyLimits`; `/cost` показывает локальный VEXZY session credit breakdown.
- Full local verification приведена в таблице 2.2; final Luna/max integration
  review returned no P0/P1 findings.

**Follow-ups, не блокирующие release**

1. Linux package was structurally validated on macOS. Real execution of its
   daemon/TUI still requires a Linux AMD64 runner because `test:native-packaging`
   deliberately skips non-host execution.
2. Runtime maps every rich field that exists in Ink state. Deeper source-state
   support for transcript paging and model-driven older/newer-window requests
   remains a future product feature.
3. No long-duration interactive PTY soak test covers a physical terminal loss
   during a live reconnect loop; deterministic socket/reconnect unit coverage
   is present.
4. The inherited repository retains baseline TypeScript/Biome diagnostics;
   the local baseline records them explicitly. Changed MindCode TUI/VEXZY paths
   have targeted type/test coverage and introduce none of those diagnostics.

### 8.3 Local atomic commit plan — EXECUTED

Локальная серия commit выполнена в следующем порядке:

1. `9701904 feat(tui): add native TUI v2 runtime` — protocol schema, strict TS
   boundary, control/Ink bridge, Rust renderer, interaction, preferences and
   responsive fixtures; после commit выполнены native-TUI, focused bridge и Rust TUI gates.
2. `40dd2e9 docs(tui): add interactive MindCode mockup` — self-contained
   Graphite Sakura visual model; inline script прошёл `node --check`.
3. `afa99c8 chore: remove obsolete provider usage surfaces` — VEXZY-only
   cleanup, renamed limits module and local credit `/cost`; focused VEXZY
   suite прошла `119/119`.
4. `278166c chore: refresh local quality baseline` — accepted current inherited
   diagnostics after targeted strict-diagnostic review.
5. `docs: update implementation status` — этот финальный документ и current
   gate results.

После каждого code commit выполнен focused smoke/test; финальный state проходит
все gates из таблицы 2.2. Remote остаётся пустым, `git push` не выполняется.
