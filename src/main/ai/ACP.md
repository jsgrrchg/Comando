# ACP (Agent Client Protocol) — Architecture Reference

Comando currently integrates four AI runtimes through the Agent Client Protocol:

- **Claude**
- **Codex**
- **Gemini**
- **Kilo**

All four communicate with the app over ACP / JSON-RPC on stdio.

---

## Runtimes at a Glance

| | Claude | Codex | Gemini | Kilo |
|---|---|---|---|---|
| **Source** | TypeScript (`@agentclientprotocol/claude-agent-acp` `0.35.0`, vendored upstream snapshot) | Rust (`codex-acp` `0.14.0`, vendored on top of `openai/codex` `rust-v0.129.0` + local patches) | External Gemini CLI binary | External Kilo CLI binary |
| **Runtime command** | `node .../claude-agent-acp/dist/index.js` or `claude-agent-acp` | `codex-acp` | `gemini --acp` | `kilo acp` |
| **Release packaging** | Embedded Node runtime + embedded vendor JS project | Bundled native binary under `resources/ai/binaries/` | Not bundled today | Not bundled today |
| **Auth methods exposed by Comando** | `claude-ai-login`, `claude-login`, `console-login`, `gateway` | `chatgpt`, `codex-api-key`, `openai-api-key` | `login_with_google`, `use_gemini` | `kilo-login` |
| **Runtime discovery** | env, settings, vendor JS, embedded bundle, PATH fallback | env, settings, bundled binary, embedded target cache, legacy vendor target cache, PATH fallback | env, settings, PATH | env, settings, PATH |
| **Notes** | Debug builds prefer vendored JS directly. Gateway auth is supported. | Detects and rejects plain `codex` CLI because current integration still expects ACP. | Login readiness is inferred from `~/.gemini/settings.json`. | Login readiness is inferred from system-level Kilo auth stores (`XDG_DATA_HOME`, `LOCALAPPDATA`, `~/.local/share`). |

Notes:

- Comando persists runtime catalogs such as available commands, config options, modes and models, then rehydrates status from the latest stored catalog on startup.
- The vendored Claude ACP snapshot follows upstream reasoning support. Comando maps upstream `thought_level` and legacy `effort` config options into the UI's reasoning controls and keeps compatibility with older saved `effort_level` preferences.
- The current Claude vendor is `@agentclientprotocol/claude-agent-acp` `0.35.0`, with `@anthropic-ai/claude-agent-sdk` `0.3.143`. Compared with the previous Comando baseline (`0.31.4`), it honors `availableModels` from Claude settings, emits real diffs when `Write` overwrites existing files, preserves task-notification result origins so autonomous followups do not incorrectly drive the user-turn lifecycle, resolves defaults through the Claude SDK settings engine, mirrors SDK task hooks into ACP plan updates, and renders local command stdout messages instead of dropping them.
- The vendored Codex ACP snapshot is currently kept at `codex-acp` `0.14.0`, with its Rust runtime dependencies pinned to `openai/codex` `rust-v0.129.0` and `agent-client-protocol` `0.11.1`.
- The vendored Codex ACP snapshot currently includes a local Fast Mode patch carried over into Comando. It exposes the ACP session config option `service_tier`, the `/fast` slash command, and rehydrates `service_tier` when a session is resumed.
- The vendored Codex ACP snapshot also carries a local image-generation bridge: live Codex `ImageGenerationBegin` / `ImageGenerationEnd` events and replayed `ResponseItem::ImageGenerationCall` items are emitted as ACP tool updates with `codexAcpEventType = "image_generation"` and `codex-acp:image:` IDs so Comando can render generated images inline instead of as generic status activity. `TurnItem::ImageGeneration` is intentionally ignored for the live bridge because Codex also emits the begin/end events, and handling both would duplicate image cards.
- The current Codex vendor also carries compatibility glue for the `rust-v0.129.0` runtime API shape, including state DB/thread-store wiring, installation IDs, async auth reload/logout, permission-profile modes, newer event payloads, and local custom prompt handling.
- Gemini and Kilo are integrated in the UI and service layer, but they are not part of the staging/bundling pipeline today.
- Status metadata currently uses `codexAcp*` names while Comando keeps app-branded `comando*` aliases for compatibility paths it owns.

---

## Authentication Semantics

Comando separates provider authentication into two user-visible actions:

- **Log out from provider** is a remote/runtime logout. In this iteration only Codex exposes a real ACP logout capability. If remote logout fails, Comando keeps local settings and secrets intact.
- **Disconnect from Comando** is local cleanup. It removes Comando-managed secrets or marks external runtime login as signed out, but it never deletes external CLI stores such as `~/.claude.json`, `~/.gemini/settings.json`, or Kilo's own auth databases.

Disconnect/logout affect new runtime sessions. Active ACP sessions may continue using credentials that were already loaded when their process launched.

Runtime credential sources are reported explicitly in `AiRuntimeStatus`:

- `comando-secret`: Comando is using a locally stored secret.
- `environment`: an environment variable wins over Comando-managed credentials.
- `external-runtime`: auth belongs to the runtime or CLI outside Comando.
- `none`: no usable credentials are available.

Credential precedence is runtime-specific:

| Runtime | Method | Runtime precedence |
|---|---|---|
| Codex | `codex-api-key` | `CODEX_API_KEY` environment variable, then `secret.ai.codex.codex_api_key` |
| Codex | `openai-api-key` | `OPENAI_API_KEY` environment variable, then `secret.ai.codex.openai_api_key` |
| Codex | `chatgpt` | Codex/ACP-managed account login |
| Claude | `gateway` | `ANTHROPIC_*` environment variables can override Comando-managed gateway URL/token/headers |
| Claude | login methods | External Claude CLI login |
| Gemini | `use_gemini` | `GEMINI_API_KEY`/`GOOGLE_API_KEY` environment variables, then Comando-managed secrets |
| Gemini | `login_with_google` | External Gemini CLI login |
| Kilo | `kilo-login` | External Kilo auth stores |

Comando stores secrets through Electron `safeStorage`. On macOS this delegates protection to Keychain, on Windows to DPAPI, and on Linux to the selected keyring backend. Linux `basic_text` and `unknown` backends are treated as weak: Comando still reads existing secrets best-effort for compatibility, but blocks new secret writes and reports the storage warning through runtime status.

---

## Binary Resolution (runtime)

When Comando needs to spawn a runtime process, it resolves the executable or command in this order.

### Claude (`claude/setup.ts` → `resolveClaudeBinary`)

1. `COMANDO_CLAUDE_ACP_BIN`
2. Custom path from settings
3. **Debug builds only:** vendor JS at `vendor/Claude-agent-acp-upstream/dist/index.js`
4. Embedded Node runtime + embedded vendor JS at `resources/ai/embedded/node/bin/node resources/ai/embedded/claude-agent-acp/dist/index.js` or the equivalent packaged resource path
5. Bundled binary at `resources/ai/binaries/claude-agent-acp` or the packaged resource equivalent
6. Vendor JS fallback
7. `claude-agent-acp` in PATH

If the resolved Claude target is a `.js` entry, Comando wraps it automatically as:

```text
node /path/to/index.js
```

On packaged macOS builds, Comando also probes architecture-specific bundled paths under `process.resourcesPath/ai/`.

### Codex (`resolver/runtime-resolver.ts` → `resolveCodexRuntime`)

1. `COMANDO_CODEX_ACP_BIN`
2. Custom path from settings
3. Bundled binary at `resources/ai/binaries/codex-acp` or the packaged resource equivalent
4. Embedded target cache at `resources/ai/embedded/codex-acp/target/{release|debug}/codex-acp`
5. Legacy vendor target cache at `vendor/codex-acp/target/{release|debug}/codex-acp`
6. `codex-acp` in PATH
7. `codex` in PATH, but this is treated as **incompatible** and surfaces an error because Comando still expects an ACP runtime rather than the App Server / MCP CLI

If no compatible runtime is found, the user-facing message points back to:

```text
pnpm run stage:ai
```

### Gemini (`gemini/setup.ts` → `resolveGeminiBinary`)

1. `COMANDO_GEMINI_ACP_BIN`
2. Custom path from settings
3. `gemini` in PATH
4. On macOS, common Homebrew installs such as `/opt/homebrew/bin/gemini` and `/usr/local/bin/gemini`

When spawned, Comando appends:

```text
--acp
```

so the effective command is:

```text
gemini --acp
```

### Kilo (`kilo/setup.ts` → `resolveKiloBinary`)

1. `COMANDO_KILO_ACP_BIN`
2. Custom path from settings
3. `kilo` in PATH
4. On macOS, common Homebrew installs such as `/opt/homebrew/bin/kilo` and `/usr/local/bin/kilo`

When spawned, Comando appends:

```text
acp
```

so the effective command is:

```text
kilo acp
```

---

## Binary Staging (build-time)

Comando stages ACP artifacts before development and production builds.

### Entry points

- `pnpm run stage:ai`
- `pnpm run stage:codex-runtime`
- `pnpm run predev`
- `pnpm run prebuild`

Today `stage:ai` stages:

- **Codex**
- **Claude**

It does **not** stage Gemini or Kilo.

### Codex staging (`scripts/ai/stage-codex-runtime.mjs`)

`stage-codex-runtime` first migrates an old `vendor/codex-acp/target/` cache into `resources/ai/embedded/codex-acp/target/` when the embedded target cache does not exist yet.

It then resolves the source binary in this order:

1. `COMANDO_CODEX_ACP_BUNDLE_BIN`
2. `COMANDO_CODEX_ACP_BIN`
3. Fresh `cargo build --release --locked` inside `vendor/codex-acp` when the embedded release binary is missing or older than vendored source files
4. Existing embedded release binary at `resources/ai/embedded/codex-acp/target/release/codex-acp`
5. Existing embedded debug binary at `resources/ai/embedded/codex-acp/target/debug/codex-acp`
6. Legacy vendor release binary at `vendor/codex-acp/target/release/codex-acp`
7. Legacy vendor debug binary at `vendor/codex-acp/target/debug/codex-acp`
8. Fresh `cargo build --release --locked` inside `vendor/codex-acp`

Fresh builds run with:

```text
CARGO_TARGET_DIR=resources/ai/embedded/codex-acp/target
```

If `cargo` is not discoverable from the Node process environment, set `CARGO=/absolute/path/to/cargo` before running `pnpm run stage:codex-runtime`.

The resulting binary is copied to:

```text
resources/ai/binaries/codex-acp
```

The embedded target cache lives under:

```text
resources/ai/embedded/codex-acp/target/
```

Current local snapshot note:

- `vendor/codex-acp/` is currently based on `codex-acp` `0.14.0`, with vendored Rust runtime dependencies pinned to `openai/codex` `rust-v0.129.0` and `agent-client-protocol` `0.11.1`.
- `vendor/codex-acp/` includes a local Fast Mode patch carried over into Comando, adding ACP `service_tier` config handling, `/fast` command support, and session `service_tier` rehydration.
- `vendor/codex-acp/` includes a local generated-image patch. Live image generation begin/end events are converted into structured ACP tool call updates with `image_generation` metadata, preserving `status`, `path`, `result`, `revised_prompt`, and `error` fields for the Comando chat pipeline. Replay also maps stored `ImageGenerationCall` response items back into `codex-acp:image:` tool calls.
- `vendor/codex-acp/` includes local subagent projection: spawned Codex child threads are registered as ACP sessions and parent-thread breadcrumbs are mirrored through `codex-acp:subagent:` tool updates.
- The local vendor was adapted to the newer Codex runtime API so `cargo build --release --locked`, `cargo test --locked`, and staging continue to work from the vendored tree. The important upstream API changes now carried locally are state DB/thread-store initialization, installation ID resolution, async auth reload/logout, permission-profile based modes, `ThreadGoalUpdated`, image generation response items, and the O(N²) exec-output fallback fix.
- Linux npm platform packages now expect the bundled `codex-resources/bwrap` payload from upstream release archives; Comando's local desktop staging still stages the native sidecar binary directly.
- This local divergence should be reevaluated once the official upstream `codex-acp` ships equivalent support, so Comando can reduce vendor drift.

### Claude staging (`scripts/ai/stage-claude-runtime.mjs`)

`stage-claude-runtime`:

1. Resolves the Node binary from `COMANDO_EMBEDDED_NODE_BIN`, PATH `node`, or `process.execPath`
2. Copies that Node binary into `resources/ai/embedded/node/bin/node`
3. Copies the vendored Claude project from `vendor/Claude-agent-acp-upstream/` into `resources/ai/embedded/claude-agent-acp/`
4. Removes any legacy standalone `resources/ai/binaries/claude-agent-acp`
5. Validates that `package.json`, `dist/index.js` and `node_modules/` exist in the staged embedded runtime

This means Claude is staged as an embedded project, not as a freshly built standalone sidecar.

Current local snapshot note:

- `vendor/Claude-agent-acp-upstream/` is synced to upstream `@agentclientprotocol/claude-agent-acp` `0.35.0` at commit `f6e12d4`.
- `vendor/Claude-agent-acp-upstream/` uses the upstream Claude ACP reasoning implementation.
- Upstream exposes model-specific reasoning values through the `thought_level` ACP session config option when the selected Claude model reports support for them.
- Comando still accepts older saved `effort_level` and `effort` preferences and applies them to upstream's reasoning option.
- The vendor now applies Claude `availableModels` settings before model catalog/config option publication, so Comando should only surface the allowed model set plus the upstream `default` entry.
- Claude `Write` tool updates now use the structured post-tool diff when overwriting existing files, which keeps Comando's inline review and edited-files surfaces from showing overwrites as plain file creation.
- Claude task-notification result origins are preserved in usage update metadata and ignored for user-turn stop-state decisions, preventing autonomous followups from ending or cancelling the visible user turn.
- Claude settings are now resolved through the Claude SDK settings engine, matching upstream defaults and trust filtering more closely than Comando's previous local merge.
- Claude SDK task hooks (`TaskCreated` and `TaskCompleted`) now populate ACP plan updates, so newer SDK task state should remain visible in Comando's plan UI.
- Upstream now renders local command stdout messages after stripping Claude command metadata, which lets slash-command and skill output reach the chat stream.
- Upstream added a `gateway-bedrock` auth method for Bedrock-style gateways, but Comando's persisted Claude gateway settings still model the existing Anthropic-compatible `gateway` path.

### macOS packaging (`scripts/package-macos-app.mjs`)

The macOS packaging flow builds a packaged AI payload under `build/package-resources/ai/`. It does not run `stage:ai`; it packages already staged or prebuilt runtime artifacts.

- **Claude**
  - stages the embedded Claude project from `resources/ai/embedded/claude-agent-acp/`, a previous packaged app on the Desktop, or the vendor tree as fallback
- **Codex**
  - stages both `darwin-arm64` and `darwin-x64` binaries under `build/package-resources/ai/binaries/darwin-{arch}/codex-acp`
  - resolves each architecture from `resources/ai/prebuilt/codex-acp/darwin-{arch}/codex-acp` or a previous packaged app on the Desktop
  - for `arm64`, also accepts the current staged `resources/ai/binaries/codex-acp` before the prebuilt/desktop fallbacks
- **Embedded Node**
  - stages both `darwin-arm64` and `darwin-x64` Node binaries under `build/package-resources/ai/embedded/node/darwin-{arch}/bin/node`
  - resolves each architecture from `resources/ai/prebuilt/node/darwin-{arch}/bin/node` or a previous packaged app on the Desktop

`electron-builder` then bundles that staged directory through:

```json
"extraResources": [
  {
    "from": "build/package-resources/ai",
    "to": "ai",
    "filter": ["**/*"]
  }
]
```

Gemini and Kilo are still expected to come from the user's machine at runtime.

### Windows packaging (`scripts/package-windows-app.mjs`)

The Windows packaging flow builds a packaged AI payload under `build/package-resources/ai/`:

- **Claude**
  - stages the embedded Claude project from `resources/ai/embedded/claude-agent-acp/` or the vendor tree as fallback
- **Codex**
  - stages the current Windows ACP binary under `build/package-resources/ai/binaries/codex-acp.exe`
- **Embedded Node**
  - stages the current Windows embedded Node binary under `build/package-resources/ai/embedded/node/bin/node.exe`

The packaging entrypoints are:

- `pnpm run package:win`
- `pnpm run package:win:x64`
- `pnpm run package:win:arm64`

`package:win` defaults to the current machine architecture. For cross-architecture packaging, seed the staged runtimes for the target architecture before invoking the matching script.

---

## Authentication

### Storage model

- Runtime settings are stored in the app SQLite database via `SettingsService`
- Secrets are stored in the same `app_settings` table but encrypted through Electron `safeStorage`
- If `safeStorage.isEncryptionAvailable()` is false, saving secrets fails

### Claude

Configured through SQLite settings keys under the `ai.claude.*` namespace.

Secrets stored by Comando:

- `secret.ai.claude.anthropic_auth_token`
- `secret.ai.claude.anthropic_custom_headers`

Supported methods:

- **`claude-login`**
  - Remote or no-browser terminal flow
  - Launches Claude with `--cli`
  - Expected to continue sign-in through `/login`

- **`claude-ai-login`**
  - Local Claude subscription login
  - Launches Claude with `--cli auth login --claudeai`

- **`console-login`**
  - Local Anthropic Console login
  - Launches Claude with `--cli auth login --console`

- **`gateway`**
  - Custom Anthropic-compatible endpoint
  - Injected through:
    - `ANTHROPIC_BASE_URL`
    - `ANTHROPIC_AUTH_TOKEN`
    - `ANTHROPIC_CUSTOM_HEADERS`

Claude login readiness is inferred from:

```text
~/.claude.json
```

and compared against `authInvalidatedAtMs`.

Remote-style Claude auth UI is enabled whenever any of these env vars are present:

- `NO_BROWSER`
- `SSH_CONNECTION`
- `SSH_CLIENT`
- `SSH_TTY`
- `CLAUDE_CODE_REMOTE`

Gateway validation rules:

- valid URL required
- HTTPS required except localhost HTTP
- embedded credentials in the URL are rejected

### Codex

Configured through SQLite settings keys under the `ai.codex.*` namespace.

Secrets stored by Comando:

- `secret.ai.codex.codex_api_key`
- `secret.ai.codex.openai_api_key`

Supported methods:

- **`chatgpt`**
  - Runs an ACP auth handshake over a temporary runtime connection
  - Comando calls `initialize`, inspects advertised `authMethods`, then calls `authenticate`

- **`codex-api-key`**
  - Injects `CODEX_API_KEY`

- **`openai-api-key`**
  - Injects `OPENAI_API_KEY`

Comando does **not** currently set `CODEX_HOME` or manage a Codex-specific app data directory directly.

### Gemini

Configured through SQLite settings keys under the `ai.gemini.*` namespace.

Secrets stored by Comando:

- `secret.ai.gemini.gemini_api_key`
- `secret.ai.gemini.google_api_key`

Supported methods:

- **`login_with_google`**
  - Opens a detached terminal and runs the Gemini CLI login flow
  - Readiness is inferred from:

```text
~/.gemini/settings.json
```

  - The selected auth type must match one of:
    - `google`
    - `login_with_google`
    - `oauth-personal`

- **`use_gemini`**
  - Uses a stored or inherited API key
  - No terminal login flow is required

Comando also injects these values when missing from the environment:

- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_LOCATION`
- `GEMINI_DEFAULT_AUTH_TYPE`

### Kilo

Configured through SQLite settings keys under the `ai.kilo.*` namespace.

Supported method:

- **`kilo-login`**
  - Opens a detached terminal and runs:

```text
kilo auth login
```

Kilo auth readiness is inferred from user-level Kilo auth stores. Comando currently checks:

- legacy JSON auth store:

```text
$XDG_DATA_HOME/kilo/auth.json
~/.local/share/kilo/auth.json
%LOCALAPPDATA%/kilo/auth.json
```

- SQLite auth store:

```text
$XDG_DATA_HOME/kilo/kilo.db
~/.local/share/kilo/kilo.db
%LOCALAPPDATA%/kilo/kilo.db
```

For the SQLite store, Comando inspects `account_state`, `account`, and `control_account` when those tables exist.

---

## ACP Protocol Basics

**Framing:** ACP over stdio. In practice Comando uses NDJSON-style framing through `@agentclientprotocol/sdk` `ndJsonStream`.

### Client → Agent requests used by Comando

- `initialize`
- `authenticate` during Codex auth launch
- `session/new`
- `session/load`
- `session/close` through `unstable_closeSession`
- `unstable_logout` during Codex ChatGPT logout
- `prompt`
- `setSessionMode`
- `unstable_setSessionModel`
- `setSessionConfigOption`
- cancel notification

Internally, the current vendored Codex runtime also performs a cleaner thread shutdown path and may fall back to `Op::Shutdown` when the wrapper channel is already gone, but that is runtime-internal behavior rather than a separate ACP request initiated by Comando.

Comando does **not** currently use:

- `session/list`
- `session/resume`
- `session/fork`

### Agent → Client callbacks and notifications handled by Comando

- filesystem callbacks:
  - `readTextFile`
  - `writeTextFile`
- terminal callbacks:
  - `createTerminal`
  - `terminalOutput`
  - `waitForTerminalExit`
  - `killTerminal`
  - `releaseTerminal`
- permission requests
- runtime user-input requests (`RequestUserInput`)
- MCP elicitation requests used for MCP tool approval flows
- session updates carrying:
  - agent message chunks
  - thought chunks
  - tool calls and tool call updates
  - plan updates
  - available command updates
  - current mode updates
  - config option updates
  - session info updates
  - usage / token context updates
  - guardian assessment progress / resolution events

Comando also handles runtime-specific user-input requests by parsing tool-call metadata and then answering through a synthesized follow-up prompt payload. The current response prefix is:

```text
__codex_acp_user_input_response__:
```

Comando recognizes the current Codex ACP status metadata key:

```text
codexAcpEventType
```

and the Comando-owned compatibility alias:

```text
comandoEventType
```

The current vendored Codex runtime emits codexAcp-prefixed metadata fields and codex-acp tool-call IDs:

- `codex-acp:status:` for status/activity bridge updates
- `codex-acp:image:` for generated-image tool calls
- `codex-acp:subagent:` for subagent breadcrumb tool calls

### Protocol version

Comando initializes ACP clients with:

```ts
PROTOCOL_VERSION
```

from `@agentclientprotocol/sdk`, not a hardcoded numeric literal.

---

## Frontend Transport

Comando is an Electron app, so it does not use the Tauri event layer from the previous codebase.

Instead:

- the main process broadcasts AI session deltas as `AiSessionUpdate`
- each renderer receives those deltas over a dedicated `MessagePortMain`
- the stream is attached through `IPC_EVENTS.aiSessionStreamPort`
- regular setup, settings and command flows continue through typed Electron IPC handlers

---

## File Map

```text
src/main/
├── ai/
│   ├── ACP.md
│   ├── client.ts                     # ACP client wrapper and connection utilities
│   ├── contracts.ts                  # Runtime metadata keys and ACP compatibility constants
│   ├── openFileBuffers.ts            # Tracked open buffers shared with AI sessions
│   ├── persistence.ts                # Session history, runtime catalog and selection persistence
│   ├── review-core.ts                # Review/change-tracking state helpers
│   ├── runtime-env.ts                # Shared runtime environment construction
│   ├── secret-store.ts               # Encrypted secret storage via Electron safeStorage
│   ├── service.ts                    # AI service orchestration and runtime settings flows
│   ├── session-core.ts               # Session-level reducers and shared AI state helpers
│   ├── worker-runtime.ts             # Live ACP session/runtime execution
│   ├── worker.ts                     # AI worker bootstrap
│   ├── resolver/
│   │   └── runtime-resolver.ts       # Codex runtime discovery and compatibility checks
│   ├── claude/
│   │   └── setup.ts                  # Claude runtime resolution, auth launch and gateway env
│   ├── codex/
│   │   └── setup.ts                  # Codex auth methods and env injection
│   ├── gemini/
│   │   └── setup.ts                  # Gemini runtime resolution and auth detection
│   └── kilo/
│       └── setup.ts                  # Kilo runtime resolution and auth detection
│
├── db/
│   ├── awaitable.ts                  # Promise coordination helpers for the DB worker
│   ├── client.ts                     # DB worker client, runtime catalog rehydration
│   ├── index.ts                      # SQLite bootstrap
│   ├── migrations.ts                 # Schema migrations
│   └── worker.ts                     # Worker entrypoint and AI bootstrap state
│
└── ipc/
    ├── index.ts                      # Typed Electron IPC handlers
    └── rate-limit.ts                 # IPC-side throttling helpers

scripts/
└── ai/
    ├── _shared.mjs                   # Shared staging paths and helpers
    ├── stage-ai-runtimes.mjs         # Stages Claude + Codex
    ├── stage-claude-runtime.mjs      # Stages embedded Node + Claude vendor project
    ├── stage-codex-runtime.mjs       # Builds or copies codex-acp
    └── verify-ai-runtimes.mjs        # Verifies staged Claude/Codex artifacts

resources/
└── ai/
    ├── binaries/                     # Bundled native executables
    ├── embedded/                     # Embedded runtime support assets and caches
    └── prebuilt/                     # Prebuilt macOS packaging inputs

vendor/
├── Claude-agent-acp-upstream/        # Vendored Claude ACP project
└── codex-acp/                        # Vendored Rust Codex ACP runtime
```

---

## App Data (macOS)

Comando stores app state under Electron `userData`.

Typical locations:

```text
~/Library/Application Support/Comando/
~/Library/Application Support/Comando Dev/
```

The SQLite database defaults to:

```text
comando.sqlite3
```

inside that `userData` directory.

Relevant data stored there includes:

- app settings
- AI runtime settings
- encrypted secret records
- runtime catalog cache
- runtime selection preferences
- persisted chat session snapshots

External auth state also used:

```text
~/.claude.json
~/.gemini/settings.json
~/.local/share/kilo/auth.json
~/.local/share/kilo/kilo.db
```

On Linux and Windows, the Kilo paths vary through `XDG_DATA_HOME` and `LOCALAPPDATA`.

---

## Environment Variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `COMANDO_CLAUDE_ACP_BIN` | Claude runtime | Override Claude runtime path or command |
| `COMANDO_CODEX_ACP_BIN` | Codex runtime / staging | Override Codex runtime path |
| `COMANDO_CODEX_ACP_BUNDLE_BIN` | Codex staging | Override the binary copied into bundled resources |
| `COMANDO_GEMINI_ACP_BIN` | Gemini runtime | Override Gemini CLI path or command |
| `COMANDO_KILO_ACP_BIN` | Kilo runtime | Override Kilo CLI path or command |
| `COMANDO_EMBEDDED_NODE_BIN` | Claude staging | Override the Node binary embedded for Claude |
| `COMANDO_APP_CHANNEL` | App runtime | Forces `dev` or `release` channel identity |
| `ANTHROPIC_BASE_URL` | Claude process | Custom Anthropic-compatible gateway URL |
| `ANTHROPIC_AUTH_TOKEN` | Claude process | Gateway auth token |
| `ANTHROPIC_CUSTOM_HEADERS` | Claude process | Gateway custom headers |
| `CODEX_API_KEY` | Codex process | Codex API key |
| `OPENAI_API_KEY` | Codex process | OpenAI API key |
| `GEMINI_API_KEY` | Gemini process | Gemini Developer API key |
| `GOOGLE_API_KEY` | Gemini process | Alternate Gemini developer key source |
| `GOOGLE_CLOUD_PROJECT` | Gemini process | Google Cloud project hint |
| `GOOGLE_CLOUD_LOCATION` | Gemini process | Google Cloud location hint |
| `GEMINI_DEFAULT_AUTH_TYPE` | Gemini process | Default Gemini auth mode |
| `NO_BROWSER` | Claude/Codex auth UX | Forces remote-style Claude auth behavior and hides the Codex ChatGPT browser login option |
| `SSH_CONNECTION` | Claude auth UX | Marks the environment as remote |
| `SSH_CLIENT` | Claude auth UX | Marks the environment as remote |
| `SSH_TTY` | Claude auth UX | Marks the environment as remote |
| `CLAUDE_CODE_REMOTE` | Claude auth UX | Marks the environment as remote |

---

## Current Caveats

- Only **Claude** and **Codex** are staged and packaged by Comando today.
- **Gemini** and **Kilo** are integrated end-to-end in the app layer, but the user must provide those CLIs on the machine.
- Claude runtime resolution still keeps a legacy standalone `claude-agent-acp` binary fallback even though the normal path prefers embedded Node + vendored JS.
- Codex PATH fallback explicitly rejects plain `codex` because Comando still targets ACP, not the App Server / MCP surface.
- The current vendored Codex runtime includes newer upstream support for MCP approval elicitation, `RequestUserInput`, guardian-assessment activity and cleaner shutdown handling, while Comando keeps legacy metadata fallbacks so older sessions can still be replayed safely.
- Secret persistence depends on Electron `safeStorage`; if the OS secure storage is unavailable, API-key and gateway-secret writes will fail.
- This document should be kept aligned with `src/main/ai/`, `scripts/ai/`, `resources/ai/` and related packaging logic whenever runtime behavior changes.
