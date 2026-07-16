# Comando

<p align="center">
  <img width="100%" alt="Comando workspace" src="https://github.com/user-attachments/assets/1ff5563c-814a-46ff-8dbc-cc3eb5746a84" />
</p>

<p align="center">
  <strong>A local-first workspace for coding with AI agents.</strong><br />
  Keep your code, agents, terminal, Git, and review in the same place.
</p>

<p align="center">
  <a href="https://github.com/jsgrrchg/Comando/issues">Report a bug</a>
  ·
  <a href="CONTRIBUTING.md">Contribute</a>
  ·
  <a href="LICENSE">GPL-3.0</a>
</p>

## Your code stays in view

Comando is a desktop workspace for developers who want to work with multiple AI agents without turning their editor into a chat window. Open projects as tabs, each with its own multipane workspace where code files, agent chats, terminals, Git views, and other tools live side by side.


## Built for the whole coding loop

- **Work with the agent you prefer.** Run Codex, Claude, Grok, Kilo, or OpenCode sessions with streaming activity, explicit permissions, queued prompts, attachments, and local history.
- **Give each agent room to work.** Open agent sessions as tabs to explore, implement, and review parallel threads of work—without losing the shared context of the branch.
- **Stay close to the code.** Use a Monaco editor with Git gutters, quick open, file tree, autosave, Vim mode, and native terminal tabs.
- **Review AI changes on their own layer.** Inspect agent changes inline, in chat, or in a dedicated review tab; keep or reject complete files and individual hunks independent from your Git change-control workflow.
- **Keep Git in context.** Stage, commit, sync, manage branches and worktrees, and compare changes without leaving the workspace.
- **Bring GitHub into the flow.** Work with issues, pull requests, checks, Actions logs, releases, and notifications—and attach issues or pull requests to a prompt.

## Get started

### Requirements

- Node.js 22.12 or later
- pnpm 10.33.0
- Rust and Cargo

### Run locally

```bash
git clone https://github.com/jsgrrchg/Comando.git
cd Comando
pnpm install
pnpm dev
```

The first start builds the native backend and prepares the bundled AI runtimes. Configure your preferred agent from the app settings; some providers require their own CLI login or API key.

## Development

```bash
pnpm check          # typecheck, lint, test, and production build
pnpm native:check   # native backend checks
cargo test --workspace
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

## Status

Comando is an experimental, pre-1.0 workspace for exploring the future of AI-powered development. The core workspace, agent sessions, review, Git, GitHub, and terminal workflows are in place, but it is still being hardened for daily use. It is deliberately not a full IDE: language-server tooling, debugging, and an extension marketplace are outside its current scope. The project moves quickly, so clone the main branch for the latest changes.

## License

Comando is released under the [GNU General Public License v3.0](LICENSE).
