# Comando

<img width="3337" height="1532" alt="Captura de pantalla 2026-07-04 a las 9 44 25" src="https://github.com/user-attachments/assets/1ff5563c-814a-46ff-8dbc-cc3eb5746a84" />

Comando is a local-first desktop workspace for coding with multiple AI agents. It is a lightweight agentic code editor, built to keep chats, files, terminals, Git, GitHub, and change review visible in one multipane surface without trying to become a full IDE. Many tools are moving toward chat-centric workflows, making it difficult for users to read and write code; Comando takes the opposite stance, allowing seamless collaboration with agents without compromising proximity to the code. 

Today the repository combines:

- An Electron desktop app with a Rust native backend that owns persistence, filesystem access, project indexing, Git, terminals, secrets, and AI sessions.
- A code-oriented workspace with split panes, persistent tabs, Monaco editing, quick open, project search, Git gutters, and native terminal tabs.
- An ACP-based AI layer with Codex, Claude, Grok, Kilo, and OpenCode runtimes.
- An AI change-review pipeline with inline review inside files, chat-level diff cards, and a dedicated Review tab for keep/reject workflows.
- First-class Git and GitHub surfaces for status, diffs, staging, commits, branches, worktrees, issues, pull requests, checks, Actions logs, releases, and notifications.
- Cross-platform packaging scripts for macOS, Windows, and Linux release artifacts.

## What Comando Is Today

The current product already includes:

- Local project opening, repository cloning, path relocation, project app-data cleanup, and worktree-aware project state
- A desktop workspace with resizable panes, draggable tabs, tab pinning, recently closed tabs, separate project windows, and persisted layout restore
- File tree navigation with filesystem watching, lazy loading, external drops, context actions, and quick open by name or path
- Monaco-based text/code editing with autosave, Vim mode, relative line numbers, minimap and suggestion settings, TextMate tokenization, file icons, and editor zoom controls
- Native terminal tabs powered by a Rust sidecar and `portable-pty`, including workspace-scoped terminal state
- AI chat tabs with queued prompts, image attachments, file/folder/selection mentions, commit mentions, GitHub issue and pull request mentions, and runtime-specific model/mode/config controls
- AI session history with transcript paging, pinned conversations, rename/delete flows, and project/worktree scoping
- Explicit agent permissions, user-input routing, live tool activity, generated-image previews, and Codex subagent session projection
- Inline AI review for supported file changes, hunk-level keep/reject actions, conflict states, and a dedicated Review tab backed by Rust/WASM diff logic
- Git status, history, commit details, staged/unstaged diffs, staging, unstaging, discard, commit, fetch, pull, push, branch creation/checkout/deletion, and worktree creation/removal/diffing
- GitHub issues, pull requests, comments, labels, milestones, checks, workflow runs, job logs, artifacts, annotations, failed-job reruns, run cancellation, notifications, release notes, and release publishing
- App settings for AI providers, theme presets, light/dark/system appearance, app zoom, file tree scale, agent sidebar scale, editor typography, chat typography, terminal shell, and update behavior

AI conversations and workspace state are stored locally in the app data area managed by the native backend. Secrets are stored through OS-backed secret storage instead of plaintext settings files.

## Why It Is Different

Many tools are moving toward chat-centric workflows that distance users from reading and writing code directly. Comando takes the opposite stance, code stays visible, editable, and reviewable, and agent-emitted tool activity is not hidden behind secondary menus. Everything remains inspectable for the user, with one project branch per window by design.

- Agents are not treated as one chat sidebar. Comando is designed around many concurrent agent sessions, split panes, terminals, diffs, and files in the same working surface.
- Agent edits stay reviewable. Comando tracks proposed changes through action logs, inline decorations, hunk controls, and a dedicated review surface before they become accepted workspace state.
- The app is project and worktree aware. AI sessions, Git state, GitHub context, terminal tabs, and history are scoped to the codebase you are actually working in.
- GitHub is part of the workflow. Issues, pull requests, checks, Actions logs, and release flows can be opened as workspace tabs and attached directly to prompts. You can drag issues and pull request to the composer of agents.
- Comando is intentionally lighter than a full code editor or IDE. It is not trying to absorb language servers, debugger stacks, refactoring engines, extension marketplaces, task runners, or every deep editor feature from VS Code, JetBrains, Zed, or similar tools. 
- The architecture is local-first. Electron is mostly the UI and orchestration layer; the Rust sidecar owns the durable and sensitive work.

## Current Capabilities

### Projects and workspace

- Open local folders and clone repositories into the project catalog.
- Track recent projects, active project, active worktree, and per-project settings.
- Open multiple project windows with persisted window and workspace state.
- Split panes horizontally or vertically, drag tabs between panes, pin tabs, reorder tabs, and reopen recently closed tabs.
- Open file, chat, chat history, review, Git, Git commit, Git worktree diff, GitHub issue, GitHub pull request, GitHub list, and terminal tabs.
- Use quick create and quick open flows for files, terminals, Git views, chat history, and new agent sessions.
- Search project entries through the native index and fuzzy file ranking.

### Editing and navigation

- Edit text and code files through Monaco.
- Use autosave, configurable font families, font size, line height, minimap, suggestions, relative line numbers, and Vim mode.
- Render file icons through Catppuccin-style type icons.
- Attach selected editor lines to chat as structured context.
- See live Git gutter changes while editing.
- Open files at specific line ranges from transcript, review, tool, Git, and GitHub references.
- Create, copy, rename, delete, trash, reveal, and externally open project entries.

### AI and change control

- Run ACP sessions for Codex, Claude, Grok, Kilo, and OpenCode (more to come).
- Configure runtime auth methods, custom binary paths, gateway URLs, API keys, and diagnostics from settings.
- Launch runtime auth flows from the app when supported.
- Send prompts with file mentions, folder mentions, selection mentions, external file references, Git commits, GitHub issues, GitHub pull requests, and image attachments.
- Queue prompts while a turn is active, edit queued prompts, pause queue draining, and resume manually.
- Stream messages, tool activity, plans, status events, user-input requests, permission prompts, and generated images.
- Keep AI session history locally with transcript paging, pinned sessions, title editing, and deletion.
- Review agent edits inline in the editor, inside chat tool cards, or in the Review tab.
- Keep or reject complete files, selected hunks, or all pending tracked files.
- Preserve unresolved review state across live snapshots and persisted transcripts.

### Git and GitHub

- Resolve repository state from the active project or worktree.
- View Git status, sync status, remotes, branches, worktrees, history, commit details, diffs, and original file contents.
- Stage, unstage, discard, commit, checkout, create branches, delete local/remote branches, create/remove worktrees, fetch, pull, push, clone, and initialize repositories.
- Resolve GitHub repositories from remotes and authenticate with a saved token or available `gh` CLI token.
- List, open, create, update, comment, close, and reopen issues.
- List, open, create, update, comment, mark ready, convert to draft, and request reviewers on pull requests.
- Inspect checks, workflow runs, jobs, logs, artifacts, and check-run annotations.
- Rerun failed workflow jobs and cancel workflow runs when the token has permission.
- List notifications, releases, labels, and milestones.
- Generate release notes, create releases, and publish draft releases.

### Native backend

- JSONL stdio sidecar with protocol negotiation and typed IPC adapters.
- SQLite-backed app persistence, project registry, workspace snapshots, settings, and app-data records.
- OS-backed keyring/safe-storage integration for AI
- Filesystem service for reads, writes, mutations, copy operations, tree listing, and watch invalidation.
- Incremental project indexing and content/path search with cancellation.
- Git command execution, parsing, status snapshots, diffs, worktrees, and mutation results.
- Terminal lifecycle and output streaming through `portable-pty`.
- AI runtime setup, session lifecycle, history, transcript storage, permissions, user input, and review disk mutations.
- Rust/WASM diff engine for review hunks and action-log reconciliation.

## Repository Layout

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
  ai/                    Staged AI runtime payloads used by dev/build/package flows
  icons/                 Platform icon sources and generated icon assets

scripts/
  ai/                    AI runtime staging and validation
  native/                Native backend build/stage/verify scripts
  package-*.mjs          macOS, Windows, and Linux packaging workflows

vendor/
  codex-acp/             Vendored Codex ACP runtime source
  Claude-agent-acp-upstream/
                          Vendored Claude ACP runtime project
```

## Stack

- **Desktop shell**: Electron 42, electron-vite 5, electron-builder 26, electron-updater
- **Frontend**: React 19, TypeScript 6, Vite 8, Tailwind CSS 4, Zustand 5
- **Editor and terminal**: Monaco Editor, vscode-textmate, vscode-oniguruma, xterm.js, Monaco Vim
- **Native backend**: Rust 2024, `rusqlite`, `keyring`, `notify`, `portable-pty`, `agent-client-protocol`, `imara-diff`
- **AI runtimes**: ACP over staged/bundled sidecars and external runtime commands
- **Testing**: Vitest for TypeScript, Cargo tests for Rust crates, fixture parity tests for native protocol payloads

## Development

Requirements:

- Node.js `^20.19.0` or `>=22.12.0`
- pnpm `10.33.0`
- Rust and Cargo
- `wasm-bindgen` only when rebuilding the review WASM bundle with `pnpm native:wasm`

Install and run:

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the Electron app in the `Comando Dev` channel. The `predev` hook builds and stages the Rust native backend in debug mode, then stages the AI runtimes.

Useful development commands:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm check
```

Native backend commands:

```bash
pnpm native:build
pnpm native:test
pnpm native:stage
pnpm native:check
pnpm native:wasm
```

AI runtime commands:

```bash
pnpm stage:ai
pnpm stage:codex-runtime
pnpm verify:ai-runtimes
```

## Validation

Full app validation:

```bash
pnpm check
```

That runs TypeScript checks, ESLint, Vitest, and the production Electron build.

Rust workspace tests:

```bash
cargo test --workspace
```

Native protocol and persistence checks:

```bash
pnpm native:protocol:check
pnpm native:persistence:check
```

The repository contains broad Vitest coverage for renderer stores/components, main-process services, IPC adapters, Git/GitHub behavior, native backend bridges, review logic, and packaging helpers, plus Rust tests across the native crates.

## Packaging

Packaging must run on the target platform.

macOS:

```bash
pnpm package:mac
pnpm release:mac
```

Windows:

```bash
pnpm package:win
pnpm package:win:x64
pnpm package:win:arm64
pnpm release:win:x64
pnpm release:win:arm64
```

Linux:

```bash
pnpm package:linux
pnpm package:linux:appimage
pnpm package:linux:deb
pnpm package:linux:rpm
pnpm release:linux
```

Generated artifacts are written to platform-specific build output directories:

- macOS: `build/macos-package/project/dist/`
- Windows and Linux: `dist/`

Packaging stages the native backend sidecar and AI runtime payloads under `build/package-resources/`. macOS builds produce universal `.dmg` and `.zip` artifacts. Windows builds produce NSIS installers for `x64` and `arm64`. Linux builds target AppImage, deb, and rpm.

## AI Runtime Notes

Comando currently wires five ACP runtimes:

- `codex`
- `claude`
- `grok`
- `kilo`
- `opencode`

Current staging status:

- Codex is staged as a native sidecar binary from `vendor/codex-acp`, or from `COMANDO_CODEX_ACP_BUNDLE_BIN` when a prebuilt bundle binary is provided.
- Claude is staged from `vendor/Claude-agent-acp-upstream` with an embedded Node runtime.
- Grok, Kilo, and OpenCode are integrated as configurable external runtimes and require their corresponding CLI/auth setup or API-key configuration.

Runtime binary overrides during development:

- `COMANDO_CODEX_ACP_BIN`
- `COMANDO_CLAUDE_ACP_BIN`
- `COMANDO_GROK_ACP_BIN`
- `COMANDO_KILO_ACP_BIN`
- `COMANDO_OPENCODE_ACP_BIN`

Bundle/staging overrides:

- `COMANDO_CODEX_ACP_BUNDLE_BIN`
- `COMANDO_EMBEDDED_NODE_BIN`

Credential environment variables recognized by diagnostics include:

- `OPENAI_API_KEY`
- `CODEX_API_KEY`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_BEDROCK_BASE_URL`
- `ANTHROPIC_CUSTOM_HEADERS`
- `XAI_API_KEY`
- `KILO_API_KEY`
- `OPENCODE_API_KEY`

Secrets saved through the settings UI are stored securely via the native secret store. External CLI logins remain owned by their respective runtimes.

## Project Status

Comando is in a polish and hardening phase. The core systems already exist: workspace, editor, AI sessions, review flow, Git, GitHub, terminal, native persistence, and packaging. The project is still pre-`1.0`, and the most important work now is stability, performance, UI polish, and release hardening. Do not rely on Comando as your only IDE yet.

The areas with the highest product sensitivity right now are:

- AI review and change control
- Inline review and hunk-level keep/reject behavior
- Session history, transcript recovery, and long conversation performance
- Multi-pane and multi-window workspace restoration
- Git worktree flows and GitHub Actions diagnostics
- Packaged runtime staging across macOS, Windows, and Linux

## Known Rough Edges

- Files with pending agent review changes cannot be edited until the pending AI review state is resolved. This is intentional for now.
- Some pending review diffs can be approximate when an agent edit is based on ambiguous snippets, or when the agents makes changes without using the edit tool.
- Scroll restoration can be imperfect when switching between inline review and editable file views.
- Acrylic transparency does not render reliably on Windows 10; as a workaround, Windows 10 users can disable window transparency in Settings > Appearance.

## License

Comando is distributed under the GNU General Public License v3.0.

```text
Copyright 2026 Comando contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
```
