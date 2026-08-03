# Copyright & Licenses

Copyright (c) 2026 Comando contributors.

Comando is licensed under the Apache License, Version 2.0 (the "License");
you may not use this project except in compliance with the License.
You may obtain a copy of the License at:

    https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the `LICENSE` file for the specific language governing permissions
and limitations under the License.

---

## Scope

Comando is an Electron, React, TypeScript desktop application with staged AI
runtime assets. This file summarizes the copyright and licensing posture of
the project, its direct dependencies, bundled assets, and vendored runtime
code.

Authoritative dependency metadata remains in:

- `package.json`
- `pnpm-lock.yaml`
- `vendor/codex-acp/Cargo.toml`
- `vendor/codex-acp/Cargo.lock`
- `vendor/Claude-agent-acp-upstream/package.json`
- `vendor/Claude-agent-acp-upstream/package-lock.json`
- individual third-party `LICENSE`, `LICENSE.md`, `NOTICE`, and README files

---

## License Summary

| License or terms | Scope |
| ---------------- | ----- |
| Apache-2.0 | Comando, Agent Client Protocol packages, TypeScript, vendored `codex-acp`, vendored Claude ACP adapter, and OpenAI Codex Rust crates |
| MIT | Majority of npm dependencies, Electron ecosystem packages, React ecosystem packages, editor packages, native helper packages, and many Rust crates |
| MIT OR Apache-2.0 / Apache-2.0 OR MIT | Common Rust crate licensing model used by many Codex sidecar dependencies |
| ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0, Zlib, BSL-1.0 | Permissive transitive dependencies used by npm and Rust packages |
| MPL-2.0 | Weak-copyleft packages such as `lightningcss` and selected Rust transitive crates |
| Unicode-3.0 | Unicode/ICU-related Rust crates pulled by the Codex sidecar dependency graph |
| CC-BY-4.0, Python-2.0, WTFPL variants | Isolated npm transitive dependencies reported by package metadata |
| OFL-1.1 | Bundled font assets |
| Anthropic legal terms | `@anthropic-ai/claude-agent-sdk` and its platform-specific binary packages |

No GPL-only runtime code dependencies were found in the current npm or Rust
dependency metadata during this audit. Some dependencies are dual-licensed;
Comando should use the permissive option where available and preserve all
required notices.

---

## Frontend And Desktop Dependencies

### Core Application

| Package | License |
| ------- | ------- |
| `react`, `react-dom` | MIT |
| `zustand` | MIT |
| `zod` | MIT |
| `tailwindcss`, `@tailwindcss/vite` | MIT |
| `vite`, `@vitejs/plugin-react`, `electron-vite` | MIT |
| `typescript` | Apache-2.0 |

### Electron Runtime And Native Integration

| Package | License |
| ------- | ------- |
| `electron` | MIT |
| `electron-builder` | MIT |
| `electron-updater` | MIT |
| `ms` | MIT |

### Editor, Terminal, And Syntax Packages

| Package | License |
| ------- | ------- |
| `@codemirror/*` packages | MIT |
| `@lezer/highlight` | MIT |
| `@monaco-editor/react`, `monaco-editor` | MIT |
| `@shikijs/langs` | MIT |
| `vscode-oniguruma`, `vscode-textmate` | MIT |
| `@xterm/xterm`, `@xterm/addon-fit` | MIT |
| `@iconify-json/catppuccin` | MIT |

### Protocol And AI Client Packages

The main application uses the Rust `agent-client-protocol` crate through the
native sidecar. The TypeScript ACP SDK is not a direct dependency of the root
package.

### Development And Test Tooling

| Package | License |
| ------- | ------- |
| `eslint`, `@eslint/js`, `eslint-plugin-react-hooks` | MIT |
| `typescript-eslint` | MIT |
| `vitest` | MIT |
| `@types/*` packages | MIT |
| `globals` | MIT |

Current npm dependency metadata, including direct and transitive packages,
was checked with `pnpm licenses list --json`.

---

## Bundled Assets

### Fonts

Comando bundles webfont files under `src/renderer/src/assets/fonts/`.
These fonts are third-party assets and should retain their upstream font
license notices when distributed.

| Font family | License |
| ----------- | ------- |
| Atkinson Hyperlegible | OFL-1.1 |
| Geist | OFL-1.1 |
| Geist Mono | OFL-1.1 |
| IBM Plex Mono | OFL-1.1 |
| Inter | OFL-1.1 |
| JetBrains Mono | OFL-1.1 |
| Literata | OFL-1.1 |
| Lora | OFL-1.1 |
| Merriweather | OFL-1.1 |
| Source Serif 4 | OFL-1.1 |

### Icons And Product Artwork

Comando application icons and project artwork live under `resources/icons/`.
Unless a file in that directory states otherwise, these assets are treated as
Comando project assets distributed under the project license.

---

## AI Runtime Assets

Comando stages AI runtime assets under `resources/ai/` for development,
packaging, and release workflows. Generated files in that directory are build
inputs produced from the vendored sources and local toolchains.

### Codex ACP Runtime

| Item | Details |
| ---- | ------- |
| Vendored path | `vendor/codex-acp` |
| Runtime artifact | `resources/ai/binaries/codex-acp` |
| Upstream package | `zed-industries/codex-acp` |
| Upstream baseline | `0.14.0`, commit `156cb0da12f6c7b1c697f90b5f22d5e14be31165` |
| OpenAI Codex Rust baseline | `rust-v0.129.0`, commit `2808a4deb181e5ca2b1293a1a5980938cb746861` |
| License | Apache-2.0 |

The Codex sidecar is built from Rust sources. Its dependency graph includes
mostly MIT, Apache-2.0, MIT OR Apache-2.0, Unicode-3.0, ISC, BSD, Zlib, BSL,
MPL-2.0, and other permissive or weak-copyleft licenses. Current Rust metadata
was checked with `cargo metadata --format-version=1 --locked`.

### Claude ACP Runtime

| Item | Details |
| ---- | ------- |
| Vendored path | `vendor/Claude-agent-acp-upstream` |
| Staged path | `resources/ai/embedded/claude-agent-acp` |
| Upstream package | `@agentclientprotocol/claude-agent-acp` |
| Upstream baseline | `0.64.2`, commit `c98141201e50778d6679f2c578cbbebe1402d7e6` |
| Package license | Apache-2.0 |
| ACP SDK dependency | `@agentclientprotocol/sdk` `1.3.0`, Apache-2.0, vendored inside the Claude runtime only |
| Claude Agent SDK dependency | `@anthropic-ai/claude-agent-sdk` `0.3.220`, Anthropic legal terms |

The Claude ACP adapter itself is Apache-2.0. Its runtime dependency
`@anthropic-ai/claude-agent-sdk` and the platform-specific
`@anthropic-ai/claude-agent-sdk-*` binary packages carry Anthropic copyright
and are subject to Anthropic's Claude Code legal and compliance terms as stated
in their bundled `LICENSE.md` files.

### Embedded Node Runtime

The Claude runtime staging script downloads the pinned official Node.js `22.23.1` distribution, verifies its SHA-256 digest, and stages its executable and notices under `resources/ai/embedded/node/`. Node.js is distributed under the MIT license with its own bundled third-party notices. Release packaging preserves the required Node.js license and notice materials for every redistributed Node binary.

### External AI Runtimes

Grok, Kilo, and OpenCode are configured as external runtimes. They are not
vendored in this repository and remain governed by their own upstream licenses,
terms, and installation channels.

---

## Vendored Dependencies

| Package | License or terms | Source |
| ------- | ---------------- | ------ |
| `vendor/codex-acp` | Apache-2.0 | `github.com/zed-industries/codex-acp` plus OpenAI Codex Rust crates |
| `vendor/Claude-agent-acp-upstream` | Apache-2.0 | `github.com/agentclientprotocol/claude-agent-acp` |
| `@agentclientprotocol/sdk` | Apache-2.0 | Agent Client Protocol TypeScript SDK, vendored only inside the Claude ACP runtime |
| `@anthropic-ai/claude-agent-sdk` | Anthropic legal terms | Anthropic Claude Agent SDK |

All original copyright notices and license headers in vendored sources should
be preserved.

---

## Modified Vendored Code

The following vendored packages include Comando-specific changes. Apache-2.0
requires modified files to carry prominent notices that changes were made and
requires preservation of upstream copyright and license notices.

### `vendor/codex-acp` - Zed Industries / OpenAI Codex Rust crates

Local Comando delta is intentionally bounded and documented in `vendor/README.md`.
The currently tracked local delta includes:

| File | Nature of changes |
| ---- | ----------------- |
| `Cargo.toml` | Pins and dependency alignment required by the embedded Codex runtime |
| `Cargo.lock` | Resolved dependency graph for the embedded Codex runtime |
| `src/lib.rs` | Library wiring required by Comando's build and runtime integration |
| `src/codex_agent.rs` | ACP metadata, model, auth, session, image-generation, and runtime compatibility changes |
| `src/prompt_args.rs` | Custom slash-prompt discovery and expansion support |
| `src/subagents.rs` | Subagent session registration and breadcrumb projection |
| `src/thread.rs` | Review-flow metadata, streamed tool diffs, user-input routing, and session synchronization |
| `vendor/codex-utils-pty` | Local patched PTY helper aligned with the embedded OpenAI Codex Rust runtime |

### `vendor/Claude-agent-acp-upstream` - Agent Client Protocol Claude ACP

The vendored Claude ACP runtime is based on upstream `@agentclientprotocol/claude-agent-acp` `0.64.2` at commit `c98141201e50778d6679f2c578cbbebe1402d7e6`. The Claude vendor source matches upstream without Comando-specific changes; the Agent/Task trailer parser hardening is now part of upstream commit `06c3d7bdbd8cc9415c8cabac060a50e0951c758b`. Claude PostToolUse structured patch responses are translated inside Comando's internal review adapter so review snippets can retain real line anchors while keeping the vendored runtime aligned with upstream source. Structured ACP permission metadata and custom-answer companion fields are normalized at Comando's native boundary so approval scopes and `AskUserQuestion` forms remain clear without modifying the vendored runtime.

This vendor directory should be reviewed intentionally whenever syncing against
upstream.

---

## License Compliance Notes

1. MIT, ISC, BSD, 0BSD, BlueOak-1.0.0, Zlib, and BSL-1.0 are permissive
   licenses. Preserve copyright notices and license text when redistributing.
2. Apache-2.0 requires preserving notices, including the license text, and
   documenting modifications to Apache-licensed files.
3. MPL-2.0 is weak copyleft. Modifications to MPL-licensed files must remain
   available under MPL-2.0, but ordinary use from Comando does not relicense
   the rest of the project.
4. Unicode-3.0 requires preserving copyright notices and license text.
5. OFL-1.1 applies to bundled fonts. Preserve font license notices and follow
   reserved-font-name requirements where applicable.
6. Anthropic Claude Agent SDK packages are not covered by Comando's Apache-2.0
   license. Preserve their bundled `LICENSE.md` notices and comply with the
   referenced Anthropic terms when redistributing or using those packages.
7. Generated package artifacts should include the project `LICENSE`, vendored
   runtime licenses, third-party dependency notices, font notices, and Node.js
   notices where applicable.

---

*This file is maintained from project dependency metadata. Last updated: 2026-07-28.*
