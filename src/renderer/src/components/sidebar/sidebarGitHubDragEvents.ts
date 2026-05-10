import type { GitHubRepositoryRef } from "@shared/ipc";

export const SIDEBAR_GITHUB_DRAG_EVENT = "comando:sidebar-github-drag";

export type SidebarGitHubDragPhase = "cancel" | "end" | "move" | "start";
export type SidebarGitHubDragItemKind = "issue" | "pull_request";

export interface SidebarGitHubDragDetail {
    readonly itemKind: SidebarGitHubDragItemKind;
    readonly number: number;
    readonly phase: SidebarGitHubDragPhase;
    readonly projectId: string | null;
    readonly ref: GitHubRepositoryRef;
    readonly title: string;
    readonly worktreeId: string | null;
    readonly x: number;
    readonly y: number;
}

export function emitSidebarGitHubDrag(detail: SidebarGitHubDragDetail): void {
    window.dispatchEvent(
        new CustomEvent<SidebarGitHubDragDetail>(SIDEBAR_GITHUB_DRAG_EVENT, {
            detail,
        }),
    );
}
