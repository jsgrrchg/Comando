# Native AI Backend

This document tracks the first native Rust AI runtime slice for Comando.

## Reference

The local reference architecture reviewed for this work is:

```text
/Users/jfg/Documents/DEVELOPMENT/NeverWrite
```

The relevant patterns are the native backend owning an AI session, a provider-neutral runtime matrix, ACP stdio process ownership, session notification mapping, permission/user-input waiters, and clear runtime readiness separate from UI state.

Comando must not copy NeverWrite names, storage assumptions, vault filesystem policy, UI behavior, or complete review/history ownership in this slice.

## PR 12 Native Auth And Secrets

PR 12 moves native runtime setup, auth readiness, secret storage, env injection,
and auth terminal launch into Rust for native AI sessions.

Additional flags:

- `COMANDO_NATIVE_AUTH=1` enables the native auth/setup path in Electron main.
- `COMANDO_NATIVE_AUTH_MODE=shadow|write` controls ownership. `shadow` keeps
  TypeScript visible; `write` returns native runtime status and sends native
  sessions without a TypeScript-built launch env.
- `COMANDO_NATIVE_AUTH_STRICT=1` is reserved for rollout paths that should fail
  instead of silently falling back after a native auth error.
- `COMANDO_NATIVE_SECRETS=1` enables native `secret_*` command routing.
- `COMANDO_NATIVE_SECRET_STORE=keyring|memory|electron-bridge` selects the
  native secret backend. `memory` is for tests and smoke only;
  `electron-bridge` currently reports unavailable unless Electron main migrates
  values into native storage.
- `COMANDO_NATIVE_AUTH_TERMINAL=1` routes Claude, OpenCode, Kilo, and Grok
  login flows through native integrated terminals with `purpose: auth`.
- `COMANDO_NATIVE_AUTH_PARITY_LOG=1` is reserved for redacted shadow-mode parity
  diagnostics.

Native storage:

```text
<Comando app data>/ai/runtime-setup.json
```

This file stores only non-secret metadata:

- selected auth method
- custom binary path
- invalidation timestamp
- Claude gateway URLs
- `secretEnvKeys` markers
- non-secret env entries

Secret values are stored through `RuntimeSecretStore`. Production uses the OS
keyring service `Comando AI Provider Secrets` with accounts shaped as
`<runtimeId>:<ENV_KEY>`. Tests use the opt-in memory store. `runtime-setup.json`
is written atomically and with `0600` permissions on Unix.

Electron main migrates legacy `electron-safe-storage-v1` secrets by reading
them with the existing `SecretStoreService` and sending in-memory
`secretPatches` to `ai_save_runtime_settings`. Legacy secrets are not deleted in
this PR, so rollback remains safe.

Native commands added or completed:

- `secret_status`
- `secret_get`
- `secret_set`
- `secret_delete`
- `ai_save_runtime_settings`
- `ai_launch_runtime_auth`
- `ai_disconnect_runtime_auth`
- `ai_logout_runtime_auth`

Runtime behavior:

- `ai_get_runtime_status` no longer needs a TypeScript `launch` when native auth
  write mode is active.
- `ai_prepare_session` accepts `launch: null`; Rust resolves the binary,
  credential source, auth method, real spawn env, and Grok ACP auth handshake.
- Env maps are kept inside Rust/native process boundaries and are not serialized
  to the renderer for status.
- Auth terminals reuse `comando-terminal` with `NativeTerminalPurpose::Auth`.

Rollback:

```text
COMANDO_NATIVE_AUTH=0
COMANDO_NATIVE_SECRETS=0
COMANDO_NATIVE_AUTH_TERMINAL=0
```

or keep native calculations non-authoritative:

```text
COMANDO_NATIVE_AUTH_MODE=shadow
```

With rollback, the TypeScript setup files and Electron safeStorage secrets
remain available.

## PR 9 Baseline Audit

The PR 9 audit rechecked the same local reference before expanding the runtime
matrix:

```text
/Users/jfg/Documents/DEVELOPMENT/NeverWrite/apps/desktop/native-backend/src/ai.rs
/Users/jfg/Documents/DEVELOPMENT/NeverWrite/apps/desktop/native-backend/src/main.rs
/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/ai/src/domain.rs
/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/ai/src/events.rs
```

Reusable reference patterns:

- `RuntimeDefinition` stays declarative: runtime id, display name, binary/env
  defaults, ACP args, protocol flavor, and capability metadata are data, not
  branches inside the engine.
- The ACP process spec is the boundary between TypeScript runtime setup/secrets
  and Rust process/session ownership.
- Permission and user-input requests are handled by Rust waiters once a session
  is native-owned.
- Grok keeps its provider-specific auth handshake and legacy ACP compatibility
  behind runtime-specific launch/auth metadata.

Current Comando baseline before PR 9:

- `crates/comando-ai` is provider-neutral and already owns real OpenCode ACP
  sessions through Rust.
- The registry lists `codex`, `claude`, `opencode`, `kilo`, and `grok`, but
  only `opencode` is marked `native_ready`.
- `AiService` already records session ownership with `sessionId -> native |
  legacy`; it must keep that invariant while expanding the matrix.
- The native event adapter already maps the core stream/status/tool/plan/token
  events used by the renderer.

PR 9 gaps to close:

- Enable the full runtime matrix under `COMANDO_NATIVE_AI_RUNTIMES` instead of
  hardcoding OpenCode as the only accepted native runtime.
- Formalize the native launch context so Rust can validate runtime id, command,
  args, cwd, env, desired selections, persisted runtime session id, and auth
  handshake hints before spawning.
- Build `AcpProcessSpec` from that context and keep env diagnostics redacted.
- Route permission/user-input responses to the native session owner instead of
  returning `not_supported`.
- Document smoke/rollback instructions for enabling or disabling individual
  native runtimes.

Baseline verification:

```text
cargo test -p comando-ai
```

## PR 9 Scope

PR 9 expands the native AI path from the initial OpenCode slice to the full
runtime matrix:

- `codex`
- `claude`
- `opencode`
- `kilo`
- `grok`

Feature flags:

- `COMANDO_NATIVE_AI=1` enables native AI routing.
- `COMANDO_NATIVE_AI_RUNTIMES=codex,claude,opencode,kilo,grok` selects the
  runtimes allowed to use Rust.
- With `COMANDO_NATIVE_AI_RUNTIMES` omitted, the native gateway defaults to the
  same five-runtime matrix.
- Runtimes not listed remain owned by the legacy TypeScript worker.

Native Rust owns the ACP process, session lifecycle, streaming, cancel/close,
permission waiters, user-input waiters, and Grok auth handshake once a session
is routed native. TypeScript still owns runtime setup, current settings,
current secrets, terminal auth launchers, and legacy fallback.

Runtime connection events are emitted as backend diagnostics when a native ACP
session is initialized. They are intentionally not visible UI copy.

Runtime launch contracts:

- Codex: TS resolves `codex-acp`; Rust expects no ACP args.
- Claude: TS may resolve a direct `claude-agent-acp` executable or `node` plus
  vendor entry args; Rust accepts the launch context as provided.
- OpenCode: Rust validates `opencode acp`.
- Kilo: Rust validates `kilo acp`.
- Grok: Rust validates `grok --no-auto-update agent stdio` and maps Grok auth
  handshakes to `xai.api_key` or `cached_token` when advertised by the runtime.
  The PR 9 implementation uses the current ACP crate; a separate legacy ACP
  transport is not advertised as ready.

Runtime capabilities are intentionally conservative. A runtime is marked
`native_ready` only for the lifecycle it can execute through Rust. Native ACP
runtimes project runtime catalog updates, provider-specific subagent sessions,
and breadcrumb metadata through the Rust-backed event stream. Runtimes outside
the native matrix remain on the legacy worker path.

Rollback:

```text
COMANDO_NATIVE_AI=0
```

or remove a single runtime from the matrix:

```text
COMANDO_NATIVE_AI_RUNTIMES=codex,claude,opencode,kilo
```

Manual smoke and rollout verification are tracked in
[`docs/native-ai-runtime-smoke.md`](native-ai-runtime-smoke.md).

## PR 8 Scope

This slice moves the first real AI session owner into Rust under feature flags:

- `COMANDO_NATIVE_AI=1` enables native AI routing.
- `COMANDO_NATIVE_AI_RUNTIMES=opencode` selects runtimes allowed to use Rust.
- Runtimes not listed remain owned by the legacy TypeScript worker.

The selected first runtime is `opencode`.

Reasons:

- Comando already resolves `opencode` through the existing TypeScript runtime setup path.
- The ACP launch shape is stable and small: `opencode acp`.
- Auth can stay with the existing OpenCode CLI/environment flow in this PR.
- It avoids making the core architecture Codex-specific while still using a real ACP process.

## Implemented Commands

The native side implements the initial lifecycle subset:

- `ai_list_runtimes`
- `ai_get_runtime_status`
- `ai_prepare_session`
- `ai_send_prompt`
- `ai_cancel_session`
- `ai_close_session`
- `ai_respond_permission`
- `ai_respond_user_input`
- `ai_set_session_model`
- `ai_set_session_mode`
- `ai_set_session_config_option`

Mode, model, and config mutations are sent to the ACP session with runtime ack.
Other unsupported native mutations return typed native AI errors instead of
falling through to the TypeScript worker.

## Implemented Events

Native AI streams small semantic events:

- `ai://runtime-status`
- `ai://runtime-connection`
- `ai://session-created`
- `ai://session-updated`
- `ai://session-closed`
- `ai://session-catalog-updated`
- `ai://subagent-created`
- `ai://subagent-breadcrumb`
- `ai://message-started`
- `ai://message-delta`
- `ai://message-completed`
- `ai://thinking-started`
- `ai://thinking-delta`
- `ai://thinking-completed`
- `ai://tool-activity`
- `ai://status-event`
- `ai://plan-updated`
- `ai://permission-request`
- `ai://user-input-request`
- `ai://token-usage`
- `ai://error`

Renderer projection keeps using the existing `AiSessionDomainEvent` flow. No UI redesign is expected.

## Legacy Boundaries

These areas intentionally remain in TypeScript for this PR:

- AI history persistence and transcript pagination.
- Review canonical state and accept/reject flows.
- Complete tracked-file diff ownership.
- Runtime settings UI and secret storage.
- Legacy fallback for runtimes not listed in `COMANDO_NATIVE_AI_RUNTIMES`.
- Open file buffer bridge beyond basic compatibility no-ops.

The central invariant is:

```text
sessionId -> owner: native | legacy
```

`prepareSession` decides ownership once. A native session must not also be prepared in the legacy worker, and a legacy session must not be opened in Rust.
