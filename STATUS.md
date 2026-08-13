# MindCode 0.1.3 — Project Status

**Дата статуса:** `2026-08-13`
**Контракт:** `PLAN.md` — approved migration `0.1.3` (multi-provider amendment `2026-08-13`)
**Платформа:** Linux x86_64

## 1. Executive summary

Миграция `0.1.3` доведена до конца: Rust-first single executable с in-process
daemon и Rust TUI, multi-provider профили, live chat через активный провайдер,
setup screen в TUI и полный purge TypeScript/Bun-пайплайна. Остаётся только
release bookkeeping (локальный коммит; tagging — отдельное решение).

**Закрыто:**
- Multi-provider контракт (amendment `2026-08-13`): два протокола
  (`openai-compatible`, `anthropic-compatible`), built-in VEXZY (first-run
  seeding, editable/removable), custom-профили без пресетов, on-disk secret
  store (env → store → fail-closed), allowlist-eligibility, `/provider` +
  `/settings` + `--provider`.
- HTTP transport (`mindcode-transport`, reqwest+rustls, без OpenSSL): оба
  протокола, streaming `/chat/completions`, антропик-каталог `/v1/models`.
- Command cleanup: `/config`/`/submodel` → `unknown_command` (exit 1),
  retire `/responses`.
- Live chat: bare prompt (`mindcode hello`) и `mindcode chat` стримят
  completion через активный провайдер; run-scoped `--worker-model` и
  `--worker-effort-lock`.
- Rust TUI свернут в workspace; UI protocol v2 control server портирован в
  Rust (`mindcode-tui-server`); `mindcode tui` запускает renderer + control
  server in-process без Bun/Node.
- Setup screen в TUI: overlay `Providers` (Ctrl+P) — список, переключение
  активного, удаление и форма добавления профиля; actions идут через control
  server в `mindcode-settings` с secret-free снапшотом провайдеров.
- Packaging: `scripts/build-native-release.sh` (release-бинарник без Bun/Node)
  + `scripts/smoke-native-release.sh`; `mindcode.sh` — POSIX-sh лаунчер
  нативного бинаря.
- Purge TypeScript: удалены `src/` (511K строк), `package.json`, `bun.lock`,
  Bun/Node-скрипты и CI; CI переписан на Rust-only гейты.
- Canonical compatibility fixture + перегенерированные `tests/native-parity/`.

**Осталось:**
- Release bookkeeping: локальный `0.1.3` commit (tagging — отдельное явное
  решение; никогда не push).

## 2. Repository / Git state

- Ветка `main`, **remote нет**, push запрещён контрактом.
- `0.1.2` — checkpointed, untagged; `0.1.3` — approved migration, реализована.
- Ключевые коммиты: `6e96421` (docs amendment) → `4c6acc8` (profiles
  end-to-end) → `76ca073` (tui fold + control server) → `d7c30e9` (bare
  prompt → live chat) → `b6b5b37` (setup screen) → `ecb8d89` (purge TS/Bun).

## 3. Cargo workspace

| Крейт | Роль |
|---|---|
| `mindcode-native` (bin `mindcode`) | CLI: auth/model/effort/provider/settings/setup-token/doctor/update/daemon/tui/chat |
| `mindcode-provider` | ProviderConfig, Protocol, SecretStore (0600/0700), SecretKey (без Debug/Display/Serialize) |
| `mindcode-settings` | secret-free `settings.json`: профили, active-provider, allowlist, worker model/effort |
| `mindcode-transport` | reqwest+rustls: `/models`, `/chat/completions`, `/v1/models`, `/v1/messages` |
| `mindcode-tui` | Ratatui renderer (UI protocol v2 client), в workspace |
| `mindcode-tui-server` | UI protocol v2 control server (socket, handshake, backpressure, input routing, projection) |
| `mindcode-protocol` | base protocol v1 + UI protocol v2 wire-типы/msgpack framing |
| `mindcode-state` | SQLite tasks/sessions |
| `mindcode-vexzy` | VEXZY catalog parsing, Worker-effort, eligibility |
| `mindcoded` | in-process daemon (SessionIndex, MCP stdio, RPC) |
| `mindcode-core-tools` | bounded process/git helpers |

Верификация (проверено): `scripts/check-rust.sh` (fmt + clippy `-D warnings` +
`cargo test --workspace --all-targets --locked`) ✅, release build + smoke ✅.

## 4. Acceptance gates (PLAN §8)

| Gate | Статус |
|---|---|
| `git diff --check` clean, только owned files | ✅ |
| Linux x64 single executable, TUI + daemon без Bun/Node | ✅ in-process daemon + TUI + release build/smoke без JS runtime |
| VEXZY + custom https профили выполняют model requests | ✅ transport + live chat через активный профиль |
| Global Worker model / effort lock | ✅ `/model`/`settings model`, `settings effort lock`, run-scoped опции; enforcement в нативном ingress |
| `/config` `/submodel` → documented `unknown_command` | ✅ |
| Compatibility fixture passes CLI/docs/tests | ✅ canonical fixture + native-parity перегенерированы |
| Full test/lint/build/smoke | ✅ Rust-only гейты (`scripts/check-rust.sh`, release + smoke) |

## 5. Release bookkeeping

1. Локальный `0.1.3` commit (вся реализация уже в `main`).
2. Tagging `v0.1.3` — отдельное явное решение владельца; никогда не push.
