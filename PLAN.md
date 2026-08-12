# MindCode 0.1.3 — approved migration contract

Дата контракта: `2026-08-12`
Проект: `MindCode`
Целевая платформа: **Linux x86_64**
Провайдер релиза: **только VEXZY**

Этот документ заменяет старый план `0.1.2` и является implementation
contract для миграции.  В локальной истории есть checkpoint `0.1.2`; он ещё не
помечен тегом `v0.1.2`.  Миграция `0.1.3` не должна переписывать этот
checkpoint и не требует remote, fetch или push.

## 1. Release handoff

| Поле | Контракт |
|---|---|
| Предыдущий checkpoint | `0.1.2`, checkpointed but untagged |
| Целевая версия | `0.1.3`, approved migration |
| Целевая архитектура | Rust-first single executable with in-process daemon and Rust TUI |
| Поддерживаемая ОС/архитектура | Linux x86_64 |
| Model API | VEXZY-only |
| VEXZY base URL | `https://api.echogate.one` |
| Credential | только `VEXZY_API_KEY`, только из окружения |
| Worker model | глобально выбираемый eligible VEXZY model |
| Worker effort | `none`, `low`, `medium`, `high`, `xhigh`, `max`; optional global lock |
| JavaScript runtime | Bun, затем Node; только on-demand для JS plugins/hooks |
| Удалённые команды | `/config`, `/submodel` |
| Будущая версия profiles | `0.1.5`, вне scope этого релиза |
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

## 3. VEXZY-only model policy

- Все model requests идут на VEXZY OpenAI-compatible API через
  `https://api.echogate.one/v1` (`/models`, `/chat/completions`, `/responses`) и
  Messages-compatible `https://api.echogate.one/v1/messages`.
- Авторизация — `Authorization: Bearer $VEXZY_API_KEY`.  Ключ не попадает в
  settings, compatibility fixture, отчёты, логи, snapshots или CLI output.
- Каталог `/v1/models` загружается динамически.  Exact provider IDs и metadata
  не заменяются alias/remap.
- **Global Worker model:** пользователь выбирает один model ID для Worker из
  текущего eligible VEXZY catalog.  Eligibility требует `available=true` и
  provider-declared Worker capabilities; stale, missing или unsupported IDs
  fail closed.  Все Worker ingress (foreground, resume, background, in-process
  и pane) используют один global selection.
- **Optional global Worker-effort lock:** lock может быть unset либо одним из
  `none|low|medium|high|xhigh|max`.  При установленном lock каждый Worker
  получает это effort; без lock сохраняется обычный per-task effort и
  отсутствующее значение нормализуется в `medium`.
- Leader model/effort и Worker model/effort — разные policy boundaries.  Leader
  не может неявно перезаписать global Worker selection или lock.

### 3.1 Public CLI surface

`/model` остаётся единственной модельной командой и должна уметь показать
eligible catalog и установить global Worker model без `/submodel`.  Worker
selection также доступен из non-interactive CLI options documented by the
compatibility fixture.  `/effort` управляет Leader effort; отдельная опция
для optional global Worker-effort lock должна быть явно указана в fixture и
не должна создавать `/config` alias.

Удалённые поверхности:

- `/config` — удалён полностью, включая hidden aliases и help text;
- `/submodel` — удалён полностью; Worker selection выполняется через public
  model surface/CLI option.

Unknown removed commands должны возвращать стабильную bounded error и не
изменять state.

## 4. Public CLI/docs/tests compatibility fixture

До release acceptance поддерживается один machine-readable, secret-free
fixture (его canonical vectors публикуются в README и тестах).  Минимальная
форма:

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

Fixture vectors MUST cover: `--help`, model listing/selection, each valid
Worker effort, lock set/unset, VEXZY auth redaction, removed `/config` and
`/submodel`, missing-runtime plugin error, and deterministic exit status.  CLI
help, README, roadmap and tests must agree with these vectors; no credential or
provider response body may be embedded.

## 5. Migration work packages

1. **Rust-first packaging:** produce and smoke-test one Linux x64 executable
   containing in-process daemon and TUI; remove mandatory Bun/Node core paths.
2. **VEXZY boundary:** retain only VEXZY endpoint/auth/catalog protocol and
   redact `VEXZY_API_KEY` from every persisted or displayed artifact.
3. **Worker policy:** implement global eligible-model selection and optional
   global effort lock across every Worker ingress; reject stale/ineligible IDs.
4. **Command cleanup:** remove `/config` and `/submodel`; update help,
   completion, errors, docs and tests.
5. **Compatibility fixture:** publish the canonical vectors above and run CLI,
   docs and test compatibility checks from the same fixture.
6. **Release bookkeeping:** record `0.1.2` as checkpointed/untagged, then make a
   local `0.1.3` commit.  Tagging is a separate explicit decision; never push.

## 6. Explicit non-goals for 0.1.3

- No provider profiles, provider picker, OAuth, marketplace or alternate model
  API.
- No Bun/Node dependency for core executable, daemon, TUI, tests or startup.
- No external daemon/sidecar requirement.
- No `/config` or `/submodel` compatibility alias.
- No credential files, checked-in API keys, remote Git, fetch or push.

## 7. Future 0.1.5 provider profiles (planning only)

`0.1.5` may add named provider profiles behind a separate approval.  A profile
will contain a name and endpoint metadata only; credentials are read from
named environment variables at process start and are never persisted.  Profile
HTTP is allowed **only to `localhost`** (loopback, with an explicit port); no
public or remote provider URL is permitted.  The `0.1.5` design must preserve
VEXZY as the complete `0.1.3` provider contract and must not reintroduce
`/config` or `/submodel`.

## 8. Acceptance gates

- `git diff --check` is clean and the diff contains only the owned contract
  documents.
- Linux x64 single executable starts, renders the Rust TUI, and performs daemon
  work without Bun or Node installed.
- VEXZY catalog/model requests succeed with `VEXZY_API_KEY`; logs and fixtures
  are secret-free.
- Global Worker model selection is honored by every backend; ineligible IDs
  fail closed; optional effort lock is global and observable.
- `/config` and `/submodel` return the documented unknown-command error.
- Compatibility fixture passes for CLI, docs and tests.
- Focused and full repository test/lint/typecheck/coverage/build/smoke gates
  pass when code changes are introduced.

## 9. Change control

Any change to platform, provider, Worker eligibility, effort-lock semantics,
removed commands, JS runtime order, or the `0.1.5` localhost boundary requires
an explicit contract update here before implementation.  Keep commits local,
small and reviewable.
