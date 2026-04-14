import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";

import { ChangeReviewPanel } from "./ChangeReviewPanel";

function createActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
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
        id: "tool-1",
        kind: "edit",
        locations: ["src/app.ts"],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: "session-1",
        status: "completed",
        summary: null,
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
        updatedAt: "2026-04-14T12:00:00.000Z",
        ...overrides,
    };
}

describe("ChangeReviewPanel", () => {
    it("renderiza el caso single-file con acciones y diff expandable", () => {
        const markup = renderToStaticMarkup(
            createElement(ChangeReviewPanel, {
                activity: createActivity(),
                defaultExpanded: true,
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [createTrackedFile()],
                worktreeId: "worktree-1",
            }),
        );

        expect(markup).toContain("Edited app.ts");
        expect(markup).toContain("Open");
        expect(markup).toContain("Accept");
        expect(markup).toContain("Reject");
        expect(markup).toContain("Resize diff preview");
        expect(markup).toContain("change-review-panel:file-1");
    });

    it("renderiza el caso multi-file con rows independientes", () => {
        const primaryDiff = createActivity().diffs[0];
        if (!primaryDiff) {
            throw new Error("Expected a primary diff for the test.");
        }

        const secondaryTrackedFile = createTrackedFile({
            hunks: [],
            identityKey: "file-2",
            kind: "create",
            newText: "export const value = 1;\n",
            oldText: "",
            path: "src/secondary.ts",
            previousPath: null,
            toolCallId: "tool-1",
            updatedAt: "2026-04-14T12:00:01.000Z",
        });
        const activity = createActivity({
            diffs: [
                primaryDiff,
                {
                    hunks: [],
                    isText: true,
                    kind: "create",
                    newText: "export const value = 1;\n",
                    oldText: "",
                    path: "src/secondary.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
        });

        const markup = renderToStaticMarkup(
            createElement(ChangeReviewPanel, {
                activity,
                defaultExpanded: true,
                defaultExpandedFileKeys: ["file-1"],
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [createTrackedFile(), secondaryTrackedFile],
            }),
        );

        expect(markup).toContain("Edited 2 files");
        expect(markup).toContain("src/app.ts");
        expect(markup).toContain("src/secondary.ts");
        expect(markup).toContain("chat-review-diff:file-1");
    });
});
