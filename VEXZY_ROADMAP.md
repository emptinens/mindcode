# MindCode VEXZY Roadmap

Версия: `0.1.0`
API: VEXZY-only
Локальное состояние: `~/.mindcode`
Переменные конфигурации: префикс `MINDCODE_`

## Контракт VEXZY

- OpenAI-compatible base URL: `https://api.echogate.one/v1`
  - `POST /chat/completions`
  - `POST /responses`
  - `GET /models`
- Messages-compatible base URL: `https://api.echogate.one`
  - `POST /v1/messages`
- Auth: `Authorization: Bearer $VEXZY_API_KEY`; ключ формата `forge-…` не сохраняется в settings, fixtures, логах и отчётах.
- Streaming: `stream: true`.
- GPT-5.6 effort: `none|low|medium|high|xhigh|max`.
- Реестр моделей загружается динамически через `GET https://api.echogate.one/v1/models`; текущий подтверждённый каталог содержит 33 модели.
- `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`: контекст `1 050 000` токенов, максимальный ответ `128 000`, усилия `none|low|medium|high|xhigh|max`.
- Worker `gpt-5.6-luna`: фиксированная модель во всех runtime-путях; Worker context `1 050 000`, max output `128 000`.

## Реализовано

### Runtime и модели

- VEXZY transport, streaming, retry/error mapping и dynamic model registry.
- User-selected Leader model, thinking mode и effort.
- Fixed `gpt-5.6-luna` Workers.
- Per-task Worker effort с fallback `medium`.
- Effort weights: `none=1`, `low=1`, `medium=2`, `high=4`, `xhigh=6`, `max=8`.
- Cost-budget lease с конфигурируемым `MINDCODE_AGENT_COST_BUDGET`, default `32`.

### Tasks и агенты

- SQLite task graph с persistent metadata.
- Atomic compare-and-swap claim.
- Dependency blocking через `blocked_by`.
- Validate overlap-check для `files_touched`.
- Worktree isolation для конфликтующих активных задач.
- Отдельный mailbox для сообщений.
- JSON-only WorkerReport:
  `{task_id,status,changed_files,evidence,tokens_used,effort_used}`.
- Полный Worker transcript исключён из Leader payload.

### Context и команды

- Soft-warning context на `85%`.
- Auto-compact trigger на `95%`.
- Atomic compact с snapshot, validation и watchdog.
- `/model`, `/effort`, `/agents`, `/tasks`.
- `/copy`, `/copycon`, `/compact`, `/status`, `/status html`.
- `/jailbreak` применяется к Leader и Worker prompt paths.
- `/mcp`, `/skills` с plugin allowlist: `ida`, `superpowers`, `math-mcp`.
- Sakura mascot вместо исходной брендированной графики.

### Build и repository

- Версия проекта `0.1.0`, CLI `mindcode`.
- Bun-based build/test workflow.
- Локальный Git без remote и push.
- Локальные атомарные коммиты по функциональным блокам.

## Реальные TODO и риски

### DONE — VEXZY-only cleanup

- Legacy OAuth/provider/remote runtime-пути удалены или локально изолированы.
- Runtime SDK transport заменён локальными VEXZY protocol types.
- Production bundle audit даёт `0` для запрещённых provider endpoints,
  credentials, package names и marketplace hosts.

### P1 — Lifecycle и надёжность

- Lifecycle `Decompose → Validate → Route → Acquire → Execute → Report → Release`
  покрыт integration tests, включая конфликты, зависимости и invalid reports.
- Расширить multi-backend smoke на resume, tmux/iTerm и восстановление lease
  после аварийного завершения отдельного процесса.
- Проверить production wire details для tool calls, structured output и usage accounting через VEXZY fixtures.
- Проверить восстановление in-process Workers после resume и reconcile зависших task statuses.

### P1 — Performance

- Профилировать пути `Decompose → Route → Acquire`.
- Устранить лишние синхронные чтения task graph и повторную загрузку immutable model/plugin metadata.
- Измерить latency, spawn cost, memory, bundle size и compact duration.
- Проверить warm in-process execution для мелких задач и адаптивный worker budget под CPU, память и VEXZY rate limits.

### DONE — Coverage и CI baseline

- `430` tests, `0` failures.
- Architectural coverage `91.43%` при gate `≥85%`.
- Race-тесты atomic claim, dependency blocking и overlap isolation добавлены.
- CI запускает source check, lint/typecheck baseline, tests, coverage, build и smoke.

### P1 — Quality debt

- Постепенно устранить существующий baseline: `8167` lint diagnostics и `4184`
  typecheck diagnostics, не ослабляя strict-конфигурацию.
- Добавить отдельный multi-platform release job для всех бинарных targets.

### P2 — Observability

- Довести `/status html` до полной статистики Leader/Worker: токены, запросы, effort, lease, latency, compact history, ошибки и стоимость только при наличии надёжных данных VEXZY.
- Добавить экспорт sanitized diagnostic bundle с автоматической redaction секретов.
- Добавить детальный timeline task graph и Worker lifecycle.

## Порядок завершения

1. Multi-backend lifecycle/resume smoke и policy-epoch hardening.
2. Performance profiling и устранение лишних ожиданий/чтений.
3. Снижение lint/typecheck baseline debt.
4. Multi-platform release build.
5. Расширение `/status html`, sanitized diagnostics и документации.
