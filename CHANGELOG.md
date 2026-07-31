# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [0.2.1] - 2026-07-30

### Added

- Configurable custom ACP runtimes, including validation, isolated launches, lifecycle recovery, and settings management.
- Mermaid diagram previews with theme-aware rendering, zoom, panning, resizing, and persistent viewport state.
- Global workspace switching and live workspace transfers across application windows.
- A unified Git changes view for reviewing uncommitted work and full branch changes against their base.
- Native context-menu actions for image previews and file tabs, including copying a file's full path.

### Changed

- Rebuilt chat transcript storage and rendering around durable blocks, paged hydration, bounded payload caches, and virtualization for responsive long-running sessions.
- Migrated read-only Git diffs to Pierre with virtualized files, sticky headers, syntax themes, and side-by-side layouts.
- Moved AI review diff materialization to the native backend and reduced refresh work during large bursts of agent file changes.
- Routed sidebar actions, shortcuts, quick open, and context menus through the active workspace surface.
- Improved Markdown table previews with constrained layouts and horizontal scrolling for wide content.
- Updated the bundled Claude ACP runtime to 0.63.0 and refreshed security-sensitive dependencies.

### Fixed

- Made transcript migration and recovery durable across interrupted writes, legacy histories, runtime failures, tab changes, and application restarts.
- Preserved chat scroll anchors, activity details, review expansion, plan collapse state, and visible diffs while streaming or restoring sessions.
- Prevented stale file reloads and watcher events from overwriting editor state after saves, tab switches, or worktree removal.
- Stabilized workspace navigation, settings refreshes, native context-menu focus and layering, and transfers involving retained contexts.
- Corrected agent session titles and sidebar visibility, full branch names in workspace tabs, pinned tab sizing, and elapsed times longer than one hour.
- Restored macOS release signing and hardened runtime preparation and packaging.

## [0.2.0] - 2026-07-15

### Added

- Persistent project and worktree context tabs, including restored layouts for closed contexts, draggable titlebar tabs, and a shortcut for copying a context's full path.
- Agent folders and live activity labels in the sidebar.
- Markdown file previews with syntax-highlighted code blocks.
- GitHub pull request label management and full-diff review support.
- A shortcut for opening uncommitted changes directly from the Git workspace.

### Changed

- Reworked workspace surface persistence and resource management for faster context switching and better performance in long-running chats.
- Modernized project tabs, Git branch navigation, the chat layout, activity rails, mentions, and the composer action button.
- Centralized AI session orchestration and improved retained-chat reopening, prompt preparation, subagent lifecycle handling, and timeline state restoration.
- Improved pull request and issue readability across the GitHub workspace.
- Updated the bundled Claude ACP runtime to 0.59.0 and hardened AI runtime packaging and verification.
- Updated GitHub Actions workflows to the Node.js 24 runtime and improved application signing and release packaging.

### Fixed

- Preserved chat history, virtual timeline geometry, tool activity anchors, and expanded activity state while navigating between contexts.
- Restored Git status in the project file tree and refreshed stale worktree inventories in the workspace switcher.
- Stabilized agent control and selector changes in newly created or retained chats.
- Corrected primary worktree scope equivalence and prompt title hydration before the first user message.

## [0.1.0] - 2026-07-04

Public launch. For full changelog, please check git history.
