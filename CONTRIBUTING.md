# Contributing to Comando

Thanks for your interest in contributing to Comando. This guide covers the local setup, workflow, validation commands, and project conventions used in this repository.

## Prerequisites

| Tool | Version | Notes |
| ------ | --------- | ------- |
| **Node.js** | `^20.19.0` or `>=22.12.0` | Required for Electron, Vite, tests, and packaging scripts |
| **pnpm** | `10.33.0` | Package manager for the desktop app |
| **Rust** | `1.96` | Pinned by `rust-toolchain.toml`; Edition 2024 across workspace crates |
| **Cargo** | From Rust toolchain | Required for the native backend and shared Rust crates |
| **wasm-bindgen** | When rebuilding WASM | Only needed for `pnpm native:wasm` |

### Platform-specific

- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Windows**: MSVC Build Tools and WebView2
- **Linux**: Standard Rust and Electron packaging dependencies (`build-essential`, `pkg-config`, `curl`, `wget`)

## Repository structure

```text
apps/
  native-backend/        Rust stdio sidecar entrypoint

crates/
  comando-ai/            ACP runtime management, sessions, history, permissions, review bridge
  comando-diff/          Rust diff and review engine plus WASM bindings
  comando-fs/            Project filesystem access, mutations, watchers, tree reads
  comando-git/           Git status, diffs, history, branches, worktrees, mutations
  comando-index/         Project indexing, ranking, path/content search
  comando-persistence/   SQLite store, metadata, health, migrations
  comando-projects/      Project registry and project path metadata
  comando-settings/      Runtime setup state and secret storage
  comando-terminal/      PTY sessions and terminal output
  comando-types/         Shared native protocol and domain DTOs

src/
  main/                  Electron main process, IPC handlers, windows, services
  preload/               Typed renderer bridge
  renderer/              React app, stores, workspace, settings, Git/GitHub UI
  shared/                Shared TypeScript contracts, settings, review helpers, native adapters
  test/                  Shared test helpers

resources/
  ai/                    AI runtime payloads used by dev/build/package flows
  icons/                 Platform icon sources and generated assets

scripts/
  ai/                    AI runtime staging and validation
  native/                Native backend build/stage/verify scripts
  package-*.mjs          macOS, Windows, and Linux packaging workflows

vendor/                  Vendored runtime sources used by build and staging flows
```

## Getting started

From the repo root:

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the Electron app in the `Comando Dev` channel. The `predev` hook builds and stages the Rust native backend in debug mode, then stages the AI runtimes.

If you only need to validate the native backend:

```bash
pnpm native:build
pnpm native:stage
pnpm native:test
```

## Development workflow

### 1. Fork and clone

```bash
git clone <your-fork-url>
cd <your-clone-directory>
```

### 2. Create a branch

```bash
git checkout -b my-change
```

### 3. Make your changes

Keep changes scoped to the feature, bug, or hardening pass you are working on. The product core is already in place, so prefer polish, stability, and clear root-cause fixes over broad speculative rewrites.

Before opening a pull request, run the relevant checks:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

For Rust or native protocol changes:

```bash
pnpm native:test
pnpm native:protocol:check
pnpm native:persistence:check
```

For full local validation:

```bash
pnpm check
```

### 4. Commit and push

```bash
git add <files>
git commit -m "fix(workspace): preserve tab focus after pane split"
git push origin my-change
```

### 5. Open a pull request

Open a PR against `main`. Describe what changed, why it changed, how it was tested, and any known follow-up work. Link related issues when applicable.

## Commit messages

Use a lightweight conventional format:

```text
type(scope): short description
```

**Types**: `fix`, `feat`, `refactor`, `chore`, `docs`, `test`, `perf`

**Scope** is optional but encouraged for targeted changes, for example `workspace`, `git`, `github`, `ai`, `terminal`, `review`, `native`, `settings`, or `packaging`.

**Examples**:

```text
fix(git): refresh worktree status after branch checkout
feat(github): add failed job rerun action
refactor(review): simplify hunk projection state
chore(packaging): refresh generated app icons
```

Keep messages descriptive and action-focused. Write in lowercase unless starting with a proper noun.

## Code style

### TypeScript

- Strict TypeScript is enforced through separate node and web configs.
- Use `import type` for type-only imports when applicable.
- Prefix intentionally unused parameters with `_`.
- Run `pnpm lint` and `pnpm typecheck` before submitting TypeScript-heavy changes.
- Keep shared contracts in `src/shared/` when both main/preload/renderer code need them.

### React

- Use functional components and hooks.
- Keep feature-specific UI close to the workspace/settings area it belongs to.
- Use Zustand for state management where existing stores already model the domain.
- UI text should be in English.
- During UI hardening, prioritize density, scanability, focus states, accessible labels, and responsive behavior over decorative redesigns.

### Rust

- Use the workspace Rust toolchain from `rust-toolchain.toml`.
- Follow `rustfmt` formatting.
- Run `cargo fmt --all` before submitting Rust changes.
- Run `cargo clippy --workspace --all-targets` when changing Rust crates.
- Keep protocol DTOs and shared domain types in `crates/comando-types`.
- Keep durable state and migrations in the persistence/project/settings crates rather than in Electron code.
- Prefer typed errors and explicit result handling over stringly-typed control flow.

### General principles

- **Simplicity first**: choose the smallest solution that addresses the actual issue.
- **Fix root causes**: do not patch around broken state ownership or protocol mismatches.
- **Bounded refactors**: if a fix requires restructuring, keep the refactor scoped to the affected module.
- **No speculative cleanup**: avoid changing unrelated code while touching a file.
- **Local-first behavior**: preserve user data locally and avoid introducing network dependencies into core workflows.
- **Reviewability**: keep commits small and intentional; large single-commit PRs are difficult to review and may be sent back for splitting.

## Testing

### TypeScript and React

```bash
pnpm test              # Run Vitest once
pnpm test:watch        # Watch mode
```

- Test files usually live next to the code they cover.
- Use Vitest assertions and Testing Library for component behavior.
- Mock native backend and Electron boundaries through existing test helpers where possible.
- Add regression coverage for state restoration, review flows, Git/GitHub actions, and IPC contracts when they are touched.

### Rust

```bash
cargo fmt --all
cargo test --workspace
cargo clippy --workspace --all-targets
cargo test -p comando-git
```

Use focused crate tests while iterating. When touching Rust crates, run formatting and Clippy before the broader native checks, then validate protocol, persistence, filesystem, Git, terminal, or AI changes with the relevant native commands.

### Native integration checks

```bash
pnpm native:check
pnpm native:protocol:check
pnpm native:persistence:check
```

`pnpm native:check` builds, tests, stages, verifies the native backend, runs protocol checks, and runs TypeScript checking.

### Native protocol changes

When changing native DTOs, IPC contracts, persistence payloads, or protocol adapters, update the matching TypeScript and Rust tests or fixtures in the same PR. Run:

```bash
pnpm native:protocol:check
```

Protocol changes should remain backward-aware when they touch persisted records, app-data metadata, or transcript/history payloads.

## Dependency and security hygiene

- Explain why new runtime dependencies are needed, especially for large packages or native crates.
- Commit the relevant lockfile updates (`pnpm-lock.yaml` or `Cargo.lock`) with dependency changes.
- Do not commit API keys, GitHub tokens, credentials, local keyring exports, real user app data, or logs containing secrets.
- Avoid adding network calls to core local-first workflows unless the feature explicitly requires them.

## UI QA

For UI changes, verify the states a user is likely to hit: hover, focus, disabled, loading, empty, error, small viewport, and dense content. Check light/dark/system appearance when the affected surface supports it, and include a short visual note or screenshot in the PR for meaningful UI changes.

## Architecture notes

### Frontend stack

- **React 19** + **TypeScript 6** + **Vite 8**
- **Electron 42** with `electron-vite`
- **Tailwind CSS 4** for styling
- **Monaco Editor** for code editing and Monaco Vim support
- **xterm.js** for terminal tabs
- **Zustand** for app and workspace state

### Native backend

- Rust stdio sidecar with JSONL protocol and typed adapters
- SQLite-backed persistence for app state, projects, sessions, settings, and metadata
- OS-backed secret storage for sensitive runtime configuration
- Filesystem watching, project indexing, Git operations, PTY lifecycle, and AI session orchestration
- Rust/WASM diff engine for review hunks and action-log reconciliation

### Key patterns

- **One workspace surface**: files, terminals, Git, GitHub, review, and AI sessions should stay visible and navigable as tabs/panes.
- **Project/worktree awareness**: state should be scoped to the active project and worktree whenever relevant.
- **Typed boundaries**: IPC, native protocol payloads, and shared DTOs should stay explicit and tested.
- **Review-first changes**: treat the AI review layer as a delicate abstraction; preserve inline review, chat diff cards, and Review tab behavior when changing edit flows.
- **Sidecar ownership**: durable, sensitive, and filesystem-heavy work belongs in Rust; Electron should orchestrate and present it.

## AI runtime and native assets

Adding support for more ACP-compatible runtimes is very welcome. When doing so, make sure the runtime integrates cleanly with Comando's AI review layer, including tracked edits, inline review state, chat diff cards, and the Review tab.

AI runtime payloads are staged during dev and build flows:

```bash
pnpm stage:ai
pnpm stage:codex-runtime
pnpm verify:ai-runtimes
```

Do not commit generated package output from `dist/`, `out/`, `build/`, or `target/` unless a maintainer explicitly asks for a generated artifact.

## Packaging

Useful packaging commands:

```bash
pnpm package:mac
pnpm package:win:x64
pnpm package:win:arm64
pnpm package:linux
```

Release commands publish artifacts and should only be used from an intentional release branch with credentials configured:

```bash
pnpm release:mac
pnpm release:win:x64
pnpm release:win:arm64
pnpm release:linux
```

## Versioning

Comando follows Semantic Versioning. During the `0.x` phase, minor bumps may include breaking changes.

Keep version changes synchronized across:

- `package.json`
- `Cargo.toml` workspace package version
- `Cargo.lock`
- `CHANGELOG.md`
- Packaging and release metadata when relevant

## Pull request checklist

- The change is scoped and avoids unrelated cleanup.
- UI copy is in English.
- New or changed behavior has focused tests where practical.
- `pnpm typecheck`, `pnpm lint`, and relevant test commands pass.
- Native protocol or persistence changes include native checks.
- User-facing changes are reflected in docs or `CHANGELOG.md` when appropriate.
