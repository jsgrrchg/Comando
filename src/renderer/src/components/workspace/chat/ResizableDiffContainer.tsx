import {
    useCallback,
    useId,
    useRef,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from "react";

import { usePersistentToolState } from "./toolExpansionStore";

const DEFAULT_DIFF_HEIGHT = 200;
const MIN_DIFF_HEIGHT = 80;

export interface ResizableDiffContainerProps {
    readonly accent: string;
    readonly children: ReactNode;
    readonly defaultHeight?: number;
    readonly minHeight?: number;
    /**
     * Stable key under which the dragged height is persisted in the surrounding
     * ToolExpansionStoreProvider, so it survives the diff card unmounting when
     * its virtualized timeline row scrolls out of view. When omitted the height
     * is per-instance and resets on unmount.
     */
    readonly persistKey?: string;
}

export function ResizableDiffContainer({
    accent,
    children,
    defaultHeight = DEFAULT_DIFF_HEIGHT,
    minHeight = MIN_DIFF_HEIGHT,
    persistKey,
}: ResizableDiffContainerProps) {
    // Fall back to a per-instance id when no persist key is given, so the hook
    // is always called with a stable, collision-free key.
    const fallbackKey = useId();
    const [height, setHeight] = usePersistentToolState<number>(
        persistKey ?? fallbackKey,
        defaultHeight,
    );
    const draggingRef = useRef(false);
    const startHeightRef = useRef(defaultHeight);
    const startYRef = useRef(0);

    const handlePointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            event.preventDefault();
            draggingRef.current = true;
            startHeightRef.current = height;
            startYRef.current = event.clientY;
            event.currentTarget.setPointerCapture(event.pointerId);
        },
        [height],
    );

    const handlePointerMove = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            if (!draggingRef.current) {
                return;
            }

            const delta = event.clientY - startYRef.current;
            setHeight(Math.max(minHeight, startHeightRef.current + delta));
        },
        [minHeight],
    );

    const handlePointerUp = useCallback(() => {
        draggingRef.current = false;
    }, []);

    return (
        <div
            style={{
                borderBottom: `1px solid color-mix(in srgb, ${accent} 8%, var(--color-border))`,
            }}
        >
            <div
                style={{
                    maxHeight: height,
                    overflow: "auto",
                }}
            >
                {children}
            </div>
            <div
                aria-label="Resize diff preview"
                onMouseEnter={(event) => {
                    event.currentTarget.style.backgroundColor = `color-mix(in srgb, ${accent} 10%, transparent)`;
                    const indicator =
                        event.currentTarget.querySelector<HTMLElement>(
                            "[data-resize-indicator]",
                        );
                    if (indicator) {
                        indicator.style.opacity = "0.6";
                        indicator.style.backgroundColor = accent;
                        indicator.style.width = "48px";
                    }
                }}
                onMouseLeave={(event) => {
                    event.currentTarget.style.backgroundColor = "transparent";
                    const indicator =
                        event.currentTarget.querySelector<HTMLElement>(
                            "[data-resize-indicator]",
                        );
                    if (indicator) {
                        indicator.style.opacity = "0.3";
                        indicator.style.backgroundColor =
                            "var(--color-text-secondary)";
                        indicator.style.width = "32px";
                    }
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                role="separator"
                style={{
                    alignItems: "center",
                    backgroundColor: "transparent",
                    cursor: "ns-resize",
                    display: "flex",
                    height: 6,
                    justifyContent: "center",
                    transition: "background-color 100ms ease",
                }}
            >
                <div
                    aria-hidden="true"
                    data-resize-indicator=""
                    style={{
                        backgroundColor: "var(--color-text-secondary)",
                        borderRadius: 1,
                        height: 2,
                        opacity: 0.3,
                        transition:
                            "opacity 100ms ease, background-color 100ms ease, width 100ms ease",
                        width: 32,
                    }}
                />
            </div>
        </div>
    );
}
