import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
} from "react";

type Point = {
    readonly x: number;
    readonly y: number;
};

export type ProjectContextTabDropPosition = "after" | "before";

export interface ProjectContextTabDropTarget {
    readonly contextKey: string;
    readonly position: ProjectContextTabDropPosition;
    readonly targetIndex: number;
}

export interface ProjectContextTabHitbox {
    readonly bottom: number;
    readonly contextKey: string;
    readonly left: number;
    readonly right: number;
    readonly top: number;
}

interface ProjectContextTabDragState {
    readonly draggedContextKey: string | null;
    readonly phase: "dragging" | "idle" | "pending";
    readonly pointerStart: Point | null;
    readonly target: ProjectContextTabDropTarget | null;
}

interface UseProjectContextTabDragOptions {
    readonly contextKeys: readonly string[];
    readonly onReorder: (
        contextKey: string,
        targetIndex: number,
    ) => Promise<void> | void;
    readonly stripRef: RefObject<HTMLDivElement | null>;
}

const CLICK_SUPPRESSION_MS = 250;
const DRAG_THRESHOLD = 6;
const SCROLL_EDGE_PX = 40;

const idleState: ProjectContextTabDragState = {
    draggedContextKey: null,
    phase: "idle",
    pointerStart: null,
    target: null,
};

export function resolveProjectContextTabDropTarget({
    contextKeys,
    draggedContextKey,
    hitboxes,
    pointer,
}: {
    readonly contextKeys: readonly string[];
    readonly draggedContextKey: string;
    readonly hitboxes: readonly ProjectContextTabHitbox[];
    readonly pointer: Point;
}): ProjectContextTabDropTarget | null {
    if (hitboxes.length === 0) {
        return null;
    }

    const stripTop = Math.min(...hitboxes.map((hitbox) => hitbox.top));
    const stripBottom = Math.max(...hitboxes.map((hitbox) => hitbox.bottom));
    if (pointer.y < stripTop - 12 || pointer.y > stripBottom + 12) {
        return null;
    }

    const sourceIndex = contextKeys.indexOf(draggedContextKey);
    if (sourceIndex < 0) {
        return null;
    }

    let targetHitbox = hitboxes.at(-1) ?? null;
    let position: ProjectContextTabDropPosition = "after";
    for (const hitbox of hitboxes) {
        if (pointer.x < hitbox.left + (hitbox.right - hitbox.left) / 2) {
            targetHitbox = hitbox;
            position = "before";
            break;
        }
    }

    if (!targetHitbox) {
        return null;
    }

    const hoveredIndex = contextKeys.indexOf(targetHitbox.contextKey);
    if (hoveredIndex < 0) {
        return null;
    }

    const insertionIndex =
        hoveredIndex + (position === "after" ? 1 : 0);
    const targetIndex =
        insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex;
    if (targetIndex === sourceIndex) {
        return null;
    }

    return {
        contextKey: targetHitbox.contextKey,
        position,
        targetIndex: Math.max(0, Math.min(contextKeys.length - 1, targetIndex)),
    };
}

export function useProjectContextTabDrag({
    contextKeys,
    onReorder,
    stripRef,
}: UseProjectContextTabDragOptions) {
    const [dragState, setDragState] =
        useState<ProjectContextTabDragState>(idleState);
    const dragStateRef = useRef<ProjectContextTabDragState>(idleState);
    const contextKeysRef = useRef(contextKeys);
    const onReorderRef = useRef(onReorder);
    const suppressClickContextKeyRef = useRef<string | null>(null);
    const suppressClickUntilRef = useRef(0);

    useEffect(() => {
        dragStateRef.current = dragState;
    }, [dragState]);

    useEffect(() => {
        contextKeysRef.current = contextKeys;
        onReorderRef.current = onReorder;
    }, [contextKeys, onReorder]);

    const clearDragState = useCallback(() => {
        setDragState(idleState);
    }, []);

    const suppressNextClick = useCallback((contextKey: string) => {
        suppressClickContextKeyRef.current = contextKey;
        suppressClickUntilRef.current = performance.now() + CLICK_SUPPRESSION_MS;
    }, []);

    useEffect(() => {
        const handleCapturedClick = (event: MouseEvent) => {
            if (performance.now() >= suppressClickUntilRef.current) {
                return;
            }

            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            const tab = target.closest<HTMLElement>(
                "[data-project-context-tab-key]",
            );
            if (
                tab?.dataset.projectContextTabKey !==
                suppressClickContextKeyRef.current
            ) {
                return;
            }

            event.preventDefault();
            event.stopImmediatePropagation();
        };

        window.addEventListener("click", handleCapturedClick, true);
        return () => {
            window.removeEventListener("click", handleCapturedClick, true);
        };
    }, []);

    const resolveDropTarget = useCallback(
        (pointer: Point): ProjectContextTabDropTarget | null => {
            const draggedContextKey = dragStateRef.current.draggedContextKey;
            const strip = stripRef.current;
            if (!draggedContextKey || !strip) {
                return null;
            }

            const hitboxes = Array.from(
                strip.querySelectorAll<HTMLElement>(
                    ":scope > [data-project-context-tab-key]",
                ),
            ).map((element) => {
                const rect = element.getBoundingClientRect();
                return {
                    bottom: rect.bottom,
                    contextKey: element.dataset.projectContextTabKey ?? "",
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                };
            });

            return resolveProjectContextTabDropTarget({
                contextKeys: contextKeysRef.current,
                draggedContextKey,
                hitboxes,
                pointer,
            });
        },
        [stripRef],
    );

    const scrollAtEdge = useCallback(
        (pointerX: number) => {
            const strip = stripRef.current;
            if (!strip || strip.scrollWidth <= strip.clientWidth) {
                return;
            }

            const rect = strip.getBoundingClientRect();
            const leftDistance = pointerX - rect.left;
            const rightDistance = rect.right - pointerX;
            if (leftDistance >= 0 && leftDistance < SCROLL_EDGE_PX) {
                strip.scrollLeft -= Math.ceil(
                    (SCROLL_EDGE_PX - leftDistance) / 4,
                );
            } else if (rightDistance >= 0 && rightDistance < SCROLL_EDGE_PX) {
                strip.scrollLeft += Math.ceil(
                    (SCROLL_EDGE_PX - rightDistance) / 4,
                );
            }
        },
        [stripRef],
    );

    const beginTabPointerDown = useCallback(
        (contextKey: string, event: ReactPointerEvent<HTMLElement>) => {
            if (event.button !== 0) {
                return;
            }

            const target = event.target;
            if (
                target instanceof HTMLElement &&
                target.closest("[data-project-context-tab-action='true']")
            ) {
                return;
            }

            setDragState({
                draggedContextKey: contextKey,
                phase: "pending",
                pointerStart: { x: event.clientX, y: event.clientY },
                target: null,
            });
        },
        [],
    );

    useEffect(() => {
        if (dragState.phase === "idle") {
            return;
        }

        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;

        const handlePointerMove = (event: PointerEvent) => {
            const currentState = dragStateRef.current;
            if (event.buttons & 1) {
                const pointer = { x: event.clientX, y: event.clientY };
                const distance = currentState.pointerStart
                    ? Math.hypot(
                          pointer.x - currentState.pointerStart.x,
                          pointer.y - currentState.pointerStart.y,
                      )
                    : 0;
                const isDragging =
                    currentState.phase === "dragging" ||
                    distance >= DRAG_THRESHOLD;
                if (!isDragging) {
                    return;
                }

                document.body.style.cursor = "grabbing";
                document.body.style.userSelect = "none";
                scrollAtEdge(pointer.x);
                setDragState((state) => ({
                    ...state,
                    phase: "dragging",
                    target: resolveDropTarget(pointer),
                }));
                return;
            }

            if (currentState.phase === "dragging" && currentState.draggedContextKey) {
                suppressNextClick(currentState.draggedContextKey);
            }
            clearDragState();
        };

        const handlePointerUp = (event: PointerEvent) => {
            const currentState = dragStateRef.current;
            if (
                currentState.phase !== "dragging" ||
                !currentState.draggedContextKey
            ) {
                clearDragState();
                return;
            }

            const target = resolveDropTarget({
                x: event.clientX,
                y: event.clientY,
            });
            suppressNextClick(currentState.draggedContextKey);
            clearDragState();
            if (target) {
                void onReorderRef.current(
                    currentState.draggedContextKey,
                    target.targetIndex,
                );
            }
        };

        const cancelDrag = () => {
            const currentState = dragStateRef.current;
            if (currentState.phase === "dragging" && currentState.draggedContextKey) {
                suppressNextClick(currentState.draggedContextKey);
            }
            clearDragState();
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") {
                return;
            }
            event.preventDefault();
            cancelDrag();
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") {
                cancelDrag();
            }
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelDrag);
        window.addEventListener("blur", cancelDrag);
        window.addEventListener("keydown", handleKeyDown);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelDrag);
            window.removeEventListener("blur", cancelDrag);
            window.removeEventListener("keydown", handleKeyDown);
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
        };
    }, [
        clearDragState,
        dragState.phase,
        resolveDropTarget,
        scrollAtEdge,
        suppressNextClick,
    ]);

    return useMemo(
        () => ({
            beginTabPointerDown,
            draggedContextKey: dragState.draggedContextKey,
            isDragging: dragState.phase === "dragging",
            target: dragState.target,
        }),
        [
            beginTabPointerDown,
            dragState.draggedContextKey,
            dragState.phase,
            dragState.target,
        ],
    );
}
