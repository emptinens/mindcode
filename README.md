# MindCode

MindCode `0.1.3` — Rust-first Linux x64 single executable с multi-provider
contract (amendment `2026-08-13`): **VEXZY** — built-in profile, custom
providers — через два протокола. Версия `0.1.2` checkpointed в локальной
истории, но ещё не tagged.

### Текущее состояние

Репозиторий — Rust workspace; единый бинарник `mindcode` реализует
`auth status`, `model`, `effort`, `provider`, `settings`, `setup-token`,
`doctor`, `update|upgrade`, `daemon` (in-process), `tui` и `chat`. Bare prompt
(`mindcode hello`) и `mindcode chat` стримят completion через активный
провайдер. TypeScript и Bun-пайплайн удалены полностью.

## Архитектура

- **Один executable:** `mindcode` — единый Rust-first Linux x86_64 бинарник.
  Daemon и Rust TUI работают in-process; отдельный `mindcoded` или
  обязательный sidecar не нужен.
- **Без обязательного JavaScript:** core CLI, daemon, TUI и model requests
  не требуют Bun или Node. JS plugins/hooks запускаются только при явном
  выборе: сначала Bun, затем Node; ни один runtime не является скрытым
  fallback для core.
- **Multi-provider (amendment `2026-08-13`):** два протокола —
  `openai-compatible` (`/models`, `/chat/completions`) и `anthropic-compatible`
  (`/v1/models`, `/v1/messages`). Пресетов провайдеров нет: пользователь вводит `name`,
  `base_url`, `protocol` и ключ. VEXZY — built-in `openai-compatible` profile
  (`https://api.echogate.one/v1`, ключ `VEXZY_API_KEY`), редактируемый и
  удаляемый.
- **Credentials:** приоритет env → on-disk secret store
  `~/.config/mindcode/credentials.json` (файл 0600, директория 0700) →
  fail-closed. Store отделён от secret-free `settings.json` (метаданные +
  allowlist). Ключ передаётся как Bearer header и никогда не попадает в
  settings, fixture, отчёты, логи, Git или вывод CLI.
- **Transport:** любой `https` endpoint разрешён, включая публичные удалённые;
  `http` — только loopback, вне loopback — warning.

## Worker policy

- **Eligibility:** VEXZY — catalog-driven (`/v1/models`: `available=true` +
  Worker capabilities + `supported_reasoning_efforts`); custom providers —
  per-profile allowlist model IDs, пустой allowlist = fail-closed.
- Пользователь выбирает **одну глобальную Worker-модель** из eligible моделей
  активного провайдера; stale/ineligible ID отклоняется.
- Global selection применяется одинаково к foreground, resume, background,
  in-process и pane Worker paths.  Leader model остаётся отдельной настройкой.
- Global Worker-effort lock — **опционален**.  Lock принимает только
  `none|low|medium|high|xhigh|max` и, если установлен, применяется ко всем
  Workers.  Без lock действует per-task effort; отсутствующее значение —
  `medium`.
- `/model` — worker model surface; `/provider` переключает активный провайдер;
  `/settings` управляет провайдерами (add/edit/remove), ключом, allowlist и
  prefs; `/effort` управляет Leader effort. Non-interactive options (закреплены
  fixture): `--provider <id>`, `--worker-model <eligible-id>`,
  `--worker-effort-lock <effort|off>`.

## Команды и совместимость

Публичный compatibility fixture для `0.1.3` должен быть одинаковым в CLI,
документации и tests.  Его минимальная форма — `tests/fixtures/compatibility.json`:

```json
{
  "version": "0.1.3",
  "platform": "linux-x64",
  "providers": {
    "protocols": {
      "openai-compatible": ["/models", "/chat/completions"],
      "anthropic-compatible": ["/v1/models", "/v1/messages"]
    },
    "presets": false,
    "builtin": {
      "vexzy": {
        "protocol": "openai-compatible",
        "base_url": "https://api.echogate.one/v1",
        "credential_env": "VEXZY_API_KEY",
        "editable": true,
        "removable": true
      }
    },
    "custom": {
      "fields": ["name", "base_url", "protocol", "key"],
      "eligibility": "per-profile allowlist model IDs",
      "allowlist_default": "empty",
      "fail_closed": true
    },
    "active_switch": {
      "command": "/provider",
      "cli_option": "--provider <id>"
    },
    "management": {
      "command": "/settings",
      "capabilities": ["add", "edit", "remove"],
      "edits": ["provider", "key", "allowlist", "prefs"]
    }
  },
  "credentials": {
    "storage": "on-disk secret store",
    "path": "~/.config/mindcode/credentials.json",
    "file_mode": "0600",
    "directory_mode": "0700",
    "separate_from_settings": true,
    "precedence": ["env", "store", "fail-closed"],
    "never_in": ["settings", "fixture", "logs", "reports", "git", "status_output"]
  },
  "transport": {
    "https": "allowed_any_endpoint",
    "http": "loopback_only",
    "non_loopback_http": "warning",
    "public_remote_endpoints": true
  },
  "eligibility": {
    "vexzy": "catalog_driven",
    "catalog_fields": ["available", "worker_capabilities", "supported_reasoning_efforts"],
    "custom": "per_profile_allowlist",
    "custom_default": "empty",
    "fail_closed": true
  },
  "commands": {
    "auth": {
      "status": "public",
      "subcommands": ["status"],
      "credential_status": ["configured", "not configured"],
      "resolution": ["env", "store", "fail-closed"],
      "exit_on_missing_credential": 1
    },
    "model": {
      "status": "public",
      "sets_global_worker_model": true,
      "subcommands": ["eligible"]
    },
    "provider": {
      "status": "public",
      "switches_active_provider": true,
      "subcommands": ["list", "use", "add", "remove", "edit"],
      "key_value_never_accepted": true
    },
    "settings": {
      "status": "public",
      "manages": ["provider", "key", "allowlist", "prefs"],
      "subcommands": ["show", "key", "allowlist", "model", "effort"],
      "key_command_output": "configured"
    },
    "effort": {
      "status": "public",
      "sets_leader_effort": true,
      "subcommands": ["worker"]
    },
    "config": {"status": "removed", "error": "unknown_command"},
    "submodel": {"status": "removed", "error": "unknown_command"}
  },
  "cli_options": {
    "provider": "--provider <id>",
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
изменяют состояние.  Fixture также покрывает `--help`, providers/protocols,
model listing и selection, lock set/unset, credential precedence и redaction,
transport rules, eligibility, missing-runtime plugin error и exit status.

## Установка и запуск

Репозиторий собирается обычным Rust toolchain; Bun и Node не требуются ни
для сборки, ни для запуска core. Release-бинарник без JS-runtime собирается
и smoke-тестируется так:

```bash
./scripts/build-native-release.sh   # dist/mindcode-linux-x64
./scripts/smoke-native-release.sh
```

Для разработки:

```bash
cargo build -p mindcode-native --locked
./target/debug/mindcode --help
./target/debug/mindcode tui          # in-process daemon + Rust TUI
```

Для built-in VEXZY profile ключ читается из env (`VEXZY_API_KEY`); для custom
providers ключ хранится в on-disk secret store
`~/.config/mindcode/credentials.json` (0600/0700) — приоритет env → store →
fail-closed.

Не помещайте ключ в settings, README, tests, fixtures или диагностические
артефакты.  Сборочные и runtime-команды, параметры выбора провайдера,
Worker-модели и Worker-effort lock должны совпадать с опубликованным
compatibility fixture.

## Локальная разработка и релизы

Репозиторий local-only: remote не добавляется, `fetch` и `push` не выполняются.
Изменения коммитятся атомарно; generated binaries, caches и credentials не
попадают в Git.  `PLAN.md` — implementation contract, а
`VEXZY_ROADMAP.md` — последовательность migration milestones.

### Будущее `0.1.5` (superseded planning)

Планировочная граница `0.1.5` (profiles только в `0.1.5`, credentials
env-only, profile HTTP только на loopback) была заменена amendment-ом
`2026-08-13`: профили и публичные remote endpoints — часть `0.1.3`.  Любая
будущая работа `0.1.5` должна сохранять provider contract `0.1.3` и не
возвращать `/config` или `/submodel`.
