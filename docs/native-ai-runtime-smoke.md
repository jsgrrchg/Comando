# Native AI Runtime Smoke

Run the app normally; the Rust sidecar is required by default.

Smoke each supported runtime:

- Codex session starts, streams, cancels, and reloads from history.
- Claude session starts, streams, handles permission requests, and records
  review state.
- OpenCode session starts and preserves auth status after restart.
- Kilo session starts and handles user input requests.
- Grok session starts and updates auth status correctly.

Review smoke:

- Agent-created file appears in the review panel.
- Agent-modified file appears in the review panel.
- Inline decorations appear.
- Keep/reject file works.
- Keep/reject hunk works.
- Dirty-buffer and external-edit conflicts are surfaced instead of overwriting
  user changes.
