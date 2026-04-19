import {
    useState,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
} from "react";

import {
    COMPOSER_PROJECT_ENTRY_MIME,
    parseComposerProjectEntryDragData,
} from "@renderer/app/drag-and-drop";

import type { GitTreeDragData, GitTreeNode } from "./types";
import { canDropProjectEntryIntoDirectory } from "./tree-dnd";
import {
    BASE_PADDING,
    ChevronIcon,
    FONT_SIZE,
    FolderIcon,
    INDENT_STEP,
    ROW_HEIGHT,
    scalePx,
    TreeIndentGuides,
} from "./GitTreeView";
import type { StickyFolder } from "./useStickyFolders";

const STICKY_CONTAINER_STYLE: CSSProperties = {
    position: "sticky",
    top: 0,
    height: 0,
    overflow: "visible",
    zIndex: 10,
    pointerEvents: "none",
};

function stickyChrome(scrollLeft: number): CSSProperties {
    return {
        left: scrollLeft - 8,
        width: "calc(100% + 16px)",
        boxSizing: "border-box",
        overflow: "hidden",
    };
}

const STICKY_EDGE_SHADOW = "0 2px 6px rgba(0,0,0,0.18)";

export function StickyFolderOverlay({
    stickyFolders,
    scrollLeft = 0,
    enableNodeDrag = false,
    onToggleDirectory,
    onNodeClick,
    onNodeDragStart,
    onNodeDrop,
    selectedPaths,
}: {
    readonly stickyFolders: readonly StickyFolder[];
    readonly scrollLeft?: number;
    readonly enableNodeDrag?: boolean;
    readonly onToggleDirectory?: (node: GitTreeNode) => void;
    readonly onNodeClick?: (
        node: GitTreeNode,
        event: ReactMouseEvent<HTMLDivElement>,
    ) => void;
    readonly onNodeDragStart?: (
        node: GitTreeNode,
        dataTransfer: DataTransfer | null,
    ) => void;
    readonly onNodeDrop?: (
        dragData: GitTreeDragData,
        node: GitTreeNode,
    ) => void;
    readonly selectedPaths?: ReadonlySet<string>;
}) {
    if (stickyFolders.length === 0) {
        return null;
    }

    return (
        <div style={STICKY_CONTAINER_STYLE}>
            {stickyFolders.map(({ node, depth, top }, i) => (
                <div
                    key={node.path}
                    style={{
                        position: "absolute",
                        top,
                        ...stickyChrome(scrollLeft),
                        zIndex: 20 - depth,
                        background:
                            "color-mix(in srgb, var(--color-bg-primary) var(--vibrancy-opacity, 100%), transparent)",
                        pointerEvents: "auto",
                        ...(i === stickyFolders.length - 1 && {
                            boxShadow: STICKY_EDGE_SHADOW,
                        }),
                    }}
                >
                    <StickyFolderRow
                        node={node}
                        depth={depth}
                        enableDrag={enableNodeDrag}
                        onToggle={onToggleDirectory}
                        onNodeClick={onNodeClick}
                        onDragStart={onNodeDragStart}
                        onDrop={onNodeDrop}
                        selectedPaths={selectedPaths}
                    />
                </div>
            ))}
        </div>
    );
}

function StickyFolderRow({
    node,
    depth,
    enableDrag,
    onToggle,
    onNodeClick,
    onDragStart,
    onDrop,
    selectedPaths,
}: {
    readonly node: GitTreeNode;
    readonly depth: number;
    readonly enableDrag?: boolean;
    readonly onToggle?: (node: GitTreeNode) => void;
    readonly onNodeClick?: (
        node: GitTreeNode,
        event: ReactMouseEvent<HTMLDivElement>,
    ) => void;
    readonly onDragStart?: (
        node: GitTreeNode,
        dataTransfer: DataTransfer | null,
    ) => void;
    readonly onDrop?: (dragData: GitTreeDragData, node: GitTreeNode) => void;
    readonly selectedPaths?: ReadonlySet<string>;
}) {
    const [isDropTarget, setIsDropTarget] = useState(false);
    const isDraggable = enableDrag === true && !node.isProjectRoot;
    const isSelected = selectedPaths?.has(node.path) === true;

    const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
        const hasSelectionModifier =
            event.metaKey || event.ctrlKey || event.shiftKey;

        if (hasSelectionModifier && onNodeClick) {
            onNodeClick(node, event);
            return;
        }

        onNodeClick?.(node, event);
        onToggle?.(node);
    };

    return (
        <div
            className="git-tree-row"
            data-drop-target={isDropTarget ? "true" : "false"}
            data-selected={isSelected ? "true" : "false"}
            draggable={isDraggable}
            style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: scalePx(6),
                height: scalePx(ROW_HEIGHT),
                paddingLeft: scalePx(BASE_PADDING + depth * INDENT_STEP + 8),
                paddingRight: scalePx(8),
                fontSize: scalePx(FONT_SIZE),
                cursor: isDraggable || onToggle ? "pointer" : "default",
                color: "var(--color-text-secondary)",
                width: "100%",
                boxSizing: "border-box",
                borderRadius: scalePx(4),
                ...(isDropTarget && {
                    backgroundColor:
                        "color-mix(in srgb, var(--color-accent) 14%, transparent)",
                    boxShadow:
                        "inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent)",
                }),
                ...(!isDropTarget &&
                    isSelected && {
                        backgroundColor:
                            "color-mix(in srgb, var(--color-accent) 10%, transparent)",
                        boxShadow:
                            "inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 22%, transparent)",
                    }),
            }}
            onClick={handleClick}
            onDragStart={(event) => {
                if (!isDraggable) return;
                onDragStart?.(node, event.dataTransfer ?? null);
            }}
            onDragOver={(event) => {
                if (!onDrop) return;

                const dragData = parseComposerProjectEntryDragData(
                    event.dataTransfer.getData(COMPOSER_PROJECT_ENTRY_MIME),
                );
                const canAccept = canDropProjectEntryIntoDirectory(
                    dragData,
                    node.isProjectRoot ? null : node.path,
                );
                if (!canAccept) return;

                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setIsDropTarget(true);
            }}
            onDragLeave={(event) => {
                if (
                    event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                    )
                ) {
                    return;
                }
                setIsDropTarget(false);
            }}
            onDrop={(event) => {
                setIsDropTarget(false);
                if (!onDrop) return;

                const dragData = parseComposerProjectEntryDragData(
                    event.dataTransfer.getData(COMPOSER_PROJECT_ENTRY_MIME),
                );
                if (
                    !canDropProjectEntryIntoDirectory(
                        dragData,
                        node.isProjectRoot ? null : node.path,
                    )
                ) {
                    return;
                }

                event.preventDefault();
                onDrop(dragData, node);
            }}
        >
            <TreeIndentGuides depth={depth} />
            <ChevronIcon open />
            <FolderIcon color="var(--color-text-secondary)" open />
            <span
                style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    flex: 1,
                    minWidth: 0,
                }}
            >
                {node.name}
            </span>
        </div>
    );
}
