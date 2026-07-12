import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from "react";

import type { SidebarAgentFolder } from "./sidebarAgentsFolderState";

export interface EditingSidebarAgentFolder {
    readonly folderId: string;
    readonly name: string;
}

type FolderReorderTarget = {
    readonly folderId: string;
    readonly position: "after" | "before";
};

const FOLDER_DRAG_THRESHOLD_PX = 6;

export function SidebarAgentsFolderList({
    collapsedFolderIds,
    dragOverFolderId,
    editingFolder,
    folders,
    getFolderGroupCount,
    onCommitFolderRename,
    onEditingFolderChange,
    onFolderContextMenu,
    onReorderFolder,
    onToggleFolder,
    renderFolderContents,
}: {
    readonly collapsedFolderIds: readonly string[];
    readonly dragOverFolderId: string | null;
    readonly editingFolder: EditingSidebarAgentFolder | null;
    readonly folders: readonly SidebarAgentFolder[];
    readonly getFolderGroupCount: (folderId: string) => number;
    readonly onCommitFolderRename: () => void;
    readonly onEditingFolderChange: (
        folder: EditingSidebarAgentFolder | null,
    ) => void;
    readonly onFolderContextMenu: (
        event: ReactMouseEvent,
        folder: SidebarAgentFolder,
    ) => void;
    readonly onReorderFolder: (
        folderId: string,
        destinationIndex: number,
    ) => void;
    readonly onToggleFolder: (folderId: string) => void;
    readonly renderFolderContents: (
        folder: SidebarAgentFolder,
    ) => ReactNode;
}) {
    const folderDragRef = useRef<{
        readonly folderId: string;
        readonly folderIds: readonly string[];
        readonly pointerId: number;
        readonly startX: number;
        readonly startY: number;
        active: boolean;
    } | null>(null);
    const dragCleanupRef = useRef<(() => void) | null>(null);
    const suppressClickRef = useRef(false);
    const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
    const [reorderTarget, setReorderTarget] =
        useState<FolderReorderTarget | null>(null);

    const clearDrag = useCallback(() => {
        folderDragRef.current = null;
        dragCleanupRef.current?.();
        dragCleanupRef.current = null;
        setDraggedFolderId(null);
        setReorderTarget(null);
    }, []);

    useEffect(
        () => () => {
            dragCleanupRef.current?.();
            dragCleanupRef.current = null;
        },
        [],
    );

    const handlePointerDown = useCallback(
        (event: ReactPointerEvent<HTMLElement>, folderId: string) => {
            if (
                event.button !== 0 ||
                editingFolder?.folderId === folderId ||
                (event.target instanceof Element &&
                    Boolean(event.target.closest("button,input")))
            ) {
                return;
            }

            dragCleanupRef.current?.();
            folderDragRef.current = {
                active: false,
                folderId,
                folderIds: folders.map((folder) => folder.id),
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
            };

            const updateTarget = (moveEvent: PointerEvent) => {
                const current = folderDragRef.current;
                if (!current || current.pointerId !== moveEvent.pointerId) {
                    return;
                }
                if (!current.active) {
                    if (
                        Math.hypot(
                            moveEvent.clientX - current.startX,
                            moveEvent.clientY - current.startY,
                        ) < FOLDER_DRAG_THRESHOLD_PX
                    ) {
                        return;
                    }
                    current.active = true;
                    setDraggedFolderId(current.folderId);
                }

                moveEvent.preventDefault();
                const header = getFolderHeaderAtPoint(
                    moveEvent.clientX,
                    moveEvent.clientY,
                );
                const targetFolderId = header?.dataset.agentFolderHeader;
                if (!targetFolderId || targetFolderId === current.folderId) {
                    setReorderTarget(null);
                    return;
                }
                const rect = header.getBoundingClientRect();
                setReorderTarget({
                    folderId: targetFolderId,
                    position:
                        moveEvent.clientY < rect.top + rect.height / 2
                            ? "before"
                            : "after",
                });
            };

            const finish = (upEvent: PointerEvent, cancelled = false) => {
                const current = folderDragRef.current;
                if (!current || current.pointerId !== upEvent.pointerId) {
                    return;
                }
                const header = getFolderHeaderAtPoint(
                    upEvent.clientX,
                    upEvent.clientY,
                );
                const targetFolderId = header?.dataset.agentFolderHeader;
                const rect = header?.getBoundingClientRect();
                const finalTarget =
                    targetFolderId &&
                    targetFolderId !== current.folderId &&
                    rect
                        ? {
                              folderId: targetFolderId,
                              position:
                                  upEvent.clientY < rect.top + rect.height / 2
                                      ? ("before" as const)
                                      : ("after" as const),
                          }
                        : null;
                const wasActive = current.active;
                clearDrag();
                if (!wasActive || cancelled || !finalTarget) {
                    return;
                }

                const remainingIds = current.folderIds.filter(
                    (candidateId) => candidateId !== current.folderId,
                );
                const targetIndex = remainingIds.indexOf(
                    finalTarget.folderId,
                );
                if (targetIndex < 0) {
                    return;
                }
                onReorderFolder(
                    current.folderId,
                    targetIndex + (finalTarget.position === "after" ? 1 : 0),
                );
                suppressClickRef.current = true;
                window.requestAnimationFrame(() => {
                    suppressClickRef.current = false;
                });
            };

            const handlePointerMove = (moveEvent: PointerEvent) =>
                updateTarget(moveEvent);
            const handlePointerUp = (upEvent: PointerEvent) => finish(upEvent);
            const handlePointerCancel = (cancelEvent: PointerEvent) =>
                finish(cancelEvent, true);
            window.addEventListener("pointermove", handlePointerMove);
            window.addEventListener("pointerup", handlePointerUp);
            window.addEventListener("pointercancel", handlePointerCancel);
            dragCleanupRef.current = () => {
                window.removeEventListener("pointermove", handlePointerMove);
                window.removeEventListener("pointerup", handlePointerUp);
                window.removeEventListener(
                    "pointercancel",
                    handlePointerCancel,
                );
            };
        },
        [clearDrag, editingFolder?.folderId, folders, onReorderFolder],
    );

    return folders.map((folder) => {
        const collapsed = collapsedFolderIds.includes(folder.id);
        const isRenaming = editingFolder?.folderId === folder.id;
        const reorderPosition =
            reorderTarget?.folderId === folder.id
                ? reorderTarget.position
                : null;
        const groupCount = getFolderGroupCount(folder.id);

        return (
            <section
                className="sidebar-agents-folder mt-1 rounded"
                data-agent-folder-id={folder.id}
                data-dragging={
                    draggedFolderId === folder.id ? "true" : "false"
                }
                data-drop-target={
                    dragOverFolderId === folder.id ? "true" : "false"
                }
                data-reorder-position={reorderPosition ?? undefined}
                key={folder.id}
            >
                <div
                    aria-expanded={!collapsed}
                    className="sidebar-agents-folder-header flex items-center gap-1.5 px-2 text-left font-semibold uppercase tracking-[0.09em] text-text-secondary/80"
                    data-agent-folder-header={folder.id}
                    onClick={() => {
                        if (!suppressClickRef.current) {
                            onToggleFolder(folder.id);
                        }
                    }}
                    onContextMenu={(event) =>
                        onFolderContextMenu(event, folder)
                    }
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onToggleFolder(folder.id);
                        }
                    }}
                    onPointerDown={(event) =>
                        handlePointerDown(event, folder.id)
                    }
                    role="button"
                    tabIndex={0}
                    title={collapsed ? "Expand folder" : "Collapse folder"}
                >
                    <FolderChevronIcon collapsed={collapsed} />
                    <FolderIcon />
                    {isRenaming && editingFolder ? (
                        <input
                            aria-label="Folder name"
                            autoFocus
                            className="sidebar-agents-folder-rename min-w-0 flex-1 rounded border border-accent bg-bg-primary px-1 py-0.5 font-semibold normal-case tracking-normal text-text-primary outline-none"
                            onBlur={onCommitFolderRename}
                            onChange={(event) =>
                                onEditingFolderChange({
                                    ...editingFolder,
                                    name: event.target.value,
                                })
                            }
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                                event.stopPropagation();
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    onCommitFolderRename();
                                } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    onEditingFolderChange(null);
                                }
                            }}
                            value={editingFolder.name}
                        />
                    ) : (
                        <span className="min-w-0 flex-1 truncate">
                            {folder.name}
                        </span>
                    )}
                    <span className="font-normal text-text-secondary/60">
                        {groupCount}
                    </span>
                </div>

                {!collapsed ? (
                    <div
                        className="sidebar-agents-folder-contents min-w-0"
                        data-agent-folder-contents={folder.id}
                    >
                        {groupCount > 0 ? (
                            renderFolderContents(folder)
                        ) : (
                            <p className="sidebar-agents-folder-empty px-3 py-1 text-text-secondary">
                                Drop threads here from their menu.
                            </p>
                        )}
                    </div>
                ) : null}
            </section>
        );
    });
}

function getFolderHeaderAtPoint(
    clientX: number,
    clientY: number,
): HTMLElement | null {
    if (
        typeof document === "undefined" ||
        typeof document.elementFromPoint !== "function"
    ) {
        return null;
    }
    return (
        document
            .elementFromPoint(clientX, clientY)
            ?.closest<HTMLElement>("[data-agent-folder-header]") ?? null
    );
}

function FolderChevronIcon({ collapsed }: { readonly collapsed: boolean }) {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="11"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
            width="11"
        >
            {collapsed ? (
                <path d="m9 6 6 6-6 6" />
            ) : (
                <path d="m6 9 6 6 6-6" />
            )}
        </svg>
    );
}

function FolderIcon() {
    return (
        <svg
            aria-hidden="true"
            className="sidebar-agents-folder-icon shrink-0"
            fill="none"
            height="12"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
            viewBox="0 0 16 16"
            width="12"
        >
            <path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h3l1.4 1.75h5.1a1.5 1.5 0 0 1 1.5 1.5v5.25a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5Z" />
        </svg>
    );
}
