/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLDivElement[] = [];

afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
        act(() => root.unmount());
    }
    for (const container of mountedContainers.splice(0)) {
        container.remove();
    }
});

function renderMenu(entries: readonly ContextMenuEntry[], onClose = vi.fn()) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    mountedContainers.push(container);

    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
        root.render(
            createElement(ContextMenu, {
                entries,
                menu: { x: 100, y: 100, payload: undefined },
                onClose,
            }),
        );
    });

    return { onClose };
}

function getMenuButton(label: string): HTMLButtonElement {
    const button = document.body.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
    );
    if (!button) {
        throw new Error(`Could not find context menu button "${label}".`);
    }
    return button;
}

describe("ContextMenu submenus", () => {
    it("opens and closes a submenu from its parent click", () => {
        renderMenu([
            {
                label: "Move to Folder",
                children: [{ label: "Research", action: vi.fn() }],
            },
        ]);

        const parentButton = getMenuButton("Move to Folder");
        act(() => parentButton.click());
        expect(getMenuButton("Research")).toBeTruthy();
        expect(parentButton.getAttribute("aria-expanded")).toBe("true");

        act(() => parentButton.click());
        expect(
            document.body.querySelector('button[aria-label="Research"]'),
        ).toBeNull();
        expect(parentButton.getAttribute("aria-expanded")).toBe("false");
    });

    it("opens on hover and flips to the left near the viewport edge", () => {
        const originalInnerWidth = window.innerWidth;
        Object.defineProperty(window, "innerWidth", {
            configurable: true,
            value: 240,
        });

        try {
            renderMenu([
                {
                    label: "Move to Folder",
                    children: [
                        { label: "Research", danger: true },
                        { type: "separator" },
                        { label: "Unavailable", disabled: true },
                    ],
                },
            ]);

            const parentButton = getMenuButton("Move to Folder");
            const parentItem = parentButton.parentElement;
            if (!parentItem) {
                throw new Error("Context menu parent item is missing.");
            }
            Object.defineProperty(parentItem, "getBoundingClientRect", {
                value: () => ({
                    left: 210,
                    top: 100,
                    right: 230,
                    bottom: 130,
                    width: 20,
                    height: 30,
                    x: 210,
                    y: 100,
                    toJSON: () => ({}),
                }),
            });

            act(() => {
                parentItem.dispatchEvent(
                    new MouseEvent("mouseover", { bubbles: true }),
                );
            });

            const bridge = document.body.querySelector<HTMLElement>(
                '[data-context-submenu-bridge="left"]',
            );
            expect(bridge?.style.right).toBe("100%");
            expect(bridge?.style.paddingRight).toBe("4px");
            expect(getMenuButton("Research").className).toContain(
                "text-[var(--diff-remove)]",
            );
            expect(getMenuButton("Unavailable").disabled).toBe(true);
            expect(
                document.body.querySelector(
                    '[data-context-submenu="true"] [role="separator"]',
                ),
            ).toBeTruthy();
        } finally {
            Object.defineProperty(window, "innerWidth", {
                configurable: true,
                value: originalInnerWidth,
            });
        }
    });

    it("closes before running a submenu action and ignores disabled items", async () => {
        const callOrder: string[] = [];
        const onClose = vi.fn(() => callOrder.push("close"));
        const action = vi.fn(() => callOrder.push("action"));
        const disabledAction = vi.fn();
        renderMenu(
            [
                {
                    label: "Move to Folder",
                    children: [
                        { label: "Research", action },
                        {
                            label: "Unavailable",
                            action: disabledAction,
                            disabled: true,
                        },
                    ],
                },
            ],
            onClose,
        );

        act(() => getMenuButton("Move to Folder").click());
        act(() => getMenuButton("Unavailable").click());
        expect(onClose).not.toHaveBeenCalled();
        expect(disabledAction).not.toHaveBeenCalled();

        await act(async () => {
            getMenuButton("Research").click();
            await Promise.resolve();
        });

        expect(callOrder).toEqual(["close", "action"]);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(action).toHaveBeenCalledTimes(1);
    });
});
