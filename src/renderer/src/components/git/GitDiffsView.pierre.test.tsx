/** @vitest-environment jsdom */
import { act, forwardRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GIT_DIFF_FIXTURES } from "./GitDiffFixtures";

const codeViewCalls = vi.hoisted(
    () => [] as Array<{ readonly [key: string]: unknown }>,
);

vi.mock("@pierre/diffs/react", () => ({
    CodeView: forwardRef(function MockCodeView(
        props: {
            readonly containerRef?: (node: HTMLDivElement | null) => void;
            readonly items: readonly {
                readonly collapsed?: boolean;
                readonly fileDiff: { readonly name: string };
                readonly id: string;
                readonly version?: number;
            }[];
            readonly options: Record<string, unknown>;
            readonly renderHeaderFilenameSuffix?: (item: {
                readonly id: string;
            }) => ReactNode;
            readonly renderHeaderMetadata?: (item: {
                readonly id: string;
            }) => ReactNode;
            readonly renderHeaderPrefix?: (item: {
                readonly collapsed?: boolean;
                readonly id: string;
            }) => ReactNode;
        },
        ref,
    ) {
        codeViewCalls.push(props);
        return (
            <div
                data-pierre-code-view="true"
                ref={(node) => {
                    props.containerRef?.(node);
                    if (typeof ref === "function") {
                        ref(node);
                    } else if (ref) {
                        ref.current = node;
                    }
                }}
            >
                {props.items.map((item) => (
                    <div data-pierre-diff-body="true" key={item.id}>
                        <div data-pierre-header-prefix="true">
                            {props.renderHeaderPrefix?.(item)}
                        </div>
                        <div data-pierre-header-suffix="true">
                            {props.renderHeaderFilenameSuffix?.(item)}
                        </div>
                        <div data-pierre-header-metadata="true">
                            {props.renderHeaderMetadata?.(item)}
                        </div>
                    </div>
                ))}
            </div>
        );
    }),
}));

import { GitDiffsView } from "./GitDiffsView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

function renderDiff(
    file: (typeof GIT_DIFF_FIXTURES)[keyof typeof GIT_DIFF_FIXTURES],
) {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
        root.render(<GitDiffsView files={[file]} showFileSelector={false} />);
    });

    return { container, root };
}

describe("GitDiffsView Pierre CodeView integration", () => {
    beforeEach(() => {
        codeViewCalls.length = 0;
    });

    it("moves Comando actions into CodeView's virtual header slots", () => {
        const onOpen = vi.fn();
        const { container, root } = renderDiff({
            ...GIT_DIFF_FIXTURES.update,
            actions: [{ id: "open", label: "Open", onClick: onOpen }],
        });

        expect(container.querySelectorAll("[data-pierre-diff-body]")).toHaveLength(1);
        expect(container.querySelectorAll("section")).toHaveLength(0);
        expect(codeViewCalls).toHaveLength(1);
        expect(
            container.querySelector("[data-pierre-header-metadata]")?.textContent,
        ).toContain("Open");

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
        ["partial GitHub patch", GIT_DIFF_FIXTURES.partialGitHub],
    ] as const)(
        "builds a virtual CodeView item for a partial %s patch",
        (_label, file) => {
            const { root } = renderDiff(file);
            const call = codeViewCalls[0];
            const items = call?.items as
                | readonly { readonly fileDiff: { readonly hunks: readonly unknown[] } }[]
                | undefined;
            const options = call?.options as Record<string, unknown> | undefined;

            expect(codeViewCalls).toHaveLength(1);
            expect(items).toHaveLength(1);
            expect(items?.[0]?.fileDiff.hunks.length).toBeGreaterThan(0);
            expect(options).toMatchObject({
                diffStyle: "unified",
                disableErrorHandling: true,
                disableFileHeader: false,
                overflow: "wrap",
                stickyHeaders: true,
            });
            expect(options?.unsafeCSS).toContain('[data-diffs-header="default"]');

            act(() => root.unmount());
        },
    );

    it("keeps the collapse control in CodeView's header", () => {
        const onToggleFileCollapse = vi.fn();
        const container = document.createElement("div");
        const root = createRoot(container);
        const file = GIT_DIFF_FIXTURES.update;

        act(() => {
            root.render(
                <GitDiffsView
                    displayMode="stack"
                    files={[file]}
                    onToggleFileCollapse={onToggleFileCollapse}
                    showFileSelector={false}
                />,
            );
        });

        const collapseButton = container.querySelector(
            '[aria-label="Collapse file"]',
        );
        act(() => {
            collapseButton?.dispatchEvent(
                new MouseEvent("click", { bubbles: true }),
            );
        });
        expect(onToggleFileCollapse).toHaveBeenCalledWith(file.id);

        act(() => root.unmount());
    });

    it("bumps the CodeView item version when controlled collapse changes", () => {
        const container = document.createElement("div");
        const root = createRoot(container);
        const file = GIT_DIFF_FIXTURES.update;

        act(() => {
            root.render(
                <GitDiffsView
                    collapsedFileIds={[]}
                    displayMode="stack"
                    files={[file]}
                    showFileSelector={false}
                />,
            );
        });
        const expandedItem = codeViewCalls.at(-1)?.items as
            | readonly { readonly collapsed?: boolean; readonly version?: number }[]
            | undefined;

        act(() => {
            root.render(
                <GitDiffsView
                    collapsedFileIds={[file.id]}
                    displayMode="stack"
                    files={[file]}
                    showFileSelector={false}
                />,
            );
        });
        const collapsedItem = codeViewCalls.at(-1)?.items as
            | readonly { readonly collapsed?: boolean; readonly version?: number }[]
            | undefined;

        expect(expandedItem?.[0]).toMatchObject({ collapsed: false, version: 0 });
        expect(collapsedItem?.[0]).toMatchObject({ collapsed: true, version: 1 });

        act(() => root.unmount());
    });

    it("uses Pierre's split layout without replacing the virtual CodeView", () => {
        const container = document.createElement("div");
        const root = createRoot(container);

        act(() => {
            root.render(
                <GitDiffsView
                    diffStyle="split"
                    files={[GIT_DIFF_FIXTURES.partialGitHub]}
                    lineWrapping={false}
                    showFileSelector={false}
                />,
            );
        });

        expect(codeViewCalls).toHaveLength(1);
        expect(codeViewCalls[0]?.options).toMatchObject({
            diffStyle: "split",
            overflow: "scroll",
            stickyHeaders: true,
        });
        expect(
            container.querySelector("[data-pierre-code-view]"),
        ).not.toBeNull();

        act(() => root.unmount());
    });

    it("keeps a mixed binary stack on the legacy renderer", () => {
        const { container, root } = renderDiff(GIT_DIFF_FIXTURES.binary);

        expect(codeViewCalls).toHaveLength(0);
        expect(container.textContent).toContain("This file is binary");

        act(() => root.unmount());
    });
});
