# MindCode 0.1.0 — план и статус реализации

Дата аудита: `2026-08-06`
Каталог проекта: `/Users/x32db/PROJECTS/mindcode`

Документ является одновременно текущим baseline, зафиксированным контрактом и
итоговым release-отчётом. Все последующие изменения должны обновлять этот файл
в том же коммите, что и затронутый контракт.

## 1. Контракт handoff

| Параметр | Обязательное значение |
|---|---|
| Проект | `MindCode` |
| Версия | `0.1.0` |
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

## 2. Аудит текущего дерева

### 2.1 Зафиксированные факты

- `package.json` уже содержит `name: "mindcode"`, `version: "0.1.0"`, bin `mindcode` и Bun scripts.
- `tsconfig.json` существует, содержит `strict: true`, `noEmit: true` и включает `src/**/*` и `scripts/**/*.ts`.
- `bun run sources:check` проверяет `2048` исходных файлов; полный Bun test-run,
  coverage, build и smoke текущего прохода завершены успешно.
- Команда `/copycon` существует и зарегистрирована в `src/commands.ts`.
- `git remote -v` не выводит remote.
- Исходный большой diff сохранён до разбиения на коммиты в локальной резервной
  копии `/Users/x32db/PROJECTS/.mindcode-backups/pre-final-20260805`.
- Реализация разбита на локальные buildable-коммиты; remote по-прежнему
  отсутствует, push не выполнялся.

### 2.2 Проверки, выполненные при аудите

| Проверка | Результат |
|---|---|
| Rust gates | PASS: `99` workspace tests + `9` native TUI tests; fmt, clippy `-D warnings` и locked manifest gates |
| Focused TS tests | PASS для TaskGraph/RPC, lifecycle, policy/report, compact и VEXZY limits |
| Полный Bun test-run | `933 pass`, `4 skip`, `0 fail`, `170 files` |
| Architectural coverage | `93.79%` (`10926/11650`), required `>=85%` across `41` allowlisted files |
| `bun run typecheck` | PASS; baseline `4062` diagnostics |
| `bun run lint` | PASS; baseline `7948` diagnostics |
| `bun run sources:check` | `2048 files`, `0 trailers` |
| Production build/smoke | PASS для `dist/mindcode.js`, native CLI и `mindcoded` sidecar |
| Bundle legacy scan | PASS; targeted provider endpoints/credentials отсутствуют |
| `git remote -v` | remote отсутствует |
| `package.json` identity | `mindcode@0.1.0` |

Проверенный test-набор включал VEXZY auth/config/errors/model client/model catalog/model registry/protocol/SDK adapter, fixed worker resolver, weighted scheduler, SQLite task graph, overlap/lifecycle, WorkerReport, compact policy/watchdog, `/copy`, `/copycon` и HTML status report.

### 2.3 Главные расхождения старого плана

Устарели следующие утверждения и удалены из текущей версии документа:

- планирование переименования проекта вместо уже существующего `mindcode@0.1.0`;
- утверждение, что `PLAN.md`, `/copycon` или `tsconfig.json` отсутствуют;
- предположение, что scheduler, task graph, WorkerReport и compact watchdog ещё не созданы;
- описание Leader и Worker как будущей миграции вместо фактических runtime boundaries;
- требование заменить локальный Git: remote уже отсутствует, поэтому переписывание истории не является частью этого плана;
- ожидание, что typecheck станет первым quality gate после добавления `tsconfig.json`: strict typecheck уже запускается, но сейчас падает на состоянии дерева.

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

### 3.10 Compact — DONE

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

Focused compact tests и полный Bun/coverage/build verification пройдены.

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
Focused command/cleanup tests и полный Bun test/build прогон пройдены.

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

Проверено финальным CI-equivalent проходом: Rust workspace — `99 pass`, native
TUI — `9 pass`, Bun — `933 pass`, `4 skip`; daemon/TaskGraph/SessionIndex
interop, build, smoke и native packaging — pass.

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

### Фаза D — quality gates — DONE

1. `bun run lint`: PASS, неизменный baseline `7948` diagnostics,
   `3ccd0394c1e70061ef7d442c62eb4e6dc55ab5b7fa86d369b32187948a1892f5`.
2. `bun run typecheck`: PASS, неизменный baseline `4062` diagnostics,
   `1f2d56b024b50063912c646c2e37206cfaf9378cce19ec8b12580c67eff595c2`.
3. Full Bun tests, architectural coverage, source hygiene, Rust gates,
   daemon interop, build/smoke, native packaging/TUI и performance gates — PASS.
4. Integration/race tests покрывают SQLite leases/claim/recovery, scheduler,
   compact и VEXZY retry/abort.
5. Golden tests для catalog, prompts, report schema и compact summary пройдены.
6. Локальный CI pipeline настроен; remote отсутствует, privacy checks пройдены.

### Фаза E — release acceptance — PASS

Release `0.1.0` считается готовым только при выполнении всех пунктов:

- package identity и CLI binary — `mindcode@0.1.0`;
- transport — только VEXZY endpoints и `VEXZY_API_KEY`;
- Leader — exact available model из dynamic catalog без fixed worker default;
- каждый Worker — `gpt-5.6-luna`, включая resume/background/pane/in-process;
- worker effort — только шесть handoff values, default `medium`;
- scheduler weights и budget совпадают с контрактом;
- task graph claim/lease/overlap/report completion atomic;
- compact warning `85%`, trigger `95%`, watchdog `120s`;
- `/copy`, `/copycon`, `/status` зарегистрированы и не раскрывают secrets;
- baseline typecheck/lint, tests, coverage gate, sources check и smoke проходят;
- `git remote -v` пуст;
- diff содержит только заявленные изменения.

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
