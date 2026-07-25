# Custom ACP runtimes

Comando can register multiple local ACP-compatible agents without adding provider-specific logic. Each definition is an independent runtime with a stable ID, revision, and launch fingerprint, so different adapters and configurations can coexist without sharing sessions.

## Add a runtime

Install and authenticate the ACP-compatible adapter before configuring it. Comando does not install packages, implicitly run package runners, or manage adapter sign-in.

In **Settings → AI Providers → Custom ACP runtimes**, select **Add runtime** and provide a definition such as:

```text
Name: Local ACP agent
Command: /absolute/path/to/your-acp-adapter
Arguments:
Environment:
Authentication: managed by the runtime
```

The command can be an absolute path or an executable available from the controlled runtime PATH. **Verify executable** only resolves the command and checks whether it is executable; it does not start a session, install dependencies, or validate credentials.

Enter one argument per line. Comando passes each line as a separate argument and never invokes a shell. Enter environment variables as `NAME=value` lines. `PATH`, `PATHEXT`, and keys that look like tokens, passwords, credentials, secrets, or API keys are not allowed.

## Security model

A custom runtime executes a local program with your user account's permissions. Only register software you trust.

The process starts with an empty environment. Comando adds a minimal allowlist of platform variables, a controlled `PATH`, and the non-secret variables declared in the definition. It does not inherit Electron's full environment or receive credentials from built-in runtimes.

**Authentication managed by the runtime** bypasses Comando's authentication gating, but it does not guarantee that the adapter is signed in. Credential failures during the handshake or first turn are reported as runtime errors.

## History and continuation

Local history and remote session continuation are separate capabilities. The transcript remains visible even when an adapter cannot reopen its remote session.

| Observed strategy | Reopen behavior |
| --- | --- |
| `resume` | Comando uses `session/resume` with the persisted remote ID. |
| `load` | Comando uses `session/load` and avoids duplicating replayed adapter events in the transcript. |
| `new-session-only` | History opens as a transcript, but continuing the conversation requires a new session. Comando does not attempt a silent continuation. |

Comando derives the strategy from capabilities advertised during `initialize`, never from the adapter name. If those capabilities no longer support the saved strategy, continuation fails before a prompt is sent.

An active session keeps the executable, arguments, and environment it was created with. Editing or deleting a definition does not replace an already-running process.

Changing only the display name preserves the launch fingerprint. Changing the command, arguments, or environment leaves the historical fingerprint in place and requires confirmation before continuing with the modified definition.

Deleting a definition does not delete or reassign its history. Settings retains a non-selectable tombstone under **Deleted definitions retained for history**. **Restore** recovers the same ID, revision, and fingerprint. If an active runtime already uses the same name, rename it first to keep the catalog unique.

Restoring a definition enables historical session preparation again, but does not force an incompatible continuation: the observed strategy and fingerprint checks still apply. To leave the previous identity behind, register a new definition and start a new session.

## ACP capabilities

Custom runtimes use the standard ACP transport for text, tools, permissions, command catalogs, models, modes, and `usage_update`. Images are sent only after the handshake advertises image-prompt support.

Comando sends `additionalDirectories` in compatible session operations. This confirms multi-root transport, not that an adapter will use every root. The existing context bar displays `usage_update` when the adapter emits it.

Out of scope:

- Automatic adapter installation or updates.
- Custom secrets in Settings or full environment inheritance.
- Login, logout, API keys, or provider-specific UI.
- Subagents and proprietary commands by default.
- Guaranteeing unadvertised ACP extensions or compensating for adapter capabilities that are not implemented.

## Troubleshooting

If **Verify executable** reports `missing`, check the command path and installation. If it reports that the file is not executable, correct its permissions outside Comando. Invalid handshakes, early exits, and authentication failures belong to the registered process and do not change sessions for other runtimes.

To test an incompatible edit, close a session, reopen it from history, and confirm the modified-definition prompt. To test deletion, remove a definition and verify that its transcript remains visible and Comando does not start another runtime as a replacement.
