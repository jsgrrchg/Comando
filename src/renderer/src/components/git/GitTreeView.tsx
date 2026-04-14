import type { CSSProperties, ReactNode } from "react";

import { GitActionButton, GitEmptyState } from "./GitUi";
import type {
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

export function GitTreeView({
    activePath = null,
    className,
    enableNodeDrag = false,
    emptyState,
    expandedPaths,
    layout = "tree",
    nodes,
    onNodeClick,
    onNodeDragStart,
    onToggleDirectory,
    renderNodeMeta,
}: GitTreeViewProps) {
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
                    depth={0}
                    enableNodeDrag={enableNodeDrag}
                    expandedPaths={expandedPaths}
                    key={node.id}
                    layout={layout}
                    node={node}
                    onNodeClick={onNodeClick}
                    onNodeDragStart={onNodeDragStart}
                    onToggleDirectory={onToggleDirectory}
                    renderNodeMeta={renderNodeMeta}
                />
            ))}
        </div>
    );
}

function GitTreeNodeRow({
    activePath,
    depth,
    enableNodeDrag,
    expandedPaths,
    layout,
    node,
    onNodeClick,
    onNodeDragStart,
    onToggleDirectory,
    renderNodeMeta,
}: {
    readonly activePath: string | null;
    readonly depth: number;
    readonly enableNodeDrag: boolean;
    readonly expandedPaths: readonly string[] | undefined;
    readonly layout: GitViewLayout;
    readonly node: GitTreeNode;
    readonly onNodeClick?: (node: GitTreeNode) => void;
    readonly onNodeDragStart?: (
        node: GitTreeNode,
        dataTransfer: DataTransfer | null,
    ) => void;
    readonly onToggleDirectory?: (node: GitTreeNode) => void;
    readonly renderNodeMeta?: (node: GitTreeNode) => ReactNode;
}) {
    const isDirectory = node.kind === "directory";
    const isExpanded =
        layout === "tree" && isDirectory
            ? expandedPaths
                ? expandedPaths.includes(node.path)
                : true
            : false;
    const isActive = activePath === node.path;
    const canOpen = Boolean(onNodeClick && node.kind === "file");
    const canToggle = Boolean(isDirectory && onToggleDirectory);
    const isDraggable = enableNodeDrag === true;
    const dragStartHandler = onNodeDragStart as
        | ((node: GitTreeNode, dataTransfer: DataTransfer | null) => void)
        | undefined;

    const paddingLeft = BASE_PADDING + depth * INDENT_STEP;

    return (
        <>
            <div
                className="git-tree-row"
                data-active={isActive ? "true" : "false"}
                draggable={isDraggable}
                onDragStart={(event) => {
                    if (!isDraggable) {
                        return;
                    }

                    dragStartHandler?.(node, event.dataTransfer ?? null);
                }}
                style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    height: ROW_HEIGHT,
                    paddingLeft,
                    paddingRight: 8,
                    fontSize: FONT_SIZE,
                    borderRadius: 4,
                    cursor: canOpen || canToggle ? "pointer" : "default",
                    color: isDirectory
                        ? "var(--color-text-secondary)"
                        : "var(--color-text-primary)",
                    ...(isActive
                        ? {
                              backgroundColor:
                                  "color-mix(in srgb, var(--color-accent) 22%, transparent)",
                              boxShadow:
                                  "inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 40%, transparent)",
                          }
                        : {}),
                    ...ROW_BOX,
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
                    <span style={{ width: ICON_SM, flexShrink: 0 }} />
                )}

                {isDirectory ? (
                    <FolderIcon open={isExpanded} />
                ) : (
                    <FileIcon status={node.status} />
                )}

                <span
                    style={{
                        flexShrink: 0,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        minWidth: 0,
                        flex: 1,
                    }}
                >
                    {node.name}
                </span>

                {node.secondaryText ? (
                    <span
                        style={{
                            fontSize: 11,
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
                        gap: 4,
                        flexShrink: 0,
                        marginLeft: "auto",
                    }}
                >
                    {renderNodeMeta ? renderNodeMeta(node) : node.meta}

                    {node.status && !isDirectory ? (
                        <StatusIndicator status={node.status} />
                    ) : null}

                    {node.actions?.length ? (
                        <div
                            className="git-tree-row-actions"
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 4,
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
                          depth={depth + 1}
                          enableNodeDrag={isDraggable}
                          expandedPaths={expandedPaths}
                          key={child.id}
                          layout={layout}
                          node={child}
                          onNodeClick={onNodeClick}
                          onNodeDragStart={dragStartHandler}
                          onToggleDirectory={onToggleDirectory}
                          renderNodeMeta={renderNodeMeta}
                      />
                  ))
                : null}
        </>
    );
}

// --- Icons ---

function ChevronIcon({
    open,
    size = ICON_SM,
}: {
    open: boolean;
    size?: number;
}) {
    return (
        <svg
            width={size}
            height={size}
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
    open,
    size = ICON_MD,
}: {
    open: boolean;
    size?: number;
}) {
    const fill = "var(--color-text-secondary)";
    if (open) {
        return (
            <svg
                width={size}
                height={size}
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
            width={size}
            height={size}
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

function FileIcon({
    status,
    size = ICON_SM,
}: {
    status: GitNodeStatus | null;
    size?: number;
}) {
    const strokeColor = status ? statusStrokeColor(status) : "currentColor";
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.58 }}
        >
            <path
                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                stroke={strokeColor}
                strokeWidth="1"
            />
            <path
                d="M9.5 1.5V5H13"
                stroke={strokeColor}
                strokeWidth="0.8"
                strokeLinecap="round"
                strokeLinejoin="round"
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
                            left: x,
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
                fontSize: 10,
                fontWeight: 600,
                lineHeight: 1,
                color,
                width: 14,
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
            return "var(--color-status-added, #22c55e)";
        case "modified":
        case "renamed":
        case "mixed":
            return "var(--color-status-modified, #eab308)";
        case "deleted":
        case "conflict":
            return "var(--color-status-deleted, #ef4444)";
        case "untracked":
            return "var(--color-status-untracked, var(--color-accent))";
        case "clean":
        default:
            return "var(--color-text-secondary)";
    }
}

function statusStrokeColor(status: GitNodeStatus): string {
    switch (status) {
        case "added":
        case "staged":
            return "#22c55e";
        case "modified":
        case "renamed":
        case "mixed":
            return "#eab308";
        case "deleted":
        case "conflict":
            return "#ef4444";
        case "untracked":
            return "currentColor";
        case "clean":
        default:
            return "currentColor";
    }
}
