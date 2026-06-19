import type { editor as MonacoEditor, IRange } from "monaco-editor";
import { describe, expect, it, vi } from "vitest";

import type { GitDiffHunk, GitFileDiff } from "@shared/ipc";

import {
    buildGitGutterDecorations,
    computeGitGutterMarkers,
    GitGutterDecorator,
    getGitGutterLineNumbersMinChars,
    hasRenderableGitGutterChange,
} from "./gitGutter";

function createDiff(
    hunks: readonly GitDiffHunk[],
    overrides: Partial<GitFileDiff> = {},
): GitFileDiff {
    return {
        hunks,
        isText: true,
        kind: "update",
        newText: null,
        oldText: null,
        path: "src/example.ts",
        previousPath: null,
        reversible: true,
        ...overrides,
    };
}

function createHunk(
    lines: GitDiffHunk["lines"],
    overrides: Partial<GitDiffHunk> = {},
): GitDiffHunk {
    return {
        id: "hunk-1",
        lines,
        newCount: 1,
        newStart: 1,
        oldCount: 1,
        oldStart: 1,
        ...overrides,
    };
}

function createDecoratorHarness(lineCount = 12) {
    const decorations = new Map<
        string,
        MonacoEditor.IModelDeltaDecoration["range"]
    >();
    let decorationId = 0;

    const model = {
        getDecorationRange: (id: string): IRange | null =>
            decorations.get(id) ?? null,
        getLineCount: () => lineCount,
    };
    const deltaDecorations = vi.fn(
        (
            oldDecorations: readonly string[],
            newDecorations: readonly MonacoEditor.IModelDeltaDecoration[],
        ): string[] => {
            for (const id of oldDecorations) {
                decorations.delete(id);
            }

            return newDecorations.map((decoration) => {
                const id = `decoration-${++decorationId}`;
                decorations.set(id, decoration.range);
                return id;
            });
        },
    );
    const disposable = () => ({ dispose: vi.fn() });
    const editor = {
        deltaDecorations,
        getModel: () => model,
        onDidChangeModel: disposable,
        onWillChangeModel: disposable,
    } as unknown as MonacoEditor.IStandaloneCodeEditor;

    return {
        decorations,
        deltaDecorations,
        decorator: new GitGutterDecorator(editor),
    };
}

describe("computeGitGutterMarkers", () => {
    it("marks pure additions as add", () => {
        const diff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "const added = true;",
                        type: "add",
                    },
                ],
                { newCount: 1, newStart: 4, oldCount: 0, oldStart: 4 },
            ),
        ]);

        expect(computeGitGutterMarkers(diff, 12)).toEqual([
            {
                deletedAtLineEnd: false,
                endLineNumber: 4,
                lineNumber: 4,
                type: "add",
            },
        ]);
    });

    it("marks replacements as modify", () => {
        const diff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "before();",
                        type: "remove",
                    },
                    {
                        id: "line-2",
                        text: "after();",
                        type: "add",
                    },
                ],
                { newCount: 1, newStart: 8, oldCount: 1, oldStart: 8 },
            ),
        ]);

        expect(computeGitGutterMarkers(diff, 20)).toEqual([
            {
                deletedAtLineEnd: false,
                endLineNumber: 8,
                lineNumber: 8,
                type: "modify",
            },
        ]);
    });

    it("marks extra added lines in a replacement block as add", () => {
        const diff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "before();",
                        type: "remove",
                    },
                    {
                        id: "line-2",
                        text: "after();",
                        type: "add",
                    },
                    {
                        id: "line-3",
                        text: "extra();",
                        type: "add",
                    },
                ],
                { newCount: 2, newStart: 10, oldCount: 1, oldStart: 10 },
            ),
        ]);

        expect(computeGitGutterMarkers(diff, 30)).toEqual([
            {
                deletedAtLineEnd: false,
                endLineNumber: 10,
                lineNumber: 10,
                type: "modify",
            },
            {
                deletedAtLineEnd: false,
                endLineNumber: 11,
                lineNumber: 11,
                type: "add",
            },
        ]);
    });

    it("anchors deleted blocks to the next surviving line", () => {
        const diff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "removed();",
                        type: "remove",
                    },
                    {
                        id: "line-2",
                        text: "stable();",
                        type: "context",
                    },
                ],
                { newCount: 1, newStart: 6, oldCount: 2, oldStart: 6 },
            ),
        ]);

        expect(computeGitGutterMarkers(diff, 18)).toEqual([
            {
                deletedAtLineEnd: false,
                endLineNumber: 6,
                lineNumber: 6,
                type: "delete",
            },
        ]);
    });

    it("anchors trailing deleted blocks to the final visible line", () => {
        const diff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "removed();",
                        type: "remove",
                    },
                ],
                { newCount: 0, newStart: 14, oldCount: 1, oldStart: 14 },
            ),
        ]);

        expect(computeGitGutterMarkers(diff, 13)).toEqual([
            {
                deletedAtLineEnd: true,
                endLineNumber: 13,
                lineNumber: 13,
                type: "delete",
            },
        ]);
    });
});

describe("buildGitGutterDecorations", () => {
    it("renders git markers in the dedicated line decorations lane", () => {
        expect(
            buildGitGutterDecorations([
                {
                    deletedAtLineEnd: false,
                    endLineNumber: 8,
                    lineNumber: 8,
                    type: "modify",
                },
                {
                    deletedAtLineEnd: true,
                    endLineNumber: 13,
                    lineNumber: 13,
                    type: "delete",
                },
            ]),
        ).toEqual([
            {
                options: {
                    description: "git-gutter-decoration",
                    isWholeLine: true,
                    linesDecorationsClassName:
                        "git-diff-glyph git-diff-modified",
                },
                range: {
                    endColumn: 1,
                    endLineNumber: 8,
                    startColumn: 1,
                    startLineNumber: 8,
                },
            },
            {
                options: {
                    description: "git-gutter-decoration",
                    isWholeLine: false,
                    linesDecorationsClassName:
                        "git-diff-glyph git-diff-deleted git-diff-deleted-end",
                },
                range: {
                    endColumn: Number.MAX_VALUE,
                    endLineNumber: 13,
                    startColumn: Number.MAX_VALUE,
                    startLineNumber: 13,
                },
            },
        ]);
    });

    it("does not attach git marker styles to line-number nodes", () => {
        const decorations = buildGitGutterDecorations([
            {
                deletedAtLineEnd: false,
                endLineNumber: 4,
                lineNumber: 4,
                type: "add",
            },
        ]);

        expect(JSON.stringify(decorations)).not.toContain(
            "lineNumberClassName",
        );
        expect(decorations[0]?.options.linesDecorationsClassName).toBe(
            "git-diff-glyph git-diff-added",
        );
    });
});

describe("GitGutterDecorator", () => {
    it("corrects a tracked decoration that Monaco moved to the wrong line", () => {
        const { decorations, decorator, deltaDecorations } =
            createDecoratorHarness();
        const diff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "before();",
                        type: "remove",
                    },
                    {
                        id: "line-2",
                        text: "after();",
                        type: "add",
                    },
                ],
                { newCount: 1, newStart: 2, oldCount: 1, oldStart: 2 },
            ),
        ]);

        decorator.setDiff(diff);

        const [firstDecorationId] = decorations.keys();
        expect(firstDecorationId).toBeDefined();
        expect(decorations.get(firstDecorationId ?? "")).toEqual({
            endColumn: 1,
            endLineNumber: 2,
            startColumn: 1,
            startLineNumber: 2,
        });

        decorations.set(firstDecorationId ?? "", {
            endColumn: 1,
            endLineNumber: 3,
            startColumn: 1,
            startLineNumber: 3,
        });
        deltaDecorations.mockClear();

        decorator.setDiff(diff);

        expect(deltaDecorations).toHaveBeenCalledWith(
            [firstDecorationId],
            [
                expect.objectContaining({
                    range: {
                        endColumn: 1,
                        endLineNumber: 2,
                        startColumn: 1,
                        startLineNumber: 2,
                    },
                }),
            ],
        );

        deltaDecorations.mockClear();
        decorator.setDiff(diff);

        expect(deltaDecorations).not.toHaveBeenCalled();
    });

    it("keeps adjacent Monaco-moved decorations when a new line is inserted above them", () => {
        const { decorations, decorator, deltaDecorations } =
            createDecoratorHarness();
        const initialDiff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "firstAdded();",
                        type: "add",
                    },
                    {
                        id: "line-2",
                        text: "secondAdded();",
                        type: "add",
                    },
                ],
                { newCount: 2, newStart: 3, oldCount: 0, oldStart: 3 },
            ),
        ]);

        decorator.setDiff(initialDiff);

        const [firstDecorationId, secondDecorationId] = decorations.keys();
        expect(firstDecorationId).toBeDefined();
        expect(secondDecorationId).toBeDefined();

        decorations.set(firstDecorationId ?? "", {
            endColumn: 1,
            endLineNumber: 4,
            startColumn: 1,
            startLineNumber: 4,
        });
        decorations.set(secondDecorationId ?? "", {
            endColumn: 1,
            endLineNumber: 5,
            startColumn: 1,
            startLineNumber: 5,
        });

        const nextDiff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "newAdded();",
                        type: "add",
                    },
                ],
                { newCount: 1, newStart: 2, oldCount: 0, oldStart: 2 },
            ),
            createHunk(
                [
                    {
                        id: "line-2",
                        text: "firstAdded();",
                        type: "add",
                    },
                    {
                        id: "line-3",
                        text: "secondAdded();",
                        type: "add",
                    },
                ],
                { newCount: 2, newStart: 4, oldCount: 0, oldStart: 3 },
            ),
        ]);
        deltaDecorations.mockClear();

        decorator.setDiff(nextDiff);

        expect(deltaDecorations).toHaveBeenCalledOnce();
        expect(deltaDecorations).toHaveBeenCalledWith(
            [],
            [
                {
                    options: {
                        description: "git-gutter-decoration",
                        isWholeLine: true,
                        linesDecorationsClassName:
                            "git-diff-glyph git-diff-added",
                    },
                    range: {
                        endColumn: 1,
                        endLineNumber: 2,
                        startColumn: 1,
                        startLineNumber: 2,
                    },
                },
            ],
        );
        expect(decorations.has(firstDecorationId ?? "")).toBe(true);
        expect(decorations.has(secondDecorationId ?? "")).toBe(true);
    });

    it("batches style replacements and new markers into one Monaco transaction", () => {
        const { decorations, decorator, deltaDecorations } =
            createDecoratorHarness();
        const initialDiff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "added();",
                        type: "add",
                    },
                ],
                { newCount: 1, newStart: 2, oldCount: 0, oldStart: 2 },
            ),
            createHunk(
                [
                    {
                        id: "line-2",
                        text: "keptAdded();",
                        type: "add",
                    },
                ],
                { newCount: 1, newStart: 5, oldCount: 0, oldStart: 5 },
            ),
        ]);

        decorator.setDiff(initialDiff);

        const [replacedDecorationId] = decorations.keys();
        expect(replacedDecorationId).toBeDefined();

        const nextDiff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "before();",
                        type: "remove",
                    },
                    {
                        id: "line-2",
                        text: "after();",
                        type: "add",
                    },
                ],
                { newCount: 1, newStart: 2, oldCount: 1, oldStart: 2 },
            ),
            createHunk(
                [
                    {
                        id: "line-3",
                        text: "keptAdded();",
                        type: "add",
                    },
                ],
                { newCount: 1, newStart: 5, oldCount: 0, oldStart: 5 },
            ),
            createHunk(
                [
                    {
                        id: "line-4",
                        text: "newAdded();",
                        type: "add",
                    },
                ],
                { newCount: 1, newStart: 7, oldCount: 0, oldStart: 7 },
            ),
        ]);
        deltaDecorations.mockClear();

        decorator.setDiff(nextDiff);

        expect(deltaDecorations).toHaveBeenCalledOnce();
        expect(deltaDecorations).toHaveBeenCalledWith(
            [replacedDecorationId],
            [
                {
                    options: {
                        description: "git-gutter-decoration",
                        isWholeLine: true,
                        linesDecorationsClassName:
                            "git-diff-glyph git-diff-modified",
                    },
                    range: {
                        endColumn: 1,
                        endLineNumber: 2,
                        startColumn: 1,
                        startLineNumber: 2,
                    },
                },
                {
                    options: {
                        description: "git-gutter-decoration",
                        isWholeLine: true,
                        linesDecorationsClassName:
                            "git-diff-glyph git-diff-added",
                    },
                    range: {
                        endColumn: 1,
                        endLineNumber: 7,
                        startColumn: 1,
                        startLineNumber: 7,
                    },
                },
            ],
        );
    });

    it("keeps a marker whose tracked range grew from typing at column 1", () => {
        const { decorations, decorator, deltaDecorations } =
            createDecoratorHarness();
        const diff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "added();",
                        type: "add",
                    },
                ],
                { newCount: 1, newStart: 4, oldCount: 0, oldStart: 4 },
            ),
        ]);

        decorator.setDiff(diff);

        const [decorationId] = decorations.keys();
        expect(decorationId).toBeDefined();

        // Monaco grows the empty whole-line range when text is typed at the
        // start of the line. The marker is still an "add" on line 4, so it must
        // not be torn down and recreated (that is what made the gutter flicker).
        decorations.set(decorationId ?? "", {
            endColumn: 6,
            endLineNumber: 4,
            startColumn: 1,
            startLineNumber: 4,
        });
        deltaDecorations.mockClear();

        decorator.setDiff(diff);

        expect(deltaDecorations).not.toHaveBeenCalled();
        expect(decorations.has(decorationId ?? "")).toBe(true);
    });

    it("preserves every shifted marker when a line is inserted above them", () => {
        const { decorations, decorator, deltaDecorations } =
            createDecoratorHarness(20);
        const initialDiff = createDiff([
            createHunk(
                [{ id: "l1", text: "a();", type: "add" }],
                { newCount: 1, newStart: 5, oldCount: 0, oldStart: 5 },
            ),
            createHunk(
                [{ id: "l2", text: "b();", type: "add" }],
                { newCount: 1, newStart: 9, oldCount: 0, oldStart: 9 },
            ),
            createHunk(
                [{ id: "l3", text: "c();", type: "add" }],
                { newCount: 1, newStart: 13, oldCount: 0, oldStart: 13 },
            ),
        ]);

        decorator.setDiff(initialDiff);

        const trackedIds = [...decorations.keys()];
        expect(trackedIds).toHaveLength(3);

        // Monaco shifts every tracked decoration down by one line after the
        // insert above them.
        for (const id of trackedIds) {
            const range = decorations.get(id);
            if (!range) {
                continue;
            }
            decorations.set(id, {
                ...range,
                endLineNumber: range.endLineNumber + 1,
                startLineNumber: range.startLineNumber + 1,
            });
        }
        deltaDecorations.mockClear();

        const nextDiff = createDiff([
            createHunk(
                [{ id: "n", text: "new();", type: "add" }],
                { newCount: 1, newStart: 2, oldCount: 0, oldStart: 2 },
            ),
            createHunk(
                [{ id: "l1", text: "a();", type: "add" }],
                { newCount: 1, newStart: 6, oldCount: 0, oldStart: 6 },
            ),
            createHunk(
                [{ id: "l2", text: "b();", type: "add" }],
                { newCount: 1, newStart: 10, oldCount: 0, oldStart: 10 },
            ),
            createHunk(
                [{ id: "l3", text: "c();", type: "add" }],
                { newCount: 1, newStart: 14, oldCount: 0, oldStart: 14 },
            ),
        ]);

        decorator.setDiff(nextDiff);

        // Only the inserted marker is created; no existing decoration is removed.
        expect(deltaDecorations).toHaveBeenCalledOnce();
        const [removedIds, created] = deltaDecorations.mock.calls[0] ?? [];
        expect(removedIds).toEqual([]);
        expect(created).toHaveLength(1);
        for (const id of trackedIds) {
            expect(decorations.has(id)).toBe(true);
        }
    });
});

describe("getGitGutterLineNumbersMinChars", () => {
    it("keeps line-number width independent from git marker space", () => {
        expect(getGitGutterLineNumbersMinChars(9)).toBe(4);
        expect(getGitGutterLineNumbersMinChars(87)).toBe(4);
        expect(getGitGutterLineNumbersMinChars(120)).toBe(4);
        expect(getGitGutterLineNumbersMinChars(2048)).toBe(4);
        expect(getGitGutterLineNumbersMinChars(10000)).toBe(5);
    });
});

describe("hasRenderableGitGutterChange", () => {
    it("keeps the gutter visible for text changes", () => {
        expect(hasRenderableGitGutterChange({ isBinary: false })).toBe(true);
    });

    it("hides the gutter when the change is binary or missing", () => {
        expect(hasRenderableGitGutterChange({ isBinary: true })).toBe(false);
        expect(hasRenderableGitGutterChange(null)).toBe(false);
    });
});
