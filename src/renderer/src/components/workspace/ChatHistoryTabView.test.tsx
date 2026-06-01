import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
    AiHistorySessionSummary,
    AiSessionSnapshot,
} from "@shared/ipc";
import type { RuntimeWorkspaceChatHistoryTab } from "@renderer/app/workspace/tree";

import { ChatHistoryTabLayout } from "./ChatHistoryTabView";

const BASE_TAB: RuntimeWorkspaceChatHistoryTab = {
    createdAt: "2026-04-17T10:00:00.000Z",
    id: "history-tab-1",
    kind: "chat_history",
    projectId: "project-1",
    title: "History",
    worktreeId: "worktree-1",
};

function createSession(
    overrides: Partial<AiHistorySessionSummary> = {},
): AiHistorySessionSummary {
    return {
        createdAt: "2026-04-17T10:00:00.000Z",
        messageCount: 2,
        preview: "Assistant returns a concise answer.",
        projectId: "project-1",
        runtimeId: "codex",
        sessionId: "session-1",
        title: "Session One",
        updatedAt: "2026-04-17T10:05:00.000Z",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

function createSnapshot(
    overrides: Partial<AiSessionSnapshot> = {},
): AiSessionSnapshot {
    return {
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: {
            entries: [
                {
                    content: "Inspect persisted transcript",
                    priority: "medium",
                    status: "completed",
                },
            ],
            updatedAt: "2026-04-17T10:05:00.000Z",
        },
        projectId: "project-1",
        runtimeId: "codex",
        runtimeSessionId: null,
        sessionId: "session-1",
        status: "idle",
        title: "Session One",
        tokenUsage: null,
        toolActivity: [
            {
                createdAt: "2026-04-17T10:04:00.000Z",
                diffs: [],
                exitCode: 0,
                id: "tool-1",
                kind: "shell",
                locations: [
                    {
                        endLine: null,
                        line: null,
                        path: "src/app.ts",
                    },
                ],
                rawInputJson: "{\"cmd\":\"echo hello\"}",
                rawOutputJson: "{\"ok\":true}",
                sessionId: "session-1",
                status: "completed",
                summary: "Executed a shell command.",
                terminalOutput: "hello",
                title: "Shell",
                updatedAt: "2026-04-17T10:04:01.000Z",
            },
        ],
        trackedFiles: [
            {
                currentText: "export const value = 2;\n",
                hunks: [],
                identityKey: "src/app.ts",
                isText: true,
                kind: "update",
                newText: "export const value = 2;\n",
                oldText: "export const value = 1;\n",
                path: "src/app.ts",
                previousPath: null,
                reviewState: "pending",
                reversible: true,
                sessionId: "session-1",
                toolCallId: null,
                updatedAt: "2026-04-17T10:04:02.000Z",
            },
        ],
        updatedAt: "2026-04-17T10:05:00.000Z",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

function renderLayout(
    overrides: Partial<Parameters<typeof ChatHistoryTabLayout>[0]> = {},
): string {
    const selectedSession = overrides.selectedSession ?? null;

    return renderToStaticMarkup(
        createElement(ChatHistoryTabLayout, {
            hasMoreMessages: false,
            handleDelete: vi.fn(async () => {}),
            handleOpenInChat: vi.fn(async () => {}),
            handleRefresh: vi.fn(async () => {}),
            handleRename: vi.fn(() => Promise.resolve()),
            isBusy: false,
            isLoadingSessions: false,
            loadSessionSnapshot: vi.fn(async () => {}),
            loadTranscriptPage: vi.fn(async () => {}),
            mutatingSessionId: null,
            scopeLabel: "Project One",
            selectedSession,
            selectedSessionId: selectedSession?.sessionId ?? null,
            selectedSnapshot: null,
            selectedSnapshotState: null,
            selectedSnapshotStatus: null,
            selectedTranscript: null,
            sessions: [],
            sessionsError: null,
            setSelectedSessionId: vi.fn(),
            tab: BASE_TAB,
            transcriptMessages: [],
            worktreeLabel: "worktree-1",
            ...overrides,
        }),
    );
}

describe("ChatHistoryTabLayout", () => {
    it("renders the loading state", () => {
        const markup = renderLayout({
            isLoadingSessions: true,
        });

        expect(markup).toContain("Loading history");
        expect(markup).toContain("Loading sessions");
    });

    it("renders the empty state", () => {
        const markup = renderLayout();

        expect(markup).toContain("No chat history yet");
        expect(markup).toContain("Select a conversation");
    });

    it("renders the error state", () => {
        const markup = renderLayout({
            sessionsError: "Could not load chat history.",
        });

        expect(markup).toContain("Could not load history");
        expect(markup).toContain("Could not load chat history.");
    });

    it("renders the session list and selected detail with transcript artifacts", () => {
        const session = createSession();
        const markup = renderLayout({
            hasMoreMessages: true,
            selectedSession: session,
            selectedSnapshot: createSnapshot(),
            selectedSnapshotState: {
                error: null,
                isLoading: false,
                snapshot: createSnapshot(),
            },
            selectedSnapshotStatus: "idle",
            selectedTranscript: {
                error: null,
                isLoading: false,
                messages: [
                    {
                        attachments: [],
                        content: "User asks for a summary",
                        createdAt: "2026-04-17T10:01:00.000Z",
                        id: "msg-1",
                        kind: "user",
                        status: "completed",
                    },
                    {
                        attachments: [],
                        content: "Assistant returns a concise answer.",
                        createdAt: "2026-04-17T10:02:00.000Z",
                        id: "msg-2",
                        kind: "assistant",
                        status: "completed",
                    },
                ],
                totalMessages: 3,
            },
            sessions: [session],
            transcriptMessages: [
                {
                    attachments: [],
                    content: "User asks for a summary",
                    createdAt: "2026-04-17T10:01:00.000Z",
                    id: "msg-1",
                    kind: "user",
                    status: "completed",
                },
                {
                    attachments: [],
                    content: "Assistant returns a concise answer.",
                    createdAt: "2026-04-17T10:02:00.000Z",
                    id: "msg-2",
                    kind: "assistant",
                    status: "completed",
                },
            ],
        });

        expect(markup).toContain("Session One");
        expect(markup).toContain("Assistant returns a concise answer.");
        expect(markup).toContain("open in chat");
        expect(markup).toContain("Load More");
    });

    it("renders child agents under their parent without rename actions", () => {
        const parent = createSession({
            sessionId: "parent-session",
            title: "Parent thread",
        });
        const child = createSession({
            parentSessionId: "parent-session",
            sessionId: "child-session",
            title: "Galileo",
        });

        const markup = renderLayout({
            selectedSession: child,
            sessions: [parent, child],
        });

        expect(markup).toContain('data-subagent="true"');
        expect(markup).toContain("Agent");
        expect(markup).toContain("Subagent of");
        expect(markup).toContain("Parent thread");
        expect(markup.match(/>rename</g)).toHaveLength(1);
    });

    it("renders a newer child below its parent in hierarchical history", () => {
        const parent = createSession({
            sessionId: "parent-session",
            title: "Parent thread",
            updatedAt: "2026-04-17T10:05:00.000Z",
        });
        const child = createSession({
            parentSessionId: "parent-session",
            sessionId: "child-session",
            title: "Galileo",
            updatedAt: "2026-04-17T10:06:00.000Z",
        });

        const markup = renderLayout({
            selectedSession: child,
            sessions: [child, parent],
        });

        expect(markup.indexOf("Parent thread")).toBeLessThan(
            markup.indexOf("Galileo"),
        );
        expect(markup).toContain('data-subagent="true"');
        expect(markup).toContain("ml-3");
    });

    it("resolves selected child context through the parent runtime session id", () => {
        const parent = createSession({
            runtimeSessionId: "runtime-parent",
            sessionId: "parent-session",
            title: "Parent thread",
        });
        const child = createSession({
            parentSessionId: "runtime-parent",
            runtimeSessionId: "runtime-child",
            sessionId: "child-session",
            title: "Galileo",
        });

        const markup = renderLayout({
            selectedSession: child,
            sessions: [parent, child],
        });

        expect(markup).toContain("Subagent of");
        expect(markup).toContain("Parent thread");
        expect(markup).not.toContain("Detached agent");
    });
});
