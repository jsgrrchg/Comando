import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    NATIVE_COMMANDS,
    NATIVE_EVENTS,
    nativeAiCatalogPatchToIpc,
    nativeAiEventToIpc,
    nativeAiRuntimeStatusToIpc,
    nativeGitInvalidationToIpc,
    nativeProjectSummaryToIpc,
    nativeTerminalDataEventToIpc,
    nativeTerminalExitEventToIpc,
    parseNativeBackendCapabilitiesOutput,
    parseNativeBackendOutput,
} from ".";
import type {
    NativeAiHistorySessionSummary,
    NativeAiHistoryStorageHealth,
    NativeAiMigrateSessionHistoryOutput,
    NativeAiRuntimeStatus,
    NativeAiSessionSnapshot,
    NativeAiSessionTranscriptPage,
} from "./ai";
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
    NativeTerminalCloseWindowInput,
    NativeTerminalCreateInput,
    NativeTerminalCreatedEvent,
    NativeTerminalDataEvent,
    NativeTerminalErrorEvent,
    NativeTerminalExitEvent,
    NativeTerminalKillInput,
    NativeTerminalListInput,
    NativeTerminalListResult,
    NativeTerminalResizeInput,
    NativeTerminalWriteInput,
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
        expect(aiEvent("ai/event.session_created.json")).toMatchObject({
            kind: "session-info",
            projectId: "project_1",
            title: "AI Session",
        });
        expect(aiEvent("ai/event.session_updated.json")).toMatchObject({
            kind: "status",
            status: "streaming",
        });
        expect(aiEvent("ai/event.message_started.json")).toMatchObject({
            kind: "message-started",
            message: { id: "message_1", kind: "assistant" },
        });
        expect(aiEvent("ai/event.message_delta.json")).toMatchObject({
            content: "Hello",
            kind: "message-delta",
            messageId: "message_1",
        });
        expect(aiEvent("ai/event.message_completed.json")).toMatchObject({
            kind: "message-completed",
            messageId: "message_1",
        });
        expect(aiEvent("ai/event.thinking_delta.json")).toMatchObject({
            kind: "thinking-delta",
            messageId: "thinking_1",
        });
        expect(aiEvent("ai/event.image_generation.json")).toMatchObject({
            kind: "image-generation",
            message: {
                generatedImage: {
                    path: "/Users/example/.codex/generated_images/image.png",
                    status: "completed",
                },
                id: "image:codex-acp:image:image-1",
                kind: "image",
            },
        });
        expect(aiEvent("ai/event.tool_activity.json")).toMatchObject({
            activity: {
                id: "tool_1",
                diffs: [],
                rawInputJson: JSON.stringify({ file_path: "src/main.ts" }),
                rawOutputJson: JSON.stringify("export function main() {}\n"),
                status: "completed",
                title: "Read file",
            },
            kind: "tool-activity",
        });
        expect(
            nativeAiEventToIpc({
                eventName: "ai://tool-activity",
                payload: {
                    diffs: [
                        {
                            hunks: [
                                {
                                    id: "src/main.rs:1:1:0",
                                    lines: [
                                        {
                                            id: "line:src/main.rs:1:1:0",
                                            text: "fn main() {}",
                                            type: "add",
                                        },
                                    ],
                                    newCount: 1,
                                    newStart: 1,
                                    oldCount: 0,
                                    oldStart: 1,
                                },
                            ],
                            isText: true,
                            kind: "create",
                            newText: "fn main() {}\n",
                            oldText: null,
                            path: "src/main.rs",
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                    kind: "edit",
                    runtimeId: "codex",
                    runtimeSessionId: "runtime_1",
                    sessionId: "session_1",
                    status: "completed",
                    summary: null,
                    title: "Edit file",
                    toolCallId: "tool_diff",
                    updatedAt: "2026-06-20T00:00:00.000Z",
                },
                type: "event",
            }),
        ).toMatchObject({
            activity: {
                diffs: [{ kind: "create", path: "src/main.rs" }],
                id: "tool_diff",
            },
            kind: "tool-activity",
        });
        expect(
            nativeAiEventToIpc({
                eventName: "ai://status-event",
                payload: {
                    detail: "Stop reason: end_turn",
                    eventId: "acp:turn:message_1",
                    runtimeId: "codex",
                    runtimeSessionId: "runtime_1",
                    sessionId: "session_1",
                    status: "completed",
                    title: "Completed",
                    updatedAt: "2026-06-20T00:00:00.000Z",
                },
                type: "event",
            }),
        ).toBeNull();
        expect(aiEvent("ai/event.plan_updated.json")).toMatchObject({
            kind: "plan",
            plan: { entries: [{ content: "Inspect files" }] },
        });
        expect(aiEvent("ai/event.permission_request.json")).toMatchObject({
            kind: "permission-request",
            request: { requestId: "permission_1" },
        });
        expect(aiEvent("ai/event.user_input_request.json")).toMatchObject({
            kind: "user-input-request",
            request: { requestId: "input_1" },
        });
        expect(aiEvent("ai/event.token_usage.json")).toMatchObject({
            kind: "token-usage",
            tokenUsage: { used: 42 },
        });
        expect(aiEvent("ai/event.subagent_created.json")).toMatchObject({
            childSessionId: "session_1:subagent:runtime_child_1",
            kind: "subagent-created",
            parentSessionId: "session_1",
            title: "Aristotle",
        });
        expect(aiEvent("ai/event.subagent_breadcrumb.json")).toMatchObject({
            childSessionId: "session_1:subagent:runtime_child_1",
            kind: "subagent-breadcrumb",
            toolCallId: "tool_1",
        });
        expect(
            nativeAiCatalogPatchToIpc(
                eventPayload("ai/event.session_catalog_updated.json"),
            ),
        ).toMatchObject({
            availableCommands: [{ id: "review", label: "/review" }],
            configOptions: [
                { id: "model", type: "select", value: "gpt-5" },
                { id: "autoApply", type: "boolean", value: false },
            ],
        });
        expect(aiEvent("ai/event.error.json")).toMatchObject({
            kind: "status",
            lastError: "Runtime process exited.",
            status: "error",
        });
        expect(
            fixture<readonly NativeAiHistorySessionSummary[]>(
                "ai/history.summary.json",
            ),
        ).toHaveLength(2);
        expect(
            fixture<NativeAiSessionTranscriptPage>("ai/history.page.json"),
        ).toMatchObject({
            sessionId: "session_1",
            totalMessages: 2,
        });
        const historySnapshot = fixture<NativeAiSessionSnapshot>(
            "ai/history.snapshot.json",
        );
        expect(historySnapshot).toMatchObject({
            runtimeId: "codex",
            sessionId: "session_1",
        });
        expect(historySnapshot.messages[0]).toMatchObject({
            id: "message_user_1",
        });
        expect(
            fixture<NativeAiMigrateSessionHistoryOutput>(
                "ai/history.migration.json",
            ),
        ).toMatchObject({
            migratedSessions: 2,
            failedSessions: 0,
        });
        expect(
            fixture<NativeAiHistoryStorageHealth>("ai/history.health.json"),
        ).toMatchObject({
            healthy: true,
            nativeSessionCount: 2,
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
        expect(
            fixture<NativeTerminalWriteInput>(
                "terminal/terminal.write_input.json",
            ),
        ).toMatchObject({ data: "pwd\r", windowId: "window_main" });
        expect(
            fixture<NativeTerminalResizeInput>(
                "terminal/terminal.resize_input.json",
            ),
        ).toMatchObject({ cols: 100, rows: 28 });
        expect(
            fixture<NativeTerminalKillInput>("terminal/terminal.kill_input.json"),
        ).toMatchObject({ sessionId: "terminal_1" });
        expect(
            fixture<NativeTerminalCloseInput>(
                "terminal/terminal.close_input.json",
            ),
        ).toMatchObject({ id: "terminal_1", reason: "user" });
        expect(
            fixture<NativeTerminalCloseWindowInput>(
                "terminal/terminal.close_window_input.json",
            ),
        ).toMatchObject({ windowId: "window_main" });
        expect(
            fixture<NativeTerminalListInput>(
                "terminal/terminal.list_input.json",
            ),
        ).toMatchObject({ windowId: "window_main" });

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
        expect(
            nativeTerminalExitEventToIpc({
                ...exitEvent,
                exitCode: null,
                signalCode: "Terminated: 15",
            }),
        ).toEqual({
            exitCode: null,
            sessionId: "terminal_1",
            signalCode: 15,
        });
    });
});

function fixture<T = unknown>(relativePath: string): T {
    return JSON.parse(
        readFileSync(path.join(fixtureRoot, relativePath), "utf8"),
    ) as T;
}

function aiEvent(relativePath: string) {
    const event = parseNativeBackendOutput(fixture(relativePath));
    expect(event.type).toBe("event");
    if (event.type !== "event") {
        throw new Error("expected event");
    }

    return nativeAiEventToIpc(event);
}

function eventPayload<T = never>(relativePath: string): T {
    const event = parseNativeBackendOutput(fixture(relativePath));
    expect(event.type).toBe("event");
    if (event.type !== "event") {
        throw new Error("expected event");
    }

    return event.payload as T;
}
