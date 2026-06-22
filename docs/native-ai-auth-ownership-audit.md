# Native AI Auth Ownership Audit

Date: 2026-06-21

This audit now records the final ownership after the Rust native backend cutover.

## Ownership

| Area | Owner | Notes |
| --- | --- | --- |
| Secret persistence | Rust native backend | Runtime and app secrets are stored through the OS keyring. Electron main exposes only the UI-facing contract. |
| Runtime setup | Rust native backend | Runtime settings, auth readiness, credential source, and launch env are resolved natively. |
| Auth terminals | Rust native backend | Auth sessions use native terminal ownership and emit redacted status events. |
| Native session launch | Rust native backend | Electron builds UI descriptors and DTOs; Rust owns process launch and ACP lifecycle. |

## Final Invariants

- Electron main must not persist secret payloads directly.
- Secret values, tokens, auth headers, cookies, full env dumps, prompts, transcripts, and raw sensitive terminal output must not be logged.
- Rollback is by shipping an earlier build or a hotfix, not by reactivating a TypeScript backend path inside the same build.

## NeverWrite Reference Patterns

The required local reference is `/Users/jfg/Documents/DEVELOPMENT/NeverWrite`.
Relevant patterns inspected for this migration:

- `apps/desktop/native-backend/src/ai.rs`: runtime setup store, native secret store, auth terminal lifecycle, and no-leak tests.
- `apps/desktop/native-backend/src/main.rs`: JSONL command routing and terminal auth command ownership.
- `crates/ai/src/domain.rs`: runtime/auth DTO shape.
- `crates/ai/src/events.rs`: event naming and payload conventions.
- `Cargo.toml`: `keyring` dependency usage for native secret storage.

Comando adapts the ownership and redaction invariants only; product names, paths,
and runtime IDs remain Comando-specific.
