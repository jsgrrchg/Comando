import {
    useEffect,
    useRef,
    type RefObject,
} from "react";

import { workspaceSurfaceLeaseRegistry } from "@renderer/app/workspace/surface-lease-registry";

const FOCUSABLE_SELECTOR = [
    "a[href]",
    "button:not(:disabled)",
    "input:not(:disabled)",
    "select:not(:disabled)",
    "textarea:not(:disabled)",
    "[tabindex]:not([tabindex='-1'])",
].join(",");
const modalFocusScopes: Array<{
    readonly root: HTMLElement;
    readonly token: symbol;
}> = [];
let nextModalLeaseId = 0;

interface ModalFocusScopeOptions {
    readonly active?: boolean;
    readonly containerRef: RefObject<HTMLElement | null>;
    readonly initialFocusRef?: RefObject<HTMLElement | null>;
    readonly modalRootRef?: RefObject<HTMLElement | null>;
    readonly onDismiss: () => void;
    readonly restoreFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Keeps keyboard and assistive-technology focus inside one modal surface.
 */
export function useModalFocusScope({
    active = true,
    containerRef,
    initialFocusRef,
    modalRootRef,
    onDismiss,
    restoreFocusRef,
}: ModalFocusScopeOptions): void {
    const onDismissRef = useRef(onDismiss);
    onDismissRef.current = onDismiss;

    useEffect(() => {
        if (!active || typeof document === "undefined") {
            return;
        }

        const container = containerRef.current;
        const modalRoot = modalRootRef?.current ?? container;
        if (!container || !modalRoot) {
            return;
        }

        const previouslyFocused =
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
        const fallbackRestoreFocus = restoreFocusRef?.current ?? null;
        const scopeToken = Symbol("modal-focus-scope");
        modalFocusScopes.push({ root: modalRoot, token: scopeToken });
        const releaseModalLease = isWorkspaceSurfaceRenderer()
            ? workspaceSurfaceLeaseRegistry.acquire({
                  id: `critical-modal:${++nextModalLeaseId}`,
                  kind: "critical-modal",
                  message: "A modal dialog requires a decision.",
              })
            : null;
        const inertSiblings = setSiblingElementsInert(modalRoot);
        const focusFrame = window.requestAnimationFrame(() => {
            if (!isTopmostModalFocusScope(scopeToken)) {
                return;
            }
            const initialFocus =
                initialFocusRef?.current ??
                getFocusableElements(container)[0] ??
                container;
            initialFocus.focus();
        });

        const handleKeyDown = (event: globalThis.KeyboardEvent) => {
            if (!isTopmostModalFocusScope(scopeToken)) {
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                onDismissRef.current();
                return;
            }
            if (event.key !== "Tab") {
                return;
            }

            const focusable = getFocusableElements(container);
            if (focusable.length === 0) {
                event.preventDefault();
                container.focus();
                return;
            }

            const current = document.activeElement;
            const first = focusable[0];
            const last = focusable.at(-1);
            if (!container.contains(current)) {
                event.preventDefault();
                (event.shiftKey ? last : first)?.focus();
                return;
            }
            if (event.shiftKey && current === first) {
                event.preventDefault();
                last?.focus();
                return;
            }
            if (!event.shiftKey && current === last) {
                event.preventDefault();
                first?.focus();
            }
        };

        document.addEventListener("keydown", handleKeyDown, true);
        return () => {
            window.cancelAnimationFrame(focusFrame);
            document.removeEventListener("keydown", handleKeyDown, true);
            const stackIndex = modalFocusScopes.findIndex(
                (scope) => scope.token === scopeToken,
            );
            if (stackIndex >= 0) {
                modalFocusScopes.splice(stackIndex, 1);
            }
            restoreSiblingInertState(inertSiblings);
            releaseModalLease?.();

            // Electron may return focus from a hidden WebContentsView after the
            // React cleanup. Two frames make the modal invoker authoritative.
            window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                    const target =
                        isRestorableFocusTarget(previouslyFocused, modalRoot)
                            ? previouslyFocused
                            : fallbackRestoreFocus;
                    if (target?.isConnected) {
                        target.focus();
                    }
                });
            });
        };
    }, [
        active,
        containerRef,
        initialFocusRef,
        modalRootRef,
        restoreFocusRef,
    ]);
}

function isWorkspaceSurfaceRenderer(): boolean {
    return (
        new URLSearchParams(window.location.search).get("window") ===
        "workspace-surface"
    );
}

function isTopmostModalFocusScope(token: symbol): boolean {
    const index = modalFocusScopes.findIndex((scope) => scope.token === token);
    const current = modalFocusScopes[index];
    if (!current || !current.root.isConnected) {
        return false;
    }
    for (const [candidateIndex, candidate] of modalFocusScopes.entries()) {
        if (
            candidateIndex === index ||
            !candidate.root.isConnected
        ) {
            continue;
        }
        if (current.root.contains(candidate.root)) {
            return false;
        }
        if (
            candidateIndex > index &&
            !candidate.root.contains(current.root)
        ) {
            return false;
        }
    }
    return true;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) =>
            !element.hidden &&
            element.getAttribute("aria-hidden") !== "true" &&
            !element.closest("[inert]") &&
            element.tabIndex >= 0,
    );
}

function isRestorableFocusTarget(
    target: HTMLElement | null,
    modalRoot: HTMLElement,
): target is HTMLElement {
    return Boolean(
        target?.isConnected &&
            !modalRoot.contains(target) &&
            target.getAttribute("aria-hidden") !== "true" &&
            !target.closest("[inert]"),
    );
}

interface InertSiblingState {
    readonly element: HTMLElement;
    readonly inert: boolean;
}

function setSiblingElementsInert(modalRoot: HTMLElement): InertSiblingState[] {
    const parent = modalRoot.parentElement;
    if (!parent) {
        return [];
    }

    const states: InertSiblingState[] = [];
    for (const sibling of parent.children) {
        if (!(sibling instanceof HTMLElement) || sibling === modalRoot) {
            continue;
        }
        states.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
    }
    return states;
}

function restoreSiblingInertState(states: readonly InertSiblingState[]): void {
    for (const { element, inert } of states) {
        if (element.isConnected) {
            element.inert = inert;
        }
    }
}
