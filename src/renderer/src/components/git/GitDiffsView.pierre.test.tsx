/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { GitDiffFile } from "./types";

const multiFileDiffCalls = vi.hoisted(() =>
    [] as Array<{ readonly options: { readonly disableFileHeader: boolean } }>,
);

vi.mock("@pierre/diffs/react", () => ({
    MultiFileDiff: (props: {
        readonly options: { readonly disableFileHeader: boolean };
    }) => {
        multiFileDiffCalls.push(props);
        return <div data-pierre-diff-body="true" />;
    },
}));

import { GitDiffsView } from "./GitDiffsView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

function createCompleteDiffFile(onOpen: () => void): GitDiffFile {
    return {
        actions: [
            {
                id: "open",
                label: "Open",
                onClick: onOpen,
            },
        ],
        hunks: [
            {
                header: "@@ -1,1 +1,1 @@",
                id: "hunk-1",
                lines: [
                    {
                        id: "line-1",
                        kind: "add",
                        newLineNumber: 1,
                        oldLineNumber: null,
                        text: "const after = true;",
                    },
                ],
                newCount: 1,
                newStart: 1,
                oldCount: 1,
                oldStart: 1,
            },
        ],
        id: "src/example.ts",
        isText: true,
        kind: "update",
        newText: "const after = true;\n",
        oldText: "const before = true;\n",
        path: "src/example.ts",
        previousPath: null,
        reversible: true,
        statusLabel: "modified",
        summary: "+1 -1",
    };
}

describe("GitDiffsView Pierre integration", () => {
    it("keeps the Comando header and file actions around a Pierre body", () => {
        multiFileDiffCalls.length = 0;
        const onOpen = vi.fn();
        const container = document.createElement("div");
        const root = createRoot(container);

        act(() => {
            root.render(
                <GitDiffsView
                    files={[createCompleteDiffFile(onOpen)]}
                    showFileSelector={false}
                />,
            );
        });

        expect(container.querySelectorAll("[data-pierre-diff-body]")).toHaveLength(1);
        expect(container.querySelectorAll('[title="modified"]')).toHaveLength(1);
        expect(multiFileDiffCalls).toHaveLength(1);
        expect(multiFileDiffCalls[0]?.options.disableFileHeader).toBe(true);

        const openButton = Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent === "Open",
        );
        act(() => {
            openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onOpen).toHaveBeenCalledOnce();

        act(() => root.unmount());
    });
});
