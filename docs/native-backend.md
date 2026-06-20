# Native Backend Protocol

Comando can optionally launch a Rust sidecar named `comando-native-backend`.
The sidecar is disabled by default. The current native backend owns the
versioned transport contract, bootstrap commands, capabilities, JSON fixtures,
clean shutdown, persistence/project registry, and the native filesystem/project
tree domain behind flags.

Rust can open the current Comando SQLite store and own `project_list` /
`project_add` only when the explicit native project registry write flag is set.
Rust can also own project tree, file read/write, filesystem mutations, copies,
and watcher invalidations when native filesystem flags are enabled. Search,
real git status/diff, terminal, AI, review, and renderer UI behavior remain
owned by the existing TypeScript path.

## Flags

- `COMANDO_NATIVE_BACKEND=1` enables the sidecar in Electron main.
- `COMANDO_NATIVE_BACKEND_PATH=/path/to/comando-native-backend` overrides path
  resolution.
- `COMANDO_NATIVE_BACKEND_STRICT=1` makes startup fail when the enabled sidecar
  cannot be found or started.
- `COMANDO_NATIVE_PERSISTENCE=1` opens the current SQLite store from Rust after
  the DB worker is ready.
- `COMANDO_NATIVE_PERSISTENCE_STRICT=1` makes native persistence startup errors
  fail app startup instead of falling back.
- `COMANDO_NATIVE_PROJECT_REGISTRY=1` enables native project registry
  integration. With no mode set, it runs in `shadow`.
- `COMANDO_NATIVE_PROJECT_REGISTRY_MODE=shadow` compares native list output with
  the legacy store and logs diagnostics without writing from Rust.
- `COMANDO_NATIVE_PROJECT_REGISTRY_MODE=write` routes project list/add through
  Rust. Other project operations still delegate to the legacy store and refresh
  the native-backed cache.
- `COMANDO_NATIVE_FS=1` enables native filesystem routing. With no mode set, it
  runs in `shadow`.
- `COMANDO_NATIVE_FS_MODE=shadow` keeps the TypeScript filesystem path visible.
- `COMANDO_NATIVE_FS_MODE=read` routes file reads through Rust. Project tree
  child reads route through Rust only when `COMANDO_NATIVE_PROJECT_TREE=1` is
  also set.
- `COMANDO_NATIVE_FS_MODE=write` routes file writes and filesystem mutations
  through Rust. Write operations do not silently fall back to TypeScript.
- `COMANDO_NATIVE_PROJECT_TREE=1` enables native project tree child reads in
  read or write mode. Complete project entry listing/search remains on the
  legacy TypeScript index until the search/indexing migration.
- `COMANDO_NATIVE_WATCHERS=1` enables native watcher registry sync and native
  `project://tree-invalidated` events in read or write mode.
- `COMANDO_NATIVE_INDEX=1` enables the native project index domain. With
  search enabled and no explicit search mode, the search rollout runs in
  `shadow`.
- `COMANDO_NATIVE_SEARCH=1` enables native path search routing eligibility.
- `COMANDO_NATIVE_SEARCH_MODE=shadow` keeps TypeScript serving
  `projects:list-entries` and `projects:search-entries` while Rust can run
  bounded parity checks.
- `COMANDO_NATIVE_SEARCH_MODE=read` routes complete project entry listing and
  project entry search through Rust. TypeScript does not build the same search
  index for that scope unless fallback is explicitly enabled.
- `COMANDO_NATIVE_SEARCH_FALLBACK=1` allows read mode to fall back to the
  legacy TypeScript search/index path after a native search failure.
- `COMANDO_NATIVE_CONTENT_SEARCH=0` is the default. Visible content search is
  not part of this rollout.

With flags unset, Comando uses the existing TypeScript path. Write mode requires
`COMANDO_NATIVE_BACKEND=1`, `COMANDO_NATIVE_PERSISTENCE=1`, and
`COMANDO_NATIVE_PROJECT_REGISTRY=1`.

## Protocol V1

Initial protocol constants:

- `protocolVersion`: `1`
- `minimumClientProtocolVersion`: `1`
- `minimumBackendProtocolVersion`: `1`

Breaking changes must define a new protocol version. Additive changes should
prefer capabilities or optional fields. Electron main performs
`backend_handshake` before using the sidecar and treats incompatible protocol
versions as startup failures for the native backend path, not renderer crashes.

There are two DTO layers:

- Native protocol DTOs under `src/shared/native-backend/*` and
  `crates/comando-types/*` describe Rust <-> Electron main.
- Current IPC DTOs under `src/shared/ipc.ts` remain the Electron/preload/renderer
  contract.

Adapters in `src/shared/native-backend/adapters.ts` are intentionally small and
temporary. If an adapter needs domain logic, that logic belongs in the future PR
that migrates the domain.

## JSONL Transport

Requests are one JSON object per line on stdin:

```json
{"id":"req_1","command":"backend_ping","args":{},"meta":{"protocolVersion":1,"sentAt":"2026-06-20T00:00:00.000Z","windowId":null,"projectId":null,"worktreeId":null}}
```

Responses and events are one JSON object per line on stdout:

```json
{"type":"response","id":"req_1","ok":true,"result":{"pong":true,"backend":"comando-native-backend"},"meta":{"protocolVersion":1,"handledAt":"2026-06-20T00:00:00.010Z"}}
{"type":"event","eventName":"backend://test-event","payload":{"message":"hello"},"meta":{"protocolVersion":1,"emittedAt":"2026-06-20T00:00:00.010Z","projectId":null,"worktreeId":null,"windowId":null}}
```

stdout is reserved for JSONL. Diagnostics and logs must go to stderr.

Request IDs may be strings or numbers for compatibility. New TypeScript calls
use string IDs (`req_1`, `req_2`, ...). Command names use `snake_case`. Event
names use `domain://event-name`.

Error responses always use this shape:

```json
{"code":"unknown_command","message":"Unknown command: missing","details":null,"retryable":false}
```

Initial error codes:

- `invalid_json`
- `invalid_request`
- `unknown_command`
- `invalid_args`
- `unsupported_protocol_version`
- `unsupported_schema_version`
- `not_supported`
- `backend_not_ready`
- `operation_cancelled`
- `operation_timeout`
- `permission_denied`
- `not_found`
- `conflict`
- `too_large`
- `binary_file`
- `external_change`
- `internal_error`

## Handshake And Capabilities

Bootstrap commands implemented by the sidecar:

- `backend_ping`
- `backend_handshake`
- `backend_capabilities`
- `backend_emit_test_event`
- `backend_shutdown`

`backend_handshake` input:

```json
{"clientName":"comando-electron-main","clientVersion":"0.1.0","protocolVersion":1,"supportedProtocolVersions":[1]}
```

`backend_capabilities` returns the versioned capabilities shape:

```json
{
  "backendName": "comando-native-backend",
  "backendVersion": "0.1.0",
  "rustVersion": "1.96",
  "protocolVersion": 1,
  "minimumClientProtocolVersion": 1,
  "minimumBackendProtocolVersion": 1,
  "capabilities": {
    "domains": ["backend", "persistence", "projects", "project-tree", "fs", "index", "search", "git", "terminal", "settings", "secret", "ai", "review", "workspace"],
    "commands": ["backend_ping"],
    "events": ["backend://test-event"],
    "features": ["bootstrap", "versioned-protocol", "json-fixtures", "native-persistence", "native-project-registry", "native-fs", "native-watchers"]
  }
}
```

The actual command and event registries live in:

- Rust: `crates/comando-types/src/commands.rs`,
  `crates/comando-types/src/events.rs`
- TypeScript: `src/shared/native-backend/commands.ts`,
  `src/shared/native-backend/events.ts`
- Fixtures: `fixtures/native-backend/protocol/registry.commands.json`,
  `fixtures/native-backend/protocol/registry.events.json`

When adding a command or event, update the Rust registry, TS registry, fixture,
DTOs if needed, and fixture tests in the same change.

## Native Persistence And Project Registry

PR 3 adds two crates:

- `crates/comando-persistence`: opens the existing SQLite database, configures
  `busy_timeout`, validates the current schema, writes native metadata, and
  reports storage health.
- `crates/comando-projects`: reads visible projects/worktrees and implements
  native `project_add` with canonical path handling, hidden-project revive,
  recent-project touch, roots, and primary worktrees.

The native metadata table is additive and idempotent:

```sql
CREATE TABLE IF NOT EXISTS native_backend_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Initial keys:

- `native.schema_version`
- `native.last_opened_at`
- `native.storage_mode`
- `native.protocol_version`

Rust validates these existing tables before opening project registry routes:

- `projects`
- `project_roots`
- `project_worktrees`
- `recent_projects`
- `workspace_sessions`

Rust does not modify AI, workspace layout, git, terminal, review, or search
tables in this PR. Native filesystem writes are real user file writes, gated by
`COMANDO_NATIVE_FS_MODE=write`.

### Commands

`persistence_open_store` configures the sidecar with paths supplied by Electron
main:

```json
{
  "appDataDir": "/Users/example/Library/Application Support/Comando",
  "databasePath": "/Users/example/Library/Application Support/Comando/comando.sqlite3",
  "mode": "shadow"
}
```

`persistence_get_storage_health` returns reachability, schema compatibility,
metadata state, and visible project/worktree counts.

`project_list` returns visible project summaries and worktrees from the current
SQLite store. `project_add` validates existing directories, canonicalizes paths,
reuses hidden project IDs, ensures roots and `${projectId}:primary`, touches
`recent_projects`, and returns a project state snapshot for the TypeScript cache.

### Shadow Mode

Shadow mode is the default when `COMANDO_NATIVE_PROJECT_REGISTRY=1`.

- TypeScript remains the user-visible writer.
- Rust reads the same SQLite store.
- Electron main compares native state with the legacy `ProjectStore` snapshot at
  startup and after registry-changing legacy operations.
- Diagnostics include counts and IDs, not full paths.

### Write Mode

Write mode requires `COMANDO_NATIVE_PROJECT_REGISTRY_MODE=write`.

- `ProjectService.listProjects()` reads from a native-backed cache.
- `ProjectService.addProjectPaths()` calls native `project_add`; legacy does not
  write the same add operation in parallel.
- Unsupported project operations still use the existing legacy store and refresh
  the native-backed cache afterward when the operation is async.
- The renderer, IPC channels, window flow, and UI text remain unchanged.

## Native Filesystem And Project Tree

PR 4 adds `crates/comando-fs`, used by the sidecar to resolve project/worktree
roots from the native project registry and perform local filesystem operations
inside those roots.

Native commands:

- `project_list_tree_children`
- `project_list_entries` for bounded diagnostics/basic traversal. Electron
  main does not use it for complete `ProjectService.listProjectEntries` results
  while the TypeScript search index remains authoritative.
- `fs_read_file`
- `fs_write_file`
- `fs_create_file`
- `fs_create_directory`
- `fs_rename_entry`
- `fs_delete_entry`
- `fs_copy_entries`
- `fs_copy_external_entries`
- `fs_record_external_mutation`
- `fs_reveal_entry_info`
- `fs_watch_start`
- `fs_watch_stop`
- `fs_watch_sync_registry`

Native events:

- `project://tree-invalidated`
- `fs://entry-created`
- `fs://entry-updated`
- `fs://entry-deleted`
- `fs://entry-renamed`
- `fs://watch-started`
- `fs://watch-stopped`
- `fs://watch-error`
- `fs://operation-error`
- `fs://origin-tracked`

Path safety rules:

- Relative paths use `/`.
- Empty path is allowed only for root-oriented operations.
- Empty segments, `.`, `..`, backslashes, and Windows-like prefixes are invalid.
- Reads/writes resolve against the project/worktree root from the native
  registry.
- New paths validate the nearest existing ancestor.
- Existing symlink/reparse components are rejected for scoped reads and writes.
- Delete rejects the project root.
- Folder rename/copy rejects moving or copying a directory into itself.

Tree visibility is editor-oriented. Dotfiles and config files are visible.
Noisy directories such as `node_modules`, `dist`, `target`, `build`,
`coverage`, and `out` are marked as noisy rather than hidden. `.git` is marked
special and is not expanded by default.

Rollback:

```bash
unset COMANDO_NATIVE_FS
unset COMANDO_NATIVE_PROJECT_TREE
unset COMANDO_NATIVE_WATCHERS
unset COMANDO_NATIVE_FS_MODE
```

or leave `COMANDO_NATIVE_BACKEND` disabled. The TypeScript filesystem/runtime
path remains the default with flags off.

## Paths

Resolution order:

1. `COMANDO_NATIVE_BACKEND_PATH`
2. `target/debug/comando-native-backend`
3. `target/debug/comando-native-backend.exe`
4. `target/release/comando-native-backend`
5. `target/release/comando-native-backend.exe`
6. `process.resourcesPath/native/<platform>/<arch>/comando-native-backend`
7. `process.resourcesPath/native/<platform>/<arch>/comando-native-backend.exe`

Packaged resources are staged under:

```text
build/package-resources/native/<platform>/<arch>/comando-native-backend
```

## Scripts

```bash
pnpm run native:build
pnpm run native:test
pnpm run native:protocol:check
pnpm run native:stage
pnpm run native:check
```

`native:stage` stages the host platform and architecture by default. To stage a
different target, pass an explicit binary:

```bash
node scripts/native/stage-native-backend.mjs --platform linux --arch x64 --binary /path/to/comando-native-backend
```

The macOS package workflow builds and stages both `darwin/arm64` and
`darwin/x64` sidecars for the universal app. It installs the required Rust
targets with `rustup target add` before building.

## Manual Smoke

```bash
pnpm run native:build
pnpm run native:stage
COMANDO_NATIVE_BACKEND=1 pnpm run dev
```

Expected result:

- the app opens normally
- Electron main logs native backend handshake/capabilities
- `backend://test-event` is forwarded on `native-backend:event`
- closing the app sends `backend_shutdown`

Native project registry shadow smoke:

```bash
COMANDO_NATIVE_BACKEND=1 COMANDO_NATIVE_PERSISTENCE=1 COMANDO_NATIVE_PROJECT_REGISTRY=1 pnpm run dev
```

Expected result:

- the app opens normally
- native persistence health is logged
- project registry parity diagnostics are logged
- adding a project still uses the legacy writer

Native project registry write smoke:

```bash
COMANDO_NATIVE_BACKEND=1 COMANDO_NATIVE_PERSISTENCE=1 COMANDO_NATIVE_PROJECT_REGISTRY=1 COMANDO_NATIVE_PROJECT_REGISTRY_MODE=write pnpm run dev
```

Expected result:

- list/add project flows work through the existing UI
- Rust writes project list/add records
- tree, watcher, git, AI, terminal, and review behavior remain on legacy paths

## Fixtures

Fixtures under `fixtures/native-backend` are the compatibility contract for PRs
that follow. They must use stable ISO timestamps, fake paths such as
`/tmp/comando-project`, and no secrets. Rust tests in
`crates/comando-types/tests/fixtures.rs` and TS tests in
`src/shared/native-backend/fixtures.test.ts` must accept the same files.

## Rollback

Unset `COMANDO_NATIVE_BACKEND`, `COMANDO_NATIVE_PERSISTENCE`, and
`COMANDO_NATIVE_PROJECT_REGISTRY`. The existing TypeScript implementation
remains the default path. To leave the sidecar on but disable Rust project
writes, use `COMANDO_NATIVE_PROJECT_REGISTRY_MODE=shadow` or unset
`COMANDO_NATIVE_PROJECT_REGISTRY`.

## Architecture Reference

The sidecar shape was checked against NeverWrite, specifically:

- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/apps/desktop/native-backend/src/main.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/types/src/domain.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/types/src/dto.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/vault/src/vault.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/vault/src/error.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/vault/tests/integration.rs`

Copied patterns: JSONL over stdin/stdout, response/event envelopes, state owned
by the sidecar, serializable errors across the RPC boundary, path normalization
before persistence, and temp-directory integration tests.

Not copied: vault assumptions, note filtering, `.neverwrite` storage, vault
watchers/indexing, or file visibility rules. Comando project registry models
developer folders and repos, not note vaults.
