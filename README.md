# MindCode

MindCode `0.1.3` — approved Rust-first Linux x64 migration для работы через
**VEXZY**. Версия `0.1.2` уже checkpointed в локальной истории, но ещё не
tagged; этот документ описывает target contract, а не готовый релиз.

### Текущий foundation

В репозитории уже есть начальный Rust binary `mindcode`: `--help`, `--version`,
`auth status`, `setup-token`, `doctor`, `update|upgrade` и in-process entrypoint
`daemon`. Он валидирует только env-only `VEXZY_API_KEY` и намеренно сообщает
`native chat runtime is not migrated yet` для обычного prompt. Полный VEXZY
chat, Rust TUI, Worker settings и public CLI parity пока находятся в migration
work packages из `PLAN.md`.

## Архитектура

- **Цель — один executable:** финальный `mindcode` будет единым Rust-first
  Linux x86_64 бинарником. Daemon и Rust TUI будут работать in-process;
  отдельный `mindcoded` или обязательный sidecar не нужен. Текущий foundation
  уже запускает daemon in-process, но Rust TUI ещё не перенесён.
- **Без обязательного JavaScript (цель):** финальные core CLI, daemon, TUI и
  обычный VEXZY request не будут требовать Bun или Node. JS plugins/hooks будут
  запускаться только при явном выборе: сначала Bun, затем Node. Ни один runtime
  не будет скрытым fallback для core.
- **VEXZY-only:** model API — `https://api.echogate.one/v1` (`/models`,
  `/chat/completions`, `/responses`) и Messages endpoint
  `https://api.echogate.one/v1/messages`.
- **Авторизация:** единственный credential — `VEXZY_API_KEY` из окружения.
  Он передаётся как Bearer header и не записывается в settings, fixture,
  отчёты, логи или вывод CLI.

## Worker policy

- `/v1/models` — динамический источник eligible VEXZY models.  Пользователь
  выбирает **одну глобальную Worker-модель** из доступных и Worker-capable IDs;
  stale/ineligible ID отклоняется.
- Global selection применяется одинаково к foreground, resume, background,
  in-process и pane Worker paths.  Leader model остаётся отдельной настройкой.
- Global Worker-effort lock — **опционален**.  Lock принимает только
  `none|low|medium|high|xhigh|max` и, если установлен, применяется ко всем
  Workers.  Без lock действует per-task effort; отсутствующее значение —
  `medium`.
- `/model` — единственная модельная команда: показывает каталог и управляет
  global Worker selection (точные non-interactive options закреплены fixture).
  `/effort` управляет Leader effort; Worker lock задаётся отдельной публичной
  CLI option, указанной в fixture.

## Команды и совместимость

Публичный compatibility fixture для `0.1.3` должен быть одинаковым в CLI,
документации и tests.  Его минимальная форма:

```json
{
  "version": "0.1.3",
  "platform": "linux-x64",
  "provider": "vexzy",
  "commands": {
    "model": {"status": "public", "sets_global_worker_model": true},
    "effort": {"status": "public", "sets_leader_effort": true},
    "config": {"status": "removed", "error": "unknown_command"},
    "submodel": {"status": "removed", "error": "unknown_command"}
  },
  "cli_options": {
    "worker_model": "--worker-model <eligible-id>",
    "worker_effort_lock": "--worker-effort-lock <effort|off>"
  },
  "worker": {
    "selection": "global",
    "eligible_catalog_only": true,
    "effort_lock": "optional-global",
    "allowed_efforts": ["none", "low", "medium", "high", "xhigh", "max"]
  },
  "js_runtime": {"order": ["bun", "node"], "mode": "on-demand", "core_required": false}
}
```

Удалённые команды `/config` и `/submodel` не имеют alias или скрытого
compatibility route.  Они возвращают стабильную `unknown_command` ошибку и не
изменяют состояние.  Fixture также покрывает `--help`, model listing и
selection, lock set/unset, redaction `VEXZY_API_KEY`, missing-runtime plugin
error и exit status.

## Установка и запуск

Текущий Rust foundation собирается обычным Rust toolchain; Bun и Node для него
не требуются. Финальный `0.1.3` core также не будет требовать Bun/Node; они
останутся нужны только выбранным JS plugins/hooks.

Перед запуском:

```bash
export VEXZY_API_KEY="forge-..."
cargo build -p mindcode-native --locked
./target/debug/mindcode --help
```

Не помещайте ключ в settings, README, tests, fixtures или диагностические
артефакты.  Сборочные и runtime-команды, параметры выбора Worker-модели и
Worker-effort lock должны совпадать с опубликованным compatibility fixture.

## Локальная разработка и релизы

Репозиторий local-only: remote не добавляется, `fetch` и `push` не выполняются.
Изменения коммитятся атомарно; generated binaries, caches и credentials не
попадают в Git.  `PLAN.md` — implementation contract, а
`VEXZY_ROADMAP.md` — последовательность migration milestones.

### Будущее `0.1.5`

Named provider profiles возможны только после отдельного approval.  Их
credentials будут env-only и никогда не попадут в settings или logs; HTTP для
profile разрешён только на `localhost` (loopback и явный port).  Это не меняет
VEXZY-only contract `0.1.3` и не добавляет provider profile сейчас.
