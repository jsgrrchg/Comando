import { useState, type CSSProperties, type ReactNode } from "react";

import {
    COMPOSER_PROJECT_ENTRY_MIME,
    parseComposerProjectEntryDragData,
} from "@renderer/app/drag-and-drop";

import { FileTypeIcon } from "@renderer/components/icons/FileTypeIcon";

import { GitActionButton, GitEmptyState } from "./GitUi";
import type {
    GitTreeDragData,
    GitNodeStatus,
    GitTreeNode,
    GitTreeViewProps,
    GitViewLayout,
} from "./types";

const ROW_HEIGHT = 28;
const FONT_SIZE = 12;
const INDENT_STEP = 16;
const BASE_PADDING = 8;
const ICON_SM = 13;
const ICON_MD = 15;

const GUIDE_COLOR = "color-mix(in srgb, var(--color-border) 82%, transparent)";

const ROW_BOX: CSSProperties = {
    width: "max-content",
    minWidth: "100%",
    boxSizing: "border-box",
};

const ROW_BOX_CONSTRAINED: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
};

function scalePx(value: number): string {
    return `calc(${value}px * var(--file-tree-scale, 1))`;
}

export function GitTreeView({
    activePath = null,
    className,
    constrainWidth = false,
    enableNodeDrag = false,
    emptyState,
    expandedPaths,
    layout = "tree",
    nodes,
    onNodeContextMenu,
    onNodeClick,
    onNodeDrop,
    onNodeDragStart,
    onToggleDirectory,
    renderNodeMeta,
    showStatusIndicator = true,
}: GitTreeViewProps) {
    const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

    if (nodes.length === 0) {
        return (
            <GitEmptyState className={className}>
                {emptyState ?? "Nothing to show yet."}
            </GitEmptyState>
        );
    }

    return (
        <div className={className}>
            {nodes.map((node) => (
                <GitTreeNodeRow
                    activePath={activePath}
                    constrainWidth={constrainWidth}
                    depth={0}
                    dropTargetPath={dropTargetPath}
                    enableNodeDrag={enableNodeDrag}
                    expandedPaths={expandedPaths}
                    key={node.id}
                    layout={layout}
                    node={node}
                    onNodeContextMenu={onNodeContextMenu}
                    onNodeClick={onNodeClick}
                    onNodeDrop={onNodeDrop}
                    onNodeDragStart={onNodeDragStart}
                    onToggleDirectory={onToggleDirectory}
                    renderNodeMeta={renderNodeMeta}
                    setDropTargetPath={setDropTargetPath}
                    showStatusIndicator={showStatusIndicator}
                />
            ))}
        </div>
    );
}

function GitTreeNodeRow({
    activePath,
    constrainWidth = false,
    depth,
    dropTargetPath,
    enableNodeDrag,
    expandedPaths,
    layout,
    node,
    onNodeContextMenu,
    onNodeClick,
    onNodeDrop,
    onNodeDragStart,
    onToggleDirectory,
    renderNodeMeta,
    setDropTargetPath,
    showStatusIndicator,
}: {
    readonly activePath: string | null;
    readonly constrainWidth?: boolean;
    readonly depth: number;
    readonly dropTargetPath: string | null;
    readonly enableNodeDrag: boolean;
    readonly expandedPaths: readonly string[] | undefined;
    readonly layout: GitViewLayout;
    readonly node: GitTreeNode;
    readonly onNodeContextMenu?: (
        node: GitTreeNode,
        position: {
            readonly x: number;
            readonly y: number;
        },
    ) => void;
    readonly onNodeClick?: (node: GitTreeNode) => void;
    readonly onNodeDrop?: (
        dragData: GitTreeDragData,
        node: GitTreeNode,
    ) => void;
    readonly onNodeDragStart?: (
        node: GitTreeNode,
        dataTransfer: DataTransfer | null,
    ) => void;
    readonly onToggleDirectory?: (node: GitTreeNode) => void;
    readonly renderNodeMeta?: (node: GitTreeNode) => ReactNode;
    readonly setDropTargetPath: (path: string | null) => void;
    readonly showStatusIndicator: boolean;
}) {
    const isDirectory = node.kind === "directory";
    const isExpanded =
        layout === "tree" && isDirectory
            ? node.isProjectRoot
                ? Boolean(node.children)
                : expandedPaths
                  ? expandedPaths.includes(node.path)
                  : true
            : false;
    const isActive = activePath === node.path;
    const canOpen = Boolean(onNodeClick && node.kind === "file");
    const canToggle = Boolean(isDirectory && onToggleDirectory);
    const isDraggable = enableNodeDrag === true && !node.isProjectRoot;
    const dragStartHandler = onNodeDragStart as
        | ((node: GitTreeNode, dataTransfer: DataTransfer | null) => void)
        | undefined;
    const isDropTarget = dropTargetPath === node.path;
    const statusTint = node.status ? statusColor(node.status) : null;
    const titleColor = statusTint
        ? statusTint
        : isDirectory
          ? "var(--color-text-secondary)"
          : "var(--color-text-primary)";

    const paddingLeft = scalePx(BASE_PADDING + depth * INDENT_STEP);

    return (
        <>
            <div
                className="git-tree-row"
                data-active={isActive ? "true" : "false"}
                data-drop-target={isDropTarget ? "true" : "false"}
                draggable={isDraggable}
                onDragEnd={() => {
                    setDropTargetPath(null);
                }}
                onDragLeave={(event) => {
                    if (
                        event.currentTarget.contains(
                            event.relatedTarget as Node | null,
                        )
                    ) {
                        return;
                    }

                    if (dropTargetPath === node.path) {
                        setDropTargetPath(null);
                    }
                }}
                onDragOver={(event) => {
                    const dragData = getTreeDragData(event.dataTransfer);
                    if (
                        !isDirectory ||
                        !onNodeDrop ||
                        !canDropIntoDirectory(
                            dragData,
                            node.isProjectRoot ? null : node.path,
                        )
                    ) {
                        return;
                    }

                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    if (dropTargetPath !== node.path) {
                        setDropTargetPath(node.path);
                    }
                }}
                onDragStart={(event) => {
                    if (!isDraggable) {
                        return;
                    }

                    dragStartHandler?.(node, event.dataTransfer ?? null);
                }}
                onDrop={(event) => {
                    const dragData = getTreeDragData(event.dataTransfer);
                    setDropTargetPath(null);

                    if (
                        !isDirectory ||
                        !onNodeDrop ||
                        !canDropIntoDirectory(
                            dragData,
                            node.isProjectRoot ? null : node.path,
                        )
                    ) {
                        return;
                    }

                    event.preventDefault();
                    onNodeDrop(dragData, node);
                }}
                onContextMenu={(event) => {
                    if (!onNodeContextMenu) {
                        return;
                    }

                    event.preventDefault();
                    onNodeContextMenu(node, {
                        x: event.clientX,
                        y: event.clientY,
                    });
                }}
                style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    gap: scalePx(6),
                    height: scalePx(ROW_HEIGHT),
                    paddingLeft,
                    paddingRight: scalePx(8),
                    fontSize: scalePx(FONT_SIZE),
                    borderRadius: scalePx(4),
                    cursor: canOpen || canToggle ? "pointer" : "default",
                    color: "var(--color-text-primary)",
                    ...(isActive
                        ? {
                              backgroundColor:
                                  "color-mix(in srgb, var(--color-accent) 22%, transparent)",
                              boxShadow:
                                  "inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 40%, transparent)",
                          }
                        : isDropTarget
                          ? {
                                backgroundColor:
                                    "color-mix(in srgb, var(--color-accent) 14%, transparent)",
                                boxShadow:
                                    "inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent)",
                            }
                          : {}),
                    ...(constrainWidth ? ROW_BOX_CONSTRAINED : ROW_BOX),
                }}
                onClick={() =>
                    canOpen
                        ? onNodeClick?.(node)
                        : canToggle
                          ? onToggleDirectory?.(node)
                          : undefined
                }
            >
                <TreeIndentGuides depth={depth} />

                {isDirectory && layout === "tree" ? (
                    <ChevronIcon open={isExpanded} />
                ) : (
                    <span style={{ width: scalePx(ICON_SM), flexShrink: 0 }} />
                )}

                {isDirectory ? (
                    <FolderIcon
                        color={statusTint ?? "var(--color-text-secondary)"}
                        open={isExpanded}
                    />
                ) : (
                    <FileTypeIcon
                        color={statusTint ?? undefined}
                        fileName={node.name}
                        scaled
                        size={ICON_SM}
                    />
                )}

                <span
                    style={{
                        flexShrink: constrainWidth ? 1 : 0,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        minWidth: constrainWidth ? scalePx(40) : 0,
                        flex: 1,
                        color: titleColor,
                    }}
                >
                    {node.name}
                </span>

                {!constrainWidth && node.secondaryText ? (
                    <span
                        style={{
                            fontSize: scalePx(11),
                            color: "var(--color-text-secondary)",
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                        }}
                    >
                        {node.secondaryText}
                    </span>
                ) : null}

                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: scalePx(4),
                        flexShrink: 0,
                        marginLeft: "auto",
                    }}
                >
                    {renderNodeMeta ? renderNodeMeta(node) : node.meta}

                    {showStatusIndicator &&
                    !constrainWidth &&
                    node.status &&
                    !isDirectory ? (
                        <StatusIndicator status={node.status} />
                    ) : null}

                    {!constrainWidth && node.actions?.length ? (
                        <div
                            className="git-tree-row-actions"
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: scalePx(4),
                            }}
                        >
                            {node.actions.map((action) => (
                                <GitActionButton
                                    action={action}
                                    key={action.id}
                                />
                            ))}
                        </div>
                    ) : null}
                </div>
            </div>

            {layout === "tree" &&
            isDirectory &&
            isExpanded &&
            node.children?.length
                ? node.children.map((child) => (
                      <GitTreeNodeRow
                          activePath={activePath}
                          constrainWidth={constrainWidth}
                          depth={depth + 1}
                          dropTargetPath={dropTargetPath}
                          enableNodeDrag={enableNodeDrag}
                          expandedPaths={expandedPaths}
                          key={child.id}
                          layout={layout}
                          node={child}
                          onNodeContextMenu={onNodeContextMenu}
                          onNodeClick={onNodeClick}
                          onNodeDrop={onNodeDrop}
                          onNodeDragStart={dragStartHandler}
                          onToggleDirectory={onToggleDirectory}
                          renderNodeMeta={renderNodeMeta}
                          setDropTargetPath={setDropTargetPath}
                          showStatusIndicator={showStatusIndicator}
                      />
                  ))
                : null}
        </>
    );
}

function getTreeDragData(
    dataTransfer: DataTransfer | null,
): GitTreeDragData | null {
    if (!dataTransfer) {
        return null;
    }

    const parsed = parseComposerProjectEntryDragData(
        dataTransfer.getData(COMPOSER_PROJECT_ENTRY_MIME),
    );
    if (!parsed) {
        return null;
    }

    return {
        kind: parsed.kind,
        name: parsed.name,
        relativePath: parsed.relativePath,
    };
}

function canDropIntoDirectory(
    dragData: GitTreeDragData | null,
    directoryPath: string | null,
): dragData is GitTreeDragData {
    if (!dragData) {
        return false;
    }

    const currentParentPath = getParentRelativePath(dragData.relativePath);
    if (currentParentPath === directoryPath) {
        return false;
    }

    if (dragData.kind === "directory") {
        return (
            dragData.relativePath !== directoryPath &&
            !(directoryPath ?? "").startsWith(`${dragData.relativePath}/`)
        );
    }

    return true;
}

function getParentRelativePath(relativePath: string): string | null {
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.length <= 1) {
        return null;
    }

    return segments.slice(0, -1).join("/");
}

// --- Icons ---

function ChevronIcon({
    open,
    size = ICON_SM,
}: {
    open: boolean;
    size?: number | string;
}) {
    return (
        <svg
            width={typeof size === "number" ? scalePx(size) : size}
            height={typeof size === "number" ? scalePx(size) : size}
            viewBox="0 0 16 16"
            fill="currentColor"
            style={{
                transform: open ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 120ms ease",
                flexShrink: 0,
                opacity: 0.5,
            }}
        >
            <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function FolderIcon({
    color = "var(--color-text-secondary)",
    open,
    size = ICON_MD,
}: {
    color?: string;
    open: boolean;
    size?: number | string;
}) {
    const fill = color;
    if (open) {
        return (
            <svg
                width={typeof size === "number" ? scalePx(size) : size}
                height={typeof size === "number" ? scalePx(size) : size}
                viewBox="0 0 16 16"
                fill="none"
                style={{ flexShrink: 0 }}
            >
                <path
                    d="M1.5 3.5A1 1 0 0 1 2.5 2.5H6l1.5 1.5h5a1 1 0 0 1 1 1V5H2.5V3.5Z"
                    fill={fill}
                    opacity="0.85"
                />
                <path
                    d="M1 5.5h13l-1.5 7.5H2.5L1 5.5Z"
                    fill={fill}
                    opacity="0.65"
                />
            </svg>
        );
    }
    return (
        <svg
            width={typeof size === "number" ? scalePx(size) : size}
            height={typeof size === "number" ? scalePx(size) : size}
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0 }}
        >
            <path
                d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3Z"
                fill={fill}
                opacity="0.65"
            />
        </svg>
    );
}

// --- Tree guides ---

function TreeIndentGuides({ depth }: { depth: number }) {
    if (depth <= 0) return null;

    return (
        <span
            aria-hidden="true"
            style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
            }}
        >
            {Array.from({ length: depth }, (_, level) => {
                const x =
                    BASE_PADDING +
                    Math.round(level * INDENT_STEP + INDENT_STEP / 2);
                return (
                    <span
                        key={level}
                        style={{
                            position: "absolute",
                            left: scalePx(x),
                            top: 0,
                            bottom: 0,
                            width: 1,
                            backgroundColor: GUIDE_COLOR,
                        }}
                    />
                );
            })}
        </span>
    );
}

// --- Status ---

function StatusIndicator({ status }: { status: GitNodeStatus }) {
    const letter = statusLetter(status);
    const color = statusColor(status);
    return (
        <span
            style={{
                fontSize: scalePx(10),
                fontWeight: 600,
                lineHeight: 1,
                color,
                width: scalePx(14),
                textAlign: "center",
                flexShrink: 0,
            }}
        >
            {letter}
        </span>
    );
}

function statusLetter(status: GitNodeStatus): string {
    switch (status) {
        case "added":
            return "A";
        case "modified":
            return "M";
        case "deleted":
            return "D";
        case "renamed":
            return "R";
        case "untracked":
            return "U";
        case "conflict":
            return "C";
        case "staged":
            return "S";
        case "mixed":
            return "±";
        case "clean":
        default:
            return "";
    }
}

function statusColor(status: GitNodeStatus): string {
    switch (status) {
        case "added":
        case "staged":
            return "var(--diff-add)";
        case "modified":
        case "renamed":
        case "mixed":
            return "var(--diff-warn)";
        case "deleted":
        case "conflict":
            return "var(--diff-remove)";
        case "untracked":
            return "var(--color-accent)";
        case "clean":
        default:
            return "var(--color-text-secondary)";
    }
}
