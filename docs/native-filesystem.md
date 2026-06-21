# Native Filesystem Backend

Project tree reads, file reads/writes, entry mutations, copy operations,
external mutation recording, reveal helpers, watchers, and search/index
invalidation route through the Rust sidecar.

Electron main keeps `ProjectService` as the UI-facing coordinator. It receives
native filesystem and search gateways and does not start a TypeScript project
worker.

Native watcher events are the source for tree/search invalidation. Errors are
reported explicitly; they do not reactivate the retired TypeScript filesystem
backend.
