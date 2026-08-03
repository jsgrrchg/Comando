import type {
    AnimationEvent,
    KeyboardEvent,
    PointerEvent,
    ReactNode,
    RefObject,
} from "react";
import { createPortal } from "react-dom";

export interface GitScopePickerMenuPosition {
    readonly height: number;
    readonly placement: "above" | "below";
    readonly width: number;
    readonly x: number;
    readonly y: number;
}

interface GitScopePickerContentProps {
    readonly actionError: string | null;
    readonly animationState: "closing" | "open" | "opening";
    readonly children: ReactNode;
    readonly isBusy: boolean;
    readonly isMounted: boolean;
    readonly isOpen: boolean;
    readonly menuPosition: GitScopePickerMenuPosition | null;
    readonly menuRef: RefObject<HTMLDivElement | null>;
    readonly onAnimationEnd: (event: AnimationEvent<HTMLDivElement>) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
    readonly onRequestClose: () => void;
    readonly onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
}

/**
 * Keeps the Git scope surface independent from the trigger that opens it so
 * the same menu can be anchored in the sidebar or the window chrome.
 */
export function GitScopePickerContent({
    actionError,
    animationState,
    children,
    isBusy,
    isMounted,
    isOpen,
    menuPosition,
    menuRef,
    onAnimationEnd,
    onKeyDown,
    onRequestClose,
    onResizeStart,
}: GitScopePickerContentProps) {
    if (!isMounted) {
        return null;
    }

    return createPortal(
        <div
            className="sidebar-git-scope-menu"
            data-animation-state={animationState}
            data-placement={menuPosition?.placement ?? "below"}
            inert={!isOpen}
            onAnimationEnd={onAnimationEnd}
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    onRequestClose();
                    return;
                }
                onKeyDown(event);
            }}
            ref={menuRef}
            style={{
                height: menuPosition?.height,
                left: menuPosition?.x ?? 8,
                top: menuPosition?.y ?? 8,
                width: menuPosition?.width ?? 280,
            }}
        >
            {children}

            {actionError ? (
                <div className="sidebar-git-scope-menu__status sidebar-git-scope-menu__status--error">
                    {actionError}
                </div>
            ) : null}

            {isBusy ? (
                <div className="sidebar-git-scope-menu__status">
                    Updating git scope…
                </div>
            ) : null}

            <div
                aria-hidden="true"
                className="sidebar-git-scope-menu__resize-handle"
                onPointerDown={onResizeStart}
                title="Resize"
            />
        </div>,
        document.body,
    );
}
