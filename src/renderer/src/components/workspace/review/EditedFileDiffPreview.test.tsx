import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AiFileDiff, AiTrackedFile } from "@shared/ipc";

import { EditedFileDiffPreview } from "./EditedFileDiffPreview";

function createDiff(): AiFileDiff {
    return {
        hunks: [
            {
                id: "hunk-1",
                lines: [
                    {
                        id: "hunk-1:remove",
                        text: "const firstBefore = true;",
                        type: "remove",
                    },
                    {
                        id: "hunk-1:add",
                        text: "const firstAfter = true;",
                        type: "add",
                    },
                ],
                newCount: 1,
                newStart: 3,
                oldCount: 1,
                oldStart: 3,
            },
            {
                id: "hunk-2",
                lines: [
                    {
                        id: "hunk-2:remove",
                        text: "const secondBefore = true;",
                        type: "remove",
                    },
                    {
                        id: "hunk-2:add",
                        text: "const secondAfter = true;",
                        type: "add",
                    },
                ],
                newCount: 1,
                newStart: 12,
                oldCount: 1,
                oldStart: 12,
            },
        ],
        isText: true,
        kind: "update",
        newText: "const firstAfter = true;\nconst secondAfter = true;\n",
        oldText: "const firstBefore = true;\nconst secondBefore = true;\n",
        path: "src/app.ts",
        previousPath: null,
        reversible: true,
    };
}

function createTrackedFile(): AiTrackedFile {
    return {
        hunks: [
            {
                id: "hunk-2",
                lines: [
                    {
                        id: "hunk-2:remove",
                        text: "const secondBefore = true;",
                        type: "remove",
                    },
                    {
                        id: "hunk-2:add",
                        text: "const secondAfter = true;",
                        type: "add",
                    },
                ],
                newCount: 1,
                newStart: 12,
                oldCount: 1,
                oldStart: 12,
            },
        ],
        identityKey: "file-1",
        isText: true,
        kind: "update",
        newText: "const firstAfter = true;\nconst secondAfter = true;\n",
        oldText: "const firstBefore = true;\nconst secondBefore = true;\n",
        path: "src/app.ts",
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-1",
        toolCallId: "tool-1",
        updatedAt: "2026-04-14T12:00:00.000Z",
    };
}

describe("EditedFileDiffPreview", () => {
    it("keeps hunk actions bound to the tracked hunk id after partial resolution", () => {
        const markup = renderToStaticMarkup(
            <EditedFileDiffPreview
                diff={createDiff()}
                diffZoom={0.72}
                expanded
                file={createTrackedFile()}
                onKeepHunk={() => {}}
                onRejectHunk={() => {}}
                testId="preview-test"
            />,
        );

        expect(markup).toContain('data-review-hunk-key="hunk-2"');
        expect(markup).not.toContain('data-review-hunk-key="hunk-1"');
        expect(markup).toContain("Accept hunk 2");
        expect(markup).not.toContain("Accept hunk 1");
    });
});
