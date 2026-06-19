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
  - upstream baseline: `zed-industries/codex-acp` `0.15.0`
  - synced against upstream commit `863d433fc91855d0b5427372bf635c894bf68cb6`
  - OpenAI Codex Rust crates: `rust-v0.133.0`
  - vendor ACP SDK: `agent-client-protocol` `0.12.1`
  - includes upstream's local `codex-utils-pty` patch under `vendor/codex-acp/vendor/codex-utils-pty`
  - local Comando delta remains intentionally bounded and currently lives in:
    - `vendor/codex-acp/Cargo.toml`
    - `vendor/codex-acp/src/lib.rs`
    - `vendor/codex-acp/src/codex_agent.rs`
    - `vendor/codex-acp/src/prompt_args.rs`
    - `vendor/codex-acp/src/subagents.rs`
    - `vendor/codex-acp/src/thread.rs`
- `Claude-agent-acp-upstream/`
  - vendored snapshot is currently based on `@agentclientprotocol/claude-agent-acp` `0.42.0`
  - synced against upstream commit `d877ee713383332267492a95425523eda65a9735`
  - uses `@agentclientprotocol/sdk` `0.24.0` and `@anthropic-ai/claude-agent-sdk` `0.3.165`
  - includes upstream fixes for stable message IDs, cancellation backstops, per-session tool cache pruning, refusal handling, permission-denied tool updates, context usage after compaction, `availableModels` allowlists, real `Write` overwrite diffs, task-notification result origins, SDK settings defaults, task-hook mirroring and local command stdout rendering

## Current Codex Delta

The Codex vendor is no longer a raw upstream checkout.

The remaining Comando-specific delta exists to preserve desktop product behavior:

- canonical `codexAcp*` ACP metadata for status, plan updates, diffs and `user_input_request`
- `__codex_acp_user_input_response__` user-input response routing
- reconstruction of `unified_diff` into `old_text`, `new_text` and hunk metadata for inline review and edited-files flows
- mode and approval-preset stability on top of Codex permission profiles
- custom slash-prompt discovery and expansion from the user's Codex prompts directory
- local `gpt-5.5` model-catalog seed while upstream Codex metadata catches up
- Fast service-tier controls exposed to the desktop UI
- generated-image bridge that emits live Codex image generation begin/end events and replayed image generation response items as ACP `image_generation` tool updates for inline chat rendering
- session-config synchronization from Codex `SessionConfiguredEvent` back into the ACP session config
- subagent session registration and breadcrumb notifications for spawned Codex child threads
- state DB/thread-store/installation ID wiring required by the `rust-v0.133.0` Codex runtime API
- async auth reload/logout compatibility for ChatGPT and API-key auth flows
- O(N²) exec-output fallback fix from upstream while preserving Comando's exec snapshot diff reconstruction

When updating Codex again, treat `863d433` plus the current OpenAI Codex crate tag as the comparison base, and review those files intentionally instead of replacing the whole directory blindly.

Comando's ACP client lives in TypeScript/Electron under `src/main/ai/` and currently uses `@agentclientprotocol/sdk` from npm. Do not copy a Rust workspace ACP client migration unless Comando gains an equivalent Rust backend.

## Current Claude Delta

The Claude vendor is based on upstream `@agentclientprotocol/claude-agent-acp`
`0.42.0`.

Comando currently carries one source-level Claude ACP delta in:

- `vendor/Claude-agent-acp-upstream/src/acp-agent.ts`
- `vendor/Claude-agent-acp-upstream/src/tests/acp-agent.test.ts`

The delta suppresses provisional live `usage_update` notifications while
Claude ACP still only knows the generic `200000` token context-window fallback.
Claude can emit those updates during `stream_event` before the later
`result.modelUsage` message reports the real model context window, such as a
1M-token Opus window. Publishing the provisional value makes Comando's context
usage bar appear artificially inflated during the turn, then snap back when the
final result arrives.

The local patch tracks whether `contextWindowSize` came from the default
placeholder, a model-name heuristic, or authoritative `modelUsage`. Streaming
usage updates are only published once the size is no longer the default
placeholder; final result usage updates still publish normally with cost and
the modelUsage window.

When updating Claude again, check upstream for an equivalent fix before
carrying this delta forward. As of upstream `v0.48.0`, upstream still emits the
streaming `usage_update` with `session.contextWindowSize` and has no equivalent
`contextWindowSizeSource` guard.

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

Suggested validation after Claude vendor updates:

```bash
cd vendor/Claude-agent-acp-upstream
npm ci
npm run build
npm test -- --run
cd ../..
node scripts/ai/stage-claude-runtime.mjs
pnpm run verify:ai-runtimes
```

Suggested validation after Codex vendor updates:

```bash
cd vendor/codex-acp && cargo test --locked
pnpm run stage:codex-runtime
pnpm test -- src/main/ai/worker-runtime.test.ts src/main/ai/service.codex.test.ts src/main/ai/service.review.test.ts src/main/ai/codex/setup.test.ts
pnpm run verify:ai-runtimes
pnpm run typecheck
```

If the staging script cannot find Cargo even though Rust is installed, run it with an explicit path, for example:

```bash
CARGO=/Users/jfg/.cargo/bin/cargo pnpm run stage:codex-runtime
```

For broader release confidence:

```bash
pnpm run verify:ai-runtimes
pnpm run build
```
