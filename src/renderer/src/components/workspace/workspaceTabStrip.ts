import { useLayoutEffect, type RefObject } from "react";

const WORKSPACE_TAB_REVEAL_PADDING = 12;

export function getWorkspaceTabStripScrollTarget({
    nodeLeft,
    nodeWidth,
    padding = WORKSPACE_TAB_REVEAL_PADDING,
    scrollWidth,
    stripLeft,
    stripWidth,
}: {
    readonly nodeLeft: number;
    readonly nodeWidth: number;
    readonly padding?: number;
    readonly scrollWidth: number;
    readonly stripLeft: number;
    readonly stripWidth: number;
}): number | null {
    const nodeRight = nodeLeft + nodeWidth;
    const visibleLeft = stripLeft + padding;
    const visibleRight = stripLeft + stripWidth - padding;

    if (nodeLeft < visibleLeft) {
        return Math.max(0, nodeLeft - padding);
    }

    if (nodeRight > visibleRight) {
        return Math.max(
            0,
            Math.min(
                nodeRight - stripWidth + padding,
                Math.max(0, scrollWidth - stripWidth),
            ),
        );
    }

    return null;
}

function findTabNodeByAttribute({
    activeTabId,
    strip,
    tabIdAttribute,
}: {
    readonly activeTabId: string;
    readonly strip: HTMLElement;
    readonly tabIdAttribute: string;
}): HTMLElement | null {
    return (
        Array.from(
            strip.querySelectorAll<HTMLElement>(`[${tabIdAttribute}]`),
        ).find((node) => node.getAttribute(tabIdAttribute) === activeTabId) ??
        null
    );
}

function revealActiveWorkspaceTabInStrip({
    activeTabId,
    strip,
    tabIdAttribute,
}: {
    readonly activeTabId: string;
    readonly strip: HTMLElement;
    readonly tabIdAttribute: string;
}): void {
    const activeNode = findTabNodeByAttribute({
        activeTabId,
        strip,
        tabIdAttribute,
    });
    if (!activeNode) {
        return;
    }

    const target = getWorkspaceTabStripScrollTarget({
        nodeLeft: activeNode.offsetLeft,
        nodeWidth: activeNode.offsetWidth,
        scrollWidth: strip.scrollWidth,
        stripLeft: strip.scrollLeft,
        stripWidth: strip.clientWidth,
    });

    if (target === null || Math.abs(target - strip.scrollLeft) < 1) {
        return;
    }

    if (typeof strip.scrollTo === "function") {
        strip.scrollTo({
            behavior: "auto",
            left: target,
        });
        return;
    }

    strip.scrollLeft = target;
}

export function useActiveWorkspaceTabStripReveal({
    activeTabId,
    draggingTabId,
    stripRef,
    tabIdAttribute,
    tabOrderKey,
}: {
    readonly activeTabId: string | null;
    readonly draggingTabId: string | null;
    readonly stripRef: RefObject<HTMLDivElement | null>;
    readonly tabIdAttribute: string;
    readonly tabOrderKey: string;
}): void {
    useLayoutEffect(() => {
        if (!activeTabId || draggingTabId) {
            return;
        }

        const strip = stripRef.current;
        if (!strip) {
            return;
        }

        let disposed = false;
        let frame: number | null = null;
        let resizeObserver: ResizeObserver | null = null;

        const reveal = () => {
            if (disposed) {
                return;
            }

            revealActiveWorkspaceTabInStrip({
                activeTabId,
                strip,
                tabIdAttribute,
            });
        };

        const scheduleReveal = () => {
            if (disposed || frame !== null) {
                return;
            }

            frame = window.requestAnimationFrame(() => {
                frame = null;
                reveal();
            });
        };

        reveal();
        scheduleReveal();

        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(scheduleReveal);
            resizeObserver.observe(strip);
        }

        window.addEventListener("resize", scheduleReveal);

        return () => {
            disposed = true;
            if (frame !== null) {
                window.cancelAnimationFrame(frame);
            }

            resizeObserver?.disconnect();
            window.removeEventListener("resize", scheduleReveal);
        };
    }, [
        activeTabId,
        draggingTabId,
        stripRef,
        tabIdAttribute,
        tabOrderKey,
    ]);
}
