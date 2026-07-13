import {
    useEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type WheelEvent as ReactWheelEvent,
} from "react";

import {
    ProjectContextMenu,
    type ProjectContextMenuProject,
} from "./ProjectContextMenu";
import { SidebarGitScopePicker } from "./sidebar/SidebarGitScopePicker";

export type { ProjectContextMenuProject } from "./ProjectContextMenu";

export interface ProjectContextTabItem {
    readonly key: string;
    readonly projectId: string;
    readonly projectName: string;
    readonly worktreeId: string | null;
    readonly worktreeLabel: string | null;
}

const PROJECT_AVATAR_HUES = [142, 210, 265, 320, 20, 45, 190, 355] as const;

function projectAvatarColor(projectId: string): string {
    let hash = 0;
    for (let index = 0; index < projectId.length; index += 1) {
        hash = (hash * 31 + projectId.charCodeAt(index)) >>> 0;
    }
    const hue = PROJECT_AVATAR_HUES[hash % PROJECT_AVATAR_HUES.length];
    return `hsl(${hue} 58% 42%)`;
}

function projectAvatarInitial(projectName: string): string {
    return projectName.trim().charAt(0).toUpperCase() || "?";
}

interface DesktopTopBarProps {
    readonly activeContextKey: string | null;
    readonly contexts: readonly ProjectContextTabItem[];
    readonly leftSidebarCollapsed: boolean;
    readonly menuProjects: readonly ProjectContextMenuProject[];
    readonly onActivateContext: (contextKey: string) => void;
    readonly onCloneRepository: (repositoryUrl: string) => Promise<boolean>;
    readonly onCloseContext: (contextKey: string) => void;
    readonly onOpenProject: (projectId: string) => void;
    readonly onOpenProjects: () => void;
    readonly onOpenSettings: () => void;
    readonly onOpenWorktree: (projectId: string, worktreeId: string) => void;
    readonly onToggleLeftSidebar: () => void;
    readonly platform: string | null;
}

export function DesktopTopBar({
    activeContextKey,
    contexts,
    leftSidebarCollapsed,
    menuProjects,
    onActivateContext,
    onCloneRepository,
    onCloseContext,
    onOpenProject,
    onOpenProjects,
    onOpenSettings,
    onOpenWorktree,
    onToggleLeftSidebar,
    platform,
}: DesktopTopBarProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRootRef = useRef<HTMLDivElement | null>(null);
    const tabsRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!menuOpen) {
            return;
        }

        const handlePointerDown = (event: MouseEvent) => {
            if (!menuRootRef.current?.contains(event.target as Node)) {
                setMenuOpen(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setMenuOpen(false);
            }
        };

        document.addEventListener("mousedown", handlePointerDown);
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("mousedown", handlePointerDown);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [menuOpen]);

    const handleTabsWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
        if (!tabsRef.current || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
            return;
        }
        tabsRef.current.scrollLeft += event.deltaY;
        event.preventDefault();
    };

    const handleTabKeyDown = (
        event: ReactKeyboardEvent<HTMLButtonElement>,
        index: number,
    ) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
            return;
        }

        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const targetIndex =
            (index + direction + contexts.length) % contexts.length;
        const target = contexts[targetIndex];
        if (!target) {
            return;
        }
        onActivateContext(target.key);
        requestAnimationFrame(() => {
            document
                .querySelector<HTMLButtonElement>(
                    `[data-project-context-key="${CSS.escape(target.key)}"]`,
                )
                ?.focus();
        });
    };

    return (
        <header
            className="app-drag desktop-titlebar project-context-titlebar relative flex shrink-0 items-center select-none"
            style={{
                height: "var(--desktop-titlebar-height, 40px)",
                paddingLeft: platform === "darwin" ? 84 : 8,
                paddingRight:
                    platform === "win32" || platform === "linux"
                        ? "var(--titlebar-controls-width, 138px)"
                        : 8,
            }}
        >
            <button
                aria-pressed={leftSidebarCollapsed}
                className="sidebar-collapse-toggle sidebar-collapse-toggle--inline app-no-drag"
                onClick={onToggleLeftSidebar}
                style={{ marginRight: 8 }}
                title={leftSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                type="button"
            >
                <svg
                    aria-hidden="true"
                    fill="none"
                    height="16"
                    viewBox="0 0 16 16"
                    width="16"
                >
                    <rect
                        height="11"
                        rx="1.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        width="13"
                        x="1.5"
                        y="2.5"
                    />
                    <line
                        stroke="currentColor"
                        strokeWidth="1.2"
                        x1="5.5"
                        x2="5.5"
                        y1="2.5"
                        y2="13.5"
                    />
                </svg>
            </button>
            <div
                aria-label="Open project workspaces"
                className="project-context-tabs app-no-drag"
                onWheel={handleTabsWheel}
                ref={tabsRef}
                role="tablist"
            >
                {contexts.map((context, index) => {
                    const isActive = context.key === activeContextKey;
                    return (
                        <div
                            className="project-context-tab-shell"
                            data-active={isActive || undefined}
                            key={context.key}
                        >
                            <span
                                aria-hidden="true"
                                className="project-context-tab-icon"
                                style={{
                                    background: projectAvatarColor(
                                        context.projectId,
                                    ),
                                }}
                            >
                                {projectAvatarInitial(context.projectName)}
                            </span>
                            {isActive ? (
                                <SidebarGitScopePicker
                                    onTitlebarKeyDown={(event) =>
                                        handleTabKeyDown(event, index)
                                    }
                                    projectId={context.projectId}
                                    title={context.projectName}
                                    titlebarContextKey={context.key}
                                    triggerVariant="titlebar"
                                    worktreeId={context.worktreeId}
                                />
                            ) : (
                                <button
                                    aria-selected={false}
                                    className="project-context-tab"
                                    data-project-context-key={context.key}
                                    onClick={() => onActivateContext(context.key)}
                                    onKeyDown={(event) =>
                                        handleTabKeyDown(event, index)
                                    }
                                    role="tab"
                                    tabIndex={-1}
                                    title={
                                        context.worktreeLabel
                                            ? `${context.projectName} — ${context.worktreeLabel}`
                                            : context.projectName
                                    }
                                    type="button"
                                >
                                    <span className="project-context-tab-copy">
                                        <span className="project-context-tab-title">
                                            {context.projectName}
                                        </span>
                                        {context.worktreeLabel && (
                                            <span className="project-context-tab-subtitle">
                                                {context.worktreeLabel}
                                            </span>
                                        )}
                                    </span>
                                </button>
                            )}
                            <button
                                aria-label={`Close ${context.projectName}`}
                                className="project-context-tab-close"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onCloseContext(context.key);
                                }}
                                tabIndex={isActive ? 0 : -1}
                                title="Close workspace"
                                type="button"
                            >
                                <svg
                                    aria-hidden="true"
                                    fill="none"
                                    height="10"
                                    viewBox="0 0 12 12"
                                    width="10"
                                >
                                    <path
                                        d="m3 3 6 6M9 3 3 9"
                                        stroke="currentColor"
                                        strokeLinecap="round"
                                        strokeWidth="1.25"
                                    />
                                </svg>
                            </button>
                        </div>
                    );
                })}
            </div>

            <div className="app-no-drag project-context-menu-root" ref={menuRootRef}>
                <button
                    aria-expanded={menuOpen}
                    aria-haspopup="dialog"
                    aria-label="Open project or worktree"
                    className="project-context-add"
                    onClick={() => {
                        setMenuOpen((open) => !open);
                    }}
                    title="Open project or worktree"
                    type="button"
                >
                    <svg
                        aria-hidden="true"
                        fill="none"
                        height="12"
                        viewBox="0 0 14 14"
                        width="12"
                    >
                        <path
                            d="M7 2v10M2 7h10"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeWidth="1.4"
                        />
                    </svg>
                </button>

                {menuOpen && (
                    <ProjectContextMenu
                        anchorLeft={Math.max(
                            8,
                            Math.min(
                                menuRootRef.current?.getBoundingClientRect()
                                    .left ?? 8,
                                window.innerWidth - 348,
                            ),
                        )}
                        onCloneRepository={onCloneRepository}
                        onClose={() => setMenuOpen(false)}
                        onOpenProject={onOpenProject}
                        onOpenProjects={onOpenProjects}
                        onOpenSettings={onOpenSettings}
                        onOpenWorktree={onOpenWorktree}
                        projects={menuProjects}
                    />
                )}
            </div>
            <div className="min-w-4 flex-1" />
        </header>
    );
}
