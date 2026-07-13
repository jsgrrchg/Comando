import {
    formatShortcutSymbols,
    type ShortcutDefinition,
} from "@renderer/app/shortcuts/registry";
import {
    projectAvatarColor,
    projectAvatarInitial,
} from "@renderer/components/projectAvatar";

// Resolve the binding from the shortcut registry at render time so the hint
// stays accurate (and uses the correct platform modifier) if it ever changes.
function ShortcutHint({ action }: { action: ShortcutDefinition["id"] }) {
    const label = formatShortcutSymbols(action);
    if (!label) {
        return null;
    }

    return (
        <kbd
            className="ml-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium text-text-primary"
            style={{
                background: "var(--color-bg-tertiary)",
                border: "1px solid color-mix(in srgb, var(--color-border) 80%, transparent)",
                fontFamily: "inherit",
            }}
        >
            {label}
        </kbd>
    );
}

function FolderIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="13"
            viewBox="0 0 14 14"
            width="14"
        >
            <path
                d="M1.5 3.5a1 1 0 0 1 1-1h2.6l1.1 1.3h5.3a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7.5Z"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth="1.1"
            />
        </svg>
    );
}

export interface WorkspacePaneRecentProject {
    readonly id: string;
    readonly name: string;
}

interface WorkspacePaneEmptyStateProps {
    readonly onOpenProject: (projectId: string) => void;
    readonly onOpenProjects: () => void;
    readonly recentProjects: readonly WorkspacePaneRecentProject[];
}

// Shown in a workspace pane that has no open tabs. Offers the most recently
// opened projects, a way to open another one, and a reminder of the
// file/chat/terminal shortcuts.
export function WorkspacePaneEmptyState({
    onOpenProject,
    onOpenProjects,
    recentProjects,
}: WorkspacePaneEmptyStateProps) {
    const hasRecentProjects = recentProjects.length > 0;

    return (
        <div className="flex h-full items-center justify-center p-6">
            <div className="flex w-full max-w-[260px] flex-col items-center gap-4">
                <p className="max-w-[240px] text-center text-[11px] leading-6 text-text-secondary">
                    Open a file
                    <ShortcutHint action="open_file_picker" />, start a chat
                    <ShortcutHint action="new_agent_from_focused_provider" />,
                    or launch a terminal
                    <ShortcutHint action="new_terminal" />.
                </p>

                {hasRecentProjects && (
                    <div className="flex w-full flex-col gap-0.5">
                        {recentProjects.map((project) => (
                            <button
                                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-text-primary hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent focus-visible:[outline-offset:-2px]"
                                key={project.id}
                                onClick={() => onOpenProject(project.id)}
                                title={project.name}
                                type="button"
                            >
                                <span
                                    aria-hidden="true"
                                    className="grid h-5 w-5 flex-none place-items-center rounded-[5px] text-[9.5px] font-bold text-white"
                                    style={{
                                        background: projectAvatarColor(
                                            project.id,
                                        ),
                                    }}
                                >
                                    {projectAvatarInitial(project.name)}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                                    {project.name}
                                </span>
                            </button>
                        ))}
                    </div>
                )}

                <button
                    className={
                        hasRecentProjects
                            ? "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] text-text-secondary hover:bg-accent-soft hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent focus-visible:[outline-offset:-2px]"
                            : "flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-[13px] font-medium text-text-primary hover:border-border-strong hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
                    }
                    onClick={onOpenProjects}
                    type="button"
                >
                    <FolderIcon />
                    Open existing project
                </button>
            </div>
        </div>
    );
}
