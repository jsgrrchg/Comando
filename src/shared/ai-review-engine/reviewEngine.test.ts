import { beforeAll, describe, expect, it } from "vitest";

import {
    engineBuildTextRangePatch,
    engineComputeDiffHunks,
    engineDeriveLinePatchFromSpans,
    initReviewEngine,
    isReviewEngineReady,
} from "./reviewEngine";

function hunkLines(oldText: string, newText: string): readonly string[] {
    return engineComputeDiffHunks(oldText, newText, `${oldText}->${newText}`)
        .flatMap((hunk) => hunk.lines)
        .map((line) => `${line.type}:${line.text}`);
}

describe("review Rust/WASM engine", () => {
    beforeAll(async () => {
        await initReviewEngine();
    });

    it("loads the engine", () => {
        expect(isReviewEngineReady()).toBe(true);
    });

    it("computes line hunks (engine is the source of truth)", () => {
        expect(hunkLines("a\nb\nc\n", "a\nB\nc\n")).toEqual([
            "remove:b",
            "add:B",
        ]);
        expect(hunkLines("one\ntwo\nthree\n", "one\nthree\n")).toEqual([
            "remove:two",
        ]);
        // Trailing newline handled correctly: two added lines, not three.
        expect(hunkLines("", "added\nlines\n")).toEqual([
            "add:added",
            "add:lines",
        ]);
        expect(hunkLines("x\ny\nz\n", "x\ny1\ny2\nz\n")).toEqual([
            "remove:y",
            "add:y1",
            "add:y2",
        ]);
    });

    it("produces UTF-16 offset spans for a sub-line edit", () => {
        // Changing "2" -> "99" inside a line: the span covers just the changed
        // characters, not the whole line — line-based diffing cannot do this.
        const patch = engineBuildTextRangePatch(
            "const y = 2;\n",
            "const y = 99;\n",
        );
        expect(patch.spans).toHaveLength(1);
        const [span] = patch.spans;
        expect("const y = 2;\n".slice(span.baseFrom, span.baseTo)).toBe("2");
        expect("const y = 99;\n".slice(span.currentFrom, span.currentTo)).toBe(
            "99",
        );
    });

    it("derives a line patch from offset spans", () => {
        const oldText = "a\nb\nc\n";
        const newText = "a\nB\nc\n";
        const patch = engineBuildTextRangePatch(oldText, newText);
        const linePatch = engineDeriveLinePatchFromSpans(
            oldText,
            newText,
            patch.spans,
        );
        expect(linePatch.edits).toEqual([
            { oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 },
        ]);
    });
});
