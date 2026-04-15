import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";

import { ToolActivityItem } from "./ToolActivityItem";

function createActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
        diffs: [],
        exitCode: null,
        id: "tool-1",
        kind: "edit",
        locations: ["src/app.ts"],
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
    it("usa ChangeReviewPanel cuando hay tracked files o diffs reviewables", () => {
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
        expect(markup).not.toContain("Accept");
        expect(markup).not.toContain("Reject");
    });

    it("cae al card de file tool cuando no hay preview reviewable", () => {
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

    it("renderiza turn_started como divisor sutil al estilo reference app", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    id: "neverwrite:status:turn:turn-1",
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

    it("resalta payloads estructurados y salida terminal en los detalles", () => {
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
    });
});
