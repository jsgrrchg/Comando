# Comando

> A local-first workspace for coding with AI on real codebases. Spawn as many agent chats as you need — the app is built for it.

Comando is a multi-pane workspace designed to let AI operate as a first-class collaborator inside your development flow, without sacrificing control, or proximity to the code.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Electron](https://img.shields.io/badge/Electron-41-47848F)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6)](https://www.typescriptlang.org/)
[![Status](https://img.shields.io/badge/status-hardening-orange)](#project-status)

---

## Table of Contents

- [What is Comando](#what-is-comando)
- [Features](#features)
- [Supported AI runtimes](#supported-ai-runtimes)
- [Requirements](#requirements)
- [Installation](#installation)
- [Scripts](#scripts)
- [Packaging](#packaging)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Tech stack](#tech-stack)
- [Project status](#project-status)
- [Contributing](#contributing)
- [Known Issues](#known-issues)
- [License](#license)

---

## What is Comando

Comando is a development environment built around three principles:

- **Local-first**: all relevant state (sessions, history, workspaces, and encrypted credentials) lives on your machine in SQLite, with secrets protected by Electron `safeStorage`. No proprietary backend, no telemetry, no mandatory remote sync.
- **Codebase-centric**: every AI session is anchored to a specific project root, branch, or worktree.
- **Explicit control**: edits, tool calls, and changes proposed by the AI go through a review flow before being applied. No silent auto-apply.

## Features

- **Multi-pane workspace** with Monaco editor, integrated terminal (xterm + native pty), AI chat, and diff viewer.
- **Persistent AI sessions** anchored to a project, with history, file mentions, and real-time streaming.
- **Inline change review** with per-hunk rejection, similar to Zed, Cursor, Antigravity, and others. There is also a dedicated Review Changes tab.
- **Integrated Git**: history, diff viewer, staging, and commit — all from the UI.
- **Persistent tabs** for files, sessions, commits, and terminals.
- **Project sidebar** with file tree and multi-repo catalog.
- **Activity panel** with event timeline and live tool execution status.
- **Explicit permissions and approvals** for sensitive tool calls.
- **Separate channels** (`dev` and `release`) with independent app identities for local development and packaged builds.

## Supported AI runtimes

Comando implements the [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol) and talks to multiple runtimes:

| Runtime | Provider | Delivery | Authentication |
|---------|----------|----------|----------------|
| **Claude** | Anthropic | Bundled/staged ACP runtime | `~/.claude.json` or `ANTHROPIC_API_KEY` (gateway-compatible via `ANTHROPIC_BASE_URL`) |
| **Codex** | OpenAI | Bundled/staged ACP runtime | ChatGPT login, Codex API key, or OpenAI API key |
| **Gemini** | Google | External runtime | Login via Gemini CLI or API-key-based configuration |
| **Kilo** | Kilo | External runtime | `kilo auth` |

Credentials are stored encrypted via Electron's `safeStorage`.
The `stage:ai` flow currently bundles and packages the Claude and Codex runtimes; Gemini and Kilo are configured as external runtimes.

## Requirements

- **Node.js** `^20.19.0` or `>=22.12.0`
- **pnpm** 10.33.0 (see `packageManager` in `package.json`)
- **Supported platforms**: macOS 15+ (universal arm64 + x64), Windows 10/11 (x64 + arm64)
- C++ toolchain to compile native dependencies during development (`better-sqlite3`, `node-pty`)
- macOS packaging must run on macOS; Windows packaging must run on Windows

## Installation

```bash
# Clone the repository
git clone https://github.com/jsgrrchg/Comando.git
cd Comando

# Install dependencies
pnpm install

# Start in development mode (renderer HMR, main auto-restart)
pnpm dev
```

`pnpm dev` already runs `pnpm stage:ai` through the `predev` hook, so you normally do not need to run it manually.
Run `pnpm stage:ai` yourself only if you want to refresh the staged AI runtimes ahead of time or troubleshoot packaging/runtime issues.

If native dependencies fail after install:

```bash
pnpm rebuild:native
```

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Local development with hot reload on the `Comando Dev` channel |
| `pnpm build` | Production build of `main`, `preload`, and `renderer` |
| `pnpm icons:build` | Generate platform icon assets from source artwork |
| `pnpm lint` | Static validation with ESLint |
| `pnpm test` | Unit tests with Vitest |
| `pnpm test:watch` | Tests in watch mode |
| `pnpm typecheck` | Type checking for `node` and `web` |
| `pnpm check` | Full CI-style check (typecheck + lint + test + build) |
| `pnpm stage:ai` | Stage bundled AI runtimes and embedded assets used by dev/build/package flows |
| `pnpm stage:codex-runtime` | Refresh only the staged Codex runtime payload |
| `pnpm verify:ai-runtimes` | Verify that the staged AI runtimes are valid |
| `pnpm rebuild:native` | Rebuild `better-sqlite3` and `node-pty` |
| `pnpm package:mac` | Build the universal macOS app and local release artifacts |
| `pnpm package:win` | Build the Windows app for the current Windows host architecture |
| `pnpm package:win:x64` | Build the Windows app for `x64` |
| `pnpm package:win:arm64` | Build the Windows app for `arm64` |
| `pnpm release:mac` | Package macOS universal and publish artifacts to the configured provider |
| `pnpm release:win:x64` | Package Windows `x64` and publish artifacts to the configured provider |
| `pnpm release:win:arm64` | Package Windows `arm64` and publish artifacts to the configured provider |

## Packaging

Comando stages the bundled Claude and Codex ACP runtimes automatically before `pnpm dev` and `pnpm build` via the `predev` and `prebuild` hooks. Packaging also relies on the staged embedded Node/runtime payload under `resources/ai`.

Run the staging step manually only when you want to refresh the staged artifacts ahead of time or diagnose runtime/package issues:

```bash
pnpm stage:ai
pnpm verify:ai-runtimes
```

```bash
# macOS only (universal arm64 + x64, produces .dmg + .zip)
pnpm package:mac

# macOS publish (GitHub Releases)
pnpm release:mac

# Windows only
pnpm package:win          # packages the current Windows host arch
pnpm package:win:x64
pnpm package:win:arm64
pnpm release:win:x64
pnpm release:win:arm64
```

Artifacts are generated at:

- macOS: `build/macos-package/project/dist/`
- Windows: `dist/`

For automatic GitHub releases:

- the workflow exports `GH_TOKEN` so `electron-builder` can publish to GitHub Releases
- the publish workflow lives at `.github/workflows/release.yml`
- macOS may publish ad-hoc artifacts until distribution signing and notarization are in place

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Renderer (React)                     │
│  Zustand stores · Monaco · xterm.js · Tailwind              │
└───────────────┬─────────────────────────────────────────────┘
                │  Typed IPC (preload bridge)
                ▼
┌─────────────────────────────────────────────────────────────┐
│                    Main Process (Electron)                   │
│  ┌──────────┐  ┌─────────┐  ┌──────────┐  ┌──────────────┐  │
│  │   IPC    │  │   AI    │  │   Git    │  │  Terminals   │  │
│  │ handlers │  │  (ACP)  │  │  engine  │  │   (node-pty) │  │
│  └──────────┘  └─────────┘  └──────────┘  └──────────────┘  │
│  ┌──────────┐  ┌─────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Projects │  │Workspace│  │ Settings │  │  SQLite      │  │
│  │ catalog  │  │  state  │  │ + secrets│  │ (migrations) │  │
│  └──────────┘  └─────────┘  └──────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│  External runtimes: Claude · Codex · Gemini · Kilo          │
│  (spawned as child processes, NDJSON/stdio communication)   │
└─────────────────────────────────────────────────────────────┘
```

- **IPC** follows the `invoke/handle` pattern with typed contracts in `src/shared/ipc`.
- **Streaming** (AI deltas, pty, git watchers) is published with `webContents.send()` and consumed with `ipcRenderer.on()`.
- **Persistence** in SQLite with a `schema_migrations` table for schema versioning.
- **Secrets** encrypted via the OS `safeStorage`.

## Project structure

```
src/
├── main/                 # Electron main process
│   ├── ai/              # ACP client, runtimes, review flow, runtime setup
│   ├── db/              # SQLite bootstrap
│   ├── git/             # Git operations (simple-git)
│   ├── ipc/             # Typed IPC handlers
│   ├── observability/   # Logging
│   ├── persistence/     # Cross-cutting persistence helpers
│   ├── projects/        # Project catalog and FS access
│   ├── settings/        # Settings service + encryption
│   ├── terminals/       # pty spawning and management
│   ├── testing/         # Main-process test helpers
│   ├── windows/         # Main and settings windows
│   ├── workers/         # Background worker supervisor
│   ├── workspace/       # Workspace state
│   └── index.ts         # Main process entrypoint
├── preload/             # Typed Node ↔ Renderer bridge
├── renderer/            # React frontend
│   └── src/
│       ├── app/         # State, hooks, editor, layout, settings, theme
│       ├── assets/      # Fonts and static renderer assets
│       ├── components/  # UI (sidebar, workspace, settings, git…)
│       ├── App.tsx      # Main window entry
│       ├── SettingsApp.tsx # Settings window entry
│       ├── styles.css   # Tailwind globals
│       └── main.tsx
├── shared/              # IPC contracts, constants, theme tokens
└── test/                # Shared test helpers and fixtures
```

## Tech stack

**Runtime and packaging**
- Electron 41 · electron-vite 5 · electron-builder 26

**Frontend**
- React 19 · TypeScript 6 · Tailwind CSS 4 · Zustand 5
- Monaco Editor · xterm.js · CodeMirror 6 · vscode-textmate

**Backend (main)**
- better-sqlite3 · node-pty · simple-git · `@agentclientprotocol/sdk`

**Tooling**
- Vite 7 · Vitest 4 · ESLint 10 · `@typescript-eslint` 8

## Project status

Comando is currently in the **hardening and UI polish** phase. The functional core (workspace, AI sessions, Git, terminal, review flow, local persistence) is complete and operational. The focus is on stability, performance, visual polish, and pre-release packaging.

Current version: `0.1.0`.

## Contributing

Contributions are welcome. Before opening a PR:

1. Make sure `pnpm check` passes locally.
2. Follow the existing code style and project conventions.
3. Code comments must be written in English; so must the UI.
4. Follow the existing UI conventions. Improvements are welcome, but they should stay aligned with the product's visual language.
5. For large changes, open an issue first to discuss the design.

## Known Issues

1. Files with pending agent review changes cannot be edited. This is intentional: the review flow prioritizes accuracy and reliability over allowing concurrent edits.
2. The Pending review tab may show approximate diffs for some agent edits. Comando tracks pending changes from agent tool-call diffs and reconciles snippet-based edits when possible, but ambiguous snippets can still produce incomplete review data.
3. Scroll restoration is not accurate when switching from inline review to the editable file view.

## License

Comando is distributed under the [Apache License 2.0](./LICENSE).

```
Copyright 2026 Comando contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
