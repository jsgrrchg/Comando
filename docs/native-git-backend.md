# Native Git Backend

This document freezes the PR 6 Git contract while the Rust implementation is
rolled out behind feature flags. The renderer-facing IPC contract stays owned by
`src/shared/ipc.ts`; native Git must adapt to that contract instead of adding new
renderer channels.

## Current IPC Surface

Renderer code continues to call the existing channels:

- `git:get-repository-snapshot`
- `git:list-branches`
- `git:list-worktrees`
- `git:list-changes`
- `git:list-history`
- `git:list-worktree-diff`
- `git:get-diff`
- `git:get-original-file`
- `git:get-commit-detail`
- `git:init-repository`
- `git:stage-paths`
- `git:unstage-paths`
- `git:discard-paths`
- `git:commit`
- `git:checkout-branch`
- `git:create-worktree`
- `git:remove-worktree`
- `git:delete-local-branch`
- `git:delete-remote-branch`
- `git:fetch`
- `git:pull`
- `git:push`

`GitGateway` in `src/main/git/service.ts` is the main-process seam.
`NativeGitRoutingGateway` in `src/main/native-backend/git.ts` decides per method
whether the UI is served by the legacy TypeScript worker or the Rust sidecar, and
it always returns the same main-process Git types before `src/main/ipc/index.ts`
adapts them to shared IPC DTOs.

## Native Command Matrix

| Existing GitGateway method | Native command | Default route | Read mode | Write mode | Network flag |
| --- | --- | --- | --- | --- | --- |
| `resolveRepository` | `git_resolve_repository` | TypeScript | Rust | Rust | n/a |
| `getRepositorySnapshot` | `git_get_repository_snapshot` | TypeScript | Rust | Rust | n/a |
| `getStatus` | `git_get_status` | TypeScript | Rust | Rust | n/a |
| `listBranches` | `git_list_branches` | TypeScript | Rust | Rust | n/a |
| `listWorktrees` | `git_list_worktrees` | TypeScript | Rust | Rust | n/a |
| `listRemotes` | `git_list_remotes` | TypeScript | Rust | Rust | n/a |
| `getDiffStats` | `git_get_diff_stats` | TypeScript | Rust | Rust | n/a |
| `getFileDiff` | `git_get_file_diff` | TypeScript | Rust | Rust | n/a |
| `getFileText` | `git_get_original_file` | TypeScript | Rust | Rust | n/a |
| `listHistory` | `git_get_history` | TypeScript | Rust | Rust | n/a |
| `getCommitDetail` | `git_get_commit_detail` | TypeScript | Rust | Rust | n/a |
| `initRepository` | `git_init_repository` | TypeScript | TypeScript | Rust when mutations enabled | n/a |
| `stagePaths` | `git_stage_paths` | TypeScript | TypeScript | Rust when mutations enabled | n/a |
| `unstagePaths` | `git_unstage_paths` | TypeScript | TypeScript | Rust when mutations enabled | n/a |
| `discardPaths` | `git_discard_paths` | TypeScript | TypeScript | Rust when mutations enabled | n/a |
| `commit` | `git_commit` | TypeScript | TypeScript | Rust when mutations enabled | n/a |
| `checkoutBranch` | `git_checkout_branch` | TypeScript | TypeScript | Rust when mutations enabled | n/a |
| `createWorktree` | `git_create_worktree` | TypeScript | TypeScript | Rust when mutations enabled | n/a |
| `removeWorktree` | `git_remove_worktree` | TypeScript | TypeScript | Rust when mutations enabled | n/a |
| `deleteLocalBranch` | `git_delete_local_branch` | TypeScript | TypeScript | Rust when mutations enabled | n/a |
| `fetch` | `git_fetch` | TypeScript | TypeScript | TypeScript | Rust only with `COMANDO_NATIVE_GIT_NETWORK=1` |
| `pull` | `git_pull` | TypeScript | TypeScript | TypeScript | Rust only with `COMANDO_NATIVE_GIT_NETWORK=1` |
| `push` | `git_push` | TypeScript | TypeScript | TypeScript | Rust only with `COMANDO_NATIVE_GIT_NETWORK=1` |
| `deleteRemoteBranch` | `git_delete_remote_branch` | TypeScript | TypeScript | TypeScript | Rust only with `COMANDO_NATIVE_GIT_NETWORK=1` |

## Flags

Native Git is off unless `COMANDO_NATIVE_GIT=1`.

`COMANDO_NATIVE_GIT_MODE` accepts:

- `shadow`: TypeScript serves the UI and Rust parity checks run in the
  background.
- `read`: Rust serves read-only Git data.
- `write`: Rust may serve read-only data and local mutations.

Mutation and network guardrails are separate:

- `COMANDO_NATIVE_GIT_MUTATIONS=1` enables local Rust Git mutations in write
  mode.
- `COMANDO_NATIVE_GIT_NETWORK=1` enables Rust `fetch`, `pull`, `push`, and
  remote branch deletion.

If `COMANDO_NATIVE_GIT=1` is set without a mode, the mode is `shadow`.

The main-process router and the sidecar both enforce guardrails. Local mutation
RPCs return `operation_disabled` unless `COMANDO_NATIVE_GIT=1`,
`COMANDO_NATIVE_GIT_MODE=write`, and `COMANDO_NATIVE_GIT_MUTATIONS=1` are all
set. Network RPCs return `network_disabled` unless those same write-mode flags
and `COMANDO_NATIVE_GIT_NETWORK=1` are set.

## Rollout Invariants

- No renderer IPC channels, copy, layout, keyboard shortcuts, or visible UI
  behavior change in this PR.
- Rust executes `git` directly with argument vectors, never shell strings.
- Read-only Rust commands set `GIT_OPTIONAL_LOCKS=0`.
- Paths passed to Git commands are repository-relative unless the command
  explicitly accepts a worktree path.
- Relative paths reject absolute paths, empty paths, `.`, and `..` segments.
- `--` is used before path arguments.
- Git stderr and remote URLs must be redacted before diagnostics are logged.
- Mutations do not silently fall back to TypeScript once routed to Rust.
- Network commands stay legacy unless `COMANDO_NATIVE_GIT_NETWORK=1`.
- Native invalidation events are small and never include diff contents.
- Shadow diagnostics compare counts, refs, relative paths, hunk counts, and text
  lengths only. They do not log raw diff contents or blob text.
- The native backend client timeout must remain longer than Rust Git command
  timeouts so the UI does not time out before a mutation finishes.
- `git init` is idempotent for existing ready repositories and must not rewrite
  the current branch.
- `discardPaths` discards worktree changes and untracked files; it preserves
  already-staged changes to match the legacy Git service.

## Test Inventory

Existing TypeScript coverage to keep green:

- `src/main/git/service.test.ts`
- `src/main/git/diff.test.ts`
- `src/renderer/src/app/store/git-store.test.ts`
- `src/renderer/src/app/projects/git-tree.test.ts`
- `src/shared/native-backend/fixtures.test.ts`

New Rust coverage should focus on:

- runner args, env, timeout, output limits, and redaction
- repository discovery for ready, missing, not-repo, bare, and nested paths
- porcelain v2 status parsing for staged, unstaged, untracked, conflicts,
  renames, copies, deletes, and type changes
- branches, remotes, worktrees, snapshots, diffs, original file reads, history,
  commit detail, local mutations, network guardrails, and invalidation

PR 6 verification commands:

```sh
cargo test -p comando-git -p comando-native-backend
pnpm exec eslint src/main/native-backend/git.ts src/main/native-backend/git.test.ts src/main/index.ts
pnpm exec tsc --noEmit -p tsconfig.node.json --pretty false
pnpm exec vitest run src/main/native-backend src/shared/native-backend src/main/git
pnpm run native:check
```
