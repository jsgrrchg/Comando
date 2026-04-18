Vendored runtimes live here on purpose.

Current scope in Comando:

- `codex-acp/`
  - vendored from the user's previous product baseline
  - used as the local source of truth for staging the bundled ACP runtime

Why this is committed:

- Comando should not depend on a separately installed ACP runtime for normal use
- staging and release inputs must be explicit and reproducible
- local deltas against the vendored runtime should be reviewable in-repo

What should not be committed under vendor:

- `target/`
- `node_modules/`
- temporary caches

Current status:

- Codex is vendored and staged into `resources/ai/binaries/`
- local Rust build caches now live under `resources/ai/embedded/`
- Claude is planned next, but is not vendored in this repository yet
