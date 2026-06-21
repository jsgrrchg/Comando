# Native AI Backend

AI runtime sessions, history, review state, runtime auth, and runtime secrets
are owned by the Rust sidecar. Electron main keeps a thin `AiService` facade for
IPC, renderer projection, settings snapshots, and event broadcasting.

Supported native runtimes are Codex, Claude, OpenCode, Kilo, and Grok. Gemini is
not launched as a dedicated ACP runtime; use a compatible external runtime such
as Kilo or OpenCode for Gemini-backed providers.

Runtime setup and auth changes are persisted through native commands. Secrets
are stored in the OS credential store through the sidecar. TypeScript must not
write canonical AI history or review state.

Use `docs/native-ai-runtime-smoke.md` for the current manual smoke checklist.
