import { useRef, type ReactNode, type RefObject } from "react";

import type { ShellPanelSide } from "../app/layout/shell-layout";
import { useModalFocusScope } from "./accessibility/useModalFocusScope";

interface ShellDrawerProps {
    readonly children: ReactNode;
    readonly id: string;
    readonly label: string;
    readonly onDismiss: () => void;
    readonly restoreFocusRef: RefObject<HTMLElement | null>;
    readonly side: ShellPanelSide;
    readonly width: number;
}

export function ShellDrawer({
    children,
    id,
    label,
    onDismiss,
    restoreFocusRef,
    side,
    width,
}: ShellDrawerProps) {
    const layerRef = useRef<HTMLDivElement | null>(null);
    const drawerRef = useRef<HTMLElement | null>(null);
    useModalFocusScope({
        containerRef: drawerRef,
        modalRootRef: layerRef,
        onDismiss,
        restoreFocusRef,
    });

    return (
        <div
            className="shell-drawer-layer"
            data-shell-drawer-layer={side}
            ref={layerRef}
        >
            <div
                aria-hidden="true"
                className="shell-drawer-backdrop"
                data-shell-drawer-backdrop={side}
                onMouseDown={(event) => {
                    if (event.currentTarget === event.target) {
                        onDismiss();
                    }
                }}
            />
            <aside
                aria-label={label}
                aria-modal="true"
                className="app-sidebar shell-drawer flex min-h-0 flex-col overflow-hidden shadow-xl"
                data-shell-overlay={side}
                id={id}
                ref={drawerRef}
                role="dialog"
                style={{ width }}
                tabIndex={-1}
            >
                {children}
            </aside>
        </div>
    );
}
