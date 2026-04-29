Vendored runtimes live here on purpose.

Current scope in Comando:

- `codex-acp/`
  - used as a Rust crate and sidecar build input during desktop builds
  - staged as the bundled Codex ACP runtime for normal app use
- `Claude-agent-acp-upstream/`
  - vendored snapshot of the Claude ACP runtime used by Comando
  - staged separately by the AI runtime verification and build scripts

## Current Baselines

- `codex-acp/`
  - upstream baseline: `zed-industries/codex-acp` `0.12.0`
  - synced against upstream commit `ee9418a65befdf08c3793d9a92dd4a083f545fcf`
  - OpenAI Codex Rust crates: `rust-v0.124.0` (`e9fb49366c93a1478ec71cc41ecee415a197d036`)
  - vendor ACP SDK: `agent-client-protocol` `0.11.1`
  - local Comando delta remains intentionally bounded and currently lives in:
    - `vendor/codex-acp/Cargo.toml`
    - `vendor/codex-acp/src/lib.rs`
    - `vendor/codex-acp/src/codex_agent.rs`
    - `vendor/codex-acp/src/prompt_args.rs`
    - `vendor/codex-acp/src/thread.rs`
- `Claude-agent-acp-upstream/`
  - vendored snapshot is currently based on `@agentclientprotocol/claude-agent-acp` `0.31.4`
  - synced against upstream commit `9957b54` (`chore(main): release 0.31.4 (#611)`)

## Current Codex Delta

The Codex vendor is no longer a raw upstream checkout.

The remaining Comando-specific delta exists to preserve desktop product behavior:

- canonical `codexAcp*` ACP metadata for status, plan updates, diffs and `user_input_request`
- `__codex_acp_user_input_response__` user-input response routing
- reconstruction of `unified_diff` into `old_text`, `new_text` and hunk metadata for inline review and edited-files flows
- mode and approval-preset stability when Codex expands writable roots under `workspace-write`
- custom slash-prompt discovery and expansion from the user's Codex prompts directory
- local `gpt-5.5` model-catalog seed while upstream Codex metadata catches up
- Fast service-tier controls exposed to the desktop UI
- generated-image bridge that emits Codex image generation events as ACP `image_generation` tool updates for inline chat rendering
- session-config synchronization from Codex `SessionConfiguredEvent` back into the ACP session config

When updating Codex again, treat `ee9418a` plus the current OpenAI Codex crate tag as the comparison base, and review those files intentionally instead of replacing the whole directory blindly.

Comando's ACP client lives in TypeScript/Electron under `src/main/ai/` and currently uses `@agentclientprotocol/sdk` from npm. Do not copy a Rust workspace ACP client migration unless Comando gains an equivalent Rust backend.

## Updating Vendored Runtimes

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
- Claude is vendored under `Claude-agent-acp-upstream/`

Suggested validation after Codex vendor updates:

```bash
cd vendor/codex-acp && cargo test -q
pnpm run stage:codex-runtime
pnpm test -- src/main/ai/worker-runtime.test.ts src/main/ai/service.codex.test.ts src/main/ai/service.review.test.ts src/main/ai/codex/setup.test.ts
pnpm run typecheck
```

For broader release confidence:

```bash
pnpm run verify:ai-runtimes
pnpm run build
```
