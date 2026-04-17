import type { RuntimeWorkspaceChatHistoryTab } from "@renderer/app/workspace/tree";

interface ChatHistoryTabViewProps {
    readonly tab: RuntimeWorkspaceChatHistoryTab;
}

export function ChatHistoryTabView({ tab }: ChatHistoryTabViewProps) {
    return (
        <div className="flex h-full min-h-0 flex-col bg-editor">
            <div className="border-b border-border px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-medium text-text-primary">
                            Chat History
                        </h2>
                        <p className="mt-1 text-xs text-text-secondary">
                            Workspace integration is ready. The full
                            history browser lands in the next phase.
                        </p>
                    </div>
                    <div className="text-right text-[11px] text-text-secondary">
                        <div>Project: {tab.projectId ?? "No project"}</div>
                        <div>Worktree: {tab.worktreeId ?? "Primary"}</div>
                    </div>
                </div>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                <div className="max-w-md rounded-xl border border-border bg-bg-panel px-4 py-5 text-center">
                    <p className="text-sm font-medium text-text-primary">
                        History tab mounted
                    </p>
                    <p className="mt-2 text-xs leading-5 text-text-secondary">
                        This tab now behaves like a first-class workspace item
                        and is singleton-scoped by project and worktree.
                    </p>
                </div>
            </div>
        </div>
    );
}
