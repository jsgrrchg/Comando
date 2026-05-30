import type { ReactNode } from "react";

import { GitActionButton } from "./GitUi";
import { GitTreeView } from "./GitTreeView";
import type {
    GitChangeGroup,
    GitChangeGroupId,
    GitTreeNodeActivationEvent,
    GitChangesViewProps,
    GitTreeNode,
} from "./types";

export function GitChangesView({
    activePath = null,
    className,
    constrainWidth = false,
    emptyState,
    expandedGroupIds,
    expandedPaths,
    groups,
    layout = "tree",
    onNodeClick,
    onToggleDirectory,
    onToggleGroup,
    renderNodeMeta,
}: GitChangesViewProps) {
    const visibleGroups = groups.filter((g) => g.count > 0);

    if (visibleGroups.length === 0) {
        return (
            <div
                className={[
                    "flex items-center justify-center px-3 py-8 text-[12px] text-text-secondary",
                    className,
                ]
                    .filter(Boolean)
                    .join(" ")}
            >
                {emptyState ?? "No changes"}
            </div>
        );
    }

    return (
        <div
            className={[
                "shell-scrollbar min-h-0 flex-1 overflow-y-auto py-1",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {visibleGroups.map((group) => (
                <GitChangeGroupSection
                    activePath={activePath}
                    constrainWidth={constrainWidth}
                    expandedGroupIds={expandedGroupIds}
                    expandedPaths={expandedPaths}
                    group={group}
                    key={group.id}
                    layout={layout}
                    onNodeClick={onNodeClick}
                    onToggleDirectory={onToggleDirectory}
                    onToggleGroup={onToggleGroup}
                    renderNodeMeta={renderNodeMeta}
                />
            ))}
        </div>
    );
}

function GitChangeGroupSection({
    activePath,
    constrainWidth,
    expandedGroupIds,
    expandedPaths,
    group,
    layout,
    onNodeClick,
    onToggleDirectory,
    onToggleGroup,
    renderNodeMeta,
}: {
    readonly activePath: string | null;
    readonly constrainWidth: boolean;
    readonly expandedGroupIds: readonly GitChangeGroupId[] | undefined;
    readonly expandedPaths: readonly string[] | undefined;
    readonly group: GitChangeGroup;
    readonly layout: "list" | "tree";
    readonly onNodeClick?: (
        node: GitTreeNode,
        event: GitTreeNodeActivationEvent,
    ) => void;
    readonly onToggleDirectory?: (node: GitTreeNode) => void;
    readonly onToggleGroup?: (groupId: GitChangeGroupId) => void;
    readonly renderNodeMeta?: (node: GitTreeNode) => ReactNode;
}) {
    const isExpanded = expandedGroupIds
        ? expandedGroupIds.includes(group.id)
        : true;

    return (
        <section>
            <button
                className="git-tree-row"
                onClick={() => onToggleGroup?.(group.id)}
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    height: 26,
                    paddingLeft: 8,
                    paddingRight: 8,
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--color-text-secondary)",
                    border: "none",
                    textAlign: "left",
                    cursor: "pointer",
                }}
                type="button"
            >
                {onToggleGroup ? (
                    <svg
                        width={10}
                        height={10}
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        style={{
                            transform: isExpanded
                                ? "rotate(90deg)"
                                : "rotate(0deg)",
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
                ) : null}

                <span>{group.title}</span>

                <span
                    style={{
                        fontSize: 10,
                        fontWeight: 500,
                        color: groupCountColor(group.id),
                        minWidth: 16,
                        textAlign: "center",
                    }}
                >
                    {group.count}
                </span>

                {group.description ? (
                    <GroupDiffStat description={group.description} />
                ) : null}

                {group.actions?.length ? (
                    <span
                        className="git-tree-row-actions"
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            marginLeft: "auto",
                        }}
                    >
                        {group.actions.map((action) => (
                            <GitActionButton action={action} key={action.id} />
                        ))}
                    </span>
                ) : null}
            </button>

            {isExpanded && group.nodes.length > 0 ? (
                <GitTreeView
                    activePath={activePath}
                    constrainWidth={constrainWidth}
                    expandedPaths={expandedPaths}
                    layout={layout}
                    nodes={group.nodes}
                    onNodeClick={onNodeClick}
                    onToggleDirectory={onToggleDirectory}
                    renderNodeMeta={renderNodeMeta}
                />
            ) : null}
        </section>
    );
}

function GroupDiffStat({ description }: { readonly description: string }) {
    const parts = description.split(" ");
    return (
        <span
            style={{
                display: "inline-flex",
                gap: 4,
                fontSize: 10,
                fontWeight: 500,
                fontFamily: "var(--font-mono, monospace)",
            }}
        >
            {parts.map((part, i) =>
                part.startsWith("+") ? (
                    <span
                        key={i}
                        style={{
                            color: "var(--diff-add)",
                        }}
                    >
                        {part}
                    </span>
                ) : part.startsWith("-") ? (
                    <span
                        key={i}
                        style={{
                            color: "var(--diff-remove)",
                        }}
                    >
                        {part}
                    </span>
                ) : (
                    <span key={i}>{part}</span>
                ),
            )}
        </span>
    );
}

function groupCountColor(groupId: GitChangeGroupId): string {
    switch (groupId) {
        case "staged":
            return "var(--diff-add)";
        case "changes":
            return "var(--diff-warn)";
        case "untracked":
            return "var(--color-accent)";
        case "conflicts":
            return "var(--diff-remove)";
        default:
            return "var(--color-text-secondary)";
    }
}
