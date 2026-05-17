import { hasPrimaryPointerButton } from "@renderer/app/pointerGuards";

export function shouldCancelSidebarDragOnMove(buttons: number): boolean {
    return !hasPrimaryPointerButton(buttons);
}

export function shouldEmitSidebarDragCancel(active: boolean): boolean {
    return active;
}
