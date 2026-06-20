# Native Search Index PR 5 Notes

This document records the migration contract for the native project search
index. The renderer IPC contract stays unchanged; native search is selected
only by explicit feature flags.

## Scope

- Rust owns the project/worktree path index behind flags.
- Rust can serve complete project entry listing and project entry search in
  read mode.
- TypeScript remains the default path when flags are unset.
- Quick open, file tree filtering, and chat file reference validation keep the
  same renderer-facing API and UI behavior.
- Real git status/diff, terminal, AI, review, and visible content search stay
  outside this PR.

## Current Callers

| Caller | Current contract | Native PR 5 contract |
| --- | --- | --- |
| Quick open | Uses the existing `projects:search-entries` IPC flow and current path ranking | Same IPC flow; ProjectService may route the request to Rust under native search flags |
| File tree filter | Uses project entry search results and optional ancestor directories | Same result shape and ancestor inclusion behavior |
| Chat file mentions | Uses `projects:list-entries` through the renderer file index store | Same IPC flow; native list results adapt to `ProjectTreeNode[]` |
| Project file reference validation | Keeps stale paths visible during invalidation and reloads the complete entry list | Same stale-while-revalidate behavior; native index emits tree invalidations through existing channels |

## Parity Matrix

| Behavior | TypeScript today | Native target |
| --- | --- | --- |
| Empty project entry search | Returns `[]` without building the search index | Returns `[]` without forcing a native build |
| Normalized query | Trimmed and lowercased | Same |
| Pathological token | Token length over 200 characters rejects the candidate | Same |
| Multi-token search | Every token must match | Same |
| Ranking | Score descending, path length ascending, relative path lexicographic | Same |
| `includeAncestorDirectories` | Ancestor directories are inserted before each matching entry, without duplicates | Same |
| Complete entry listing | All indexed files/directories as `ProjectTreeNode[]` | Same shape, git fields left null unless legacy overlay is active |
| Default flags | Legacy TypeScript path | Legacy TypeScript path |
| Shadow mode | Legacy serves UI, native can compare bounded parity | Same |
| Read mode | Native serves list/search, fallback must be explicit | Same |

## Ranking Contract

Native path search must port the current TypeScript scoring literally before
making any ranking improvements:

- exact name: `+420`
- exact path: `+390`
- name starts with token: `+220`
- path starts with token: `+150`
- name substring: `+190 - min(index * 8, 80)`
- path substring: `+120 - min(index * 2, 70)`
- compact subsequence: `+70 - min(extra compact length, 28)`
- depth penalty: `- depth * 4`
- path length penalty: `- min(path length, 160) * 0.02`

The initial Rust implementation should prefer clarity and parity over clever
ranking optimization. Bounded top-k insertion is enough for the first native
path index.

## Editor Index Policy

Comando is a code editor, not a vault.

- Dotfiles, config files, and hidden files are eligible for path search.
- `.git` internals are excluded by default.
- High-churn dependency/build directories are explicitly excluded by policy for
  performance: `node_modules`, `target`, `dist`, `build`, `coverage`, `out`,
  `.next`, `.turbo`, `.cache`.
- Symlinks are not followed by default.
- Direct file reads remain owned by the filesystem layer and are not blocked by
  index policy alone.

## Rollback

Unset `COMANDO_NATIVE_INDEX`, `COMANDO_NATIVE_SEARCH`,
`COMANDO_NATIVE_SEARCH_MODE`, and `COMANDO_NATIVE_CONTENT_SEARCH`. With flags
off, `ProjectRuntime` remains the default owner for complete entry listing and
project entry search.

## Architecture Reference Checked

- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/index/src/index.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/index/src/search.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/index/tests/integration.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/vault/src/watcher.rs`
