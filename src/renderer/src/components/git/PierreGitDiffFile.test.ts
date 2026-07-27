import { describe, expect, it } from "vitest";

import type { GitDiffFile } from "./types";
import {
    canRenderGitDiffWithPierre,
    getPierreDiffVirtualMetrics,
    getPierreGitDiffInput,
} from "./PierreGitDiffFile";
import { GIT_DIFF_FIXTURES } from "./GitDiffFixtures";

describe("Pierre Git diff adapter", () => {
    it("uses the native complete update fixture without changing its content", () => {
        const file = GIT_DIFF_FIXTURES.update;
        const input = getPierreGitDiffInput(file);

        expect(canRenderGitDiffWithPierre(file)).toBe(true);
        expect(input).toEqual({
            newFile: {
                cacheKey: `${file.id}:new`,
                contents: file.newText,
                name: file.path,
            },
            oldFile: {
                cacheKey: `${file.id}:old`,
                contents: file.oldText,
                name: file.path,
            },
        });
    });

    it.each([
        ["update", GIT_DIFF_FIXTURES.update],
        ["create", GIT_DIFF_FIXTURES.create],
        ["delete", GIT_DIFF_FIXTURES.delete],
        ["rename", GIT_DIFF_FIXTURES.rename],
        ["missing final newline", GIT_DIFF_FIXTURES.noFinalNewline],
        ["long line", GIT_DIFF_FIXTURES.longLine],
    ] as const)("keeps complete %s content eligible", (_label, file) => {
            expect(canRenderGitDiffWithPierre(file)).toBe(true);
            expect(getPierreGitDiffInput(file)).not.toBeNull();
    });

    it("accepts empty creates and deletes", () => {
        const created: GitDiffFile = {
            ...GIT_DIFF_FIXTURES.create,
            newText: "",
        };
        const deleted: GitDiffFile = {
            ...GIT_DIFF_FIXTURES.delete,
            oldText: "",
        };

        expect(getPierreGitDiffInput(created)).toMatchObject({
            newFile: { contents: "", name: created.path },
            oldFile: null,
        });
        expect(getPierreGitDiffInput(deleted)).toMatchObject({
            newFile: null,
            oldFile: { contents: "", name: deleted.path },
        });
    });

    it("uses the previous path for the old side of a rename", () => {
        const input = getPierreGitDiffInput(GIT_DIFF_FIXTURES.rename);

        expect(input?.oldFile?.name).toBe("src/old-name.ts");
        expect(input?.newFile?.name).toBe("src/new-name.ts");
    });

    it("preserves a missing final newline and a long line", () => {
        const noFinalNewline = getPierreGitDiffInput(
            GIT_DIFF_FIXTURES.noFinalNewline,
        );
        const longLine = getPierreGitDiffInput(GIT_DIFF_FIXTURES.longLine);

        expect(noFinalNewline?.oldFile?.contents).not.toMatch(/\n$/);
        expect(noFinalNewline?.newFile?.contents).not.toMatch(/\n$/);
        expect(longLine?.newFile?.contents.length).toBeGreaterThan(2_000);
    });

    it("aligns Pierre's virtual line estimates with the resolved typography", () => {
        expect(
            getPierreDiffVirtualMetrics(null, null).lineHeight,
        ).toBeCloseTo(20.15);
        expect(getPierreDiffVirtualMetrics(15, 1.6)).toMatchObject({
            lineHeight: 24,
        });
        expect(getPierreDiffVirtualMetrics(15, 26)).toMatchObject({
            lineHeight: 26,
        });
    });

    it.each([
        ["binary", GIT_DIFF_FIXTURES.binary],
        ["partial GitHub patch", GIT_DIFF_FIXTURES.partialGitHub],
    ])("keeps the legacy renderer for %s files", (_label, file) => {
        expect(canRenderGitDiffWithPierre(file)).toBe(false);
        expect(getPierreGitDiffInput(file)).toBeNull();
    });
});
