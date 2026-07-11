This directory contains staged AI runtime assets used by the desktop app.

Generated paths under here are build inputs, not source:

- `binaries/`
  - bundled native executables such as the adjacent `codex-acp` and `codex-code-mode-host` sidecars
- `embedded/`
  - local build caches and embedded runtime support assets
  - current Rust target cache for vendored `codex-acp`
  - embedded Node plus the staged Claude ACP JavaScript project

These outputs are prepared by the scripts in `scripts/ai/`.
The current vendored Codex runtime is built from `vendor/codex-acp` (`codex-acp` 0.16.0 on OpenAI Codex Rust `rust-v0.144.0`) and staged with `pnpm run stage:codex-runtime` or `pnpm run stage:ai`.
