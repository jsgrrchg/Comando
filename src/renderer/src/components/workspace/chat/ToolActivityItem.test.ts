import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";

import { ToolActivityItem } from "./ToolActivityItem";

const mockAiStoreState = vi.hoisted(() => ({
    current: {
        sessions: {} as Record<string, unknown>,
    },
}));

vi.mock("@renderer/app/store/ai-store", () => ({
    useAiStore: (
        selector: (state: typeof mockAiStoreState.current) => unknown,
    ) => selector(mockAiStoreState.current),
}));

vi.mock("@renderer/app/hooks/use-ai-chat-settings", () => ({
    useAiChatSettings: () => ({
        chatFontFamily: "system",
        chatFontSize: 14,
        composerFontFamily: "system",
        composerFontSize: 14,
        requireCmdEnterToSend: false,
        reviewDiffZoom: 0.72,
        screenshotRetentionSeconds: 0,
        historyRetentionDays: 0,
        toolCardExpansionMode: "collapsed",
    }),
}));

function createActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
        diffs: [],
        exitCode: null,
        id: "tool-1",
        kind: "edit",
        locations: [
            {
                endLine: null,
                line: null,
                path: "src/app.ts",
            },
        ],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: "session-1",
        status: "completed",
        summary: "Updated src/app.ts",
        terminalOutput: null,
        title: "Edit file",
        updatedAt: "2026-04-14T00:00:00.000Z",
        ...overrides,
    };
}

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
        sessionId: "session-1",
        toolCallId: "tool-1",
        updatedAt: "2026-04-14T00:00:00.000Z",
        ...overrides,
    };
}

describe("ToolActivityItem", () => {
    it("uses ChangeReviewPanel when tracked files or reviewable diffs exist", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    diffs: [
                        {
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
                            isText: true,
                            kind: "update",
                            newText: "const after = true;\n",
                            oldText: "const before = true;\n",
                            path: "src/app.ts",
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [createTrackedFile()],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Edited app.ts");
        expect(markup).toContain("font-weight:400");
        expect(markup).not.toContain("Accept");
        expect(markup).not.toContain("Reject");
    });

    it("falls back to file tool card when no reviewable preview exists", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity(),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Edit file");
        expect(markup).not.toContain("done");
        expect(markup).not.toContain("Accept");
        expect(markup).not.toContain("Reject");
    });

    it("expands file tool details when the card policy is always expanded", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity(),
                expansionMode: "expanded",
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Updated src/app.ts");
    });

    it("does not expand read tool details when the card policy is always expanded", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    kind: "read",
                    summary: "Read-only details stay collapsed.",
                    title: "Read src/app.ts",
                }),
                expansionMode: "expanded",
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Read ");
        expect(markup).toContain("src/app.ts");
        expect(markup).not.toContain("Read-only details stay collapsed.");
    });

    it("does not expand terminal tool details when the card policy is always expanded", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    kind: "shell",
                    rawInputJson: JSON.stringify({ command: "echo hidden" }),
                    summary: null,
                    terminalOutput: "terminal hidden output\n",
                    title: "Run echo",
                }),
                expansionMode: "expanded",
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Run echo");
        expect(markup).not.toContain("terminal hidden output");
    });

    it("does not expand generic tool details when the card policy is always expanded", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    kind: "unknown",
                    locations: [],
                    rawInputJson: JSON.stringify({ value: "generic hidden" }),
                    summary: "Generic hidden summary.",
                    title: "Run generic tool",
                }),
                expansionMode: "expanded",
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Run generic tool");
        expect(markup).not.toContain("Generic hidden summary.");
        expect(markup).not.toContain("generic hidden");
    });

    it("only expands latest live tool details for the latest policy", () => {
        const historyMarkup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity(),
                expansionMode: "latest",
                isLatestStreamingTool: false,
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );
        const liveMarkup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity(),
                expansionMode: "latest",
                isLatestStreamingTool: true,
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(historyMarkup).not.toContain("Updated src/app.ts");
        expect(liveMarkup).toContain("Updated src/app.ts");
        expect(liveMarkup).toContain("cursor:pointer");
    });

    it("renders read tool titles as clickable internal links when they target a project file", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    kind: "read",
                    locations: [],
                    summary: null,
                    title: "Read src/components/example.cpp",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Read ");
        expect(markup).toContain("src/components/example.cpp");
        expect(markup).toContain("Open src/components/example.cpp");
        expect(markup).toContain("color:inherit");
    });

    it("renders turn_started as a subtle Codex ACP-style divider", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    id: "codex-acp:status:turn:turn-1",
                    kind: "other",
                    summary: "Context window: 128000",
                    title: "New turn",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain('data-testid="turn-start-divider"');
        expect(markup).toContain("New turn");
        expect(markup).not.toContain("Context window: 128000");
    });

    it("renders open-session actions for subagent breadcrumbs", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    action: {
                        kind: "open_session",
                        sessionId: "child-session",
                    },
                    kind: "unknown",
                    locations: [],
                    summary: null,
                    title: "Spawned Galileo",
                }),
                onOpenFile: async () => {},
                onOpenSession: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Open Galileo");
        expect(markup).toContain("app-no-drag");
    });

    it("highlights structured payloads and terminal output in details", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    kind: "shell",
                    rawInputJson: JSON.stringify({ command: "cat Cargo.toml" }),
                    rawOutputJson: JSON.stringify({
                        package: { name: "comando" },
                    }),
                    status: "failed",
                    terminalOutput: '[package]\nname = "comando"\n',
                    title: "Run shell command",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("cm-static-code");
        expect(markup).toContain("Cargo.toml");
        expect(markup).toContain("comando");
        expect(markup.indexOf("comando")).toBeLessThan(
            markup.indexOf("Cargo.toml"),
        );
    });

    it("keeps failed terminal cards compact when there is no output to show", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    exitCode: 1,
                    kind: "shell",
                    rawInputJson: JSON.stringify({
                        command: "pnpm run typecheck",
                    }),
                    status: "failed",
                    summary: null,
                    terminalOutput: null,
                    title: "Run pnpm run typecheck",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Run pnpm run typecheck");
        expect(markup).toContain("exit 1");
        expect(markup).not.toContain("space-y-1");
        expect(markup).not.toContain("cm-static-code");
    });

    it("does not repeat duplicated terminal commands in expanded output", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    exitCode: 1,
                    kind: "shell",
                    rawInputJson: JSON.stringify({
                        command: "pnpm run typecheck",
                    }),
                    status: "failed",
                    summary: null,
                    terminalOutput: "Type error\n",
                    title: "Run pnpm run typecheck",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Type error");
        expect(markup).toContain("space-y-1");
        expect(markup.match(/pnpm run typecheck/g)).toHaveLength(1);
    });
});
