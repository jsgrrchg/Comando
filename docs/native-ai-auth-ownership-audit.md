# Native AI Auth Ownership Audit

Date: 2026-06-21

This note captures the starting point for moving native runtime setup, auth,
secret storage, env resolution, and auth terminal ownership into Rust.

## Comando Ownership Today

| Area | Current owner | Key files | Notes |
| --- | --- | --- | --- |
| Secret persistence | Electron main / SQLite settings | `src/main/ai/secret-store.ts`, `src/main/settings/service.ts` | Secrets are stored as `electron-safe-storage-v1` records in `app_settings`. Rust cannot decrypt those payloads directly. |
| Runtime PATH expansion | TypeScript | `src/main/ai/runtime-env.ts` | TS adds executable dir, user bins, Homebrew paths, system defaults, and inherited `PATH`. |
| Auth terminals | TypeScript | `src/main/ai/auth/terminal-login.ts` | Login flows launch external terminals through temporary scripts. Native terminal sessions already support `purpose: auth`, but AI auth is not wired to them yet. |
| Binary resolution | TypeScript | `src/main/ai/resolver/runtime-resolver.ts`, `src/main/ai/*/setup.ts` | Runtime-specific setup files resolve binaries, auth methods, readiness, credential source, and launch env. |
| Native runtime status | Rust receives TS launch state | `crates/comando-ai/src/engine.rs`, `crates/comando-ai/src/runtime.rs` | `AiEngine::get_runtime_status` delegates to `RuntimeRegistry::status_from_launch`, which requires `launch.status` for native-ready runtimes. |
| Native session launch | Mixed | `src/main/native-backend/ai.ts`, `crates/comando-ai/src/engine.rs`, `crates/comando-ai/src/acp.rs` | TS still builds `NativeAiLaunchSpec`, including env, before Rust spawns ACP. |

The current split means a native session can still depend on TypeScript for
auth readiness, executable selection, credential source, and final env. That is
the split-brain PR 12 needs to remove for native sessions.

## Native Gaps To Close

- `NativeAiRuntimeStatus` lacks several UI-compatible auth fields such as
  credential source labels, auth session/storage messages, and disconnect/logout
  capability flags.
- `apps/native-backend/src/commands.rs` routes AI requests, but the PR 12
  auth/secrets commands are not implemented there yet.
- `comando-ai` has runtime descriptors and ACP launch, but no Rust-owned
  runtime setup store, secret store, env resolver, or auth method matrix.
- `comando-terminal` has the general PTY substrate needed for auth terminals,
  but AI-specific `ai_launch_runtime_auth` behavior is not attached to it.
- Electron main must migrate old `safeStorage` secrets by reading them in TS and
  forwarding plaintext only in-memory to native `secret_set`.

## NeverWrite Reference Patterns

The required local reference is `/Users/jfg/Documents/DEVELOPMENT/NeverWrite`.
Relevant patterns inspected for this PR:

- `apps/desktop/native-backend/src/ai.rs`: `RuntimeSetupStore`,
  `RuntimeSecretStore`, `OsRuntimeSecretStore`, `InMemoryRuntimeSecretStore`,
  `secret_env_keys`, auth terminal lifecycle, and no-leak tests.
- `apps/desktop/native-backend/src/main.rs`: JSONL command routing for
  `ai_start_auth_terminal_session`, terminal write/resize/close, and snapshot
  commands.
- `crates/ai/src/domain.rs`: AI runtime/auth DTO shape and runtime identifiers.
- `crates/ai/src/events.rs`: event naming and payload conventions for runtime
  and terminal auth updates.
- `Cargo.toml`: `keyring` dependency features used by the native backend.

Comando should adapt the storage and lifecycle invariants, not the product
names, vault concepts, `.neverwrite` paths, or `*-acp` runtime IDs.

## Target Ownership

For native sessions:

1. Renderer keeps the existing Settings/UI behavior.
2. Electron main chooses legacy, shadow, or native write mode.
3. Rust loads runtime setup metadata.
4. Rust reads secrets from native secret storage.
5. Rust resolves the binary, auth method, credential source, readiness, and env.
6. Rust spawns ACP using real env and emits only redacted diagnostics/status.

Legacy TypeScript setup remains available behind flags until the old backend is
removed in a later PR.
