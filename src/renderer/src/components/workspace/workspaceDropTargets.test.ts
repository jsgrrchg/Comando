import { describe, expect, it } from "vitest";

import { resolveWorkspaceDropTarget } from "./workspaceDropTargets";

type TestElement = HTMLElement & {
    readonly children?: readonly TestElement[];
    dataset: Record<string, string>;
    scrollLeft: number;
};

function createElement(
    rect: Partial<DOMRect>,
    options: {
        readonly children?: readonly TestElement[];
        readonly workspaceTabId?: string;
    } = {},
): TestElement {
    return {
        dataset: options.workspaceTabId
            ? { workspaceTabId: options.workspaceTabId }
            : {},
        getBoundingClientRect: () => ({
            bottom: rect.bottom ?? 0,
            height: rect.height ?? 0,
            left: rect.left ?? 0,
            right: rect.right ?? 0,
            top: rect.top ?? 0,
            width: rect.width ?? 0,
            x: rect.left ?? 0,
            y: rect.top ?? 0,
            toJSON: () => ({}),
        } as DOMRect),
        querySelectorAll: () => options.children ?? [],
        scrollLeft: 0,
    } as unknown as TestElement;
}

function rect(rect: Partial<DOMRect>): Partial<DOMRect> {
    return {
        bottom: rect.bottom ?? 0,
        height: rect.height ?? 0,
        left: rect.left ?? 0,
        right: rect.right ?? 0,
        top: rect.top ?? 0,
        width: rect.width ?? 0,
        x: rect.left ?? 0,
        y: rect.top ?? 0,
    };
}

describe("resolveWorkspaceDropTarget", () => {
    it("resolves strip insertion index and ignores the dragged tab", () => {
        const pane = createElement(rect({}));
        const firstTab = createElement(rect({
            bottom: 32,
            height: 32,
            left: 0,
            right: 100,
            top: 0,
            width: 100,
        }), { workspaceTabId: "tab-a" });
        const draggedTab = createElement(rect({
            bottom: 32,
            height: 32,
            left: 100,
            right: 200,
            top: 0,
            width: 100,
        }), { workspaceTabId: "tab-dragged" });
        const secondTab = createElement(rect({
            bottom: 32,
            height: 32,
            left: 200,
            right: 300,
            top: 0,
            width: 100,
        }), { workspaceTabId: "tab-b" });
        const strip = createElement(rect({
            bottom: 32,
            height: 32,
            left: 0,
            right: 300,
            top: 0,
            width: 300,
        }), { children: [firstTab, draggedTab, secondTab] });

        const target = resolveWorkspaceDropTarget({
            draggedTabId: "tab-dragged",
            paneElements: new Map([["pane-a", pane]]),
            pointer: { x: 180, y: 12 },
            tabStripElements: new Map([["pane-a", strip]]),
        });

        expect(target).toMatchObject({
            index: 1,
            paneId: "pane-a",
            type: "strip",
        });
    });

    it("resolves center and edge pane targets", () => {
        const pane = createElement(rect({
            bottom: 300,
            height: 300,
            left: 0,
            right: 300,
            top: 0,
            width: 300,
        }));

        const centerTarget = resolveWorkspaceDropTarget({
            paneElements: new Map([["pane-a", pane]]),
            pointer: { x: 150, y: 150 },
            tabStripElements: new Map(),
        });
        expect(centerTarget).toMatchObject({
            paneId: "pane-a",
            type: "pane-center",
        });

        const splitTarget = resolveWorkspaceDropTarget({
            paneElements: new Map([["pane-a", pane]]),
            pointer: { x: 292, y: 150 },
            tabStripElements: new Map(),
        });
        expect(splitTarget).toMatchObject({
            direction: "right",
            paneId: "pane-a",
            type: "split",
        });
    });

    it("uses a generous edge zone for native pane splits", () => {
        const pane = createElement(rect({
            bottom: 300,
            height: 300,
            left: 0,
            right: 300,
            top: 0,
            width: 300,
        }));

        const target = resolveWorkspaceDropTarget({
            paneElements: new Map([["pane-a", pane]]),
            pointer: { x: 250, y: 150 },
            tabStripElements: new Map(),
        });

        expect(target).toMatchObject({
            direction: "right",
            paneId: "pane-a",
            type: "split",
        });
    });

    it("resolves a split when the pointer is slightly outside a pane edge", () => {
        const pane = createElement(rect({
            bottom: 300,
            height: 300,
            left: 0,
            right: 300,
            top: 0,
            width: 300,
        }));

        const target = resolveWorkspaceDropTarget({
            paneElements: new Map([["pane-a", pane]]),
            pointer: { x: 306, y: 150 },
            tabStripElements: new Map(),
        });

        expect(target).toMatchObject({
            direction: "right",
            paneId: "pane-a",
            type: "split",
        });
    });
});
