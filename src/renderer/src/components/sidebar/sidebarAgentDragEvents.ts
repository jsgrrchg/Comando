import type { AiRuntimeId } from "@shared/ipc";

export const SIDEBAR_AGENT_DRAG_EVENT = "comando:sidebar-agent-drag";

export type SidebarAgentDragPhase = "cancel" | "end" | "move" | "start";

export interface SidebarAgentDragDetail {
    readonly phase: SidebarAgentDragPhase;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
    readonly title: string;
    readonly worktreeId: string | null;
    readonly x: number;
    readonly y: number;
}

export function emitSidebarAgentDrag(detail: SidebarAgentDragDetail): void {
    window.dispatchEvent(
        new CustomEvent<SidebarAgentDragDetail>(SIDEBAR_AGENT_DRAG_EVENT, {
            detail,
        }),
    );
}
