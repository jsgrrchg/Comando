import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    NATIVE_COMMANDS,
    NATIVE_EVENTS,
    nativeAiEventToIpc,
    nativeAiRuntimeStatusToIpc,
    nativeGitInvalidationToIpc,
    nativeProjectSummaryToIpc,
    nativeTerminalDataEventToIpc,
    nativeTerminalExitEventToIpc,
    parseNativeBackendCapabilitiesOutput,
    parseNativeBackendOutput,
} from ".";
import type { NativeAiRuntimeStatus } from "./ai";
import type {
    NativeGitBranchSummary,
    NativeGitChangeEntry,
    NativeGitCommitDetail,
    NativeGitDiffStatRecord,
    NativeGitFileDiff,
    NativeGitHistoryListResult,
    NativeGitOperationResult,
    NativeGitOriginalFile,
    NativeGitRemoteSummary,
    NativeGitRepositoryInvalidation,
    NativeGitRepositoryResolution,
    NativeGitRepositorySnapshot,
    NativeGitStatusSnapshot,
    NativeGitWorktreeDiffResult,
    NativeGitWorktreeSummary,
} from "./git";
import type {
    NativeIndexedProjectEntry,
    NativeIndexStatusResult,
    NativeProjectEntrySearchResult,
    NativeSearchCancelled,
} from "./search";
import type { NativePersistenceStorageHealth } from "./persistence";
import type {
    NativeProjectState,
    NativeProjectSummary,
    NativeProjectTreeEntry,
} from "./projects";
import type {
    NativeTerminalCloseInput,
    NativeTerminalClosedEvent,
    NativeTerminalCreateInput,
    NativeTerminalCreatedEvent,
    NativeTerminalDataEvent,
    NativeTerminalErrorEvent,
    NativeTerminalExitEvent,
    NativeTerminalListResult,
} from "./terminal";

const fixtureRoot = path.join(process.cwd(), "fixtures", "native-backend");

describe("native backend fixtures", () => {
    it("parses protocol envelope fixtures", () => {
        const request = fixture<Record<string, unknown>>(
            "protocol/request.backend_ping.json",
        );
        expect(request).toMatchObject({
            command: "backend_ping",
            id: "req_1",
            meta: { protocolVersion: 1 },
        });

        expect(
            parseNativeBackendOutput(
                fixture("protocol/response.backend_ping.json"),
            ),
        ).toMatchObject({
            id: "req_1",
            ok: true,
            type: "response",
        });

        expect(
            parseNativeBackendOutput(
                fixture("protocol/response.error.unknown_command.json"),
            ),
        ).toMatchObject({
            error: { code: "unknown_command", retryable: false },
            ok: false,
            type: "response",
        });

        expect(() =>
            parseNativeBackendOutput({
                error: {
                    code: "unknown_command",
                    details: null,
                    message: "Unknown command",
                },
                id: "req_missing",
                ok: false,
                type: "response",
            }),
        ).toThrow("retryable");

        expect(
            parseNativeBackendOutput(fixture("protocol/event.backend_test.json")),
        ).toMatchObject({
            eventName: "backend://test-event",
            type: "event",
        });
    });

    it("keeps TS registries aligned with shared fixtures", () => {
        expect([...NATIVE_COMMANDS]).toEqual(
            fixture("protocol/registry.commands.json"),
        );
        expect([...NATIVE_EVENTS]).toEqual(fixture("protocol/registry.events.json"));
    });

    it("parses capabilities v1", () => {
        const capabilities = parseNativeBackendCapabilitiesOutput(
            fixture("protocol/capabilities.v1.json"),
        );

        expect(capabilities.protocolVersion).toBe(1);
        expect(capabilities.capabilities.domains).toContain("search");
        expect(capabilities.capabilities.domains).toContain("secret");
        expect(capabilities.capabilities.commands).toContain("backend_handshake");
        expect(capabilities.capabilities.events).toContain("ai://message-delta");
    });

    it("accepts AI fixtures and adapts small event payloads", () => {
        const messageEvent = parseNativeBackendOutput(
            fixture("ai/event.message_delta.json"),
        );
        expect(messageEvent.type).toBe("event");
        if (messageEvent.type !== "event") {
            throw new Error("expected event");
        }

        expect(nativeAiEventToIpc(messageEvent)).toMatchObject({
            content: "Hello",
            kind: "message-delta",
            messageId: "message_1",
        });

        const toolEvent = parseNativeBackendOutput(
            fixture("ai/event.tool_activity.json"),
        );
        expect(toolEvent.type).toBe("event");
        if (toolEvent.type !== "event") {
            throw new Error("expected event");
        }

        expect(nativeAiEventToIpc(toolEvent)).toMatchObject({
            activity: {
                id: "tool_1",
                status: "completed",
                title: "Read file",
            },
            kind: "tool-activity",
        });
    });

    it("adapts native runtime status to current IPC status shape", () => {
        const status: NativeAiRuntimeStatus = {
            authMethod: "chatgpt",
            authMethods: [{ description: "ChatGPT login", id: "chatgpt", name: "ChatGPT" }],
            authReady: true,
            checkedAt: "2026-06-20T00:00:00.000Z",
            command: "codex",
            hasCustomBinaryPath: false,
            hasGatewayConfig: false,
            hasGatewayUrl: false,
            message: null,
            onboardingRequired: false,
            runtimeId: "codex",
            source: "bundled",
            state: "ready",
        };

        expect(nativeAiRuntimeStatusToIpc(status)).toMatchObject({
            authReady: true,
            runtimeId: "codex",
            state: "ready",
        });
    });

    it("accepts project and git fixtures", () => {
        const project = fixture<NativeProjectSummary>(
            "projects/project.summary.json",
        );
        expect(nativeProjectSummaryToIpc(project)).toMatchObject({
            id: "project_1",
            rootPath: "/tmp/comando-project",
        });
        const projectState = fixture<NativeProjectState>(
            "projects/project.state.json",
        );
        expect(projectState.worktrees[0]).toMatchObject({
            headSha: null,
            id: "project_1:primary",
            isPrimary: true,
        });

        const treeEntry = fixture<NativeProjectTreeEntry>(
            "projects/project.tree_entry.json",
        );
        expect(treeEntry).toMatchObject({
            kind: "file",
            relativePath: "src/main.ts",
        });

        const snapshot = fixture<NativeGitRepositorySnapshot>(
            "git/repository.snapshot.json",
        );
        expect(snapshot.status.summary.changedCount).toBe(1);
        expect(
            fixture<NativeGitRepositoryResolution>(
                "git/repository.resolution.json",
            ).state,
        ).toBe("ready");
        expect(
            fixture<NativeGitStatusSnapshot>("git/status.snapshot.json").entries,
        ).toHaveLength(1);
        expect(
            fixture<NativeGitChangeEntry>("git/change.entry.json").path,
        ).toBe("src/main.ts");
        expect(
            fixture<NativeGitBranchSummary>("git/branch.summary.json").isCurrent,
        ).toBe(true);
        expect(
            fixture<NativeGitRemoteSummary>("git/remote.summary.json").isDefault,
        ).toBe(true);
        expect(
            fixture<NativeGitWorktreeSummary>("git/worktree.summary.json")
                .isPrimary,
        ).toBe(true);
        expect(fixture<NativeGitDiffStatRecord>("git/diff.stat.json").key).toBe(
            "unstaged:src/main.ts",
        );
        expect(
            fixture<NativeGitFileDiff>("git/diff.file.json").summary.insertions,
        ).toBe(1);
        expect(
            fixture<NativeGitOriginalFile>("git/original_file.json").isText,
        ).toBe(true);
        expect(
            fixture<NativeGitHistoryListResult>("git/history.list.json")
                .totalCount,
        ).toBe(1);
        expect(
            fixture<NativeGitCommitDetail>("git/commit.detail.json")
                .changedFileCount,
        ).toBe(1);
        expect(
            fixture<NativeGitWorktreeDiffResult>("git/worktree.diff.json")
                .sections,
        ).toHaveLength(1);
        expect(
            fixture<NativeGitRepositoryInvalidation>(
                "git/repository.invalidation.json",
            ).reason,
        ).toBe("status");
        expect(
            fixture<NativeGitOperationResult>("git/operation.result.json").ok,
        ).toBe(true);

        const indexStatus = fixture<NativeIndexStatusResult>(
            "index/index.status.json",
        );
        expect(indexStatus.status).toBe("ready");
        const indexedEntry = fixture<NativeIndexedProjectEntry>(
            "index/indexed.entry.json",
        );
        expect(indexedEntry.policyState).toBe("indexed");
        const searchResult = fixture<NativeProjectEntrySearchResult>(
            "index/search.entries_result.json",
        );
        expect(searchResult.entries[0].relativePath).toBe("src/main.ts");
        const cancelled = fixture<NativeSearchCancelled>(
            "index/search.cancelled.json",
        );
        expect(cancelled.cancelled).toBe(true);

        expect(
            nativeGitInvalidationToIpc({
                occurredAt: "2026-06-20T00:00:00.000Z",
                projectId: "project_1",
                reason: "status",
                rootPath: "/tmp/comando-project",
                worktreeId: "worktree_1",
            }),
        ).toMatchObject({ reason: "status", worktreeId: "worktree_1" });

        const health = fixture<NativePersistenceStorageHealth>(
            "persistence/storage.health.json",
        );
        expect(health).toMatchObject({
            databaseReachable: true,
            projectCount: 1,
        });
    });

    it("accepts terminal fixtures and adapters", () => {
        expect(
            fixture<NativeTerminalCreateInput>(
                "terminal/terminal.create_input.json",
            ),
        ).toMatchObject({
            launch: { kind: "shell" },
            terminalId: "workspace-terminal-1",
            windowId: "window_main",
        });
        expect(
            fixture<NativeTerminalCreatedEvent>(
                "terminal/terminal.created_event.json",
            ).session,
        ).toMatchObject({
            launchedBy: "user",
            program: "/bin/zsh",
            purpose: "workspace",
        });
        expect(
            fixture<NativeTerminalListResult>(
                "terminal/terminal.list_result.json",
            ).sessions,
        ).toHaveLength(1);
        expect(
            fixture<NativeTerminalClosedEvent>(
                "terminal/terminal.closed_event.json",
            ),
        ).toMatchObject({
            reason: "user",
            sessionId: "terminal_1",
            windowId: "window_main",
        });
        expect(
            fixture<NativeTerminalErrorEvent>(
                "terminal/terminal.error_event.json",
            ),
        ).toMatchObject({
            retryable: false,
            terminalId: "workspace-terminal-1",
        });
        const closeInput: NativeTerminalCloseInput = {
            id: "terminal_1",
            reason: "user",
            windowId: "window_main",
        };
        expect(closeInput.id).toBe("terminal_1");

        const event = fixture<NativeTerminalDataEvent>(
            "terminal/terminal.data_event.json",
        );

        expect(nativeTerminalDataEventToIpc(event)).toEqual({
            data: "ready\n",
            sessionId: "terminal_1",
        });

        const exitEvent = fixture<NativeTerminalExitEvent>(
            "terminal/terminal.exit_event.json",
        );
        expect(nativeTerminalExitEventToIpc(exitEvent)).toEqual({
            exitCode: 0,
            sessionId: "terminal_1",
            signalCode: null,
        });
    });
});

function fixture<T = unknown>(relativePath: string): T {
    return JSON.parse(
        readFileSync(path.join(fixtureRoot, relativePath), "utf8"),
    ) as T;
}
