# Native Filesystem PR 4 Notes

This document records the filesystem invariants for the native project tree
migration. The renderer IPC contract stays unchanged; native code is only
selected by feature flags.

## Scope

- Native Rust owns project tree child listing, file reads, writes, create,
  rename, delete, copy, external copy, bounded diagnostic entry listing,
  watcher lifecycle, write tracking, and coalesced invalidations.
- Advanced search/indexing, real git status/diff, terminal, AI, and review
  workflows stay on the existing TypeScript paths.
- With all native filesystem flags off, the existing TypeScript runtime remains
  the only implementation.

## Routing Modes

- `COMANDO_NATIVE_FS_MODE=shadow`: TypeScript serves the UI. Native may observe
  or run diagnostics, but does not write and does not replace visible UX.
- `COMANDO_NATIVE_FS_MODE=read`: Native serves tree/file reads. Complete entry
  listing and search remain on the legacy TypeScript path until the indexing
  migration.
- `COMANDO_NATIVE_FS_MODE=write`: Native serves tree/file reads and filesystem
  mutations routed through `ProjectService`. Writes must not fall back silently.

If `COMANDO_NATIVE_FS=1` is set without an explicit mode, the mode is `shadow`.

## Parity Matrix

| Current TypeScript behavior | Native PR 4 behavior |
| --- | --- |
| `ProjectRuntime.listProjectTreeChildren` | `project_list_tree_children`, adapted to `ProjectTreeNode` |
| `ProjectRuntime.listProjectEntries` | Legacy TypeScript until the native index/search migration; `project_list_entries` is bounded and diagnostic only |
| `ProjectRuntime.openProjectFile` | `fs_read_file`, adapted to `ProjectFileDocument` |
| `ProjectRuntime.saveProjectFile` | `fs_write_file` in write mode only |
| `ProjectRuntime.createProjectEntry` | `fs_create_file` / `fs_create_directory` in write mode only |
| `ProjectRuntime.copyProjectEntries` | `fs_copy_entries` in write mode only |
| `ProjectRuntime.copyExternalProjectEntries` | `fs_copy_external_entries` in write mode only |
| `ProjectRuntime.renameProjectEntry` | `fs_rename_entry` in write mode only |
| `ProjectRuntime.deleteProjectEntry` | `fs_delete_entry` in write mode only |
| `ProjectRuntime.recordProjectEntryMutation` | `fs_record_external_mutation` in write mode, legacy otherwise |
| `ProjectRuntime.searchProjectEntries` | Legacy TypeScript until PR 5 |
| Git badges / ignored checks | Legacy TypeScript until PR 6 |

## Visibility Policy

Comando is a code editor, not a vault. Dotfiles, config files, and generated but
relevant files must remain navigable. The native policy may mark noisy
directories such as `node_modules`, `dist`, `target`, `build`, `coverage`, and
`out`, but must not hide them irreversibly. `.git` is explicit special handling:
visible as an entry, but not expanded by default for safety and performance.

## Safety Policy

- Relative paths use `/`.
- Empty path is allowed only for root-oriented operations.
- Empty segments, `.`, `..`, backslashes, and Windows-like prefixes are invalid.
- Reads and writes resolve against the native project/worktree registry.
- New paths validate the nearest existing ancestor before joining the target.
- Existing symlinks/reparse points in scoped components are rejected for reads
  and writes so operations cannot escape the allowed root.
- Delete rejects the project root.
- Folder rename/copy rejects moving or copying a directory into itself.
- Native errors are typed and avoid logging file contents or raw secret values.

## Watcher Policy

Native watchers are per project/worktree root. Events are normalized to relative
paths and coalesced over a short debounce window close to the legacy 140 ms
behavior. Own writes are tracked briefly so external invalidations are not
double-counted after native mutations.
