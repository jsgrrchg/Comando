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
import {
    resolveWorkspaceDropTarget,
    type WorkspaceDropPoint as Point,
    type WorkspaceTabDropTarget,
} from "./workspaceDropTargets";

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

export type { WorkspaceTabDropTarget } from "./workspaceDropTargets";

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
const CLICK_SUPPRESSION_MS = 250;

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

    const resolveDropTarget = useCallback(
        (
            pointer: Point,
            options: { readonly skipExternal?: boolean } = {},
        ): WorkspaceTabDropTarget | null => {
            const draggedTab = dragStateRef.current.draggedTab;
            if (
                !options.skipExternal &&
                draggedTab &&
                resolveExternalDropTarget
            ) {
                const externalTarget = resolveExternalDropTarget(
                    draggedTab,
                    pointer,
                );
                if (externalTarget) {
                    return externalTarget;
                }
            }

            return resolveWorkspaceDropTarget({
                draggedTabId: draggedTab?.tabId ?? null,
                paneElements: paneRefs.current,
                pointer,
                tabStripElements: tabStripRefs.current,
            });
        },
        [resolveExternalDropTarget],
    );

    const performHitTest = useCallback(
        (pointer: Point): HitTestResult => {
            return { target: resolveDropTarget(pointer) };
        },
        [resolveDropTarget],
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
            resolveDropTarget,
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
            resolveDropTarget,
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

function distanceBetweenPoints(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
