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
  - OpenAI Codex Rust crates: `rust-v0.144.0`
  - resolved OpenAI Codex commit: `767822446c7a594caa19609ca435281a9ec67e0d`
  - vendor ACP SDK: `agent-client-protocol` `0.14.0`
  - known rollback baseline: `rust-v0.137.0` from Comando `main`
  - includes a local `codex-utils-pty` patch aligned with the embedded Codex Rust runtime under `vendor/codex-acp/vendor/codex-utils-pty`
  - local Comando delta remains intentionally bounded and currently lives in:
    - `vendor/codex-acp/Cargo.toml`
    - `vendor/codex-acp/Cargo.lock`
    - `vendor/codex-acp/build.rs`
    - `vendor/codex-acp/src/lib.rs`
    - `vendor/codex-acp/src/codex_agent.rs`
    - `vendor/codex-acp/src/prompt_args.rs`
    - `vendor/codex-acp/src/subagents.rs`
    - `vendor/codex-acp/src/thread.rs`
    - `vendor/codex-acp/vendor/codex-utils-pty`
- `Claude-agent-acp-upstream/`
  - vendored snapshot is currently based on `@agentclientprotocol/claude-agent-acp` `0.63.0`
  - synced against upstream commit `15979bba7907484ee22111cdc33b79b0bdcd452d`
  - uses `@agentclientprotocol/sdk` `1.3.0` and `@anthropic-ai/claude-agent-sdk` `0.3.220`
  - runs with the pinned official Node.js `22.23.1` distribution, verified by SHA-256 during preparation
  - matches the upstream source snapshot without Comando-specific source changes

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
- state DB/thread-store/installation ID wiring required by the `rust-v0.144.0` Codex runtime API
- compatibility shims for `rust-v0.144.0` auth, model discovery, MCP config, `PathUri`, and turn-event APIs
- async auth reload/logout compatibility for ChatGPT and API-key auth flows
- O(N²) exec-output fallback fix from upstream while preserving Comando's exec snapshot diff reconstruction
- one canonical ACP projection per Codex turn item, including typed web/image extensions
- multi-agent v2 `SubAgentActivity` breadcrumbs with late child metadata reconciliation
- a build-time Codex tag marker embedded in `codex-code-mode-host` so packaging can reject mixed bundles

### Codex patch ownership and coverage

| Area | Local responsibility | Primary coverage |
| --- | --- | --- |
| Compile/runtime API | Keep the legacy ACP adapter compiling against the pinned Codex tag | `cargo check --manifest-path vendor/codex-acp/Cargo.toml` |
| Code Mode bundle | Build, stage, and verify `codex-acp` plus `codex-code-mode-host` atomically | `scripts/ai/codex-runtime-version.test.mjs`, packaging preflights |
| Catalog/config | Project runtime models and refresh config options after selection | `src/main/ai/service.codex.test.ts` |
| Permissions | Preserve ACP approvals, elicitations, cancellation, and late-response cleanup | `vendor/codex-acp/src/thread.rs` tests |
| Terminal/diffs/review | Preserve streaming output, stable IDs, hunks, and anchored diffs | vendor and `crates/comando-ai/src/acp.rs` tests |
| Sessions/history | Resume without replay and normalize legacy duplicate activities idempotently | `crates/comando-ai/src/history.rs`, `src/main/ai/session-core.test.ts` |
| Subagents | Project v1 collaboration and v2 activity into navigable child sessions | `vendor/codex-acp/src/subagents.rs`, `crates/comando-ai/src/acp.rs` tests |
| Packaging | Reject incomplete, stale, or mixed Codex runtime bundles | staging and macOS/Windows/Linux package scripts |

When updating Codex again, treat `863d433` plus the current OpenAI Codex crate tag as the comparison base, and review those files intentionally instead of replacing the whole directory blindly.

Comando's primary ACP boundary lives in the Rust native backend. Electron main adapts runtime settings, IPC DTOs, review state, and UI-facing status, but it does not depend on the TypeScript ACP SDK from the root package. Claude is the intentional exception: its vendored runtime carries its own encapsulated `@agentclientprotocol/sdk` dependency and is staged separately with the Claude runtime payload.

## Current Claude Delta

The Claude vendor is based on upstream `@agentclientprotocol/claude-agent-acp` `0.63.0` with no Comando-specific source delta. The Agent/Task trailer parser hardening that previously existed as a local patch is now provided by upstream commit `06c3d7bdbd8cc9415c8cabac060a50e0951c758b`, so it is no longer maintained separately. Claude PostToolUse structured patch responses are translated inside Comando's internal review adapter, which keeps review behavior out of the vendored runtime and allows future updates to remain direct upstream syncs.

The runtime includes the optional `providers/*`, `_session/steering`, and `subagent-transcript` capabilities, but Comando does not consume them. Prompt queuing and “Send now” continue to use Comando's shared queue and cancel-then-dispatch flow.

When updating Claude again, compare against upstream commit `15979bba7907484ee22111cdc33b79b0bdcd452d` and review any ACP event-shape or Claude Agent SDK changes before replacing the vendor snapshot.

## Updating Vendored Runtimes

Why this is committed:

- Comando should not depend on a separately installed ACP runtime for normal use
- staging and release inputs must be explicit and reproducible
- local deltas against the vendored runtime should be reviewable in-repo

What should not be committed under vendor:

- `target/`
- `node_modules/`
- temporary caches

Claude staging downloads and caches the official Node.js `22.23.1` distribution for the host platform and architecture under the ignored `resources/ai/prebuilt/node/` directory. Each supported archive has a pinned SHA-256 digest, and staging executes the copied binary before accepting it. `COMANDO_EMBEDDED_NODE_BIN` remains available as an explicit development override for a compatible standalone Node binary.

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
