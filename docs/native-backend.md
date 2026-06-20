# Native Backend Protocol

Comando can optionally launch a Rust sidecar named `comando-native-backend`.
The sidecar is disabled by default. The current native backend owns the
versioned transport contract, bootstrap commands, capabilities, JSON fixtures,
and clean shutdown.

This layer does not move AI, filesystem, git, terminal, persistence, or review
behavior into Rust yet. TypeScript remains the functional owner until a later
domain PR explicitly moves ownership behind a flag.

## Flags

- `COMANDO_NATIVE_BACKEND=1` enables the sidecar in Electron main.
- `COMANDO_NATIVE_BACKEND_PATH=/path/to/comando-native-backend` overrides path
  resolution.
- `COMANDO_NATIVE_BACKEND_STRICT=1` makes startup fail when the enabled sidecar
  cannot be found or started.

With `COMANDO_NATIVE_BACKEND` unset, Comando uses the existing TypeScript path.

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
    "domains": ["backend"],
    "commands": ["backend_ping"],
    "events": ["backend://test-event"],
    "features": ["bootstrap", "versioned-protocol"]
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

## Fixtures

Fixtures under `fixtures/native-backend` are the compatibility contract for PRs
that follow. They must use stable ISO timestamps, fake paths such as
`/tmp/comando-project`, and no secrets. Rust tests in
`crates/comando-types/tests/fixtures.rs` and TS tests in
`src/shared/native-backend/fixtures.test.ts` must accept the same files.

## Rollback

Unset `COMANDO_NATIVE_BACKEND`. The existing TypeScript implementation remains
the default path.

## Architecture Reference

The sidecar shape was checked against NeverWrite, specifically:

- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/apps/desktop/native-backend/src/main.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/apps/desktop/native-backend/src/ai.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/ai/src/events.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/ai/src/domain.rs`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/diff/Cargo.toml`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/index/Cargo.toml`
- `/Users/jfg/Documents/DEVELOPMENT/NeverWrite/crates/vault/Cargo.toml`

Only the sidecar transport pattern was copied: JSONL over stdin/stdout, response
and event envelopes, a single stdout writer, diagnostics on stderr, and tests
that treat events as backend outputs.
