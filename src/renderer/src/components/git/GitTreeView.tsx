import {
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode,
} from "react";

import {
    COMPOSER_PROJECT_ENTRY_MIME,
    parseComposerProjectEntryDragData,
} from "@renderer/app/drag-and-drop";

import { FileTypeIcon } from "@renderer/components/icons/FileTypeIcon";

import { GitActionButton, GitEmptyState } from "./GitUi";
import { canDropProjectEntryIntoDirectory } from "./tree-dnd";
import type {
    GitTreeDragData,
    GitNodeStatus,
    GitTreeNode,
    GitTreeViewProps,
    GitViewLayout,
} from "./types";

export const ROW_HEIGHT = 28;
export const FONT_SIZE = 12;
export const INDENT_STEP = 16;
export const BASE_PADDING = 8;
export const ICON_SM = 13;
export const ICON_MD = 15;
const AUTO_EXPAND_DELAY_MS = 2000;

export const GUIDE_COLOR = "var(--color-tree-guide)";

const ROW_BOX: CSSProperties = {
    width: "max-content",
    minWidth: "100%",
    boxSizing: "border-box",
};

const ROW_BOX_CONSTRAINED: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
};

export function scalePx(value: number): string {
    return `calc(${value}px * var(--file-tree-scale, 1))`;
}

export function GitTreeView({
    activePath = null,
    className,
    constrainWidth = false,
    editingDraftName = null,
    editingPath = null,
    enableNodeDrag = false,
    emptyState,
    expandedPaths,
    layout = "tree",
    nodes,
    onEditingCancel,
    onEditingDraftNameChange,
    onEditingSubmit,
    onNodeContextMenu,
    onNodeClick,
    onNodeDrop,
    onNodeDragStart,
    onToggleDirectory,
    renderNodeMeta,
    scrollToActivePathSignal,
    showStatusIndicator = true,
    stickyFolderPaths,
}: GitTreeViewProps) {
    const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
    const [activeDragData, setActiveDragData] =
        useState<GitTreeDragData | null>(null);
    const hoverExpandPathRef = useRef<string | null>(null);
    const hoverExpandTimeoutRef = useRef<number | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const clearHoverExpand = () => {
        hoverExpandPathRef.current = null;
        if (hoverExpandTimeoutRef.current !== null) {
            window.clearTimeout(hoverExpandTimeoutRef.current);
            hoverExpandTimeoutRef.current = null;
        }
    };

    const scheduleHoverExpand = (
        node: GitTreeNode,
        isExpanded: boolean,
        canAcceptDrop: boolean,
    ) => {
        if (
            !canAcceptDrop ||
            !onToggleDirectory ||
            !node.hasChildren ||
            isExpanded
        ) {
            clearHoverExpand();
            return;
        }

        const hoverPath = node.path;
        if (hoverExpandPathRef.current === hoverPath) {
            return;
        }

        clearHoverExpand();
        hoverExpandPathRef.current = hoverPath;
        hoverExpandTimeoutRef.current = window.setTimeout(() => {
            hoverExpandTimeoutRef.current = null;
            hoverExpandPathRef.current = null;
            onToggleDirectory(node);
        }, AUTO_EXPAND_DELAY_MS);
    };

    useEffect(() => {
        return () => {
            hoverExpandPathRef.current = null;
            if (hoverExpandTimeoutRef.current !== null) {
                window.clearTimeout(hoverExpandTimeoutRef.current);
                hoverExpandTimeoutRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (scrollToActivePathSignal === undefined || !activePath) {
            return;
        }

        const frameId = window.requestAnimationFrame(() => {
            const activeRow =
                containerRef.current?.querySelector<HTMLElement>(
                    '[data-active="true"]',
                ) ?? null;
            activeRow?.scrollIntoView({
                block: "nearest",
                inline: "nearest",
            });
        });

        return () => {
            window.cancelAnimationFrame(frameId);
        };
    }, [activePath, nodes, scrollToActivePathSignal]);

    if (nodes.length === 0) {
        return (
            <GitEmptyState className={className}>
                {emptyState ?? "Nothing to show yet."}
            </GitEmptyState>
        );
    }

    return (
        <div className={className} ref={containerRef}>
            {nodes.map((node) => (
                <GitTreeNodeRow
                    activePath={activePath}
                    constrainWidth={constrainWidth}
                    depth={0}
                    dropTargetPath={dropTargetPath}
                    activeDragData={activeDragData}
                    editingDraftName={editingDraftName}
                    editingPath={editingPath}
                    enableNodeDrag={enableNodeDrag}
                    expandedPaths={expandedPaths}
                    key={node.id}
                    layout={layout}
                    node={node}
                    onEditingCancel={onEditingCancel}
                    onEditingDraftNameChange={onEditingDraftNameChange}
                    onEditingSubmit={onEditingSubmit}
                    onNodeContextMenu={onNodeContextMenu}
                    onNodeClick={onNodeClick}
                    onNodeDrop={onNodeDrop}
                    onNodeDragStart={onNodeDragStart}
                    scheduleHoverExpand={scheduleHoverExpand}
                    onToggleDirectory={onToggleDirectory}
                    renderNodeMeta={renderNodeMeta}
                    setActiveDragData={setActiveDragData}
                    clearHoverExpand={clearHoverExpand}
                    setDropTargetPath={setDropTargetPath}
                    showStatusIndicator={showStatusIndicator}
                    stickyFolderPaths={stickyFolderPaths}
                />
            ))}
        </div>
    );
}

function GitTreeNodeRow({
    activePath,
    activeDragData,
    constrainWidth = false,
    depth,
    dropTargetPath,
    editingDraftName,
    editingPath,
    enableNodeDrag,
    expandedPaths,
    layout,
    node,
    onEditingCancel,
    onEditingDraftNameChange,
    onEditingSubmit,
    onNodeContextMenu,
    onNodeClick,
    onNodeDrop,
    onNodeDragStart,
    scheduleHoverExpand,
    onToggleDirectory,
    renderNodeMeta,
    setActiveDragData,
    clearHoverExpand,
    setDropTargetPath,
    showStatusIndicator,
    stickyFolderPaths,
}: {
    readonly activePath: string | null;
    readonly activeDragData: GitTreeDragData | null;
    readonly constrainWidth?: boolean;
    readonly depth: number;
    readonly dropTargetPath: string | null;
    readonly editingDraftName: string | null;
    readonly editingPath: string | null;
    readonly enableNodeDrag: boolean;
    readonly expandedPaths: readonly string[] | undefined;
    readonly layout: GitViewLayout;
    readonly node: GitTreeNode;
    readonly onEditingCancel?: () => void;
    readonly onEditingDraftNameChange?: (value: string) => void;
    readonly onEditingSubmit?: () => void;
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
    readonly scheduleHoverExpand: (
        node: GitTreeNode,
        isExpanded: boolean,
        canAcceptDrop: boolean,
    ) => void;
    readonly onToggleDirectory?: (node: GitTreeNode) => void;
    readonly renderNodeMeta?: (node: GitTreeNode) => ReactNode;
    readonly setActiveDragData: (dragData: GitTreeDragData | null) => void;
    readonly clearHoverExpand: () => void;
    readonly setDropTargetPath: (path: string | null) => void;
    readonly showStatusIndicator: boolean;
    readonly stickyFolderPaths?: ReadonlySet<string>;
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
    const isEditing = editingPath === node.path;
    const isActive = activePath === node.path;
    const canOpen = !isEditing && Boolean(onNodeClick && node.kind === "file");
    const canToggle = !isEditing && Boolean(isDirectory && onToggleDirectory);
    const isDraggable =
        !isEditing && enableNodeDrag === true && !node.isProjectRoot;
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
    const isStickyHidden =
        isDirectory && stickyFolderPaths?.has(node.path) === true;

    return (
        <>
            {isStickyHidden ? (
                <div
                    aria-hidden="true"
                    style={{ height: scalePx(ROW_HEIGHT) }}
                />
            ) : (
                <div
                    className="git-tree-row"
                    data-active={isActive ? "true" : "false"}
                    data-drop-target={isDropTarget ? "true" : "false"}
                    data-path={node.path}
                    draggable={isDraggable}
                    onDragEnd={() => {
                        clearHoverExpand();
                        setActiveDragData(null);
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
                            clearHoverExpand();
                            setDropTargetPath(null);
                        }
                    }}
                    onDragOver={(event) => {
                        const dragData =
                            activeDragData ??
                            getTreeDragData(event.dataTransfer);
                        const canAcceptDrop =
                            isDirectory &&
                            Boolean(onNodeDrop) &&
                            canDropProjectEntryIntoDirectory(
                                dragData,
                                node.isProjectRoot ? null : node.path,
                            );

                        scheduleHoverExpand(node, isExpanded, canAcceptDrop);

                        if (!isDirectory || !onNodeDrop || !canAcceptDrop) {
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

                        setActiveDragData({
                            kind: node.kind,
                            name: node.name,
                            relativePath: node.path,
                        });
                        dragStartHandler?.(node, event.dataTransfer ?? null);
                    }}
                    onDrop={(event) => {
                        const dragData =
                            activeDragData ??
                            getTreeDragData(event.dataTransfer);
                        clearHoverExpand();
                        setActiveDragData(null);
                        setDropTargetPath(null);

                        if (
                            !isDirectory ||
                            !onNodeDrop ||
                            !canDropProjectEntryIntoDirectory(
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
                        if (!onNodeContextMenu || isEditing) {
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
                        <span
                            style={{ width: scalePx(ICON_SM), flexShrink: 0 }}
                        />
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

                    {isEditing ? (
                        <TreeInlineNameInput
                            constrainWidth={constrainWidth}
                            titleColor={titleColor}
                            value={editingDraftName ?? node.name}
                            onCancel={onEditingCancel}
                            onChange={onEditingDraftNameChange}
                            onSubmit={onEditingSubmit}
                        />
                    ) : (
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
                    )}

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
            )}

            {layout === "tree" &&
            isDirectory &&
            isExpanded &&
            node.children?.length
                ? node.children.map((child) => (
                      <GitTreeNodeRow
                          activePath={activePath}
                          activeDragData={activeDragData}
                          constrainWidth={constrainWidth}
                          depth={depth + 1}
                          dropTargetPath={dropTargetPath}
                          editingDraftName={editingDraftName}
                          editingPath={editingPath}
                          enableNodeDrag={enableNodeDrag}
                          expandedPaths={expandedPaths}
                          key={child.id}
                          layout={layout}
                          node={child}
                          onEditingCancel={onEditingCancel}
                          onEditingDraftNameChange={onEditingDraftNameChange}
                          onEditingSubmit={onEditingSubmit}
                          onNodeContextMenu={onNodeContextMenu}
                          onNodeClick={onNodeClick}
                          onNodeDrop={onNodeDrop}
                          onNodeDragStart={dragStartHandler}
                          scheduleHoverExpand={scheduleHoverExpand}
                          onToggleDirectory={onToggleDirectory}
                          renderNodeMeta={renderNodeMeta}
                          setActiveDragData={setActiveDragData}
                          clearHoverExpand={clearHoverExpand}
                          setDropTargetPath={setDropTargetPath}
                          showStatusIndicator={showStatusIndicator}
                          stickyFolderPaths={stickyFolderPaths}
                      />
                  ))
                : null}
        </>
    );
}

function TreeInlineNameInput({
    constrainWidth,
    onCancel,
    onChange,
    onSubmit,
    titleColor,
    value,
}: {
    readonly constrainWidth: boolean;
    readonly onCancel?: () => void;
    readonly onChange?: (value: string) => void;
    readonly onSubmit?: () => void;
    readonly titleColor: string;
    readonly value: string;
}) {
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        const input = inputRef.current;
        if (!input) {
            return;
        }

        input.focus();
        input.select();
    }, []);

    return (
        <input
            aria-label="Edit entry name"
            autoCapitalize="off"
            autoCorrect="off"
            data-inline-tree-editor="true"
            onBlur={() => onSubmit?.()}
            onChange={(event) => onChange?.(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
                event.stopPropagation();

                if (event.key === "Enter") {
                    event.preventDefault();
                    onSubmit?.();
                    return;
                }

                if (event.key === "Escape") {
                    event.preventDefault();
                    onCancel?.();
                }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            ref={inputRef}
            spellCheck={false}
            style={{
                flexShrink: constrainWidth ? 1 : 0,
                minWidth: constrainWidth ? scalePx(40) : scalePx(84),
                flex: 1,
                height: scalePx(22),
                paddingInline: scalePx(6),
                borderRadius: scalePx(4),
                border: "1px solid color-mix(in srgb, var(--color-accent) 45%, var(--color-border))",
                background:
                    "color-mix(in srgb, var(--color-bg-elevated) 92%, white 8%)",
                color: titleColor,
                font: "inherit",
                outline: "none",
            }}
            type="text"
            value={value}
        />
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

// --- Icons ---

export function ChevronIcon({
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

export function FolderIcon({
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

export function TreeIndentGuides({ depth }: { depth: number }) {
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
