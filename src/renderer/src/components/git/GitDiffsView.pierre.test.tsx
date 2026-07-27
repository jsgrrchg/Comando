/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    GIT_DIFF_FIXTURES,
} from "./GitDiffFixtures";

const multiFileDiffCalls = vi.hoisted(() =>
    [] as Array<{
        readonly newFile: {
            readonly contents: string;
            readonly name: string;
        } | null;
        readonly oldFile: {
            readonly contents: string;
            readonly name: string;
        } | null;
        readonly options: {
            readonly diffStyle: "unified";
            readonly disableErrorHandling: boolean;
            readonly disableFileHeader: boolean;
            readonly overflow: "scroll" | "wrap";
        };
    }>,
);

vi.mock("@pierre/diffs/react", () => ({
    MultiFileDiff: (props: (typeof multiFileDiffCalls)[number]) => {
        multiFileDiffCalls.push(props);
        return <div data-pierre-diff-body="true" />;
    },
}));

import { GitDiffsView } from "./GitDiffsView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

function renderDiff(file: (typeof GIT_DIFF_FIXTURES)[keyof typeof GIT_DIFF_FIXTURES]) {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
        root.render(<GitDiffsView files={[file]} showFileSelector={false} />);
    });

    return { container, root };
}

describe("GitDiffsView Pierre integration", () => {
    beforeEach(() => {
        multiFileDiffCalls.length = 0;
    });

    it("keeps the Comando header and file actions around a Pierre body", () => {
        const onOpen = vi.fn();
        const { container, root } = renderDiff({
            ...GIT_DIFF_FIXTURES.update,
            actions: [
                {
                    id: "open",
                    label: "Open",
                    onClick: onOpen,
                },
            ],
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

    it.each([
        ["update", GIT_DIFF_FIXTURES.update],
        ["create", GIT_DIFF_FIXTURES.create],
        ["delete", GIT_DIFF_FIXTURES.delete],
        ["rename", GIT_DIFF_FIXTURES.rename],
        ["missing final newline", GIT_DIFF_FIXTURES.noFinalNewline],
        ["long line", GIT_DIFF_FIXTURES.longLine],
    ] as const)(
        "passes complete %s content to Pierre through the public contract",
        (_label, file) => {
            const { root } = renderDiff(file);
            const call = multiFileDiffCalls[0];

            expect(multiFileDiffCalls).toHaveLength(1);
            expect(call?.options).toMatchObject({
                diffStyle: "unified",
                disableErrorHandling: true,
                disableFileHeader: true,
                overflow: "wrap",
            });
            expect(call?.newFile).toEqual(
                file.newText === null
                    ? null
                    : {
                          cacheKey: `${file.id}:new`,
                          contents: file.newText,
                          name: file.path,
                      },
            );
            expect(call?.oldFile).toEqual(
                file.oldText === null
                    ? null
                    : {
                          cacheKey: `${file.id}:old`,
                          contents: file.oldText,
                          name: file.previousPath ?? file.path,
                      },
            );

            act(() => root.unmount());
        },
    );

    it.each([
        ["binary", GIT_DIFF_FIXTURES.binary, "This file is binary"],
        ["partial GitHub patch", GIT_DIFF_FIXTURES.partialGitHub, "old"],
    ] as const)("keeps the legacy renderer for a %s", (_label, file, text) => {
        const { container, root } = renderDiff(file);

        expect(multiFileDiffCalls).toHaveLength(0);
        expect(container.textContent).toContain(text);

        act(() => root.unmount());
    });
});
