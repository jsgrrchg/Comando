# Native Backend Protocol

Comando requires the Rust sidecar `comando-native-backend` for local backend
work. Electron main is the UI bridge: it starts the sidecar, performs the
handshake, validates capabilities, routes IPC, projects DTOs, and broadcasts
native events to renderer windows.

Rust owns persistence, project registry, filesystem/project tree/watchers,
search/index, git, terminal PTYs, AI runtime sessions, review state, runtime
auth, and secrets. TypeScript keeps renderer UI, preload contracts, shared DTOs,
thin main-process facades, and migration/test fixtures.

## Startup

Electron main always starts the sidecar. Startup fails if the binary is missing,
the process cannot start, the protocol handshake fails, or the backend reports
an incompatible protocol.

`COMANDO_NATIVE_BACKEND_PATH` is the only supported override. It is for
development and tests, not a product fallback.

Rollback means installing a previous build or shipping a hotfix. There is no
runtime flag that reactivates the retired TypeScript backend.

## Protocol V1

- `protocolVersion`: `1`
- `minimumClientProtocolVersion`: `1`
- `minimumBackendProtocolVersion`: `1`

Breaking changes require a new protocol version. Additive changes should use
capabilities or optional fields.

DTOs live in:

- `src/shared/native-backend/*`
- `crates/comando-types/*`

Protocol fixtures live in:

- `fixtures/native-backend/protocol/*`

When commands or events change, update both the TypeScript and Rust registries
and the fixtures.

## Packaging

Packaged apps include the sidecar under `resources/native/<platform>/<arch>/`.
The app fails clearly if the packaged sidecar cannot be resolved.

Use:

```bash
pnpm run native:build
pnpm run native:stage
node scripts/native/verify-native-backend.mjs
```
