import type { RefCallback, UIEventHandler } from "react";

import type { ProjectSummary } from "@shared/ipc";

import {
    GitTreeView,
    type GitTreeNode,
    type GitTreeViewProps,
} from "@renderer/components/git";
import { StickyFolderOverlay } from "@renderer/components/git/StickyFolderOverlay";
import type { StickyFolder } from "@renderer/components/git/useStickyFolders";

export interface FileExplorerInlineEditorState {
    readonly draftName: string;
    readonly kind: "directory" | "file";
    readonly originalName: string;
    readonly path: string;
}

interface FileExplorerPanelProps {
    readonly activeFilePath: string | null;
    readonly contextTargetResetSignal: number;
    readonly expandedPaths: readonly string[];
    readonly inlineEditor: FileExplorerInlineEditorState | null;
    readonly isFiltering: boolean;
    readonly onBackgroundContextMenu: NonNullable<
        GitTreeViewProps["onBackgroundContextMenu"]
    >;
    readonly onBackgroundDrop: NonNullable<GitTreeViewProps["onBackgroundDrop"]>;
    readonly onClearSelection: () => void;
    readonly onEditingCancel: () => void;
    readonly onEditingDraftNameChange: (value: string) => void;
    readonly onEditingSubmit: () => void;
    readonly onExternalFilesDrop: NonNullable<
        GitTreeViewProps["onExternalFilesDrop"]
    >;
    readonly onNodeClick: NonNullable<GitTreeViewProps["onNodeClick"]>;
    readonly onNodeContextMenu: NonNullable<
        GitTreeViewProps["onNodeContextMenu"]
    >;
    readonly onNodeDragStart: NonNullable<
        GitTreeViewProps["onNodeDragStart"]
    >;
    readonly onNodeDrop: NonNullable<GitTreeViewProps["onNodeDrop"]>;
    readonly onScroll: UIEventHandler<HTMLDivElement>;
    readonly onScrollToPathConsumed: () => void;
    readonly onToggleDirectory: NonNullable<
        GitTreeViewProps["onToggleDirectory"]
    >;
    readonly project: ProjectSummary | null;
    readonly revealPath: string | null;
    readonly revealSignal: number | null;
    readonly scrollRef: RefCallback<HTMLDivElement>;
    readonly selectedPaths: ReadonlySet<string>;
    readonly stickyFolderPaths: ReadonlySet<string>;
    readonly stickyFolders: readonly StickyFolder[];
    readonly stickyFoldersEnabled: boolean;
    readonly suppressKeyboardCursor: boolean;
    readonly treeNodes: readonly GitTreeNode[];
}

export function FileExplorerPanel({
    activeFilePath,
    contextTargetResetSignal,
    expandedPaths,
    inlineEditor,
    isFiltering,
    onBackgroundContextMenu,
    onBackgroundDrop,
    onClearSelection,
    onEditingCancel,
    onEditingDraftNameChange,
    onEditingSubmit,
    onExternalFilesDrop,
    onNodeClick,
    onNodeContextMenu,
    onNodeDragStart,
    onNodeDrop,
    onScroll,
    onScrollToPathConsumed,
    onToggleDirectory,
    project,
    revealPath,
    revealSignal,
    scrollRef,
    selectedPaths,
    stickyFolderPaths,
    stickyFolders,
    stickyFoldersEnabled,
    suppressKeyboardCursor,
    treeNodes,
}: FileExplorerPanelProps) {
    return (
        <div
            ref={scrollRef}
            className="shell-scrollbar flex-1 overflow-y-auto px-2 py-2"
            data-workspace-inspector-panel="files"
            onClick={(event) => {
                if (
                    event.target instanceof HTMLElement &&
                    event.target.closest(".git-tree-row")
                ) {
                    return;
                }

                onClearSelection();
            }}
            onScroll={onScroll}
        >
            {project ? (
                <>
                    {!isFiltering && stickyFoldersEnabled ? (
                        <StickyFolderOverlay
                            enableNodeDrag
                            onExternalFilesDrop={onExternalFilesDrop}
                            onNodeClick={onNodeClick}
                            onNodeDragStart={onNodeDragStart}
                            onNodeDrop={onNodeDrop}
                            onToggleDirectory={onToggleDirectory}
                            selectedPaths={selectedPaths}
                            stickyFolders={stickyFolders}
                        />
                    ) : null}
                    <GitTreeView
                        activePath={activeFilePath}
                        contextTargetResetSignal={contextTargetResetSignal}
                        editingDraftName={inlineEditor?.draftName ?? null}
                        editingPath={inlineEditor?.path ?? null}
                        emptyState={isFiltering ? null : undefined}
                        enableNodeDrag
                        expandedPaths={expandedPaths}
                        layout="tree"
                        nodes={treeNodes}
                        onBackgroundContextMenu={onBackgroundContextMenu}
                        onBackgroundDrop={
                            isFiltering ? undefined : onBackgroundDrop
                        }
                        onEditingCancel={onEditingCancel}
                        onEditingDraftNameChange={onEditingDraftNameChange}
                        onEditingSubmit={onEditingSubmit}
                        onExternalFilesDrop={
                            isFiltering ? undefined : onExternalFilesDrop
                        }
                        onNodeClick={onNodeClick}
                        onNodeContextMenu={onNodeContextMenu}
                        onNodeDragStart={onNodeDragStart}
                        onNodeDrop={onNodeDrop}
                        onScrollToPathConsumed={onScrollToPathConsumed}
                        onToggleDirectory={
                            isFiltering ? undefined : onToggleDirectory
                        }
                        scrollToPath={revealPath}
                        scrollToPathSignal={revealSignal ?? undefined}
                        selectedPaths={selectedPaths}
                        showStatusIndicator={false}
                        stickyFolderPaths={stickyFolderPaths}
                        suppressKeyboardCursor={suppressKeyboardCursor}
                    />
                </>
            ) : (
                <InspectorUnavailableState />
            )}
        </div>
    );
}

function InspectorUnavailableState() {
    return (
        <div className="px-3 py-4 text-xs text-text-secondary" role="status">
            Choose a workspace to browse its files.
        </div>
    );
}
