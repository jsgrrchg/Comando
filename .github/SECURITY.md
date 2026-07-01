# Security Policy

Comando is a local-first desktop workspace for coding with AI agents. It handles local repositories, terminals, Git and GitHub state, AI runtime configuration, credentials, and reviewable file edits, so we take security reports seriously.

If you believe you have found a vulnerability, please report it privately so we can investigate and coordinate a fix before details become public.

## Reporting a Vulnerability

Please use GitHub's private vulnerability reporting flow:

1. Open the **Security** tab for this repository.
2. Click **Report a vulnerability**.
3. Include a clear description of the issue and its potential impact.
4. Include reproduction steps, proof-of-concept details, affected versions, logs, or screenshots when they help explain the issue.

Please do not report suspected vulnerabilities through public issues, discussions, pull requests, or social channels until we have reviewed the report and agreed on a disclosure path.

## What to Include

Helpful reports usually include:

- The affected platform, app version, and installation source.
- Clear steps to reproduce the behavior.
- The expected and actual security impact.
- Whether the issue affects local files, Git repositories, terminal execution, GitHub access, AI runtime execution, persisted app data, or secret storage.
- Any relevant files, configuration, sample payloads, logs, screenshots, or crash reports.
- Whether the issue is already public or known elsewhere.

Please remove personal credentials, private source code, and unrelated sensitive data from any report attachments when possible. If sensitive material is required to demonstrate the issue, keep the report private and say so clearly.

## Scope

This policy applies to the code, packaging, release artifacts, and project-maintained integrations in this repository, including:

- The Electron desktop app, preload bridge, renderer, IPC handlers, and window orchestration.
- The Rust native backend, protocol adapters, persistence layer, filesystem operations, Git operations, terminal sessions, and indexing.
- AI runtime staging, ACP-compatible runtime integrations, permission handling, and AI session orchestration.
- The AI review layer, including tracked edits, inline review state, chat diff cards, Review tab behavior, and keep/reject flows.
- GitHub integration surfaces, token handling, release workflows, notifications, issues, pull requests, checks, Actions logs, and artifacts.
- Build, packaging, update, and release automation for macOS, Windows, and Linux.

For vulnerabilities in third-party dependencies, please report the issue to the upstream project first unless Comando's use of that dependency introduces a separate vulnerability.

## Out of Scope

The following are generally out of scope unless they demonstrate a concrete vulnerability in Comando itself:

- Social engineering, phishing, or attacks requiring access to a user's machine or unlocked desktop session.
- Issues caused only by malicious repositories, scripts, prompts, or binaries that the user intentionally runs outside Comando's trust boundaries.
- Vulnerabilities in external AI providers, ACP runtimes, GitHub, Git, shells, package managers, operating systems, or Electron itself, unless Comando's integration creates additional exposure.
- Denial-of-service reports that only crash a local development build without security impact or data exposure.
- Reports based only on missing security headers for local desktop app surfaces that are not exposed to the network.

## Response Expectations

We will review private vulnerability reports as promptly as we can, ask follow-up questions when needed, and coordinate remediation and disclosure through GitHub Security Advisories when appropriate.

We may prioritize reports that can expose local files, credentials, repositories, app data, terminal execution, GitHub tokens, AI runtime permissions, release artifacts, or the integrity of Comando's AI review workflow.

Thank you for helping keep Comando and its users safe.
