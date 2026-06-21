# Native AI Runtime Smoke

This checklist verifies the PR 9 native AI runtime matrix with real local
runtimes. It is a runbook, not proof that the checks were executed. Record the
runtime, date, machine, and result in the PR when a smoke pass is run.

## Flags

Enable the full native matrix:

```text
COMANDO_NATIVE_AI=1
COMANDO_NATIVE_AI_RUNTIMES=codex,claude,opencode,kilo,grok
```

Rollback all native AI routing:

```text
COMANDO_NATIVE_AI=0
```

Rollback one runtime by removing it from the matrix:

```text
COMANDO_NATIVE_AI_RUNTIMES=codex,claude,opencode,kilo
```

## Runtime Commands

Expected launch contracts:

- Codex: `codex-acp`
- Claude: `claude-agent-acp`, or `node <vendor-entry.js>` when resolved by TS
- OpenCode: `opencode acp`
- Kilo: `kilo acp`
- Grok: `grok --no-auto-update agent stdio`

TypeScript remains responsible for runtime setup, settings, secrets, terminal
auth, and the sanitized launch context. Rust owns the ACP process after native
routing is selected.

## Per Runtime Checklist

Run this for each runtime: Codex, Claude, OpenCode, Kilo, and Grok.

1. Start Comando with native AI enabled for the runtime.
2. Open the existing runtime settings/status surface.
3. Confirm the runtime is ready or shows the existing onboarding message.
4. Start a new session.
5. Send a small prompt, such as `Reply with one short sentence.`
6. Confirm `ai://session-created` and `ai://session-updated` events arrive.
7. Confirm `ai://message-started`, `ai://message-delta`, and
   `ai://message-completed` arrive in order.
8. Send a second prompt and cancel while streaming.
9. Confirm cancel returns the session to idle and does not affect other
   sessions.
10. Close the session.
11. Confirm the runtime process exits and no native session handle remains.
12. Confirm logs do not contain prompts, secrets, auth tokens, or raw env
    values.

## Runtime Specific Checks

- Codex: confirm normal streaming still works if provider metadata is emitted.
  When provider-specific subagent metadata is emitted, confirm child sessions
  appear, breadcrumbs open the child session, and output remains owned by the
  child transcript.
- Claude: confirm both direct executable and node wrapper launch contexts are
  accepted when locally available.
- OpenCode: confirm `opencode acp` starts without requiring Rust to verify every
  external auth source.
- Kilo: confirm `kilo acp` uses the env prepared by TypeScript and does not
  require Rust auth-store probing.
- Grok: confirm the launch uses `--no-auto-update agent stdio`; API-key auth
  should map to `xai.api_key`, and external login should map to `cached_token`
  when advertised by the runtime. This rollout uses the current ACP crate and
  does not claim a separate legacy transport.

## Mixed Native And Legacy

1. Enable native AI for one runtime only.
2. Start a native session for that runtime.
3. Start a legacy session for a different runtime.
4. Stream both sessions.
5. Cancel one session.
6. Confirm the other session keeps streaming.
7. Confirm each session keeps its original owner until close.

## Permission And User Input

When a runtime emits permission or elicitation requests:

1. Confirm the renderer receives `ai://permission-request` or
   `ai://user-input-request`.
2. Respond through the existing UI.
3. Confirm Rust resolves the waiting ACP request.
4. Cancel or close the session while a request is waiting.
5. Confirm waiters are cancelled and no later response is accepted for the old
   request id.

## Expected Backend Events

The native path may emit these events:

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

`ai://runtime-connection` is a runtime-level backend diagnostic. It is not UI
copy and does not need a session projection.

## Redaction Checks

Search native backend diagnostics and Electron logs after smoke. The following
must not appear:

- Prompt text beyond the UI transcript itself.
- API keys, bearer tokens, session cookies, auth headers, or custom headers.
- Raw env maps.
- Raw tool output that may contain file contents or secrets.

Safe diagnostics may include runtime ids, command names, status labels, request
ids, and counts.
