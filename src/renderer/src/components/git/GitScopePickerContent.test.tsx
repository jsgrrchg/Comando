/** @vitest-environment jsdom */
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitScopePickerContent } from "./GitScopePickerContent";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

describe("GitScopePickerContent", () => {
    it("renders through a portal and delegates Escape to its host", () => {
        const onRequestClose = vi.fn();
        const onKeyDown = vi.fn();
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);

        act(() => {
            root?.render(
                <GitScopePickerContent
                    actionError="Could not switch branches."
                    animationState="open"
                    isBusy={false}
                    isMounted
                    isOpen
                    menuPosition={{
                        height: 320,
                        placement: "below",
                        width: 300,
                        x: 24,
                        y: 40,
                    }}
                    menuRef={createRef<HTMLDivElement>()}
                    onAnimationEnd={() => undefined}
                    onKeyDown={onKeyDown}
                    onRequestClose={onRequestClose}
                    onResizeStart={() => undefined}
                >
                    <button type="button">Checkout</button>
                </GitScopePickerContent>,
            );
        });

        const menu = document.body.querySelector<HTMLElement>(
            ".sidebar-git-scope-menu",
        );
        expect(menu?.parentElement).toBe(document.body);
        expect(menu?.textContent).toContain("Checkout");
        expect(menu?.textContent).toContain("Could not switch branches.");
        expect(menu?.dataset.placement).toBe("below");

        act(() => {
            menu?.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
            );
        });

        expect(onRequestClose).toHaveBeenCalledOnce();
        expect(onKeyDown).not.toHaveBeenCalled();
    });
});
