import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiSessionSnapshot, AiTrackedFile } from "@shared/ipc";
import type { RuntimeWorkspaceReviewTab } from "@renderer/app/workspace/tree";

const mockAiStoreState = vi.hoisted(() => ({
    current: {
        ensureSession: vi.fn(async () => {}),
        keepAllTrackedFiles: vi.fn(async () => {}),
        keepTrackedFile: vi.fn(async () => {}),
        keepTrackedFileHunks: vi.fn(async () => {}),
        rejectAllTrackedFiles: vi.fn(async () => {}),
        rejectTrackedFile: vi.fn(async () => {}),
        rejectTrackedFileHunks: vi.fn(async () => {}),
        sessions: {} as Record<string, unknown>,
        setSessionDiffZoom: vi.fn(),
    },
}));

vi.mock("@renderer/app/store/ai-store", () => ({
    useAiStore: (
        selector: (state: typeof mockAiStoreState.current) => unknown,
    ) => selector(mockAiStoreState.current),
}));

import { ReviewTabView } from "./ReviewTabView";

const TAB: RuntimeWorkspaceReviewTab = {
    createdAt: "2026-04-14T00:00:00.000Z",
    id: "review-tab-1",
    kind: "review",
    projectId: "project-1",
    runtimeId: "codex",
    sessionId: "session-1",
    title: "Review",
    worktreeId: null,
};

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    return {
        hunks: [
            {
                id: "hunk-1",
                lines: [
                    {
                        id: "line-1",
                        text: "const before = true;",
                        type: "remove",
                    },
                    {
                        id: "line-2",
                        text: "const after = true;",
                        type: "add",
                    },
                ],
                newCount: 1,
                newStart: 8,
                oldCount: 1,
                oldStart: 8,
            },
        ],
        identityKey: "file-1",
        isText: true,
        kind: "update",
        newText: "const after = true;\n",
        oldText: "const before = true;\n",
        path: "src/app.ts",
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: TAB.sessionId,
        toolCallId: "tool-1",
        updatedAt: "2026-04-14T12:00:00.000Z",
        ...overrides,
    };
}

function createSnapshot(
    trackedFiles: readonly AiTrackedFile[],
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
        plan: null,
        projectId: TAB.projectId,
        runtimeId: TAB.runtimeId,
        runtimeSessionId: "runtime-session-1",
        sessionId: TAB.sessionId,
        status: "idle",
        title: TAB.title,
        toolActivity: [],
        trackedFiles: [...trackedFiles],
        updatedAt: "2026-04-14T00:00:00.000Z",
        worktreeId: TAB.worktreeId,
    };
}

function setMockSessionSnapshot(snapshot: AiSessionSnapshot) {
    mockAiStoreState.current.sessions = {
        [TAB.sessionId]: {
            diffZoom: 0.72,
            localError: null,
            snapshot,
        },
    };
}

describe("ReviewTabView", () => {
    beforeEach(() => {
        const storage = new Map<string, string>();
        vi.stubGlobal("localStorage", {
            clear: () => storage.clear(),
            getItem: (key: string) => storage.get(key) ?? null,
            key: (index: number) => Array.from(storage.keys())[index] ?? null,
            get length() {
                return storage.size;
            },
            removeItem: (key: string) => {
                storage.delete(key);
            },
            setItem: (key: string, value: string) => {
                storage.set(key, value);
            },
        });

        mockAiStoreState.current.ensureSession.mockClear();
        mockAiStoreState.current.keepAllTrackedFiles.mockClear();
        mockAiStoreState.current.keepTrackedFile.mockClear();
        mockAiStoreState.current.keepTrackedFileHunks.mockClear();
        mockAiStoreState.current.rejectAllTrackedFiles.mockClear();
        mockAiStoreState.current.rejectTrackedFile.mockClear();
        mockAiStoreState.current.rejectTrackedFileHunks.mockClear();
        mockAiStoreState.current.setSessionDiffZoom.mockClear();
        mockAiStoreState.current.sessions = {};
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("renders the header with stats and actions when pending changes exist", () => {
        setMockSessionSnapshot(
            createSnapshot([
                createTrackedFile(),
                createTrackedFile({
                    hunks: [],
                    identityKey: "file-2",
                    kind: "create",
                    newText: "export const secondary = true;\n",
                    oldText: "",
                    path: "src/secondary.ts",
                    updatedAt: "2026-04-14T12:00:01.000Z",
                }),
            ]),
        );

        const markup = renderToStaticMarkup(
            createElement(ReviewTabView, {
                onOpenFile: async () => {},
                tab: TAB,
            }),
        );

        expect(markup).toContain("Pending Changes");
        expect(markup).toContain("collapse");
        expect(markup).toContain("reject all");
        expect(markup).toContain("keep all");
        expect(markup).toContain("src/app.ts");
        expect(markup).toContain("src/secondary.ts");
        expect(markup).toContain(">2 files<");
        expect(markup).toContain("+2");
        expect(markup).toContain("-1");
    });

    it("displays empty state when there are no pending changes", () => {
        setMockSessionSnapshot(createSnapshot([]));

        const markup = renderToStaticMarkup(
            createElement(ReviewTabView, {
                onOpenFile: async () => {},
                tab: TAB,
            }),
        );

        expect(markup).toContain("No pending AI edits");
        expect(markup).toContain("New edits will appear here automatically.");
    });
});
