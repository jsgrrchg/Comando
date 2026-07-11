import { describe, expect, it } from "vitest";

import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";

import {
    getStructuredToolCommand,
    getStructuredToolTarget,
    getToolActivityDescriptor,
} from "./toolActivityDescriptor";
import { isEditedFileToolActivity } from "./toolActivityKinds";

function createActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        action: null,
        createdAt: "2026-07-10T00:00:00.000Z",
        diffs: [],
        exitCode: null,
        id: "tool-1",
        kind: "read",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: "session-1",
        status: "completed",
        summary: null,
        terminalOutput: null,
        title: "Read file",
        updatedAt: "2026-07-10T00:00:00.000Z",
        ...overrides,
    };
}

describe("toolActivityDescriptor", () => {
    it("resolves a file target from structured input without locations", () => {
        const activity = createActivity({
            rawInputJson: JSON.stringify({ file_path: "src/app.ts" }),
        });

        expect(getStructuredToolTarget(activity)).toBe("src/app.ts");
        expect(getToolActivityDescriptor(activity)).toEqual({
            category: "file",
            command: null,
            target: "src/app.ts",
        });
    });

    it("prefers structured input over locations and never derives from titles", () => {
        const activity = createActivity({
            locations: [
                {
                    endLine: null,
                    line: null,
                    path: "src/from-location.ts",
                },
            ],
            rawInputJson: JSON.stringify({ path: "src/from-input.ts" }),
            title: "Read src/from-title.ts",
        });

        expect(getStructuredToolTarget(activity)).toBe("src/from-input.ts");
    });

    it("preserves basename-only structured targets for later resolution", () => {
        const activity = createActivity({
            rawInputJson: JSON.stringify({ filePath: "app.ts" }),
        });

        expect(getStructuredToolTarget(activity)).toBe("app.ts");
    });

    it("extracts terminal commands from provider-neutral structured input", () => {
        const activity = createActivity({
            kind: "shell",
            rawInputJson: JSON.stringify({ command: "pnpm test" }),
            title: "Run tests",
        });

        expect(getStructuredToolCommand(activity)).toBe("pnpm test");
        expect(getToolActivityDescriptor(activity)).toEqual({
            category: "command",
            command: "pnpm test",
            target: "pnpm test",
        });
    });

    it("classifies search and status activity without using provider ids", () => {
        expect(
            getToolActivityDescriptor(
                createActivity({
                    kind: "grep",
                    rawInputJson: JSON.stringify({ query: "TimelineRow" }),
                }),
            ),
        ).toMatchObject({ category: "search", target: "TimelineRow" });
        expect(
            getToolActivityDescriptor(createActivity({ kind: "status" })),
        ).toMatchObject({ category: "status" });
    });

    it("describes normalized fetch activity from query or url input", () => {
        expect(
            getToolActivityDescriptor(
                createActivity({
                    kind: "fetch",
                    rawInputJson: JSON.stringify({
                        url: "https://example.com/docs",
                    }),
                }),
            ),
        ).toMatchObject({
            category: "search",
            target: "https://example.com/docs",
        });
    });

    it("accepts the provider-neutral cmd command alias", () => {
        expect(
            getStructuredToolCommand(
                createActivity({
                    kind: "execute",
                    rawInputJson: JSON.stringify({ cmd: "pnpm typecheck" }),
                }),
            ),
        ).toBe("pnpm typecheck");
    });
});

describe("isEditedFileToolActivity", () => {
    it.each(["create", "delete", "edit", "move", "remove", "rename", "update", "write"])(
        "keeps %s activity visible before a diff arrives",
        (kind) => {
            expect(
                isEditedFileToolActivity(createActivity({ kind }), []),
            ).toBe(true);
        },
    );

    it("recognizes diff and tracked-file evidence", () => {
        const activityWithDiff = createActivity({
            diffs: [
                {
                    hunks: [],
                    isText: true,
                    kind: "update",
                    newText: "next",
                    oldText: "previous",
                    path: "src/app.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
            kind: "generic",
        });
        const trackedFile = {} as AiTrackedFile;

        expect(isEditedFileToolActivity(activityWithDiff, [])).toBe(true);
        expect(
            isEditedFileToolActivity(createActivity({ kind: "generic" }), [
                trackedFile,
            ]),
        ).toBe(true);
    });
});
