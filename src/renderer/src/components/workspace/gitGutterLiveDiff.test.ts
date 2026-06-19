import { describe, expect, it } from "vitest";

import { computeGitGutterMarkers } from "./gitGutter";
import { buildLiveGitGutterDiff } from "./gitGutterLiveDiff";

function buildDiff(baseText: string, currentText: string) {
    const diff = buildLiveGitGutterDiff({
        baseText,
        currentText,
        kind: "update",
        path: "src/example.ts",
        previousPath: null,
    });

    if (!diff) {
        throw new Error("Expected live diff to be built.");
    }

    return diff;
}

describe("buildLiveGitGutterDiff", () => {
    it("returns an empty diff when the live buffer matches the base text", () => {
        expect(buildDiff("const value = 1;\n", "const value = 1;\n").hunks)
            .toEqual([]);
    });

    it("marks live replacements and additions", () => {
        const diff = buildDiff(
            "const value = 1;\nconst same = true;\n",
            [
                "const value = 2;",
                "const same = true;",
                "const extra = true;",
                "",
            ].join("\n"),
        );

        expect(computeGitGutterMarkers(diff, 4)).toEqual([
            {
                deletedAtLineEnd: false,
                endLineNumber: 1,
                lineNumber: 1,
                type: "modify",
            },
            {
                deletedAtLineEnd: false,
                endLineNumber: 3,
                lineNumber: 3,
                type: "add",
            },
        ]);
    });

    it("anchors live deletions to the next surviving line", () => {
        const diff = buildDiff("alpha\nremove me\nomega\n", "alpha\nomega\n");

        expect(computeGitGutterMarkers(diff, 3)).toEqual([
            {
                deletedAtLineEnd: false,
                endLineNumber: 2,
                lineNumber: 2,
                type: "delete",
            },
        ]);
    });

    it("does not mark stable lines between separate live edits", () => {
        const diff = buildDiff(
            ["one", "two", "three", "four", "five", ""].join("\n"),
            ["ONE", "two", "three", "FOUR", "five", ""].join("\n"),
        );

        expect(computeGitGutterMarkers(diff, 6)).toEqual([
            {
                deletedAtLineEnd: false,
                endLineNumber: 1,
                lineNumber: 1,
                type: "modify",
            },
            {
                deletedAtLineEnd: false,
                endLineNumber: 4,
                lineNumber: 4,
                type: "modify",
            },
        ]);
    });

    it("declines to compute very large live diff matrices", () => {
        const baseText = Array.from(
            { length: 1_500 },
            (_, index) => `base ${index}`,
        ).join("\n");
        const currentText = Array.from(
            { length: 1_500 },
            (_, index) => `current ${index}`,
        ).join("\n");

        expect(
            buildLiveGitGutterDiff({
                baseText,
                currentText,
                kind: "update",
                path: "src/large.ts",
                previousPath: null,
            }),
        ).toBeNull();
    });
});
