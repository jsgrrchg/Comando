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
import {
    ContextMenu,
    type ContextMenuState,
} from "./context-menu/ContextMenu";
import {
    projectAvatarColor,
    projectAvatarInitial,
} from "./projectAvatar";
import { SidebarGitScopePicker } from "./sidebar/SidebarGitScopePicker";
import { useProjectContextTabDrag } from "./useProjectContextTabDrag";

export type { ProjectContextMenuProject } from "./ProjectContextMenu";

export interface ProjectContextTabItem {
    readonly key: string;
    readonly projectId: string;
    readonly projectName: string;
    readonly worktreeId: string | null;
    readonly worktreeLabel: string | null;
}

interface DesktopTopBarProps {
    readonly activeContextKey: string | null;
    readonly contexts: readonly ProjectContextTabItem[];
    readonly leftSidebarCollapsed: boolean;
    readonly menuProjects: readonly ProjectContextMenuProject[];
    readonly onActivateContext: (contextKey: string) => void;
    readonly onCloneRepository: (repositoryUrl: string) => Promise<boolean>;
    readonly onCloseContext: (contextKey: string) => void;
    readonly onMoveContextToNewWindow: (contextKey: string) => void;
    readonly onOpenProject: (projectId: string) => void;
    readonly onOpenProjects: () => void;
    readonly onOpenSettings: (initialCategory?: "updates") => void;
    readonly onOpenWorktree: (projectId: string, worktreeId: string) => void;
    readonly onReorderContext: (
        contextKey: string,
        targetIndex: number,
    ) => Promise<void> | void;
    readonly onToggleLeftSidebar: () => void;
    readonly platform: string | null;
    readonly settingsLabel: string | null;
}

export function DesktopTopBar({
    activeContextKey,
    contexts,
    leftSidebarCollapsed,
    menuProjects,
    onActivateContext,
    onCloneRepository,
    onCloseContext,
    onMoveContextToNewWindow,
    onOpenProject,
    onOpenProjects,
    onOpenSettings,
    onOpenWorktree,
    onReorderContext,
    onToggleLeftSidebar,
    platform,
    settingsLabel,
}: DesktopTopBarProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<ProjectContextTabItem> | null>(null);
    const menuRootRef = useRef<HTMLDivElement | null>(null);
    const tabsRef = useRef<HTMLDivElement | null>(null);
    const contextTabDrag = useProjectContextTabDrag({
        contextKeys: contexts.map((context) => context.key),
        onReorder: onReorderContext,
        stripRef: tabsRef,
    });

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
                    height="14"
                    viewBox="0 0 14 14"
                    width="14"
                >
                    <rect
                        height="9"
                        rx="1.3"
                        stroke="currentColor"
                        strokeWidth="1.1"
                        width="11"
                        x="1.5"
                        y="2.5"
                    />
                    <path
                        d="M5 3.4v7.2"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeOpacity="0.55"
                        strokeWidth="2.4"
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
                            data-dragging={
                                contextTabDrag.isDragging &&
                                contextTabDrag.draggedContextKey === context.key
                                    ? "true"
                                    : undefined
                            }
                            data-drop-position={
                                contextTabDrag.target?.contextKey === context.key
                                    ? contextTabDrag.target.position
                                    : undefined
                            }
                            data-project-context-tab-key={context.key}
                            key={context.key}
                            onContextMenu={(event) => {
                                event.preventDefault();
                                setMenuOpen(false);
                                setContextMenu({
                                    payload: context,
                                    x: event.clientX,
                                    y: event.clientY,
                                });
                            }}
                            onPointerDown={(event) =>
                                contextTabDrag.beginTabPointerDown(
                                    context.key,
                                    event,
                                )
                            }
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
                                data-project-context-tab-action="true"
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
                        onCloneRepository={onCloneRepository}
                        onClose={() => setMenuOpen(false)}
                        onOpenProject={onOpenProject}
                        onOpenProjects={onOpenProjects}
                        onOpenSettings={onOpenSettings}
                        onOpenWorktree={onOpenWorktree}
                        projects={menuProjects}
                        settingsLabel={settingsLabel}
                    />
                )}
            </div>
            {contextMenu ? (
                <ContextMenu
                    entries={[
                        {
                            action: () =>
                                onMoveContextToNewWindow(
                                    contextMenu.payload.key,
                                ),
                            label: "Move to New Window",
                        },
                        { type: "separator" },
                        {
                            action: () =>
                                onCloseContext(contextMenu.payload.key),
                            danger: true,
                            label: "Close",
                        },
                    ]}
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                />
            ) : null}
            <div className="min-w-4 flex-1" />
        </header>
    );
}
