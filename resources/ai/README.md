This directory contains staged AI runtime assets used by the desktop app.

Generated paths under here are build inputs, not source:

- `binaries/`
  - bundled native executables such as `codex-acp`
- `embedded/`
  - local build caches and embedded runtime support assets
  - current Rust target cache for vendored `codex-acp`
  - future embedded runtimes and support binaries such as Node for Claude

These outputs are prepared by the scripts in `scripts/ai/`.
