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
| **Source** | TypeScript (`@agentclientprotocol/claude-agent-acp` `0.29.0` + local upstream snapshot including the post-release `usage_update` stream fix) | Rust (`codex-acp` `0.11.1`) | External Gemini CLI binary | External Kilo CLI binary |
| **Runtime command** | `node .../claude-agent-acp/dist/index.js` or `claude-agent-acp` | `codex-acp` | `gemini --acp` | `kilo acp` |
| **Release packaging** | Embedded Node runtime + embedded vendor JS project | Bundled native binary under `resources/ai/binaries/` | Not bundled today | Not bundled today |
| **Auth methods exposed by Comando** | `claude-ai-login`, `claude-login`, `console-login`, `gateway` | `chatgpt`, `codex-api-key`, `openai-api-key` | `login_with_google`, `use_gemini` | `kilo-login` |
| **Runtime discovery** | env, settings, vendor JS, embedded bundle, PATH fallback | env, settings, bundled binary, embedded target cache, PATH fallback | env, settings, PATH | env, settings, PATH |
| **Notes** | Debug builds prefer vendored JS directly. Gateway auth is supported. | Detects and rejects plain `codex` CLI because current integration still expects ACP. | Login readiness is inferred from `~/.gemini/settings.json`. | Login readiness is inferred from Kilo auth stores under the user data directory. |

Notes:

- Comando persists runtime catalogs such as available commands, config options, modes and models, then rehydrates status from the latest stored catalog on startup.
- Gemini and Kilo are integrated in the UI and service layer, but they are not part of the staging/bundling pipeline today.
- Some compatibility markers still use legacy reference app-prefixed metadata names inside the session stream.

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
5. `codex-acp` in PATH
6. `codex` in PATH, but this is treated as **incompatible** and surfaces an error because Comando still expects an ACP runtime rather than the App Server / MCP CLI

If no compatible runtime is found, the user-facing message points back to:

```text
pnpm run stage:ai
```

### Gemini (`gemini/setup.ts` → `resolveGeminiBinary`)

1. `COMANDO_GEMINI_ACP_BIN`
2. Custom path from settings
3. `gemini` in PATH

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

`stage-codex-runtime` resolves the source binary in this order:

1. `COMANDO_CODEX_ACP_BUNDLE_BIN`
2. `COMANDO_CODEX_ACP_BIN`
3. Existing embedded release binary at `resources/ai/embedded/codex-acp/target/release/codex-acp`
4. Existing embedded debug binary at `resources/ai/embedded/codex-acp/target/debug/codex-acp`
5. Legacy vendor target caches under `vendor/codex-acp/target/`
6. Fresh `cargo build --release --locked` inside `vendor/codex-acp`

The resulting binary is copied to:

```text
resources/ai/binaries/codex-acp
```

The embedded target cache lives under:

```text
resources/ai/embedded/codex-acp/target/
```

### Claude staging (`scripts/ai/stage-claude-runtime.mjs`)

`stage-claude-runtime`:

1. Resolves the Node binary from `COMANDO_EMBEDDED_NODE_BIN`, PATH `node`, or `process.execPath`
2. Copies that Node binary into `resources/ai/embedded/node/bin/node`
3. Copies the vendored Claude project from `vendor/Claude-agent-acp-upstream/` into `resources/ai/embedded/claude-agent-acp/`
4. Removes any legacy standalone `resources/ai/binaries/claude-agent-acp`
5. Validates that `package.json`, `dist/index.js` and `node_modules/` exist in the staged embedded runtime

This means Claude is staged as an embedded project, not as a freshly built standalone sidecar.

### macOS packaging (`scripts/package-macos-app.mjs`)

The macOS packaging flow builds a packaged AI payload under `build/package-resources/ai/`:

- **Claude**
  - stages the embedded Claude project from `resources/ai/embedded/claude-agent-acp/`, a previous packaged app on the Desktop, or the vendor tree as fallback
- **Codex**
  - stages architecture-specific prebuilt binaries under `build/package-resources/ai/binaries/darwin-{arch}/codex-acp`
- **Embedded Node**
  - stages architecture-specific prebuilt Node binaries under `build/package-resources/ai/embedded/node/darwin-{arch}/bin/node`

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

---

## Authentication

### Storage model

Unlike reference app, Comando does not keep AI setup in standalone JSON files.

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
  - guardian assessment progress / resolution events

Comando also handles runtime-specific user-input requests by parsing tool-call metadata and then answering through a synthesized follow-up prompt payload. The current response prefix is:

```text
__neverwrite_user_input_response__:
```

Comando also still recognizes reference app-style status metadata keys such as:

```text
neverwriteEventType
```

These are compatibility shims carried over from the original integration lineage. The current vendored Codex runtime still emits those reference app-prefixed metadata fields and status tool-call IDs while also supporting newer upstream behaviors such as MCP approval elicitation routing and guardian-assessment tool activity.

### Protocol version

Comando initializes ACP clients with:

```ts
PROTOCOL_VERSION
```

from `@agentclientprotocol/sdk`, not a hardcoded numeric literal.

---

## Frontend Transport

Comando is an Electron app, so it does not use the Tauri event layer from reference app.

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
│   ├── service.ts                    # ACP client orchestration and session lifecycle
│   ├── persistence.ts                # Session history, runtime catalog and selection persistence
│   ├── secret-store.ts               # Encrypted secret storage via Electron safeStorage
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
│   ├── client.ts                     # DB worker client, runtime catalog rehydration
│   ├── index.ts                      # SQLite bootstrap
│   └── worker.ts                     # Worker entrypoint and AI bootstrap state
│
└── ipc/
    └── index.ts                      # Typed Electron IPC handlers

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
| `NO_BROWSER` | Claude auth UX | Forces remote-style Claude auth behavior |
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
- The current vendored Codex runtime includes newer upstream support for MCP approval elicitation, `RequestUserInput`, guardian-assessment activity and cleaner shutdown handling, but some stream metadata and user-input plumbing still use reference app-prefixed compatibility markers.
- Secret persistence depends on Electron `safeStorage`; if the OS secure storage is unavailable, API-key and gateway-secret writes will fail.
- This document should be kept aligned with `src/main/ai/`, `scripts/ai/`, `resources/ai/` and related packaging logic whenever runtime behavior changes.
