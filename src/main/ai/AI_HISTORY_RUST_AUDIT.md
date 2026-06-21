# AI History Audit

Current invariant: Rust owns canonical AI history and review persistence.
Electron main may cache live snapshots and project updates to the renderer, but
it must not write a parallel TypeScript history store.
