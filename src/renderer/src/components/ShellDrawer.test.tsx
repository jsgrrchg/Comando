/** @vitest-environment jsdom */
import { act, createRef, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShellDrawer } from "./ShellDrawer";
import { useModalFocusScope } from "./accessibility/useModalFocusScope";

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

describe("ShellDrawer", () => {
    it("uses modal semantics, backdrop dismissal, and Escape", async () => {
        const onDismiss = vi.fn();
        const restoreFocusRef = createRef<HTMLButtonElement>();
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);

        act(() => {
            root?.render(
                <ShellDrawer
                    id="workspace-inspector-drawer"
                    label="Workspace inspector"
                    onDismiss={onDismiss}
                    restoreFocusRef={restoreFocusRef}
                    side="right"
                    width={340}
                >
                    <button type="button">First</button>
                    <button type="button">Last</button>
                </ShellDrawer>,
            );
        });
        await act(async () => {
            await nextFrame();
        });

        const drawer = container.querySelector<HTMLElement>("[role='dialog']");
        expect(drawer?.getAttribute("aria-modal")).toBe("true");
        expect(drawer?.getAttribute("aria-label")).toBe(
            "Workspace inspector",
        );
        expect(drawer?.style.width).toBe("340px");

        act(() => {
            document.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
            );
        });
        expect(onDismiss).toHaveBeenCalledOnce();

        const backdrop = container.querySelector<HTMLElement>(
            "[data-shell-drawer-backdrop='right']",
        );
        act(() => {
            backdrop?.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true }),
            );
        });
        expect(onDismiss).toHaveBeenCalledTimes(2);
    });

    it("traps Tab and restores focus to the chrome control", async () => {
        const trigger = document.createElement("button");
        document.body.appendChild(trigger);
        trigger.focus();
        const restoreFocusRef = createRef<HTMLButtonElement>();
        restoreFocusRef.current = trigger;
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);

        act(() => {
            root?.render(
                <ShellDrawer
                    id="workspace-navigator-drawer"
                    label="Workspace navigator"
                    onDismiss={() => undefined}
                    restoreFocusRef={restoreFocusRef}
                    side="left"
                    width={280}
                >
                    <button type="button">First</button>
                    <button type="button">Last</button>
                </ShellDrawer>,
            );
        });
        await act(async () => {
            await nextFrame();
        });
        const buttons = container.querySelectorAll<HTMLButtonElement>("button");
        expect(document.activeElement).toBe(buttons[0]);

        act(() => {
            buttons[1]?.focus();
            buttons[1]?.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }),
            );
        });
        expect(document.activeElement).toBe(buttons[0]);

        await act(async () => {
            root?.unmount();
            root = null;
            await nextFrame();
            await nextFrame();
        });
        expect(document.activeElement).toBe(trigger);
        trigger.remove();
    });

    it("lets a nested workspace dialog own Escape and focus", async () => {
        const onDismissDrawer = vi.fn();
        const onDismissDialog = vi.fn();
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);

        act(() => {
            root?.render(
                <ShellDrawer
                    id="workspace-navigator-drawer"
                    label="Workspace navigator"
                    onDismiss={onDismissDrawer}
                    restoreFocusRef={createRef<HTMLButtonElement>()}
                    side="left"
                    width={280}
                >
                    <button type="button">Navigator action</button>
                    <NestedTestDialog onDismiss={onDismissDialog} />
                </ShellDrawer>,
            );
        });
        await act(async () => {
            await nextFrame();
        });

        expect(document.activeElement?.textContent).toBe("Dialog action");
        act(() => {
            document.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
            );
        });
        expect(onDismissDialog).toHaveBeenCalledOnce();
        expect(onDismissDrawer).not.toHaveBeenCalled();
    });
});

function NestedTestDialog({ onDismiss }: { readonly onDismiss: () => void }) {
    const dialogRef = useRef<HTMLDivElement | null>(null);
    useModalFocusScope({
        containerRef: dialogRef,
        onDismiss,
    });
    return (
        <div
            aria-label="Nested workspace dialog"
            aria-modal="true"
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
        >
            <button type="button">Dialog action</button>
        </div>
    );
}

function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
