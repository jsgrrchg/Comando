# Native AI Backend

This document tracks the first native Rust AI runtime slice for Comando.

## Reference

The local reference architecture reviewed for this work is:

```text
/Users/jfg/Documents/DEVELOPMENT/NeverWrite
```

The relevant patterns are the native backend owning an AI session, a provider-neutral runtime matrix, ACP stdio process ownership, session notification mapping, permission/user-input waiters, and clear runtime readiness separate from UI state.

Comando must not copy NeverWrite names, storage assumptions, vault filesystem policy, UI behavior, or complete review/history ownership in this slice.

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

Unsupported native mutations return typed native AI errors instead of falling through to the TypeScript worker.

## Implemented Events

Native AI streams small semantic events:

- `ai://runtime-status`
- `ai://runtime-connection`
- `ai://session-created`
- `ai://session-updated`
- `ai://session-closed`
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
- Runtimes other than the selected native runtime.
- Open file buffer bridge beyond basic compatibility no-ops.

The central invariant is:

```text
sessionId -> owner: native | legacy
```

`prepareSession` decides ownership once. A native session must not also be prepared in the legacy worker, and a legacy session must not be opened in Rust.
