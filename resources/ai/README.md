This directory contains staged AI runtime assets used by the desktop app.

Generated paths under here are build inputs, not source:

- `binaries/`
  - bundled native executables such as the staged `codex-acp` sidecar
- `embedded/`
  - local build caches and embedded runtime support assets
  - current Rust target cache for vendored `codex-acp`
  - embedded Node plus the staged Claude ACP JavaScript project

These outputs are prepared by the scripts in `scripts/ai/`.
The current vendored Codex sidecar is built from `vendor/codex-acp` (`codex-acp` 0.14.0 on OpenAI Codex Rust `rust-v0.129.0`) and staged with `pnpm run stage:codex-runtime` or `pnpm run stage:ai`.
