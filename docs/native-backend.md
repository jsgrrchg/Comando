# Native Backend Bootstrap

Comando can optionally launch a Rust sidecar named `comando-native-backend`.
The sidecar is disabled by default and PR 1 only provides bootstrap plumbing:
JSONL transport, health checks, capabilities, a test event, staging, packaging
resources, and clean shutdown.

This PR does not move AI, filesystem, git, terminal, persistence, or review
behavior into Rust.

## Flags

- `COMANDO_NATIVE_BACKEND=1` enables the sidecar in Electron main.
- `COMANDO_NATIVE_BACKEND_PATH=/path/to/comando-native-backend` overrides path
  resolution.
- `COMANDO_NATIVE_BACKEND_STRICT=1` makes startup fail when the enabled sidecar
  cannot be found or started.

With `COMANDO_NATIVE_BACKEND` unset, Comando uses the existing TypeScript path.

## JSONL Protocol

Requests are one JSON object per line on stdin:

```json
{"id":1,"command":"backend_ping","args":{}}
```

Responses and events are one JSON object per line on stdout:

```json
{"type":"response","id":1,"ok":true,"result":{"pong":true,"backend":"comando-native-backend"}}
{"type":"event","eventName":"backend://test-event","payload":{"message":"hello"}}
```

stdout is reserved for JSONL. Diagnostics and logs must go to stderr.

Supported commands:

- `backend_ping`
- `backend_capabilities`
- `backend_emit_test_event`
- `backend_shutdown`

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
pnpm run native:stage
pnpm run native:check
```

`native:stage` stages the host platform and architecture by default. To stage a
different target, pass an explicit binary:

```bash
node scripts/native/stage-native-backend.mjs --platform linux --arch x64 --binary /path/to/comando-native-backend
```

## Manual Smoke

```bash
pnpm run native:build
pnpm run native:stage
COMANDO_NATIVE_BACKEND=1 pnpm run dev
```

Expected result:

- the app opens normally
- Electron main logs native backend ping/capabilities
- `backend://test-event` is forwarded on `native-backend:event`
- closing the app sends `backend_shutdown`

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
