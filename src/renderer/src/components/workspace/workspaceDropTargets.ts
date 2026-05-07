import type { SplitDirection } from "@renderer/app/workspace/tree";

export type WorkspaceDropPoint = {
    readonly x: number;
    readonly y: number;
};

export type WorkspaceDropRect = {
    readonly bottom: number;
    readonly height: number;
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly width: number;
};

export type WorkspaceTabDropTarget =
    | {
          readonly index: number;
          readonly lineRect: WorkspaceDropRect;
          readonly paneId: string;
          readonly type: "strip";
      }
    | {
          readonly type: "composer";
      }
    | {
          readonly paneId: string;
          readonly rect: WorkspaceDropRect;
          readonly type: "pane-center";
      }
    | {
          readonly direction: SplitDirection;
          readonly paneId: string;
          readonly rect: WorkspaceDropRect;
          readonly type: "split";
      };

export type WorkspacePaneDropTarget = Extract<
    WorkspaceTabDropTarget,
    { type: "pane-center" | "split" | "strip" }
>;

const EDGE_DROP_ZONE_RATIO = 0.22;
const MIN_EDGE_DROP_ZONE_PX = 56;
const MAX_EDGE_DROP_ZONE_PX = 96;
const OVERLAY_INSET_PX = 6;
const EMPTY_STRIP_PADDING_PX = 12;
const PANE_DROP_TARGET_SLOP_PX = 12;
const STRIP_SCROLL_STEP_PX = 18;
const STRIP_SCROLL_ZONE_PX = 28;

export function isWorkspacePaneDropTarget(
    target: WorkspaceTabDropTarget | null,
): target is WorkspacePaneDropTarget {
    return (
        target?.type === "strip" ||
        target?.type === "pane-center" ||
        target?.type === "split"
    );
}

export function resolveWorkspaceDropTarget(input: {
    readonly draggedTabId?: string | null;
    readonly paneElements: ReadonlyMap<string, HTMLElement>;
    readonly pointer: WorkspaceDropPoint;
    readonly tabStripElements: ReadonlyMap<string, HTMLElement>;
    readonly autoScrollStrip?: boolean;
}): WorkspaceTabDropTarget | null {
    for (const [paneId, strip] of input.tabStripElements) {
        const stripRect = rectFromDom(strip.getBoundingClientRect());
        if (!pointWithinRect(input.pointer, stripRect)) {
            continue;
        }

        if (input.autoScrollStrip ?? true) {
            autoScrollTabStrip(strip, input.pointer.x);
        }

        return resolveStripDropTarget(
            paneId,
            strip,
            input.pointer.x,
            input.draggedTabId ?? null,
        );
    }

    for (const [paneId, pane] of input.paneElements) {
        const paneRect = rectFromDom(pane.getBoundingClientRect());
        if (!pointWithinRect(input.pointer, paneRect)) {
            continue;
        }

        const splitTarget = resolveSplitDropTarget(
            paneId,
            paneRect,
            input.pointer,
        );
        if (splitTarget) {
            return splitTarget;
        }

        return {
            paneId,
            rect: insetRect(paneRect, OVERLAY_INSET_PX),
            type: "pane-center",
        };
    }

    const nearestPane = getNearestPaneWithinSlop(
        input.paneElements,
        input.pointer,
    );
    if (nearestPane) {
        const direction = resolveOutsidePaneDropDirection(
            nearestPane.rect,
            input.pointer,
        );
        return {
            direction,
            paneId: nearestPane.paneId,
            rect: buildSplitPreviewRect(nearestPane.rect, direction),
            type: "split",
        };
    }

    return null;
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
    paneRect: WorkspaceDropRect,
    pointer: WorkspaceDropPoint,
): WorkspaceTabDropTarget | null {
    const edgeWidth = getEdgeDropZoneSize(paneRect.width);
    const edgeHeight = getEdgeDropZoneSize(paneRect.height);
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

function getEdgeDropZoneSize(size: number): number {
    return Math.min(
        MAX_EDGE_DROP_ZONE_PX,
        Math.max(MIN_EDGE_DROP_ZONE_PX, size * EDGE_DROP_ZONE_RATIO),
    );
}

function getNearestPaneWithinSlop(
    paneElements: ReadonlyMap<string, HTMLElement>,
    pointer: WorkspaceDropPoint,
): { readonly paneId: string; readonly rect: WorkspaceDropRect } | null {
    let nearest:
        | {
              readonly distance: number;
              readonly paneId: string;
              readonly rect: WorkspaceDropRect;
          }
        | null = null;

    for (const [paneId, pane] of paneElements) {
        const paneRect = rectFromDom(pane.getBoundingClientRect());
        const distance = getDistanceToRect(pointer, paneRect);
        if (distance > PANE_DROP_TARGET_SLOP_PX) {
            continue;
        }

        if (!nearest || distance < nearest.distance) {
            nearest = { distance, paneId, rect: paneRect };
        }
    }

    return nearest ? { paneId: nearest.paneId, rect: nearest.rect } : null;
}

function getDistanceToRect(
    point: WorkspaceDropPoint,
    rect: WorkspaceDropRect,
): number {
    const dx =
        point.x < rect.left
            ? rect.left - point.x
            : point.x > rect.right
              ? point.x - rect.right
              : 0;
    const dy =
        point.y < rect.top
            ? rect.top - point.y
            : point.y > rect.bottom
              ? point.y - rect.bottom
              : 0;

    return Math.hypot(dx, dy);
}

function resolveOutsidePaneDropDirection(
    paneRect: WorkspaceDropRect,
    pointer: WorkspaceDropPoint,
): SplitDirection {
    const distances: Array<readonly [SplitDirection, number]> = [
        ["left", Math.abs(pointer.x - paneRect.left)],
        ["right", Math.abs(pointer.x - paneRect.right)],
        ["up", Math.abs(pointer.y - paneRect.top)],
        ["down", Math.abs(pointer.y - paneRect.bottom)],
    ];
    return distances.sort((left, right) => left[1] - right[1])[0]?.[0] ?? "left";
}

function buildSplitPreviewRect(
    paneRect: WorkspaceDropRect,
    direction: SplitDirection,
): WorkspaceDropRect {
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

function rectFromDom(rect: DOMRect): WorkspaceDropRect {
    return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
    };
}

function insetRect(
    rect: WorkspaceDropRect,
    inset: number,
): WorkspaceDropRect {
    return {
        bottom: rect.bottom - inset,
        height: Math.max(rect.height - inset * 2, 0),
        left: rect.left + inset,
        right: rect.right - inset,
        top: rect.top + inset,
        width: Math.max(rect.width - inset * 2, 0),
    };
}

function pointWithinRect(
    point: WorkspaceDropPoint,
    rect: WorkspaceDropRect,
): boolean {
    return (
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
    );
}
