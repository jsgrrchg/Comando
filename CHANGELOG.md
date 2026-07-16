# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

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
