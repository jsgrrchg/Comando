import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";

import {
    emitWorkspaceTabComposerDrag,
    type WorkspaceTabComposerDragItem,
} from "@renderer/app/drag-and-drop";
import type { WorkspaceTab } from "@shared/ipc";

import type { SplitDirection } from "@renderer/app/workspace/tree";

type Point = {
    readonly x: number;
    readonly y: number;
};

type Rect = {
    readonly bottom: number;
    readonly height: number;
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly width: number;
};

type DragPhase = "dragging" | "idle" | "pending";

export type WorkspaceDraggedTab = {
    readonly composerDragItem?: WorkspaceTabComposerDragItem | null;
    readonly isDirty: boolean;
    readonly kind: WorkspaceTab["kind"];
    readonly paneId: string;
    readonly sourceIndex: number;
    readonly tabId: string;
    readonly title: string;
};

export type WorkspaceTabDropTarget =
    | {
          readonly index: number;
          readonly lineRect: Rect;
          readonly paneId: string;
          readonly type: "strip";
      }
    | {
          readonly type: "composer";
      }
    | {
          readonly paneId: string;
          readonly rect: Rect;
          readonly type: "pane-center";
      }
    | {
          readonly direction: SplitDirection;
          readonly paneId: string;
          readonly rect: Rect;
          readonly type: "split";
      };

type DragState = {
    readonly activeDropTarget: WorkspaceTabDropTarget | null;
    readonly draggedTab: WorkspaceDraggedTab | null;
    readonly phase: DragPhase;
    readonly pointerCurrent: Point | null;
    readonly pointerOffset: Point | null;
    readonly pointerStart: Point | null;
};

type UseWorkspaceTabDragOptions = {
    readonly onDropToSplit: (
        tabId: string,
        sourcePaneId: string,
        targetPaneId: string,
        direction: SplitDirection,
    ) => Promise<void>;
    readonly onMoveToPane: (
        tabId: string,
        sourcePaneId: string,
        targetPaneId: string,
        targetIndex: number,
    ) => Promise<void>;
    readonly onReorder: (
        paneId: string,
        tabId: string,
        targetIndex: number,
    ) => Promise<void>;
    readonly resolveExternalDropTarget?: (
        draggedTab: WorkspaceDraggedTab,
        pointer: Point,
    ) => Extract<WorkspaceTabDropTarget, { type: "composer" }> | null;
};

type HitTestResult = {
    readonly target: WorkspaceTabDropTarget | null;
};

const DRAG_THRESHOLD = 6;
const EDGE_TARGET_PX = 26;
const CLICK_SUPPRESSION_MS = 250;
const OVERLAY_INSET_PX = 6;
const EMPTY_STRIP_PADDING_PX = 12;
const STRIP_SCROLL_STEP_PX = 18;
const STRIP_SCROLL_ZONE_PX = 28;

const idleState: DragState = {
    activeDropTarget: null,
    draggedTab: null,
    phase: "idle",
    pointerCurrent: null,
    pointerOffset: null,
    pointerStart: null,
};

export function useWorkspaceTabDrag({
    onDropToSplit,
    onMoveToPane,
    onReorder,
    resolveExternalDropTarget,
}: UseWorkspaceTabDragOptions) {
    const [dragState, setDragState] = useState<DragState>(idleState);
    const dragStateRef = useRef<DragState>(idleState);
    const paneRefs = useRef(new Map<string, HTMLElement>());
    const tabStripRefs = useRef(new Map<string, HTMLElement>());
    const latestPointerRef = useRef<Point | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const suppressClickUntilRef = useRef(0);

    useEffect(() => {
        dragStateRef.current = dragState;
    }, [dragState]);

    const clearDragState = useCallback(() => {
        if (animationFrameRef.current !== null) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }

        latestPointerRef.current = null;
        setDragState(idleState);
    }, []);

    const setPaneElement = useCallback(
        (paneId: string, element: HTMLElement | null) => {
            if (element) {
                paneRefs.current.set(paneId, element);
                return;
            }

            paneRefs.current.delete(paneId);
        },
        [],
    );

    const setTabStripElement = useCallback(
        (paneId: string, element: HTMLElement | null) => {
            if (element) {
                tabStripRefs.current.set(paneId, element);
                return;
            }

            tabStripRefs.current.delete(paneId);
        },
        [],
    );

    const commitDrop = useCallback(
        async (
            draggedTab: WorkspaceDraggedTab,
            target: WorkspaceTabDropTarget | null,
        ) => {
            if (!target) {
                return;
            }

            if (target.type === "composer") {
                return;
            }

            if (target.type === "strip") {
                if (target.paneId === draggedTab.paneId) {
                    await onReorder(
                        draggedTab.paneId,
                        draggedTab.tabId,
                        target.index,
                    );
                    return;
                }

                await onMoveToPane(
                    draggedTab.tabId,
                    draggedTab.paneId,
                    target.paneId,
                    target.index,
                );
                return;
            }

            if (target.type === "pane-center") {
                if (target.paneId === draggedTab.paneId) {
                    return;
                }

                await onMoveToPane(
                    draggedTab.tabId,
                    draggedTab.paneId,
                    target.paneId,
                    Number.POSITIVE_INFINITY,
                );
                return;
            }

            await onDropToSplit(
                draggedTab.tabId,
                draggedTab.paneId,
                target.paneId,
                target.direction,
            );
        },
        [onDropToSplit, onMoveToPane, onReorder],
    );

    const performHitTest = useCallback(
        (pointer: Point): HitTestResult => {
            const draggedTab = dragStateRef.current.draggedTab;
            if (draggedTab && resolveExternalDropTarget) {
                const externalTarget = resolveExternalDropTarget(
                    draggedTab,
                    pointer,
                );
                if (externalTarget) {
                    return { target: externalTarget };
                }
            }

            for (const [paneId, strip] of tabStripRefs.current) {
                const stripRect = rectFromDom(strip.getBoundingClientRect());
                if (!pointWithinRect(pointer, stripRect)) {
                    continue;
                }

                autoScrollTabStrip(strip, pointer.x);
                return {
                    target: resolveStripDropTarget(
                        paneId,
                        strip,
                        pointer.x,
                        dragStateRef.current.draggedTab?.tabId ?? null,
                    ),
                };
            }

            for (const [paneId, pane] of paneRefs.current) {
                const paneRect = rectFromDom(pane.getBoundingClientRect());
                if (!pointWithinRect(pointer, paneRect)) {
                    continue;
                }

                const splitTarget = resolveSplitDropTarget(
                    paneId,
                    paneRect,
                    pointer,
                );
                if (splitTarget) {
                    return { target: splitTarget };
                }

                return {
                    target: {
                        paneId,
                        rect: insetRect(paneRect, OVERLAY_INSET_PX),
                        type: "pane-center",
                    },
                };
            }

            return { target: null };
        },
        [resolveExternalDropTarget],
    );

    const schedulePointerFrame = useCallback(() => {
        if (animationFrameRef.current !== null) {
            return;
        }

        animationFrameRef.current = requestAnimationFrame(() => {
            animationFrameRef.current = null;
            const pointer = latestPointerRef.current;
            const currentState = dragStateRef.current;
            if (!pointer || currentState.phase === "idle") {
                return;
            }

            const distance = currentState.pointerStart
                ? distanceBetweenPoints(pointer, currentState.pointerStart)
                : 0;
            const nextPhase =
                currentState.phase === "pending" && distance >= DRAG_THRESHOLD
                    ? "dragging"
                    : currentState.phase;
            const hitTest =
                nextPhase === "dragging"
                    ? performHitTest(pointer)
                    : { target: null };

            if (nextPhase === "dragging" && currentState.draggedTab) {
                emitComposerDragPhase(
                    currentState.draggedTab,
                    currentState.phase === "pending" ? "start" : "move",
                    pointer,
                );
            }

            setDragState((previousState) => ({
                ...previousState,
                activeDropTarget: hitTest.target,
                phase: nextPhase,
                pointerCurrent: pointer,
            }));
        });
    }, [performHitTest]);

    const beginTabPointerDown = useCallback(
        (
            draggedTab: WorkspaceDraggedTab,
            event: ReactPointerEvent<HTMLElement>,
        ) => {
            if (event.button !== 0) {
                return;
            }

            const eventTarget = event.target;
            if (
                eventTarget instanceof HTMLElement &&
                eventTarget.closest("[data-workspace-tab-close='true']")
            ) {
                return;
            }

            const element = event.currentTarget;
            const rect = element.getBoundingClientRect();
            const pointerStart = {
                x: event.clientX,
                y: event.clientY,
            };

            setDragState({
                activeDropTarget: null,
                draggedTab,
                phase: "pending",
                pointerCurrent: pointerStart,
                pointerOffset: {
                    x: pointerStart.x - rect.left,
                    y: pointerStart.y - rect.top,
                },
                pointerStart,
            });
        },
        [],
    );

    const cancelDrag = useCallback(() => {
        suppressClickUntilRef.current =
            performance.now() + CLICK_SUPPRESSION_MS;
        emitComposerDragPhase(
            dragStateRef.current.draggedTab,
            "cancel",
            dragStateRef.current.pointerCurrent,
        );
        clearDragState();
    }, [clearDragState]);

    const handleTabClick = useCallback(
        (event: ReactMouseEvent | MouseEvent) => {
            if (performance.now() < suppressClickUntilRef.current) {
                event.preventDefault();
                event.stopPropagation();
                return true;
            }

            return false;
        },
        [],
    );

    useEffect(() => {
        const currentState = dragStateRef.current;
        if (currentState.phase === "idle") {
            return;
        }

        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;
        if (currentState.phase === "dragging") {
            document.body.style.cursor = "grabbing";
            document.body.style.userSelect = "none";
        }

        const handlePointerMove = (event: PointerEvent) => {
            latestPointerRef.current = {
                x: event.clientX,
                y: event.clientY,
            };
            schedulePointerFrame();
        };

        const handlePointerUp = (event: PointerEvent) => {
            const finalState = dragStateRef.current;
            if (finalState.phase === "dragging" && finalState.draggedTab) {
                const pointer = {
                    x: event.clientX,
                    y: event.clientY,
                };
                const { target } = performHitTest(pointer);
                emitComposerDragPhase(finalState.draggedTab, "end", pointer);
                suppressClickUntilRef.current =
                    performance.now() + CLICK_SUPPRESSION_MS;
                clearDragState();
                void commitDrop(finalState.draggedTab, target);
                return;
            }

            clearDragState();
        };

        const handlePointerCancel = () => {
            emitComposerDragPhase(
                dragStateRef.current.draggedTab,
                "cancel",
                dragStateRef.current.pointerCurrent,
            );
            clearDragState();
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") {
                return;
            }

            event.preventDefault();
            cancelDrag();
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerCancel);
        window.addEventListener("keydown", handleKeyDown);

        return () => {
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerCancel);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [
        cancelDrag,
        clearDragState,
        commitDrop,
        performHitTest,
        schedulePointerFrame,
        dragState.phase,
    ]);

    return useMemo(
        () => ({
            activeDropTarget: dragState.activeDropTarget,
            beginTabPointerDown,
            draggedTab: dragState.draggedTab,
            handleTabClick,
            isDragging:
                dragState.phase === "dragging" && Boolean(dragState.draggedTab),
            phase: dragState.phase,
            pointerCurrent: dragState.pointerCurrent,
            pointerOffset: dragState.pointerOffset,
            setPaneElement,
            setTabStripElement,
        }),
        [
            beginTabPointerDown,
            dragState.activeDropTarget,
            dragState.draggedTab,
            dragState.phase,
            dragState.pointerCurrent,
            dragState.pointerOffset,
            handleTabClick,
            setPaneElement,
            setTabStripElement,
        ],
    );
}

function emitComposerDragPhase(
    draggedTab: WorkspaceDraggedTab | null,
    phase: "cancel" | "end" | "move" | "start",
    pointer: Point | null,
): void {
    const item = draggedTab?.composerDragItem ?? null;
    if (!item) {
        return;
    }

    emitWorkspaceTabComposerDrag({
        item,
        phase,
        x: pointer?.x ?? 0,
        y: pointer?.y ?? 0,
    });
}

function resolveStripDropTarget(
    paneId: string,
    strip: HTMLElement,
    pointerX: number,
    draggedTabId: string | null,
): WorkspaceTabDropTarget {
    const stripRect = rectFromDom(strip.getBoundingClientRect());
    const tabElements = Array.from(
        strip.querySelectorAll<HTMLElement>("[data-workspace-tab-id]"),
    ).filter((element) => element.dataset.workspaceTabId !== draggedTabId);
    let index = tabElements.length;

    for (const [tabIndex, element] of tabElements.entries()) {
        const rect = rectFromDom(element.getBoundingClientRect());
        if (pointerX < rect.left + rect.width / 2) {
            index = tabIndex;
            break;
        }
    }

    let lineLeft = stripRect.left + EMPTY_STRIP_PADDING_PX;
    if (tabElements.length > 0) {
        if (index === 0) {
            lineLeft = rectFromDom(tabElements[0].getBoundingClientRect()).left;
        } else if (index >= tabElements.length) {
            lineLeft = rectFromDom(
                tabElements[tabElements.length - 1].getBoundingClientRect(),
            ).right;
        } else {
            lineLeft = rectFromDom(
                tabElements[index].getBoundingClientRect(),
            ).left;
        }
    }

    return {
        index,
        lineRect: {
            bottom: stripRect.bottom - 4,
            height: Math.max(stripRect.height - 8, 16),
            left: lineLeft - 1,
            right: lineLeft + 1,
            top: stripRect.top + 4,
            width: 2,
        },
        paneId,
        type: "strip",
    };
}

function resolveSplitDropTarget(
    paneId: string,
    paneRect: Rect,
    pointer: Point,
): WorkspaceTabDropTarget | null {
    const edgeWidth = Math.min(
        EDGE_TARGET_PX,
        Math.max(16, Math.floor(paneRect.width / 4)),
    );
    const edgeHeight = Math.min(
        EDGE_TARGET_PX,
        Math.max(16, Math.floor(paneRect.height / 4)),
    );
    const distances: Array<readonly [SplitDirection, number, number]> = [
        ["left", pointer.x - paneRect.left, edgeWidth],
        ["right", paneRect.right - pointer.x, edgeWidth],
        ["up", pointer.y - paneRect.top, edgeHeight],
        ["down", paneRect.bottom - pointer.y, edgeHeight],
    ];
    const nearest = distances.reduce<
        readonly [SplitDirection, number, number] | null
    >((currentNearest, candidate) => {
        if (candidate[1] > candidate[2]) {
            return currentNearest;
        }

        if (!currentNearest || candidate[1] < currentNearest[1]) {
            return candidate;
        }

        return currentNearest;
    }, null);

    if (!nearest) {
        return null;
    }

    return {
        direction: nearest[0],
        paneId,
        rect: buildSplitPreviewRect(paneRect, nearest[0]),
        type: "split",
    };
}

function buildSplitPreviewRect(
    paneRect: Rect,
    direction: SplitDirection,
): Rect {
    const previewWidth = Math.max(paneRect.width * 0.42, 72);
    const previewHeight = Math.max(paneRect.height * 0.42, 72);

    switch (direction) {
        case "left":
            return {
                ...paneRect,
                right: paneRect.left + previewWidth,
                width: previewWidth,
            };
        case "right":
            return {
                ...paneRect,
                left: paneRect.right - previewWidth,
                width: previewWidth,
            };
        case "up":
            return {
                ...paneRect,
                bottom: paneRect.top + previewHeight,
                height: previewHeight,
            };
        case "down":
            return {
                ...paneRect,
                height: previewHeight,
                top: paneRect.bottom - previewHeight,
            };
    }
}

function autoScrollTabStrip(strip: HTMLElement, pointerX: number): void {
    const rect = strip.getBoundingClientRect();
    if (pointerX <= rect.left + STRIP_SCROLL_ZONE_PX) {
        strip.scrollLeft -= STRIP_SCROLL_STEP_PX;
        return;
    }

    if (pointerX >= rect.right - STRIP_SCROLL_ZONE_PX) {
        strip.scrollLeft += STRIP_SCROLL_STEP_PX;
    }
}

function rectFromDom(rect: DOMRect): Rect {
    return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
    };
}

function insetRect(rect: Rect, inset: number): Rect {
    return {
        bottom: rect.bottom - inset,
        height: Math.max(rect.height - inset * 2, 0),
        left: rect.left + inset,
        right: rect.right - inset,
        top: rect.top + inset,
        width: Math.max(rect.width - inset * 2, 0),
    };
}

function pointWithinRect(point: Point, rect: Rect): boolean {
    return (
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
    );
}

function distanceBetweenPoints(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
