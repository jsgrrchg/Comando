import { SidebarGitScopePicker } from "@renderer/components/sidebar/SidebarGitScopePicker";

interface GitContextTriggerProps {
    readonly onOpenWorkspace: (
        projectId: string,
        worktreeId: string | null,
        options?: { readonly emptyLayout?: boolean },
    ) => Promise<void>;
    readonly projectId: string | null;
    readonly titlebarContextKey: string | null;
    readonly worktreeId: string | null;
}

/**
 * Uses the existing Git scope behavior while keeping the title bar's anchor
 * small enough to leave a predictable draggable window region.
 */
export function GitContextTrigger({
    onOpenWorkspace,
    projectId,
    titlebarContextKey,
    worktreeId,
}: GitContextTriggerProps) {
    if (!projectId) {
        return null;
    }

    return (
        <SidebarGitScopePicker
            onTitlebarMenuRequest={(anchor) => {
                // The workspace is a separate WebContentsView above the host
                // renderer, so its surface must own the visible popover.
                void window.comando.openWorkspaceSurfaceGitScopeMenu(anchor);
            }}
            onOpenWorkspace={onOpenWorkspace}
            projectId={projectId}
            titlebarContextKey={titlebarContextKey ?? undefined}
            triggerVariant="titlebar"
            worktreeId={worktreeId}
        />
    );
}
