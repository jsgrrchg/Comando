# AI History Rust Rollout

Date: 2026-06-20

## Flags

- `COMANDO_NATIVE_AI=1`: enables native AI runtime routing.
- `COMANDO_NATIVE_AI_RUNTIMES=codex,claude,opencode,kilo,grok`: selects native runtimes.
- `COMANDO_NATIVE_AI_HISTORY=1`: enables Rust-owned AI history reads and mutations through the native gateway.

## Modes

The current PR keeps rollout explicit:

- Flags off: legacy TypeScript/SQLite history remains the source of truth.
- Native AI on, native history off: native runtime sessions can run, but history reads continue through legacy persistence.
- Native AI history on: Rust history storage is used first, with read-only SQLite fallback for legacy sessions.

## Storage

Native history stores session data under the app data directory:

```text
ai/
  sessions/
    session-<sha256(session_id)>/
      session-meta.json
      session-state.json
      transcript.jsonl
      index.json
      compact-state.json
  migrations/
    sqlite-history-v1.json
```

The logical `sessionId` is preserved in metadata. The directory name is a hash so dangerous ids cannot escape the app data root.

## Migration

`ai_migrate_session_history` copies legacy SQLite sessions into native history storage. It is idempotent and non-destructive:

- Existing native sessions win and are skipped.
- `mode: "read_only"` performs a dry run without writing native sessions or a manifest.
- `limit` bounds the number of legacy sessions processed in one run.
- SQLite legacy tables are not deleted or modified.
- Failures are recorded per session in the migration output and manifest.
- Payloads are not logged.

`ai_list_session_runtime_mappings` exposes native subagent runtime mappings so resumed parent sessions can reattach child runtime sessions without falling back to SQLite.

## Rollback

Immediate rollback:

```text
COMANDO_NATIVE_AI_HISTORY=0
```

Full native AI rollback:

```text
COMANDO_NATIVE_AI=0
```

Rollback does not delete native history storage. Legacy SQLite remains available for sessions that were not migrated.

## Smoke Checklist

- Create a native AI session.
- Send a prompt and confirm the user message is persisted to Rust history.
- Close and reopen the session from history.
- Continue a reopened native session and confirm prior transcript messages remain visible.
- Load the transcript page.
- Open a native subagent from history and confirm it remains scoped to the parent project/worktree.
- Pin and unpin the native session.
- Rename the native session.
- Delete the native session.
- Run legacy read fallback for a SQLite-only session.
- Run migration twice and confirm the second run skips migrated sessions.
