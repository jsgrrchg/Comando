import {
    useRef,
    useState,
    type DragEvent as ReactDragEvent,
    type MouseEvent as ReactMouseEvent,
} from "react";
import {
    COMPOSER_PROJECT_ENTRY_MIME,
    parseComposerProjectEntryDragData,
} from "@renderer/app/drag-and-drop";
import { useSettingsStore } from "@renderer/app/store/settings-store";

import { GitEmptyState } from "./GitUi";
import { GitTreeView } from "./GitTreeView";
import { StickyFolderOverlay } from "./StickyFolderOverlay";
import type { GitFilesViewProps } from "./types";
import { useStickyFolders } from "./useStickyFolders";

export function GitFilesView({
    className,
    emptyState,
    ...treeProps
}: GitFilesViewProps) {
    const [isRootDropActive, setIsRootDropActive] = useState(false);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const stickyFoldersEnabled = useSettingsStore(
        (state) => state.appearance.stickyFoldersEnabled,
    );
    const { stickyFolders, stickyFolderPaths, scrollLeft } = useStickyFolders({
        scrollContainerRef: scrollRef,
        nodes: treeProps.nodes,
        expandedPaths: treeProps.expandedPaths,
        layout: treeProps.layout ?? "tree",
        enabled: stickyFoldersEnabled,
    });

    if (treeProps.nodes.length === 0) {
        return (
            <GitEmptyState className={className}>
                {emptyState ?? "No files to show."}
            </GitEmptyState>
        );
    }

    return (
        <div
            ref={scrollRef}
            className={[
                "min-h-0 flex-1 overflow-y-auto px-2 py-2",
                isRootDropActive
                    ? "rounded-md bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg-panel))] outline-1 outline-[color-mix(in_srgb,var(--color-accent)_55%,transparent)]"
                    : "",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
            onDragLeave={(event: ReactDragEvent<HTMLDivElement>) => {
                if (
                    event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                    )
                ) {
                    return;
                }

                setIsRootDropActive(false);
            }}
            onDragOver={(event: ReactDragEvent<HTMLDivElement>) => {
                if (
                    !treeProps.onBackgroundDrop ||
                    isEventInsideTreeRow(event.target)
                ) {
                    return;
                }

                const dragData = parseComposerProjectEntryDragData(
                    event.dataTransfer.getData(COMPOSER_PROJECT_ENTRY_MIME),
                );
                if (
                    !dragData ||
                    getParentRelativePath(dragData.relativePath) === null
                ) {
                    return;
                }

                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setIsRootDropActive(true);
            }}
            onDrop={(event: ReactDragEvent<HTMLDivElement>) => {
                if (
                    !treeProps.onBackgroundDrop ||
                    isEventInsideTreeRow(event.target)
                ) {
                    return;
                }

                setIsRootDropActive(false);
                const dragData = parseComposerProjectEntryDragData(
                    event.dataTransfer.getData(COMPOSER_PROJECT_ENTRY_MIME),
                );
                if (
                    !dragData ||
                    getParentRelativePath(dragData.relativePath) === null
                ) {
                    return;
                }

                event.preventDefault();
                treeProps.onBackgroundDrop(dragData);
            }}
            onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
                if (
                    !treeProps.onBackgroundContextMenu ||
                    isEventInsideTreeRow(event.target)
                ) {
                    return;
                }

                event.preventDefault();
                treeProps.onBackgroundContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                });
            }}
        >
            <StickyFolderOverlay
                stickyFolders={stickyFolders}
                scrollLeft={scrollLeft}
                enableNodeDrag={treeProps.enableNodeDrag}
                onToggleDirectory={treeProps.onToggleDirectory}
                onNodeDragStart={treeProps.onNodeDragStart}
                onNodeDrop={treeProps.onNodeDrop}
            />
            <GitTreeView {...treeProps} stickyFolderPaths={stickyFolderPaths} />
        </div>
    );
}

function isEventInsideTreeRow(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        Boolean(target.closest(".git-tree-row"))
    );
}

function getParentRelativePath(relativePath: string): string | null {
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.length <= 1) {
        return null;
    }

    return segments.slice(0, -1).join("/");
}
