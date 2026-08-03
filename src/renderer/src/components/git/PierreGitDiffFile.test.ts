import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import type { GitDiffFile } from "./types";
import {
    canRenderGitDiffWithPierre,
    compactPartialHunkOffsets,
    createPierreGitDiffItem,
    createPierreGitCodeViewItems,
    getPierreDiffVirtualMetrics,
    getPierreGitDiffPatch,
    getPierreGitPlaceholderLabel,
    PIERRE_GIT_DIFF_HEADER_HEIGHT_PX,
    PIERRE_GIT_DIFF_UNSAFE_CSS,
} from "./PierreGitDiffFile";
import { GIT_DIFF_FIXTURES } from "./GitDiffFixtures";

describe("Pierre Git diff adapter", () => {
    it("uses the raw Git patch without requiring complete file contents", () => {
        const file = GIT_DIFF_FIXTURES.update;
        const patch = getPierreGitDiffPatch({
            ...file,
            newText: null,
            oldText: null,
        });

        expect(canRenderGitDiffWithPierre(file)).toBe(true);
        expect(patch).toBe(file.patch);
        expect(parsePatchFiles(patch ?? "", file.id, true)[0]?.files).toHaveLength(1);
    });

    it.each([
        ["update", GIT_DIFF_FIXTURES.update],
        ["create", GIT_DIFF_FIXTURES.create],
        ["delete", GIT_DIFF_FIXTURES.delete],
        ["rename", GIT_DIFF_FIXTURES.rename],
        ["missing final newline", GIT_DIFF_FIXTURES.noFinalNewline],
        ["long line", GIT_DIFF_FIXTURES.longLine],
        ["partial GitHub patch", GIT_DIFF_FIXTURES.partialGitHub],
    ] as const)("keeps %s patches eligible", (_label, file) => {
            expect(canRenderGitDiffWithPierre(file)).toBe(true);
            expect(getPierreGitDiffPatch(file)).not.toBeNull();
    });

    it("wraps hunk-only patches in the file headers PatchDiff requires", () => {
        const file: GitDiffFile = {
            ...GIT_DIFF_FIXTURES.partialGitHub,
            patch: "@@ -1 +1 @@\n-old\n+new\n",
        };

        const patch = getPierreGitDiffPatch(file);

        expect(patch).toBe(
            "--- src/main.ts\n+++ src/main.ts\n@@ -1 +1 @@\n-old\n+new\n",
        );
        expect(parsePatchFiles(patch ?? "", file.id, true)[0]?.files).toHaveLength(1);
    });

    it("compacts deep partial hunk offsets without losing context separators", () => {
        const item = createPierreGitDiffItem(
            {
                ...GIT_DIFF_FIXTURES.partialGitHub,
                patch:
                    "@@ -3400,2 +3400,2 @@\n first\n-old\n+new\n@@ -5100,1 +5100,1 @@\n-oldest\n+latest\n",
            },
            false,
        );

        expect(item).not.toBeNull();
        const fileDiff = item?.fileDiff;
        expect(fileDiff?.isPartial).toBe(true);
        expect(fileDiff?.hunks[0]?.collapsedBefore).toBeGreaterThan(3_000);
        expect(fileDiff?.hunks[0]?.unifiedLineStart).toBe(0);
        expect(fileDiff?.hunks[1]?.unifiedLineStart).toBe(
            fileDiff?.hunks[0]?.unifiedLineCount,
        );
    });

    it("leaves complete file layouts untouched when compacting offsets", () => {
        const partial = createPierreGitDiffItem(
            GIT_DIFF_FIXTURES.update,
            false,
        )?.fileDiff;
        const complete = partial ? { ...partial, isPartial: false } : null;

        expect(complete).toBeDefined();
        expect(compactPartialHunkOffsets(complete!)).toBe(complete);
    });

    it("builds a partial patch from legacy hunks when a source has no raw patch", () => {
        const file: GitDiffFile = {
            ...GIT_DIFF_FIXTURES.rename,
            newText: null,
            oldText: null,
            patch: null,
        };

        const patch = getPierreGitDiffPatch(file);

        expect(patch).toContain(
            "--- src/old-name.ts\n+++ src/new-name.ts\n",
        );
        expect(patch).toContain(
            "-export const previous = true;\n+export const renamed = true;\n",
        );
        expect(parsePatchFiles(patch ?? "", file.id, true)[0]?.files).toHaveLength(1);
    });

    it("aligns Pierre's virtual line estimates with the resolved typography", () => {
        expect(
            getPierreDiffVirtualMetrics(null, null).lineHeight,
        ).toBeCloseTo(20.15);
        expect(
            getPierreDiffVirtualMetrics(null, null).diffHeaderHeight,
        ).toBe(PIERRE_GIT_DIFF_HEADER_HEIGHT_PX);
        expect(getPierreDiffVirtualMetrics(15, 1.6)).toMatchObject({
            lineHeight: 24,
        });
        expect(getPierreDiffVirtualMetrics(15, 26)).toMatchObject({
            lineHeight: 26,
        });
    });

    it("uses the stable Pierre header data attributes for compact sticky styling", () => {
        expect(PIERRE_GIT_DIFF_UNSAFE_CSS).toContain(
            '[data-diffs-header="default"]',
        );
        expect(PIERRE_GIT_DIFF_UNSAFE_CSS).toContain("[data-sticky]");
    });

    it.each([
        ["binary", GIT_DIFF_FIXTURES.binary],
    ])("marks %s files as unavailable textual diffs", (_label, file) => {
        expect(canRenderGitDiffWithPierre(file)).toBe(false);
        expect(getPierreGitDiffPatch(file)).toBeNull();
    });

    it("creates an ordered placeholder instead of rejecting a mixed stack", () => {
        const items = createPierreGitCodeViewItems([
            GIT_DIFF_FIXTURES.update,
            GIT_DIFF_FIXTURES.binary,
        ]);

        expect(items).toMatchObject([
            {
                id: GIT_DIFF_FIXTURES.update.id,
                type: "diff",
            },
            {
                file: {
                    contents: "",
                    name: GIT_DIFF_FIXTURES.binary.path,
                },
                id: GIT_DIFF_FIXTURES.binary.id,
                type: "file",
            },
        ]);
        expect(getPierreGitPlaceholderLabel(GIT_DIFF_FIXTURES.binary)).toBe(
            "Binary file changed",
        );
    });

    it("labels empty and invalid text diffs without leaving CodeView", () => {
        const emptyFile: GitDiffFile = {
            ...GIT_DIFF_FIXTURES.update,
            hunks: [],
            patch: null,
        };
        const invalidFile: GitDiffFile = {
            ...GIT_DIFF_FIXTURES.update,
            id: "invalid-patch",
            patch: "not a patch",
        };
        const items = createPierreGitCodeViewItems([emptyFile, invalidFile]);

        expect(items).toMatchObject([
            { id: emptyFile.id, type: "file" },
            { id: invalidFile.id, type: "file" },
        ]);
        expect(getPierreGitPlaceholderLabel(emptyFile)).toBe(
            "No textual changes",
        );
        expect(getPierreGitPlaceholderLabel(invalidFile)).toBe(
            "Diff unavailable",
        );
    });
});
