# MindCode 0.1.3 — approved migration contract

Дата контракта: `2026-08-12`
Проект: `MindCode`
Целевая платформа: **Linux x86_64**
Провайдеры: **multi-provider** (amendment `2026-08-13`); VEXZY — built-in profile

Этот документ заменяет старый план `0.1.2` и является implementation
contract для миграции.  В локальной истории есть checkpoint `0.1.2`; он ещё не
помечен тегом `v0.1.2`.  Миграция `0.1.3` не должна переписывать этот
checkpoint и не требует remote, fetch или push.

Amendment `2026-08-13`: владелец утвердил multi-provider contract update
(docs-only); что и почему изменено — §9 Change control.

## 1. Release handoff

| Поле | Контракт |
|---|---|
| Предыдущий checkpoint | `0.1.2`, checkpointed but untagged |
| Целевая версия | `0.1.3`, approved migration (multi-provider amendment `2026-08-13`) |
| Целевая архитектура | Rust-first single executable with in-process daemon and Rust TUI |
| Поддерживаемая ОС/архитектура | Linux x86_64 |
| Model API | Multi-provider: `openai-compatible` (`/models`, `/chat/completions`) и `anthropic-compatible` (`/v1/messages`) |
| Built-in provider | VEXZY: `openai-compatible`, base `https://api.echogate.one/v1`, env credential `VEXZY_API_KEY`; редактируемый/удаляемый |
| Custom providers | без пресетов: пользователь вводит `name`, `base_url`, `protocol`, ключ |
| Credential | env → on-disk secret store `~/.config/mindcode/credentials.json` (0600/0700) → fail-closed |
| Transport | любой `https`; `http` только loopback (иначе warning) |
| Worker model | глобально выбираемый eligible model активного провайдера |
| Worker effort | `none`, `low`, `medium`, `high`, `xhigh`, `max`; optional global lock |
| JavaScript runtime | Bun, затем Node; только on-demand для JS plugins/hooks |
| Команды | `/model`, `/provider`, `/settings`, `/effort` |
| Удалённые команды | `/config`, `/submodel` |
| Будущая версия profiles | встроены в `0.1.3` amendment-ом `2026-08-13`; отдельного `0.1.5` provider gate нет |
| Git | local-only; remote/fetch/push запрещены |

## 2. Runtime shape

### 2.0 Реализованный foundation (не release acceptance)

В commit `c3210d4` уже добавлен первый Rust-native vertical slice:

- workspace binary `mindcode` версии `0.1.3`;
- `--help`, `--version`, `auth status`, `setup-token`, `doctor`,
  `update|upgrade` и in-process entrypoint для `daemon`;
- VEXZY credential shape validation без вывода значения `VEXZY_API_KEY`;
- явная диагностика `native chat runtime is not migrated yet` для обычного
  prompt.

Это **не** означает готовность `0.1.3`: Rust TUI, VEXZY chat transport,
catalog/Worker settings, полный public CLI parity и release packaging ещё не
перенесены. Разделы ниже фиксируют target contract и acceptance gates, а не
заявляют, что эти пункты уже выполнены.

### 2.1 Один Rust executable

`mindcode` — единый Linux x64 ELF-бинарник.  Rust владеет запуском,
конфигурацией, IPC boundaries, daemon lifecycle и терминальным интерфейсом.
Daemon работает in-process: отдельный `mindcoded`, sidecar, supervisor или
обязательный child process не является частью `0.1.3` core contract.  TUI —
Rust-first, без обязательной загрузки JavaScript UI.

Запуск, idle/reconnect и завершение должны работать без установленного Bun или
Node.  Отсутствие JS runtime не является ошибкой базового CLI/TUI.

### 2.2 On-demand JavaScript extensions

JS plugins и hooks — опциональная граница расширений, а не часть core.  При
явном выборе расширения resolver:

1. ищет Bun;
2. если Bun недоступен, ищет Node;
3. запускает найденный runtime только для этого plugin/hook;
4. возвращает bounded error, если оба runtime отсутствуют.

Не допускаются `bun install`, Node child-process startup или скрытый JS
fallback во время обычного запуска, daemon work, TUI или VEXZY request.

## 3. Multi-provider model policy

(amendment `2026-08-13` — заменяет прежнюю VEXZY-only политику)

### 3.0 Providers и protocols

- Два supported protocols: `openai-compatible` (`/models`, `/chat/completions`)
  и `anthropic-compatible` (`/v1/messages`).  Других protocols нет.
- Пресетов провайдеров нет: для каждого custom profile пользователь вводит
  `name`, `base_url`, `protocol` и ключ.
- VEXZY — built-in `openai-compatible` profile: base
  `https://api.echogate.one/v1`, env credential `VEXZY_API_KEY`.  Он
  редактируется и удаляется как любой другой profile.

### 3.1 Credentials

- Авторизация — `Authorization: Bearer <key>`.
- Приоритет: env-переменная → on-disk secret store
  `~/.config/mindcode/credentials.json` (файл 0600, директория 0700) →
  fail-closed.
- Secret store отделён от `settings.json`: settings хранит только metadata
  профилей и allowlist.
- Ключ никогда не попадает в settings, compatibility fixture, отчёты, логи,
  snapshots, Git или CLI/status output.

### 3.2 Transport

- Любой `https` endpoint разрешён, включая публичные удалённые.
- `http` разрешён только на loopback; `http` вне loopback — warning.
- Никаких OAuth, marketplace или provider presets.

### 3.3 Worker eligibility и global selection

- VEXZY: каталог `/v1/models` загружается динамически; eligibility требует
  `available=true` + provider-declared Worker capabilities +
  `supported_reasoning_efforts`.  Exact provider IDs и metadata не заменяются
  alias/remap.
- Custom providers: per-profile allowlist model IDs; пустой allowlist по
  умолчанию → fail-closed.
- **Global Worker model:** пользователь выбирает один model ID для Worker из
  eligible моделей активного провайдера.  Stale, missing или unsupported IDs
  fail closed.  Все Worker ingress (foreground, resume, background, in-process
  и pane) используют один global selection.
- **Optional global Worker-effort lock:** lock может быть unset либо одним из
  `none|low|medium|high|xhigh|max`.  При установленном lock каждый Worker
  получает это effort; без lock сохраняется обычный per-task effort и
  отсутствующее значение нормализуется в `medium`.
- Leader model/effort и Worker model/effort — разные policy boundaries.  Leader
  не может неявно перезаписать global Worker selection или lock.

### 3.4 Public CLI surface

- `/model` — публичная модельная команда: показывает eligible модели
  активного провайдера и устанавливает global Worker model.
- `/provider` — переключение активного провайдера.
- `/settings` — управление провайдерами (add/edit/remove), ключом, allowlist
  и prefs.
- `/effort` — управляет Leader effort.
- Non-interactive CLI options (документированы compatibility fixture):
  `--provider <id>`, `--worker-model <eligible-id>`,
  `--worker-effort-lock <effort|off>`.  Worker lock не создаёт `/config` alias.

Удалённые поверхности:

- `/config` — удалён полностью, включая hidden aliases и help text;
- `/submodel` — удалён полностью; Worker selection выполняется через public
  model surface/CLI option.

Unknown removed commands должны возвращать стабильную bounded error и не
изменять state.

## 4. Public CLI/docs/tests compatibility fixture

До release acceptance поддерживается один machine-readable, secret-free
fixture (его canonical vectors публикуются в README и тестах).  Минимальная
форма — `tests/fixtures/compatibility.json`:

```json
{
  "version": "0.1.3",
  "platform": "linux-x64",
  "providers": {
    "protocols": {
      "openai-compatible": ["/models", "/chat/completions"],
      "anthropic-compatible": ["/v1/messages"]
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
    "model": {"status": "public", "sets_global_worker_model": true},
    "provider": {"status": "public", "switches_active_provider": true},
    "settings": {
      "status": "public",
      "manages": ["provider", "key", "allowlist", "prefs"]
    },
    "effort": {"status": "public", "sets_leader_effort": true},
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

Fixture vectors MUST cover: `--help`, provider listing/switch (`/provider`),
profile management (`/settings` add/edit/remove), model listing/selection,
each valid Worker effort, lock set/unset, credential precedence
(env → store → fail-closed) and redaction, transport rules (any `https`,
loopback-only `http` with a warning outside loopback), VEXZY catalog-driven and
custom allowlist eligibility, removed `/config` and `/submodel`,
missing-runtime plugin error, and deterministic exit status.  CLI help, README,
roadmap and tests must agree with these vectors; no credential or provider
response body may be embedded.

## 5. Migration work packages

1. **Rust-first packaging:** produce and smoke-test one Linux x64 executable
   containing in-process daemon and TUI; remove mandatory Bun/Node core paths.
2. **Provider boundary:** implement two protocols (`openai-compatible`,
   `anthropic-compatible`), the built-in VEXZY profile and custom profiles
   without presets; add the on-disk secret store with
   env → store → fail-closed precedence; redact every credential from
   persisted or displayed artifacts.
3. **Transport:** allow any `https` endpoint; restrict `http` to loopback and
   warn outside it.
4. **Worker policy:** implement global eligible-model selection (VEXZY
   catalog-driven, custom allowlist fail-closed) and the optional global
   effort lock across every Worker ingress; reject stale/ineligible IDs.
5. **Command cleanup:** keep `/model`, `/provider`, `/settings`, `/effort`;
   remove `/config` and `/submodel`; update help, completion, errors, docs and
   tests.
6. **Compatibility fixture:** publish the canonical vectors above and run CLI,
   docs and test compatibility checks from the same fixture.
7. **Release bookkeeping:** record `0.1.2` as checkpointed/untagged, then make a
   local `0.1.3` commit.  Tagging is a separate explicit decision; never push.

## 6. Explicit non-goals for 0.1.3

- No provider presets, provider picker, OAuth, marketplace or protocols beyond
  the two fixed ones.
- No Bun/Node dependency for core executable, daemon, TUI, tests or startup.
- No external daemon/sidecar requirement.
- No `/config` or `/submodel` compatibility alias.
- No credential in settings, fixture, logs, reports, Git или CLI output; the
  only secret storage is the environment and `credentials.json` (0600).
- No remote Git, fetch or push.

## 7. Future 0.1.5 (superseded provider-profile planning)

The planning-only `0.1.5` provider-profile boundary (environment-only
credentials, loopback-only profile HTTP) was superseded on `2026-08-13` by the
approved multi-provider amendment: profiles are part of `0.1.3`, secrets live
in the on-disk secret store, and public remote endpoints are permitted.  Any
future `0.1.5` work must preserve the `0.1.3` provider contract and must not
reintroduce `/config` or `/submodel`.

## 8. Acceptance gates

- `git diff --check` is clean and the diff contains only the owned contract
  documents.
- Linux x64 single executable starts, renders the Rust TUI, and performs daemon
  work without Bun or Node installed.
- Built-in VEXZY and at least one custom https profile complete model requests;
  credential precedence env → store → fail-closed works; logs and fixtures are
  secret-free.
- Any `https` endpoint is accepted; loopback `http` works; non-loopback `http`
  is warned.
- Global Worker model selection is honored by every backend; ineligible IDs
  fail closed (VEXZY catalog-driven, custom allowlist); optional effort lock is
  global and observable.
- `/config` and `/submodel` return the documented unknown-command error;
  `/provider` and `/settings` switch/manage providers.
- Compatibility fixture passes for CLI, docs and tests.
- Focused and full repository test/lint/typecheck/coverage/build/smoke gates
  pass when code changes are introduced.

## 9. Change control

Any change to platform, provider, Worker eligibility, effort-lock semantics,
removed commands, JS runtime order, or the transport boundary requires
an explicit contract update here before implementation.  Keep commits local,
small and reviewable.

### Amendment `2026-08-13` — multi-provider contract update (docs-only)

- **Что изменено:** `0.1.3` переведён с VEXZY-only на multi-provider.  Два
  protocols (`openai-compatible` через `/models` + `/chat/completions`,
  `anthropic-compatible` через `/v1/messages`); пресеты провайдеров не
  добавляются.  VEXZY стал built-in `openai-compatible` profile
  (`https://api.echogate.one/v1`, `VEXZY_API_KEY`), редактируемым/удаляемым.
  Ключи переехали в on-disk secret store `~/.config/mindcode/credentials.json`
  (0600/0700) отдельно от secret-free `settings.json`; приоритет
  env → store → fail-closed.  Transport: любой `https` разрешён, `http` —
  loopback-only (иначе warning); снято прежнее планировочное ограничение
  профилей (`0.1.5`) на loopback-only.  Eligibility: VEXZY catalog-driven
  (как раньше), custom providers — per-profile allowlist (пустой дефолт =
  fail-closed).  Команды: добавлены `/provider` (смена активного провайдера)
  и `/settings` (add/edit/remove провайдеров, ключ, allowlist, prefs);
  CLI-опция `--provider <id>`.
- **Почему:** владелец утвердил multi-provider amendment; контракт обязан
  отражать фактически одобренное направление релиза.
- **Что не изменилось:** `/config` и `/submodel` остаются удалёнными
  (`unknown_command`, без алиасов и hidden routes); JS-runtime порядок
  (Bun → Node, on-demand) и статус `0.1.2` checkpointed/untagged не тронуты;
  Git local-only; секреты не попадают в settings/fixture/логи/отчёты/Git.
- **Затронутые документы:** `AGENTS.md`, `PLAN.md`, `README.md`,
  `CHANGELOG.md`, `VEXZY_ROADMAP.md`, `tests/fixtures/compatibility.json`.
