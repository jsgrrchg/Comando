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

