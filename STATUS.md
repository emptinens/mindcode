# MindCode 0.1.3 — Project Status

**Дата статуса:** `2026-08-13`
**Контракт:** `PLAN.md` — approved migration `0.1.3` (multi-provider amendment `2026-08-13`)
**Платформа:** Linux x86_64

## 1. Executive summary

Миграция `0.1.3` прошла foundation → provider → TUI-интеграцию. Релиз пока не
закрыт: остаются setup screen (провайдер add/switch в TUI), live model-request
path, packaging единого бинаря и финальный purge TypeScript.

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
- Rust TUI свернут в workspace; UI protocol v2 control server портирован в
  Rust (`mindcode-tui-server`); `mindcode tui` запускает renderer + control
  server in-process без Bun/Node.
- Canonical compatibility fixture + перегенерированные `tests/native-parity/`.

**Осталось:**
- Setup screen: добавление/переключение провайдера прямо в TUI.
- Live model-request path (chat/worker runtime поверх transport).
- Packaging: `mindcode.sh`/release-сборка → единый нативный бинарь.
- Полный purge `src/` и Bun-pipeline; release bookkeeping (локальный `0.1.3`
  commit; tagging — отдельное решение, никогда не push).

## 2. Repository / Git state

- Ветка `main`, **remote нет**, push запрещён контрактом.
- `0.1.2` — checkpointed, untagged; `0.1.3` — незавершённый approved migration.
- Commit series: `6e96421` (docs amendment) → `acccee0` (provider/transport
  foundation) → `d44b2d9` (command cleanup) → `03e6098` (tui lock refresh) →
  `4c6acc8` (profiles end-to-end) → `97ec76e` (anthropic /v1/models doc) →
  `af95e42` (first-run VEXZY) → `76ca073` (tui fold + control server) →
  `dcebd5d` (`mindcode tui`).

## 3. Cargo workspace

| Крейт | Роль |
|---|---|
| `mindcode-native` (bin `mindcode`) | CLI: auth/model/effort/provider/settings/setup-token/doctor/update/daemon/tui |
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

Сборка/тесты (проверено): `cargo build --workspace --locked` ✅ ·
`cargo clippy --workspace --all-targets -- -D warnings` ✅ · `cargo fmt --all
-- --check` ✅ · `cargo test --workspace --all-targets --locked` ✅ (native 40,
tui 82, tui-server 19, + остальные).

## 4. Acceptance gates (PLAN §8)

| Gate | Статус |
|---|---|
| `git diff --check` clean, только owned files | ✅ |
| Linux x64 single executable, TUI + daemon без Bun/Node | ⚠️ частично: in-process daemon + TUI работают; release-packaging и setup screen нет |
| VEXZY + custom https профили выполняют model requests | ⚠️ transport готов; live chat/worker path не подключён |
| Global Worker model / effort lock enforced | ⚠️ примитивы + CLI; enforcement в worker ingress не завершён |
| `/config` `/submodel` → documented `unknown_command` | ✅ |
| Compatibility fixture passes CLI/docs/tests | ⚠️ fixture существует; fixture-driven test harness не подключён |
| Full test/lint/typecheck/coverage/build/smoke | ⚠️ Rust-часть зелёная; Bun-pipeline ещё существует |

## 5. Следующие шаги

1. **Setup screen** — провайдер add/switch в TUI (snapshot-форма + input
   actions → `mindcode-settings`).
2. **Live model-request path** — chat/worker через `mindcode-transport` +
   активный профиль.
3. **Packaging** — release-сборка единого бинаря, `mindcode.sh` → нативный
   бинарь.
4. **Purge TypeScript** — удаление `src/` и Bun-pipeline после Rust-parity.
5. **Release bookkeeping** — локальный `0.1.3` commit; tagging отдельно.
