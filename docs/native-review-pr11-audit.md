# PR 11 Native Diff Review Audit

## Current Ownership

| Area | Current owner | Native target |
| --- | --- | --- |
| Line diff generation | `src/shared/ai-tracked-file.ts` (`computeDiffHunks`) | `crates/comando-diff` using Histogram diff |
| Tracked file merge/sync | `src/shared/ai-tracked-file.ts` | `comando-diff` for pure text decisions, native review state for canonical snapshots |
| Tool/output diff normalization | `src/main/ai/review-core.ts` and `src/main/ai/worker-runtime.ts` | Native review reconciliation and later provider-neutral tool diff adapters in `comando-ai` |
| Native turn reconciliation | `src/main/ai/service.ts` git-status baseline fallback | Sidecar-owned review state behind `COMANDO_NATIVE_REVIEW` |
| Keep/reject file | `src/main/ai/worker-runtime.ts` | Native review commands validating current content before mutation |
| Keep/reject hunks | `resolveTrackedFileHunks` plus worker writes | `comando-diff` hunk decisions plus sidecar validation/writes |
| Reject all rollback | `src/main/ai/worker-runtime.ts` path backups | Native preflight, backup, mutation, rollback |
| Renderer projection | `ai-store.ts`, review panel, inline decorations | Unchanged UI consuming canonical tracked-file payloads |

## NeverWrite References Consulted

- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/diff/src/lib.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/diff/src/action_log.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/diff/src/wasm_bindings.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/ai/src/tool_diffs.rs`

The implementation borrows the dedicated diff crate shape, Histogram line diff, UTF-16 span math, JSON WASM bindings, and the separation between canonical review decisions and UI projection. It does not copy NeverWrite naming, vault assumptions, storage paths, or UI behavior.

## Required Edge Cases

- Keep/reject must not write when disk or a dirty buffer no longer matches reviewed content.
- Hunk decisions must preserve CRLF/LF and no-newline-at-EOF behavior as far as the current review payload can represent it.
- Reject all must preflight all files and roll back already-mutated files if a later mutation fails.
- Create reject must delete only when the file content matches the agent-created reviewed content.
- Update reject must restore old text only when the current file matches reviewed current text.
- Delete reject must restore old text only when the path has not been recreated conflictively.
- Move reject must validate both current and previous paths.
- Binary and oversized files must be represented as conflicts or non-text tracked files without sending huge content to the renderer.
- Native and legacy sessions must have a single review owner; legacy keeps the worker path.
- Any new visible error text must be in English and avoid file content, prompts, secrets, raw tool output, and large payloads.

## Rollout

Native review is guarded by the existing native AI gates plus the review flag:

- `COMANDO_NATIVE_AI=1`
- `COMANDO_NATIVE_REVIEW=1`
- `COMANDO_NATIVE_REVIEW_MODE=shadow|write` is reserved for rollout policy; the current sidecar path is only used when `COMANDO_NATIVE_REVIEW=1`.
- `COMANDO_NATIVE_REVIEW_WASM=1` is reserved for renderer-side WASM projection helpers.

Native sessions route review state through the sidecar. Legacy sessions continue using the TypeScript worker review owner. The renderer still receives the existing `AiTrackedFile` shape and keeps the current review panel and inline review UI.

## Rollback

Use one of these levers without deleting persisted state:

- `COMANDO_NATIVE_REVIEW=0`
- unset `COMANDO_NATIVE_AI`
- keep native AI enabled but route a runtime out of `COMANDO_NATIVE_AI_RUNTIMES`

Rollback does not remove `review-state.json`; the sidecar will leave persisted native review state in place for later rehydration.

## Commands And Events

Native review commands:

- `ai_capture_review_baseline`
- `ai_reconcile_tracked_files`
- `ai_list_tracked_files`
- `ai_load_review_state`
- `ai_keep_tracked_file`
- `ai_reject_tracked_file`
- `ai_keep_tracked_file_hunks`
- `ai_reject_tracked_file_hunks`
- `ai_keep_all_tracked_files`
- `ai_reject_all_tracked_files`
- `ai_notify_file_buffer`

Native review events:

- `ai://review-updated`
- `ai://tracked-file-updated`

## Validation Used

- `cargo test -p comando-native-backend -p comando-ai -p comando-diff`
- `pnpm exec vitest run src/shared/native-backend src/main/native-backend src/main/ai/service.review.test.ts src/renderer/src/components/workspace/ReviewTabView.test.ts`
- `pnpm exec tsc --noEmit -p tsconfig.node.json`
- `pnpm exec tsc --noEmit -p tsconfig.web.json`

The WASM build script is present as `pnpm native:wasm`; the local toolchain currently has only native Apple targets installed, so `wasm32-unknown-unknown` must be installed before verifying that script.
