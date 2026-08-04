# MindCode 0.1.0 — единый подробный план переработки

## 1. Назначение документа

Этот файл является единым планом превращения текущего проекта в **MindCode** — локальный CLI/TUI-инструмент для автономной разработки через **Vexzy API**.

План фиксирует архитектуру, порядок работ, ограничения, критерии готовности и правила ведения разработки. До отдельного подтверждения пользователя выполняется только подготовка плана; переименование, удаление кода, замена Git-репозитория и миграция runtime не начинаются.

Главные цели:

- максимальная скорость выполнения задач;
- высокая автономность;
- минимальный расход токенов основного контекста;
- предсказуемое поведение Leader и Worker;
- фиксированная модель всех Worker — `gpt-5.6-luna`;
- только Vexzy API без старых provider/runtime-путей;
- единый компактный системный промпт;
- надёжный `/compact` без зависания на 97%;
- структурированный обмен результатами между Worker и Leader;
- адаптивная параллельность без статического лимита в 20 агентов;
- атомарный task graph и защита от конфликтующих правок;
- полностью локальная статистика и подробный HTML-отчёт;
- упорядоченные исходники и единые правила модулей;
- постоянное ведение локального Git-репозитория;
- обязательное использование Luna-субагентов при разработке самого MindCode.

---

## 2. Зафиксированные решения

### 2.1 Идентичность проекта

| Параметр | Целевое значение |
|---|---|
| Название | `MindCode` |
| Версия | `0.1.0` |
| Пакет | `mindcode` |
| CLI-бинарник | `mindcode` |
| Каталог настроек | `~/.mindcode` |
| Префикс переменных окружения | `MINDCODE_` |
| API-провайдер | только Vexzy |
| Модель Worker | только `gpt-5.6-luna` |
| Effort Worker | `low \| medium \| high \| max` |
| Effort по умолчанию | `medium` |
| Предупреждение compact | 85% |
| Автоматический compact | 95% |
| Git | локальный, без remote по умолчанию |

Технические термины `Leader`, `leader-agent`, `Worker` и `worker-agent` остаются названиями архитектурных ролей. Они не считаются старым брендом.

### 2.2 Модель Leader и Worker

- Модель Leader выбирается пользователем из реестра моделей Vexzy.
- Thinking mode и reasoning effort Leader меняются независимо.
- Выбранный `max` для Leader должен реально уходить в запрос как `max`, без скрытого преобразования в `high`.
- Все Worker, fork-агенты, background-агенты, in-process-агенты, tmux/iTerm-агенты и resumed Worker используют только `gpt-5.6-luna`.
- Автоматический выбор другой модели Worker по сложности запрещён.
- Fallback Worker на Sonnet, Haiku, Claude или любую другую модель запрещён.
- В UI, логах, отчётах и runtime должна показываться фактическая модель, а не устаревшая подпись.
- Полный список основных моделей и их возможностей будет добавлен после получения спецификации Vexzy.
- Ожидаемое окно контекста Luna — 1 000 000 токенов; окончательное значение должно приходить из подтверждённого Vexzy capability registry и проверяться тестом.

### 2.3 Обязательное использование Luna-субагентов

При разработке MindCode каждая значимая задача должна выполняться с участием Luna-субагентов.

Обязательный процесс:

1. Leader анализирует запрос и формирует задачи.
2. Для каждой задачи создаётся `TaskSpec` с явным effort, зависимостями и наборами файлов.
3. Исследование, реализация, тестирование, оптимизация и документация делегируются Worker на `gpt-5.6-luna`.
4. Для значимых изменений отдельный Luna Worker выполняет независимую проверку.
5. Leader принимает только структурированные отчёты, проверяет diff и интегрирует результат.
6. Полные Worker-транскрипты не добавляются в контекст Leader.

Leader сохраняет полный read/write-доступ для архитектурной работы, интеграции, разрешения конфликтов и финальных исправлений. Даже прямое изменение Leader должно быть проверено Luna Worker перед завершением этапа.

Для тривиальных задач используется тёплый in-process Luna Worker, чтобы запуск отдельного процесса не съедал время. Если Luna недоступна, другая модель не подставляется: задача остаётся ожидающей, а причина фиксируется в диагностике.

---

## 3. Текущее состояние, подтверждённое read-only аудитом

Старая Git-история не исследовалась.

- В проекте около 1 985 файлов под `src`.
- `PLAN.md` до этого отсутствовал.
- Есть промежуточный `VEXZY_ROADMAP.md`.
- Текущий пакет называется `@anthropic-ai/claude-code`, версия указана как `1.0.0`.
- Текущий бинарник называется `claude`.
- Основной стек: TypeScript, React/Ink и Bun.
- В проекте отсутствует `tsconfig.json`, поэтому текущий `typecheck` нельзя считать рабочим quality gate.
- Полноценных тестов мало — около десяти файлов.
- CI отсутствует.
- `/copy` частично реализован, но не зарегистрирован в основном command registry.
- `/copycon` отсутствует.
- Prompt assembly разделён между Leader, AgentTool, fork, resume, background, in-process, tmux/iTerm, compact и helper-query путями.
- Worker model/effort разрешаются в нескольких местах и могут расходиться.
- Scheduler остаётся в основном count-based, а task graph и leases не образуют единую транзакционную модель.
- Compact имеет несколько путей и слабый fallback, из-за чего возможны зависание и потеря состояния.
- `/jailbreak` не имеет единого immutable snapshot для всех Worker runtime.
- В UI и исходниках остаются старые логотипы, mascot, названия и provider-specific компоненты.
- Присутствуют Anthropic SDK, OAuth, Bedrock, Vertex, Foundry и другие старые runtime-пути.
- Текущий Git подключён к remote, а рабочее дерево уже содержит много незакоммиченных изменений.

Перед реализацией эти факты повторно фиксируются машинным отчётом, потому что состояние дерева может измениться.

---

## 4. Этап 0 — полная инвентаризация и baseline

До любых рефакторингов необходимо:

1. Просканировать текущее дерево без чтения старой Git-истории.
2. Составить карту модулей:
   - bootstrap и lifecycle;
   - API transport;
   - model registry;
   - auth;
   - prompt compiler/assembly;
   - Leader/coordinator;
   - Worker runtime;
   - scheduler;
   - task list/task graph;
   - mailbox;
   - context и compact;
   - команды;
   - MCP;
   - plugins;
   - skills;
   - TUI/HTML UI;
   - статистика;
   - storage;
   - тесты и build scripts.
3. Для каждого файла определить одно действие:
   - `KEEP`;
   - `REFACTOR`;
   - `MOVE`;
   - `RENAME`;
   - `REMOVE`;
   - `REPLACE`;
   - `TBD`.
4. Найти все строки и импорты, связанные со старым брендом и provider-ами.
5. Построить dependency graph модулей и найти циклы.
6. Зафиксировать исходные показатели:
   - время запуска;
   - время сборки;
   - размер bundle;
   - память;
   - число зависимостей;
   - число API-запросов на типовой сценарий;
   - токены Leader/Worker;
   - spawn latency Worker;
   - compact latency;
   - количество тестов и текущее покрытие.
7. Проверить все существующие незакоммиченные изменения и сохранить их как часть нового baseline, ничего не теряя.

Результат этапа: карта исходников, baseline-отчёт, перечень рисков и точный список файлов для первого атомарного изменения.

---

## 5. Новый локальный Git и постоянный Git workflow

### 5.1 Новый репозиторий MindCode

После утверждения плана создаётся новый локальный Git-репозиторий без старой истории.

Порядок:

1. Проверить хэши и сделать локальный rollback-snapshot текущего рабочего дерева без секретов, `node_modules` и build-артефактов.
2. Сохранить существующую `.git` вне рабочего каталога как временный rollback-артефакт; не использовать её историю при разработке MindCode.
3. Выполнить `git init -b main`.
4. Создать фактический `.gitignore` для Bun/Node/TypeScript, локальной статистики, секретов, временных worktree и отчётов.
5. Запустить все уже доступные проверки, записать их точные результаты и создать импортный baseline-коммит до запуска worktree-агентов.
6. Не добавлять remote.
7. Удалить rollback-артефакт старой `.git` только после отдельного подтверждения и проверки нового baseline.

Первый импортный baseline-коммит является единственным bootstrap-исключением: он фиксирует существующее рабочее дерево без новой функциональности и может содержать заранее документированный отсутствующий quality gate, например неработающий `typecheck` из-за отсутствующего `tsconfig.json`. При этом доступные build/tests/smoke обязаны быть запущены, а их фактический статус — записан. Следующий коммит обязан восстановить полный набор quality gates; после него исключения запрещены.

### 5.2 Постоянные правила Git

- MindCode всегда разрабатывается в локальном Git-репозитории.
- Любой логически завершённый блок фиксируется отдельным коммитом.
- После bootstrap baseline перед каждым коммитом обязательны format, lint, typecheck, целевые тесты и smoke-run.
- Сломанное состояние не коммитится.
- Worker в изоляции может выполнять `git add` и `git commit` только в своей ветке/worktree.
- Worker не выполняет merge в `main`.
- Leader проверяет WorkerReport, diff, тесты и только затем делает merge.
- `push`, создание remote и любые сетевые Git-операции выполняются только по явной просьбе пользователя.
- История остаётся локальной, пока пользователь отдельно не подключит репозиторий.

### 5.3 Работа в пользовательских каталогах без `.git`

Чтобы агенты работали в каталогах, которые не являются Git-репозиториями, MindCode использует **shadow Git repository**:

- metadata хранится в `~/.mindcode/workspaces/<workspace-hash>/git`;
- рабочий каталог пользователя используется как `work-tree`;
- внутри пользовательского каталога `.git` автоматически не создаётся;
- создаётся локальный baseline-коммит, от которого можно строить worktree/isolation;
- remote отсутствует;
- пользовательские файлы не отправляются наружу;
- если пользователь явно просит вести Git прямо в проекте, MindCode выполняет обычный `git init` после подтверждения.

Это устраняет ошибки `not in a git repository`, `HEAD does not exist` и невозможность создать agent worktree, не загрязняя чужой каталог.

### 5.4 План атомарных коммитов

```text
chore: initialize local MindCode repository
chore: add working TypeScript and quality baseline
chore: rename project to MindCode and set version 0.1.0
refactor: organize source tree by domain
feat: add Vexzy-only provider boundary
feat: centralize system prompt compiler
feat: enforce fixed gpt-5.6-luna worker runtime
feat: assign per-task reasoning effort
feat: add adaptive cost-weighted scheduler
feat: add atomic shared task graph
feat: add overlap validation and isolation
feat: add structured worker reports
feat: register copy and add copycon
feat: make compact atomic with 85/95 thresholds
feat: propagate policy snapshots to every worker runtime
feat: add agent and task command UX
feat: add local statistics and HTML status report
feat: restrict plugins and add math-mcp
feat: replace legacy mascot with Sakura UI
perf: optimize runtime, storage, prompts and UI
test: add unit, race, lifecycle and snapshot coverage
ci: add local and GitHub Actions validation pipeline
docs: finalize MindCode documentation
```

---

## 6. Сортировка и организация исходников

Исходники сортируются не механической перестановкой файлов, а по доменам и ответственности. Массовый перенос одним коммитом запрещён: каждый домен переносится отдельно с обновлением импортов и smoke-проверкой.

### 6.1 Целевая структура

```text
src/
  app/
    bootstrap/
    lifecycle/
    runtime/

  core/
    config/
    errors/
    events/
    logging/
    metrics/
    types/

  providers/
    vexzy/
      auth/
      capabilities/
      client/
      errors/
      models/
      schemas/
      streaming/
      usage/

  prompts/
    compiler/
    sections/
    roles/
    policy/
    cache/
    compact/
    copy-context/

  leader/
    decompose/
    validate/
    route/
    synthesis/
    integration/

  workers/
    runtime/
    launcher/
    pool/
    lease/
    report/
    isolation/
    backends/

  scheduler/
    budget/
    queue/
    scoring/
    overlap/
    dispatch/
    retry/

  tasks/
    graph/
    persistence/
    claims/
    dependencies/
    transactions/

  mailbox/
    persistence/
    routing/

  context/
    accounting/
    compact/
    continuation/

  commands/
    model/
    effort/
    agents/
    tasks/
    compact/
    status/
    copy/
    copycon/
    mcp/
    skills/
    jailbreak/

  mcp/
  plugins/
  skills/
  statistics/
  storage/

  ui/
    tui/
    sakura/
    agents/
    tasks/
    status/
    compact/

  tests/
    unit/
    integration/
    race/
    snapshots/
    fixtures/
```

### 6.2 Правила исходников

- Один модуль отвечает за один домен.
- Provider transport не смешивается с scheduler, prompt или UI.
- UI не изменяет task graph напрямую.
- Команды являются тонкими адаптерами и вызывают сервисные интерфейсы.
- Mailbox и task state физически и логически разделены.
- Общие типы не дублируются между runtime-путями.
- Barrel exports допускаются только на границах домена.
- Имена файлов, каталогов, типов и тестов приводятся к единому соглашению.
- Импорты автоматически форматируются и сортируются Biome; порядок массивов/handlers, влияющий на поведение, автоматически не переставляется.
- Generated-файлы отделяются и не редактируются вручную.
- Неиспользуемые команды, feature flags, provider paths и зависимости удаляются после проверки consumers.
- Для границ модулей добавляются lint-правила, запрещающие обратные зависимости `core -> UI` и `core -> provider implementation`.
- После каждого перемещения запускается typecheck и целевой smoke-test.

---

## 7. Переименование и удаление старого runtime

### 7.1 Переименование

Обновляются:

- `package.json`, lockfiles и build metadata;
- CLI entrypoint и имя бинарника;
- каталоги конфигурации и session storage;
- переменные окружения;
- help, README, документация и command descriptions;
- TUI, HTML-отчёты, заголовки и ошибки;
- названия логов, метрик и telemetry events;
- тестовые snapshots;
- launcher/install/rollback scripts;
- комментарии, где старое имя является брендом.

Целевые значения:

```text
MindCode
mindcode
MINDCODE_*
~/.mindcode
0.1.0
```

### 7.2 Удаление старых интеграций

После появления работающего Vexzy transport удаляются:

- Anthropic SDK;
- Anthropic OAuth и billing headers;
- Bedrock;
- Vertex;
- Foundry;
- provider auto-routing;
- Claude model aliases;
- Claude-specific cache headers;
- старые login/logout потоки;
- внутренние analytics/feature gates, не нужные MindCode;
- старые UI assets и mascot;
- команды и сервисы, не относящиеся к MindCode/Vexzy.

Перед удалением каждого блока:

1. найти все runtime consumers;
2. перенести нужную общую функциональность;
3. добавить regression test;
4. удалить код и dependency;
5. проверить bundle и smoke-run;
6. выполнить branding/provider scan.

Runtime MindCode не должен читать старые config paths. Импорт старых настроек не входит в `0.1.0`, если пользователь отдельно его не запросит.

---

## 8. Vexzy-only API слой

### 8.1 Provider boundary

Весь сетевой runtime проходит через один Vexzy client:

```ts
interface VexzyClient {
  listModels(): Promise<ModelInfo[]>
  complete(request: CompletionRequest): AsyncIterable<CompletionEvent>
  countTokens(request: TokenCountRequest): Promise<TokenCount>
  cancel(requestId: string): Promise<void>
  health(): Promise<HealthStatus>
}
```

Scheduler, prompts, task graph, UI и команды работают с provider-neutral типами и не знают wire-format Vexzy.

### 8.2 Capability registry

Для каждой модели хранятся:

```ts
type ModelCapabilities = {
  id: string
  display_name: string
  context_window: number
  max_output_tokens: number
  efforts: Array<'low' | 'medium' | 'high' | 'max'>
  thinking_modes: string[]
  tools: boolean
  structured_output: boolean
  images: boolean
  streaming: boolean
}
```

`/model` показывает эти возможности и меняет только Leader. Worker resolver игнорирует выбор Leader и всегда возвращает `gpt-5.6-luna`.

### 8.3 Данные Vexzy, которые ещё требуются

До реализации production transport пользователь должен предоставить:

- base URL;
- endpoint моделей;
- endpoint генерации;
- auth header и формат ключа;
- streaming protocol;
- tool-call request/response schema;
- structured-output schema;
- usage fields;
- error schema;
- retryable status/error codes;
- rate-limit headers;
- request cancellation;
- список моделей;
- thinking/effort параметры каждой модели;
- context/output limits.

До этого разрешены provider interfaces, mock transport и fixtures, но не предположения о wire-format.

### 8.4 Надёжность transport

- connection reuse;
- bounded streaming buffers и backpressure;
- cancellation;
- timeouts по фазам;
- retry с jitter/backoff только для retryable ошибок;
- circuit breaker;
- rate-limit awareness;
- request idempotency;
- secret redaction;
- локальная health-диагностика;
- точный usage accounting.

---

## 9. Единый системный промпт и PromptCompiler

### 9.1 Причина переработки

Сейчас системные инструкции собираются разными путями. Простая замена текста в одном файле оставит несовместимое поведение у fork, resume, background, in-process, tmux/iTerm, compact и helper models.

Вводится единый `PromptCompiler`, который используется всеми model-call путями.

### 9.2 Runtime-пути

Один compiler обязан обслуживать:

- Leader;
- обычный Worker;
- fork Worker;
- resumed Worker;
- background Worker;
- in-process Worker;
- tmux Worker;
- iTerm Worker;
- compact helper;
- `/copycon` helper;
- session title и другие helper queries.

Helper-пути получают минимальный role profile, но всегда проходят общую identity/policy/capability сборку.

### 9.3 Порядок секций

Статическая часть:

1. MindCode identity.
2. Immutable authority contract.
3. Common operating contract.
4. Stable role contract.
5. Tool protocol.
6. Structured-output contract.
7. Cache boundary.

Динамическая часть:

8. Role delta.
9. Task/control envelope.
10. Effort и lease.
11. Dependency/file ownership.
12. Policy snapshot.
13. MCP capability delta.
14. Skill references/digests.
15. Context/compact state.
16. User task.

Task ID, effort, worker ID, MCP delta и runtime statistics не должны менять статический prefix.

### 9.4 Контракт Leader

Смысл системного промпта Leader:

```text
You are the MindCode Leader.
Decompose work, assign every task an explicit low|medium|high|max effort,
validate dependencies and file overlap, schedule fixed Luna workers,
verify structured evidence, integrate results, and communicate with the user.
Keep full read/write access.
Never import raw worker transcripts into your context.
Accept only validated WorkerReport objects.
Missing task effort must be normalized to medium before scheduling.
```

Leader обязан:

- понимать запрос и формировать dependency graph;
- назначать effort на этапе Decompose;
- выбирать количество Worker по текущему бюджету;
- не отправлять задачу в scheduler без effort;
- проверять overlap до Route;
- принимать только schema-valid reports;
- проверять evidence, diff и тесты;
- не выдумывать состояние Worker;
- выполнять синтез и интеграцию;
- минимизировать собственный контекст.

### 9.5 Контракт Luna Worker

```text
You are a MindCode Worker running exclusively on gpt-5.6-luna.
Execute exactly one leased task using its assigned effort.
Respect declared files, dependencies, isolation and policy snapshot.
Do not create nested workers or mutate the task graph.
Verify the result and return exactly one structured WorkerReport.
```

Worker:

- выполняет только одну leased task;
- не выбирает модель;
- не повышает effort;
- не создаёт nested agents;
- не меняет scheduler/task graph/policy;
- пишет только в разрешённые файлы;
- выполняет проверки;
- возвращает один структурированный отчёт.

### 9.6 Custom prompts и policy

- Immutable protocol, role contract и WorkerReport schema нельзя случайно удалить custom prompt-ом.
- Пользовательский custom system prompt подключается в отдельный extension slot.
- `/jailbreak` изменяет canonical policy profile, а не вручную дописывает разные фрагменты в разные runtime-пути.
- Prompt cache namespace включает role и policy digest.
- Если Vexzy поддерживает provider-side prompt caching, adapter отображает статические/динамические блоки в его wire-format; Anthropic-specific `cache_control` не сохраняется.

### 9.7 Целевой размер

- Leader static + role contract: ориентир до 1 500 токенов.
- Worker static + role/report contract: ориентир до 1 350 токенов.
- Skill bodies и MCP instructions загружаются только по необходимости.
- Динамический envelope должен быть компактным и структурированным.

---

## 10. `/jailbreak` и единый PolicySnapshot

```ts
type PolicySnapshot = {
  profile: string
  epoch: number
  digest: string
  created_at: string
}
```

Правила:

- `/jailbreak` изменяет session policy и увеличивает `epoch`.
- Каждый Worker получает immutable snapshot при запуске.
- Snapshot передаётся ordinary/fork/resume/background/in-process/tmux/iTerm Worker.
- Compact, `/copycon` и helper queries получают соответствующий policy profile.
- Worker не может самостоятельно менять или расширять snapshot.
- WorkerReport содержит policy epoch/digest.
- Активный Worker заканчивает задачу на своём snapshot; новый epoch применяется к новым задачам.
- Leader отклоняет отчёт, если task policy epoch не совпадает с выданным lease.
- При необходимости пользователь может явно перезапустить активные задачи на новом epoch.
- Кэш разных policy digest не смешивается.

---

## 11. Per-task effort и исправление `/effort`

Допустимые значения:

```text
low
medium
high
max
```

Правила:

- Глобальное наследование `max` всеми Worker удаляется.
- Leader обязан назначать effort каждой задаче.
- Если решение отсутствует, Decompose нормализует значение в `medium`.
- После нормализации TaskSpec всегда содержит effort; scheduler отклоняет невалидную задачу.
- Effort Leader, default Worker effort и effort конкретной задачи являются разными настройками.
- `/effort max` для Leader остаётся `max` во всём пути: UI → config → runtime state → request serialization → `/status`.
- Уже запущенный Worker сохраняет effort своего lease.
- Effort отображается в Agent panel, `/agents`, `/tasks`, `/status` и WorkerReport.

Пример TaskSpec:

```ts
type TaskSpec = {
  task_id: string
  kind: 'research' | 'implement' | 'verify' | 'integrate'
  directive: string
  effort: 'low' | 'medium' | 'high' | 'max'
  priority: number
  depends_on: string[]
  read_set: string[]
  write_set: string[]
  required_skills: string[]
  required_mcp: string[]
  policy_epoch: number
}
```

---

## 12. Адаптивный weighted scheduler

Статический hard cap `20` удаляется. Ограничение основывается на суммарной стоимости активных leases.

Базовые веса:

```text
low    = 1
medium = 2
high   = 4
max    = 8
```

```ts
type Lease = {
  lease_id: string
  task_id: string
  worker_id: string
  effort: 'low' | 'medium' | 'high' | 'max'
  weight: number
  acquired_at: string
  expires_at: string
  policy_epoch: number
}
```

### 12.1 Бюджет

- Базовый cost budget задаётся `MINDCODE_AGENT_COST_BUDGET`/config.
- Начальное рекомендуемое значение — 32 условные единицы.
- Runtime может временно уменьшить доступный бюджет по памяти, CPU, Vexzy rate limits, token/request budget и ошибкам.
- Значение не является статическим количеством агентов.
- Число Worker определяется суммой их весов и текущими ресурсами.

Расчёт выполняется детерминированно на каждом событии изменения ресурсов:

```text
configured_budget = config/env, default 32
cpu_budget        = max(1, logical_cpu_count * 4)
memory_budget     = floor(max(0, available_memory_mb - reserve_mb)
                          / measured_memory_mb_per_weight)
rate_budget       = budget, рассчитанный из Vexzy concurrent/request limits
token_budget      = budget, рассчитанный из доступного token-rate окна
health_budget     = budget после circuit-breaker/error-pressure снижения

effective_budget = max(0, min(
  configured_budget,
  cpu_budget,
  memory_budget,
  rate_budget,
  token_budget,
  health_budget
))
```

Если Vexzy не предоставляет конкретный limit, соответствующий компонент считается равным `configured_budget`, а не угадывается. `measured_memory_mb_per_weight` берётся из rolling p95 локальных измерений. Для защиты от oscillation повышение budget требует двух стабильных окон, а снижение при memory/rate pressure применяется сразу.

`effective_budget = 0` является допустимым состоянием: новые Worker не запускаются до восстановления ресурсов или rate-limit окна, а очередь сохраняется без потери задач.

### 12.2 Очередь и fairness

- FIFO остаётся базовым порядком.
- Учитываются priority, critical path, age и retry count.
- Более лёгкая задача может временно обойти тяжёлую, если тяжёлая не помещается в бюджет, но число обходов ограничено.
- Aging не позволяет тяжёлой задаче голодать.
- Tie-breaker детерминирован по enqueue sequence/task ID.
- Retry не создаёт второй активный lease.
- Expired lease атомарно освобождается и может быть восстановлен.

Acceptance criteria scheduler:

- сумма активных weights никогда не превышает `effective_budget`;
- один task не получает два активных lease;
- при постоянной доступности ресурсов runnable task не голодает более двух bounded-bypass циклов;
- одинаковый snapshot/queue даёт одинаковый порядок dispatch;
- снижение budget не убивает выполняющийся Worker, но блокирует новые acquire до возвращения в предел;
- race test с параллельными acquire не превышает budget ни в одном наблюдаемом состоянии;
- scheduler tick не выполняет N+1 чтения task storage.

### 12.3 Worker pool

- `low` и короткие `medium` задачи используют тёплый in-process pool.
- Тяжёлые, долгие и изолированные задачи используют отдельный runtime.
- tmux/iTerm — только display/backend, а не отдельная логика модели или промпта.
- Spawn не выполняется для задачи, которую дешевле выполнить тёплым Worker.
- Wake-up event-driven; постоянный polling исключается.

---

## 13. Shared task graph, atomic claim и mailbox

Для task graph выбирается SQLite WAL через Bun SQLite: это даёт настоящие транзакции, индексы и атомарный claim без добавления тяжёлого внешнего сервиса.

Файлы состояния:

```text
~/.mindcode/state/tasks.db
~/.mindcode/state/mailbox.db
~/.mindcode/state/reports/
~/.mindcode/state/runs/
```

Mailbox хранится отдельно от task graph.

### 13.1 Статусы

```text
pending
claimed
running
completed
failed
blocked
cancelled
```

### 13.2 Поля задачи

```ts
type TaskRecord = {
  id: string
  status: TaskStatus
  owner: string | null
  effort: Effort
  priority: number
  blocked_by: string[]
  read_set: string[]
  write_set: string[]
  files_touched: string[]
  claimed_at: string | null
  started_at: string | null
  finished_at: string | null
  lease_id: string | null
  policy_epoch: number
  report_id: string | null
  version: number
}
```

### 13.3 Atomic claim

- `pending -> claimed` выполняется одной транзакцией/CAS.
- Условие claim проверяет status, version, зависимости и отсутствие активного lease.
- Из множества параллельных claim-попыток ровно одна получает success.
- Задача с незавершённым `blocked_by` не claimable.
- Циклы зависимостей отклоняются до записи.
- Idempotency key предотвращает дубли.
- Каждая мутация увеличивает graph version.
- Recovery проверяет незавершённые транзакции и expired leases.
- Запросы получают один согласованный snapshot, чтобы исключить N+1 чтения.

---

## 14. Dedup, overlap и isolation

Перед Route выполняется Validate.

Проверяются:

- точные пути;
- parent/child каталоги;
- glob patterns;
- symlink-resolved paths;
- case-folded paths на macOS;
- write/write;
- write/read;
- дублирующая цель задачи;
- уже активный semantic target;
- незаявленные изменения.

Правила:

- write/write всегда сериализируется;
- write/read сериализируется, кроме чтения immutable snapshot;
- конфликтующая задача получает `blocked_by`;
- параллельная запись разрешена только при explicit worktree isolation;
- Worker, изменивший файл вне write set, получает invalid report;
- Leader не принимает конфликтующий diff;
- path index строится один раз на graph snapshot, а не пересчитывается для каждой пары задач.

---

## 15. Structured WorkerReport и контекст Leader

```ts
type WorkerReport = {
  schema_version: 'worker-report/1'
  task_id: string
  run_id: string
  worker_id: string
  model: 'gpt-5.6-luna'
  effort_used: 'low' | 'medium' | 'high' | 'max'
  policy_epoch: number
  status: 'completed' | 'partial' | 'blocked' | 'failed'
  summary: string
  changed_files: string[]
  evidence: Array<{
    id: string
    type: 'file' | 'diff' | 'command' | 'test' | 'artifact'
    path?: string
    command?: string
    exit_code?: number
    digest?: string
  }>
  tokens_used: number
  validation: {
    verdict: 'pass' | 'fail' | 'not_run'
  }
  blockers: string[]
}
```

Требования:

- JSON Schema/Zod validation обязательна.
- `task_id`, `status`, `changed_files`, `evidence`, `tokens_used` и `effort_used` обязательны.
- Paths нормализуются относительно workspace.
- Evidence может содержать SHA-256 diff/artifact digest.
- Leader получает report, но не transcript.
- Raw transcript хранится отдельно локально с retention policy и открывается только по явному запросу пользователя.
- Raw transcript не попадает в compact или `/copycon` по умолчанию.
- Невалидный отчёт не переводит задачу в `completed`.

---

## 16. Команды

### 16.1 `/model`

- показывает Vexzy model registry и capability table;
- меняет только модель Leader;
- отдельно показывает thinking mode и effort Leader;
- всегда показывает Worker model как `gpt-5.6-luna` без возможности смены;
- валидирует capability до сохранения;
- не подменяет неизвестную модель старым alias.

### 16.2 `/effort`

```text
/effort low
/effort medium
/effort high
/effort max
```

- изменяет effort Leader;
- показывает effective request value;
- не изменяет уже выданные task leases;
- позволяет Leader назначать effort при Decompose;
- исключает рассинхронизацию UI/config/runtime.

### 16.3 `/agents`

Показывает:

- worker ID/name;
- фактическую модель;
- effort;
- task ID;
- status;
- lease weight;
- elapsed time;
- input/output/total tokens;
- request count;
- files touched;
- blockers и retry.

### 16.4 `/tasks`

Показывает dependency graph, статусы, owner, effort, leases, `blocked_by`, overlaps, retries и timestamps. Claim/update выполняются через task service, а не прямой записью JSON.

### 16.5 `/copy`

Существующая команда регистрируется и получает context-aware поведение:

- если открыт Worker — копируется его последнее видимое сообщение;
- иначе копируется последнее сообщение Leader;
- можно указать agent/task явно;
- поддерживаются full response, code block, clipboard и file output;
- при отсутствии clipboard используется stdout/file fallback;
- скрытые prompts и internal payloads не копируются.

Примеры:

```text
/copy
/copy agent <worker-id>
/copy task <task-id>
/copy --code
/copy --file <path>
```

### 16.6 `/copycon`

Команда вызывает отдельный `gpt-5.6-luna` helper и создаёт самодостаточный prompt для продолжения в новой сессии.

Вход Luna helper:

- видимая история диалога;
- принятые WorkerReports;
- summary task graph;
- подтверждённые решения;
- изменённые файлы;
- результаты тестов;
- blockers;
- текущий следующий шаг.

По умолчанию исключаются:

- credentials и env secrets;
- hidden system prompts;
- tool schemas;
- raw MCP payloads;
- raw Worker transcripts;
- содержимое секретных файлов.

Результат не добавляется обратно в контекст Leader. Он копируется в clipboard и при необходимости сохраняется в файл. Предусматриваются `--markdown`, `--json` и явно подтверждаемый `--raw`.

### 16.7 `/compact`

- ручной и автоматический режим;
- soft warning/метрика на 85%;
- hard trigger на 95%;
- watchdog, cancel и bounded retry;
- атомарная замена истории;
- rollback при невалидном summary;
- отображение progress и причины retry;
- отсутствие бесконечного состояния 97%.

### 16.8 `/status` и `/stats`

`/status` показывает краткий runtime status и умеет создать подробный HTML. `/stats` предоставляет расширенную фильтрацию и JSON/HTML export. Их storage и агрегатор общие, чтобы не дублировать статистику.

### 16.9 `/mcp` и `/skills`

- показывают фактически загруженные возможности, состояние и latency;
- не дублируют полные bodies в prompt;
- позволяют включить/отключить разрешённый компонент;
- отображают version/digest.

### 16.10 `/jailbreak`

- меняет canonical PolicySnapshot;
- показывает profile/epoch/digest;
- применяется ко всем новым Worker runtime-путям;
- позволяет увидеть, какие активные задачи ещё выполняются на предыдущем epoch.

---

## 17. Context accounting, `/compact` и продолжение сессии

### 17.1 Context accounting

Используется effective model context window из Vexzy registry. В расчёт включаются system blocks, tool schemas, messages, attachments и reserved output budget.

```text
85%: warning + metric, без compact
95%: hard trigger
```

### 17.2 Atomic compact

Перед compact создаётся snapshot:

- task graph/version;
- active leases;
- accepted WorkerReports;
- PolicySnapshot;
- pinned user decisions;
- blockers;
- verification results;
- model/capability state;
- хвост последних сообщений.

Порядок:

1. Сохранить исходную историю.
2. Сформировать sanitized compact input.
3. Запустить Luna compact helper с timeout/watchdog.
4. Проверить anchors: цели, незавершённые task IDs, decisions, policy epoch и files.
5. Проверить размер и валидность summary.
6. Атомарно заменить старую часть истории.
7. При любой ошибке оставить исходный context и записать diagnostic.

Целевой summary: 5–8% удаляемой conversational части с сохранением 5% последнего хвоста.

### 17.3 Resume

Resume восстанавливает task graph, accepted reports, policy, model/effort Leader и незавершённые задачи. Отсутствующие in-process Worker не считаются живыми: leases reconciled, после чего задачи безопасно перезапускаются.

---

## 18. MCP, plugins и skills

### 18.1 Разрешённый набор

После инвентаризации удаляются все кастомные plugins, кроме:

- IDA;
- Superpowers;
- `math-mcp`.

`math-mcp` добавляется и проверяется на совместимость с Vexzy tool-call schema. Неиспользуемые plugin data удаляются только после локального backup.

### 18.2 MCP architecture

Разделяются:

- tools;
- resources;
- prompts;
- instructions;
- schemas;
- capabilities;
- health/status.

MCP instruction changes передаются как динамические deltas после cache boundary. Skills загружаются по требованию; статический prompt содержит только имя, версию, digest и краткое описание.

---

## 19. Локальная статистика и HTML `/status`

### 19.1 Метрики

Локально собираются:

- requests total/success/error/retry;
- latency avg/p50/p95/p99;
- input/output/total tokens;
- токены по Leader, Worker, модели, effort, команде и task;
- active/peak Worker;
- cost-budget utilization;
- task duration/status/retry;
- compact count/duration/ratio/failures;
- context utilization;
- tool/MCP calls;
- cache hit/miss, если поддерживается Vexzy;
- files/lines changed;
- overlaps/conflicts;
- startup/build/bundle metrics;
- стоимость, только если Vexzy предоставляет надёжные данные.

### 19.2 HTML-отчёт

`/status --html` создаёт самодостаточную локальную страницу без CDN и внешнего сервера:

- overview cards;
- график токенов и запросов по времени;
- Leader/Worker breakdown;
- effort distribution;
- worker concurrency и budget utilization;
- task graph/statuses;
- compact timeline;
- latency/retry/errors;
- changed files;
- MCP/skills health;
- текущие model capabilities;
- Sakura theme.

Графики реализуются оптимизированным SVG/Canvas, assets встраиваются локально, secrets автоматически редактируются.

---

## 20. Sakura mascot и UI

Старый mascot заменяется собственным образом MindCode: красивое розовое дерево сакуры с падающими листьями.

Варианты:

- terminal full;
- narrow terminal;
- compact one-line/status;
- static fallback;
- animated terminal;
- HTML/SVG;
- icon;
- light/dark theme.

Оптимизация:

- один канонический vector source;
- минимальное число terminal redraw;
- ограниченный FPS;
- lazy loading;
- пауза анимации при скрытом/неактивном UI;
- `prefers-reduced-motion` и config toggle;
- статический fallback для SSH, слабого терминала и CI;
- отсутствие тяжёлых bitmap runtime dependencies;
- snapshot/performance тесты.

Agent panel показывает Leader и Luna Worker, фактический effort, токены, task, lease, status и progress. Узкий режим не скрывает модель/effort полностью, а использует компактные обозначения.

---

## 21. Полная оптимизация

Оптимизация проводится измеряемыми проходами, а не слепой переписью.

### 21.1 Код и зависимости

- удалить dead code, старые feature flags и неиспользуемые команды;
- удалить неиспользуемые dependencies;
- объединить дубли prompt/model/effort/task logic;
- сократить сериализации и копирование больших массивов сообщений;
- использовать lazy imports для редких команд;
- исключить N+1 чтения storage;
- выполнять batch transitions task graph;
- кэшировать immutable model/plugin/skill metadata;
- ограничить retention Worker transcripts;
- уменьшить UI re-render и bundle size.

### 21.2 Critical path

Профилируются:

```text
Decompose -> Validate -> Route -> Acquire -> Execute -> Report -> Release
```

Отдельные метрики:

```text
startup_ms
prompt_compile_ms
task_snapshot_ms
overlap_validate_ms
scheduler_wait_ms
lease_acquire_ms
worker_spawn_ms
first_token_ms
worker_runtime_ms
report_validate_ms
compact_ms
status_render_ms
memory_peak_mb
bundle_bytes
```

- Независимые read-only проверки выполняются параллельно.
- Зависимые изменения остаются последовательными.
- Polling заменяется событиями.
- Один scheduler tick использует один snapshot graph state.
- Overlap использует индекс путей, а не полный pairwise scan.

### 21.3 Rust/native hot paths

Полная перепись инструментов на Rust заранее не выполняется. Кандидаты — file index/search, diff, path-overlap и тяжёлая сериализация — сначала профилируются.

Перенос в Rust/native допускается, если benchmark подтверждает заметный выигрыш, API остаётся стабильным, а стоимость сборки и кроссплатформенной поддержки оправдана. Для каждого native-модуля обязателен TypeScript fallback и одинаковые golden tests.

### 21.4 Количественные цели оптимизации

Точные абсолютные значения фиксируются после baseline на целевой машине. Минимальные относительные цели для типового многозадачного сценария:

- уменьшить startup p50 минимум на 20%;
- уменьшить prompt/system overhead минимум на 30%;
- уменьшить warm Worker acquire/start p95 минимум на 50%;
- уменьшить peak memory сценария с командой Worker минимум на 20%;
- уменьшить production bundle минимум на 15% после удаления legacy provider-ов;
- сократить повторные task-storage reads на dispatch до одного snapshot + одной транзакции;
- удерживать `/status` terminal render ниже 100 мс для 10 000 локальных metric events;
- не допустить регрессии task throughput более чем на 5% ни на одной поддерживаемой платформе;
- исключить неограниченные очереди, polling loops и рост Worker transcript memory;
- обеспечить нулевое превышение scheduler cost budget в stress-тесте.

Если цель не достигнута, итоговый отчёт обязан показать baseline, результат, причину и решение: продолжить оптимизацию либо отдельно согласовать пересмотр цели.

---

## 22. Build, форматирование и качество

Нужно создать рабочую конфигурацию TypeScript/Bun:

- добавить и проверить `tsconfig.json`;
- привести scripts к единому Bun workflow;
- настроить Biome format/lint/import sorting;
- добавить module-boundary checks;
- добавить dependency/branding scans;
- исключить `node_modules`, `dist`, coverage, local state, secrets и reports из Git;
- сделать команды `format:check`, `lint`, `typecheck`, `test`, `test:race`, `coverage`, `build`, `smoke` реально исполняемыми.

Lockfile policy выбирается один: Bun lockfile является каноническим; лишний npm lock удаляется после воспроизводимой установки и проверки.

---

## 23. Тестовая стратегия

### 23.1 Unit tests

- Vexzy schemas/auth/stream/errors/usage;
- model capability registry;
- fixed Luna resolution во всех runtime-путях;
- effort normalization и сохранение `max`;
- PromptCompiler section order/cache boundary;
- PolicySnapshot propagation;
- scheduler weights, budget, fairness и release;
- task graph transitions/dependencies/cycles;
- atomic claim;
- overlap/path normalization;
- WorkerReport schema/evidence;
- `/copy` selection;
- `/copycon` sanitation/output;
- compact 85/95/watchdog/rollback;
- statistics aggregation;
- Sakura rendering.

### 23.2 Race tests

- много параллельных claim одной задачи — ровно один победитель;
- concurrent graph updates;
- duplicate idempotency key;
- lease acquire/release/expiry;
- mailbox delivery;
- policy epoch changes;
- compact snapshot replacement;
- overlap validation under concurrent scheduling.

### 23.3 Integration lifecycle

```text
Decompose
-> Assign effort
-> Validate dependencies
-> Detect overlap
-> Route
-> Acquire weighted lease
-> Execute gpt-5.6-luna Worker
-> Validate WorkerReport
-> Release lease
-> Update graph
-> Integrate
-> Verify
```

Сценарий включает независимые, конфликтующие, зависимые, failed/retried задачи, policy change, compact, resume, `/copycon` и statistics.

### 23.4 Prompt/golden tests

Snapshot-покрытие для Leader, ordinary Worker, fork, resume, background, in-process, tmux, iTerm, compact и helper paths.

Проверяется:

- Worker всегда Luna;
- effort только `low|medium|high|max`;
- default `medium`;
- task ID/effort не меняют static cache prefix;
- policy snapshot присутствует;
- raw transcript не попадает Leader;
- старые brand/provider fragments отсутствуют.

### 23.5 Покрытие

- не менее 85% на изменённых модулях;
- для scheduler, task graph, PromptCompiler и policy желательная цель 90%+;
- coverage report сохраняется локально и отображается в `/status` development section.

---

## 24. CI и локальные quality gates

Единый pipeline:

```text
install
format check
lint
typecheck
unit tests
race tests
integration tests
prompt snapshots
coverage
bundle build
smoke launch
branding scan
dependency scan
```

Pipeline запускается локально перед merge. Также готовится GitHub Actions workflow для будущего remote, но он не публикуется и remote не подключается автоматически.

Task/Teammate completion hooks не разрешают Worker завершить задачу без schema-valid WorkerReport и заявленных проверок. Красный pipeline блокирует merge.

---

## 25. Пошаговый порядок реализации

### Фаза A — подготовка

1. Утвердить `PLAN.md`.
2. Получить Vexzy API contract и список моделей.
3. Выполнить полный inventory без Git-history.
4. Зафиксировать baseline и rollback snapshot.
5. Создать новый локальный Git и документированный импортный baseline-коммит после запуска всех доступных проверок.
6. Первым обычным коммитом починить typecheck/build/test baseline и запретить дальнейшие bootstrap-исключения.

### Фаза B — идентичность и структура

7. Переименовать проект в MindCode `0.1.0`.
8. Ввести новые config/env/binary namespaces.
9. Создать целевые domain boundaries.
10. Сортировать и переносить исходники домен за доменом.
11. Удалять legacy только после переноса consumers и теста.

### Фаза C — Vexzy и prompts

12. Реализовать Vexzy schemas/client/auth/stream/usage.
13. Добавить capability registry.
14. Исправить Leader model/thinking/effort path.
15. Ввести единый PromptCompiler.
16. Ввести Leader/Worker role contracts.
17. Ввести PolicySnapshot и полное `/jailbreak` propagation.

### Фаза D — агенты и task runtime

18. Зафиксировать Worker model на `gpt-5.6-luna` во всех runtime-путях.
19. Ввести обязательный per-task effort.
20. Реализовать SQLite task graph и отдельный mailbox.
21. Реализовать atomic claim/dependencies/recovery.
22. Реализовать overlap/dedup/path index.
23. Реализовать weighted scheduler и adaptive budget.
24. Реализовать warm Luna pool и isolation backends.
25. Реализовать WorkerReport и transcript separation.

### Фаза E — context и команды

26. Исправить `/model` и `/effort`.
27. Доработать `/agents` и `/tasks`.
28. Зарегистрировать `/copy`.
29. Добавить Luna-based `/copycon`.
30. Переписать compact accounting/watchdog/atomic rollback.
31. Добавить 85% warning и 95% trigger.
32. Исправить resume/reconciliation.
33. Доработать `/mcp`, `/skills` и `/jailbreak` status.

### Фаза F — плагины, UI и статистика

34. Удалить лишние plugins, оставить IDA/Superpowers и добавить math-mcp.
35. Создать единый local metrics store.
36. Доработать `/status` и `/stats`.
37. Создать self-contained HTML dashboard.
38. Создать Sakura mascot/theme и responsive terminal variants.
39. Обновить agent/task/compact UI.

### Фаза G — оптимизация и завершение

40. Снять повторный performance baseline.
41. Удалить dead code/dependencies/дубли.
42. Оптимизировать hot paths, memory, startup, bundle и redraw.
43. Оценить Rust/native кандидаты по benchmark.
44. Добавить unit/race/integration/golden tests.
45. Довести coverage изменённых модулей до 85%+.
46. Настроить локальные gates и CI workflow.
47. Выполнить branding/provider scan.
48. Выполнить полный smoke и lifecycle test.
49. Проверить дерево атомарных локальных коммитов.
50. Подготовить финальный отчёт.

---

## 26. Критерии готовности

MindCode `0.1.0` считается готовым, когда одновременно выполнено следующее:

- используется только Vexzy API;
- старые provider/runtime пути удалены;
- пакет, бинарник, config и env используют MindCode namespace;
- Worker model во всех путях равен `gpt-5.6-luna`;
- UI никогда не показывает Sonnet для Luna Worker;
- Leader `max` effort реально остаётся `max` в API-запросе;
- каждая задача имеет явный effort, default — `medium`;
- count cap `20` заменён cost-weighted adaptive budget;
- task graph персистентен и транзакционен;
- race test подтверждает ровно один успешный claim;
- зависимости и overlaps блокируют конфликтующий запуск;
- mailbox отделён от task graph;
- Worker возвращает schema-valid WorkerReport;
- raw Worker transcript не попадает в Leader context;
- `/copy` работает context-aware;
- `/copycon` генерируется Luna и создаёт переносимый prompt;
- compact предупреждает на 85%, запускается на 95% и не зависает на 97%;
- compact/resume сохраняют graph, reports, decisions и policy;
- `/jailbreak` применяется ко всем Worker runtime-путям;
- `/status` показывает подробную статистику и создаёт локальный HTML;
- остаются только IDA, Superpowers и math-mcp;
- Sakura полностью заменяет старый mascot;
- исходники организованы по доменам и автоматически форматируются;
- dead code и неиспользуемые зависимости удалены;
- локальный Git не содержит старой истории и не имеет remote по умолчанию;
- все логические изменения оформлены атомарными проверенными коммитами;
- разработка выполнялась с Luna-субагентами;
- lint, typecheck, tests, race tests, build и smoke проходят;
- покрытие изменённых модулей не ниже 85%;
- `PLAN.md` соответствует фактической реализации.

---

## 27. Данные и решения, необходимые перед production-реализацией

От пользователя требуется Vexzy contract:

1. Base URL.
2. Auth header/format.
3. Models endpoint.
4. Completion endpoint.
5. Streaming protocol.
6. Tool-call schema.
7. Structured-output schema.
8. Usage schema.
9. Error/retry schema.
10. Rate-limit fields.
11. Список моделей.
12. Thinking/effort capabilities.
13. Context/output limits.
14. Cancellation semantics.

Без этих данных не фиксируются сетевые предположения. Остальные provider-neutral фазы можно проектировать и тестировать на mock transport.

---

## 28. Финальный отчёт после реализации

Финальный отчёт должен содержать:

1. Итоговое дерево исходников.
2. Список перемещённых, удалённых и объединённых модулей.
3. Список удалённых зависимостей и legacy runtime-путей.
4. Дерево локальных коммитов.
5. Описание Vexzy contract/adapter.
6. Схему PromptCompiler.
7. Схему Leader → Worker lifecycle.
8. Схему scheduler/task graph/leases.
9. Описание `/copy`, `/copycon`, `/compact`, `/status` и `/jailbreak`.
10. Список MCP/plugins/skills.
11. Скриншоты/артефакты Sakura UI и HTML dashboard.
12. Результаты lint/typecheck/build/smoke.
13. Результаты unit/integration/race/golden tests.
14. Coverage report.
15. Performance baseline до/после.
16. Метрики startup, bundle, memory, spawn, compact и tokens.
17. Список оставшихся TODO и рисков.
18. Список решений, которые потребовали уточнения Vexzy.
