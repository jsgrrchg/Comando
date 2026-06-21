# AI History Rust Audit

Date: 2026-06-20

## References

Comando:

- `src/main/ai/persistence.ts`
- `src/main/ai/persistence.test.ts`
- `src/main/ai/service.ts`
- `src/main/ai/service.history.test.ts`
- `src/main/db/migrations.ts`
- `src/shared/ipc.ts`
- `src/renderer/src/components/workspace/ChatHistoryTabView.tsx`
- `src/renderer/src/components/workspace/chat-history/sessionHierarchy.ts`
- `src/main/native-backend/ai.ts`
- `src/shared/native-backend/ai.ts`
- `src/shared/native-backend/adapters.ts`
- `src/shared/native-backend/commands.ts`
- `apps/native-backend/src/commands.rs`
- `crates/comando-types/src/ai.rs`
- `crates/comando-types/src/commands.rs`
- `crates/comando-ai/src/lib.rs`

NeverWrite:

- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/ai/src/persistence.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/ai/src/domain.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/ai/src/events.rs`

## Existing Behavior To Preserve

- `AiPersistence.saveSessionSnapshot` currently owns SQLite AI history. It writes `chat_sessions`, `chat_transcripts`, `chat_transcript_messages`, `chat_session_runtime_state`, `chat_session_review_state`, and `chat_session_runtime_links`.
- `loadSessionSnapshot` reconstructs from `chat_session_runtime_state`, but prefers `chat_transcript_messages` for `messages` when shadow messages exist.
- `loadSessionTranscriptPage` reads pages from `chat_transcript_messages`, normalizing `offset` to `>= 0` and truncating `limit` into `1..=200`.
- `listSessionHistory` filters by `projectId` and `worktreeId`; `null` means the global no-project/no-worktree scope, not a wildcard.
- History currently returns `pinnedAt`, while existing UI logic keeps the current visual and hierarchy behavior.
- Root sessions with no messages are hidden. Child/subagent sessions are preserved even when `messageCount = 0`.
- `runtimeSessionId` and parent links are resolved through `chat_session_runtime_links`; a parent reference can be an app session id or runtime session id.
- `deleteSession` deletes by `chat_sessions.id`; related rows rely on existing cascade/schema behavior.
- `setSessionPinned` only mutates `chat_sessions.pinned_at`.
- `renameSession` updates the full snapshot for non-live sessions and delegates to the legacy worker for live legacy sessions.
- `handleNativeSessionEvent`, `handleNativeSessionCatalogPatch`, `#acceptPreparedLiveSnapshot`, and tracked-file reconciliation still call `saveSessionSnapshot` for native sessions. PR 10 must remove that split-brain write path.
- The renderer continues to use the same public IPC channels and must not need visual changes.

## Initial Native Gaps

- `NativeAiGateway` does not yet expose history methods for snapshot, pin, delete, historical rename, migration, or storage health.
- `apps/native-backend/src/commands.rs` routes AI runtime commands, but does not yet implement the full history command set.
- `crates/comando-types/src/ai.rs` lacks native DTOs for history summary/page/snapshot/mutations/migration/health.
- `crates/comando-ai` does not yet provide `ai/sessions` storage, metadata JSON, transcript JSONL, index, compaction, recovery, or SQLite migration.
- `AiService` does not yet route history reads/writes by Rust-vs-legacy ownership.
- With native history flags disabled, the SQLite path must remain intact.

## Test Surface

- Existing TS tests to preserve: `src/main/ai/persistence.test.ts` and `src/main/ai/service.history.test.ts`.
- New TS coverage needed: native owner routing, NativeAiGateway history parsers, no `saveSessionSnapshot` for native sessions, and legacy fallback.
- New Rust coverage needed: safe storage keys, metadata roundtrip, transcript JSONL/index, long transcript paging, compaction/recovery, legacy SQLite reader, and idempotent migration.

## NeverWrite Patterns To Adapt

- Session directory storage with `session-<sha256(session_id)>`.
- `session-meta.json`, `transcript.jsonl`, `index.json`, and `compact-state.json`.
- Offset/length/hash index as the source of truth for paging.
- Append new or changed messages while reusing offsets for unchanged messages.
- Compaction with temp files, backups, and recovery marker.
- Do not copy `.neverwrite` paths, `vault` names, or the simplified message shape. Comando must persist payloads compatible with `AiMessage`.
