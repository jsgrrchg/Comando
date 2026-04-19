# Comando

> A local-first workspace for coding with AI on real codebases.

Comando is an Electron desktop application that orchestrates AI-assisted programming directly on local repositories. It is not a chat embedded in an editor, nor a web client wrapped in a shell: it is a multi-pane workspace designed to let AI operate as a first-class collaborator inside your development flow, without sacrificing control, privacy, or proximity to the code.

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
- [License](#license)

---

## What is Comando

Comando is a development environment built around three principles:

- **Local-first**: all relevant state (sessions, history, credentials, workspaces) lives on your machine in SQLite and the OS keychain. No proprietary backend, no telemetry, no mandatory remote sync.
- **Codebase-centric**: every AI session is anchored to a specific project root. The AI works on real files, not pasted snippets.
- **Explicit control**: edits, tool calls, and changes proposed by the AI go through a review flow before being applied. No silent auto-apply.

## Features

- **Multi-pane workspace** with Monaco editor, integrated terminal (xterm + native pty), AI chat, and diff viewer.
- **Persistent AI sessions** anchored to a project, with history, file mentions, and real-time streaming.
- **Change review** side-by-side before accepting AI-proposed edits, with per-hunk rejection.
- **Integrated Git**: history, diff viewer, staging, and commit — all from the UI.
- **Persistent tabs** for files, sessions, commits, and terminals.
- **Project sidebar** with file tree and multi-repo catalog.
- **Activity panel** with event timeline and live tool execution status.
- **Explicit permissions and approvals** for sensitive tool calls.
- **Separate channels** (`dev` and `release`) with independent app identities for local development and packaged builds.

## Supported AI runtimes

Comando implements the [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol) and talks to multiple runtimes:

| Runtime | Provider | Authentication |
|---------|----------|----------------|
| **Claude** | Anthropic | `~/.claude.json` or `ANTHROPIC_API_KEY` (gateway-compatible via `ANTHROPIC_BASE_URL`) |
| **Codex** | OpenAI | ChatGPT login or API key |
| **Gemini** | Google | Login via Gemini CLI |
| **Kilo** | Kilo | `kilo auth` |

Credentials are stored encrypted via Electron's `safeStorage`.

## Requirements

- **Node.js** 18 or higher
- **pnpm** 10.33.0 (see `packageManager` in `package.json`)
- **Supported platforms**: macOS 15+ (universal arm64 + x64), Windows 10/11 (x64 + arm64)
- C++ toolchain to compile native dependencies (`better-sqlite3`, `node-pty`)

## Installation

```bash
# Clone the repository
git clone https://github.com/<your-org>/comando.git
cd comando

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
| `pnpm lint` | Static validation with ESLint |
| `pnpm test` | Unit tests with Vitest |
| `pnpm test:watch` | Tests in watch mode |
| `pnpm typecheck` | Type checking for `node` and `web` |
| `pnpm check` | Full CI-style check (typecheck + lint + test + build) |
| `pnpm stage:ai` | Stage Claude and Codex runtimes into the bundle |
| `pnpm rebuild:native` | Rebuild `better-sqlite3` and `node-pty` |
| `pnpm release:mac` | Package macOS universal and publish artifacts to the configured provider |
| `pnpm release:win:x64` | Package Windows `x64` and publish artifacts to the configured provider |
| `pnpm release:win:arm64` | Package Windows `arm64` and publish artifacts to the configured provider |

## Packaging

Comando stages the Codex and Claude ACP runtimes automatically before `pnpm dev` and `pnpm build` via the `predev` and `prebuild` hooks.

Run the staging step manually only when you want to refresh the staged artifacts ahead of time or diagnose runtime/package issues:

```bash
pnpm stage:ai
```

```bash
# macOS (universal arm64 + x64, produces .dmg + .zip)
pnpm package:mac

# macOS publish (GitHub Releases)
pnpm release:mac

# Windows
pnpm package:win          # multi-arch
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
│   ├── ai/              # ACP client and runtimes (Claude, Codex, Gemini, Kilo)
│   ├── db/              # SQLite bootstrap and worker
│   ├── git/             # Git operations (simple-git)
│   ├── ipc/             # Typed IPC handlers
│   ├── projects/        # Project catalog and FS access
│   ├── terminals/       # pty spawning and management
│   ├── workspace/       # Workspace state
│   ├── windows/         # Main and settings windows
│   ├── settings/        # Settings service + encryption
│   └── observability/   # Logging
├── preload/             # Typed Node ↔ Renderer bridge
├── renderer/            # React frontend
│   └── src/
│       ├── components/  # UI (sidebar, workspace, settings, git…)
│       ├── app/         # Zustand stores
│       ├── styles.css   # Tailwind globals
│       └── main.tsx
└── shared/              # IPC contracts, constants, theme tokens
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

1. You cannot edit files while they have pending agent review changes.
2. Some open files may require a manual reload to reflect the latest external changes.

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
