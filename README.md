# MindCode

MindCode `0.1.0` — локальный CLI/TUI для разработки через VEXZY API.

## Архитектура

- **VEXZY-only transport:** OpenAI-compatible API на `https://api.echogate.one/v1` для `/chat/completions`, `/responses` и `/models`; совместимый Messages endpoint — `https://api.echogate.one/v1/messages` через base URL `https://api.echogate.one`.
- **Авторизация:** единственный credential — `VEXZY_API_KEY` формата `forge-…`. Ключ передаётся как `Authorization: Bearer ...`, не записывается в настройки, отчёты и логи и не выводится программой.
- **Динамический каталог:** `/v1/models` является источником актуального реестра из 33 моделей и их capability metadata. Новые модели подхватываются без изменения MindCode.
- **Leader:** модель, thinking mode и reasoning effort выбираются пользователем из доступного VEXZY-реестра. Поддерживаемые усилия GPT-5.6: `none`, `low`, `medium`, `high`, `xhigh`, `max`.
- **Workers:** все Worker-пути используют только `gpt-5.6-luna`. Контекст Luna — `1 050 000` токенов, максимальный ответ — `128 000`; UI может показывать `1.1M`. Effort назначается Leader для каждой задачи отдельно; fallback — `medium`.
- **Планирование:** weighted cost-budget lease с весами `none=1`, `low=1`, `medium=2`, `high=4`, `xhigh=6`, `max=8`. Бюджет задаётся `MINDCODE_AGENT_COST_BUDGET`, значение по умолчанию — `32`.
- **Task graph:** персистентный SQLite-граф с atomic claim, зависимостями, `blocked_by`, overlap-check и worktree isolation для конфликтующих файлов.
- **Worker reports:** только структурированный JSON: `task_id`, `status`, `changed_files`, `evidence`, `tokens_used`, `effort_used`. Полный transcript Worker в контекст Leader не передаётся.
- **Контекст:** soft-warning на `85%`, автоматический `/compact` на `95%`; compact выполняется атомарно с watchdog.

## Команды

- `/model` — выбрать Leader-модель и посмотреть capability metadata.
- `/effort` — изменить reasoning effort Leader; effort Worker назначается по задачам.
- `/agents`, `/tasks` — состояние Worker-пула и task graph.
- `/copy` — скопировать последнее сообщение агента.
- `/copycon` — создать компактный prompt-контекст для продолжения сессии в другом запуске.
- `/compact` — атомарно сжать контекст.
- `/status` — показать состояние сессии; `/status html` — сгенерировать HTML-отчёт со статистикой.
- `/jailbreak` — изменить активную policy-конфигурацию сессии и синхронизировать её с Worker-путями.
- `/mcp`, `/skills` — управление доступными интеграциями.

Разрешённый plugin allowlist: `ida`, `superpowers`, `math-mcp`.

## Установка и запуск

Требуется Bun `>=1.1` и Node `>=22`.

```bash
bun install
bun run build
bun run test
```

Для запуска из исходников:

```bash
bun src/entrypoints/cli.tsx
```

Собранные бинарники находятся в `dist/`. Целевой набор можно ограничить переменной `MINDCODE_BUILD_TARGETS`, например:

```bash
MINDCODE_BUILD_TARGETS=bun-darwin-arm64 bun run build
```

Перед запуском:

```bash
export VEXZY_API_KEY="forge-..."
```

Ключ не вставляется в `settings.json`, README, fixtures или диагностические артефакты.

## Локальная разработка

Исходный код ведётся в локальном Git-репозитории без remote и без автоматической отправки изменений. Коммиты выполняются локально атомарными блоками. Временные сборочные артефакты, локальные настройки и секреты не добавляются в Git.

Основные файлы проектного контракта и порядка работ: `PLAN.md` и `VEXZY_ROADMAP.md`.
