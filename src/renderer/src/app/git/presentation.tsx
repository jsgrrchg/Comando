import type {
    GitChangeEntry,
    GitFileDiff as SharedGitFileDiff,
    GitRepositorySnapshot,
    GitRepositoryState,
    ProjectSummary,
} from "@shared/ipc";

import type {
    GitAction,
    GitChangeGroup,
    GitChangeGroupId,
    GitDiffFile,
    GitNodeStatus,
    GitRepositorySummary,
    GitTreeNode,
} from "@renderer/components/git";

type MutableGitChangeTreeNode = {
    readonly children: Map<string, MutableGitChangeTreeNode>;
    readonly kind: "directory" | "file";
    readonly name: string;
    readonly path: string;
    change: GitChangeEntry | null;
};

export function buildGitChangeGroups(
    changes: readonly GitChangeEntry[],
    actions: {
        readonly onDiscardPath: (path: string) => void;
        readonly onOpenDiff: (path: string) => void;
        readonly onStagePath: (path: string) => void;
        readonly onUnstagePath: (path: string) => void;
    },
): readonly GitChangeGroup[] {
    const groups: readonly GitChangeGroupId[] = [
        "conflicts",
        "changes",
        "staged",
        "untracked",
    ];

    return groups.map((groupId) => {
        const groupChanges = changes.filter((change) => {
            switch (groupId) {
                case "conflicts":
                    return change.scope === "conflicted";
                case "staged":
                    return change.scope === "staged";
                case "untracked":
                    return change.scope === "untracked";
                case "changes":
                default:
                    return change.scope === "unstaged";
            }
        });

        const { additions, deletions } = sumGitDiffStats(groupChanges);

        return {
            actions: [],
            count: groupChanges.length,
            description:
                groupChanges.length > 0
                    ? formatGitCountLabel(additions, deletions, {
                          zeroIsEmpty: true,
                      })
                    : null,
            emptyLabel: `No ${groupId} entries.`,
            id: groupId,
            nodes: buildGitChangeTreeNodes(groupChanges, actions),
            title:
                groupId === "conflicts"
                    ? "Conflicts"
                    : groupId === "changes"
                      ? "Changes"
                      : groupId === "staged"
                        ? "Staged"
                        : "Untracked",
        } satisfies GitChangeGroup;
    });
}

export function buildGitDiffFiles(
    selectedDiffPath: string | null,
    diffCache: Record<string, SharedGitFileDiff | null>,
    changes: readonly GitChangeEntry[],
): readonly GitDiffFile[] {
    const orderedPaths = [
        ...(selectedDiffPath ? [selectedDiffPath] : []),
        ...changes.map((change) => change.path),
        ...Object.keys(diffCache),
    ];

    const uniquePaths = Array.from(new Set(orderedPaths));

    return uniquePaths.map((path) => {
        const change = changes.find((entry) => entry.path === path) ?? null;
        const diff = diffCache[path] ?? null;

        if (diff) {
            return convertSharedGitDiff(diff, change);
        }

        return {
            hunks: [],
            id: path,
            isText: !(change?.isBinary ?? false),
            kind: mapChangeKindToDiffKind(change),
            newText: null,
            oldText: null,
            path,
            previousPath: change?.previousPath ?? null,
            reversible: change?.scope !== "untracked",
            statusLabel: formatChangeLabel(change),
            summary: formatGitCountLabel(
                change?.additions ?? null,
                change?.deletions ?? null,
            ),
        } satisfies GitDiffFile;
    });
}

export function summarizeGitRepository(
    project: ProjectSummary | null,
    snapshot: GitRepositorySnapshot | null,
): GitRepositorySummary | null {
    if (!snapshot) {
        return null;
    }

    const activeWorktree = snapshot.worktrees.find(
        (worktree) => worktree.id === snapshot.currentWorktreeId,
    );

    return {
        aheadBy: snapshot.aheadBy,
        behindBy: snapshot.behindBy,
        branchName: snapshot.branch?.name ?? null,
        detached: snapshot.branch?.isDetached ?? false,
        repositoryName: project?.name ?? getPathBase(snapshot.rootPath),
        stateLabel: describeRepositoryState(snapshot.repositoryState, snapshot),
        upstreamName: snapshot.branch?.upstreamName ?? null,
        worktreeName:
            activeWorktree?.branchName ?? getPathBase(activeWorktree?.rootPath),
        worktreePath: activeWorktree?.rootPath ?? snapshot.rootPath,
    };
}

function mapGitChangeToNodeStatus(
    change: GitChangeEntry,
): GitTreeNode["status"] {
    switch (change.kind) {
        case "conflicted":
            return "conflict";
        case "added":
            return change.scope === "staged" ? "staged" : "added";
        case "deleted":
            return "deleted";
        case "renamed":
            return "renamed";
        case "untracked":
            return "untracked";
        case "typechange":
        case "copied":
        case "modified":
        default:
            return change.scope === "staged" ? "staged" : "modified";
    }
}

function buildGitChangeTreeNodes(
    changes: readonly GitChangeEntry[],
    actions: {
        readonly onDiscardPath: (path: string) => void;
        readonly onOpenDiff: (path: string) => void;
        readonly onStagePath: (path: string) => void;
        readonly onUnstagePath: (path: string) => void;
    },
): readonly GitTreeNode[] {
    const roots = new Map<string, MutableGitChangeTreeNode>();

    for (const change of changes) {
        const parts = change.path.split("/").filter(Boolean);
        if (parts.length === 0) {
            continue;
        }

        let currentMap = roots;
        let currentPath = "";

        for (const [index, part] of parts.entries()) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const isLeaf = index === parts.length - 1;
            const existing = currentMap.get(currentPath);

            if (existing) {
                if (isLeaf) {
                    existing.change = change;
                }
                currentMap = existing.children;
                continue;
            }

            const nextNode: MutableGitChangeTreeNode = {
                change: isLeaf ? change : null,
                children: new Map<string, MutableGitChangeTreeNode>(),
                kind: isLeaf && !change.hasChildren ? "file" : "directory",
                name: part,
                path: currentPath,
            };

            currentMap.set(currentPath, nextNode);
            currentMap = nextNode.children;
        }
    }

    return Array.from(roots.values())
        .map((node) => finalizeGitChangeTreeNode(node, actions))
        .sort(compareGitTreeNodes);
}

function finalizeGitChangeTreeNode(
    node: MutableGitChangeTreeNode,
    actions: {
        readonly onDiscardPath: (path: string) => void;
        readonly onOpenDiff: (path: string) => void;
        readonly onStagePath: (path: string) => void;
        readonly onUnstagePath: (path: string) => void;
    },
): GitTreeNode {
    const children = Array.from(node.children.values())
        .map((child) => finalizeGitChangeTreeNode(child, actions))
        .sort(compareGitTreeNodes);
    const status =
        node.change !== null
            ? mapGitChangeToNodeStatus(node.change)
            : deriveDirectoryStatus(children);

    return {
        actions:
            node.kind === "file" && node.change
                ? buildGitChangeActions(node.change, actions)
                : [],
        children,
        hasChildren: children.length > 0,
        id: node.path,
        kind: node.kind,
        meta:
            node.change &&
            (node.change.additions !== null ||
                node.change.deletions !== null) ? (
                <span
                    className="font-mono text-[11px]"
                    style={{ display: "inline-flex", gap: 4 }}
                >
                    {node.change.additions != null && (
                        <span
                            style={{
                                color: "var(--color-status-added, #22c55e)",
                            }}
                        >
                            +{node.change.additions}
                        </span>
                    )}
                    {node.change.deletions != null && (
                        <span
                            style={{
                                color: "var(--color-status-deleted, #ef4444)",
                            }}
                        >
                            -{node.change.deletions}
                        </span>
                    )}
                </span>
            ) : null,
        name: node.name,
        path: node.path,
        secondaryText: node.change?.previousPath
            ? `from ${node.change.previousPath}`
            : node.change?.isBinary
              ? "Binary file"
              : null,
        status,
    };
}

function buildGitChangeActions(
    change: GitChangeEntry,
    actions: {
        readonly onDiscardPath: (path: string) => void;
        readonly onOpenDiff: (path: string) => void;
        readonly onStagePath: (path: string) => void;
        readonly onUnstagePath: (path: string) => void;
    },
): readonly GitAction[] {
    const nextActions: GitAction[] = [
        {
            id: `${change.path}:diff`,
            label: "Diff",
            onClick: () => actions.onOpenDiff(change.path),
        },
    ];

    if (change.scope === "staged") {
        nextActions.push({
            id: `${change.path}:unstage`,
            label: "Unstage",
            onClick: () => actions.onUnstagePath(change.path),
        });
    } else {
        nextActions.push({
            id: `${change.path}:stage`,
            label: "Stage",
            onClick: () => actions.onStagePath(change.path),
        });
    }

    nextActions.push({
        id: `${change.path}:discard`,
        label: "Discard",
        onClick: () => actions.onDiscardPath(change.path),
        tone: "danger",
    });

    return nextActions;
}

function deriveDirectoryStatus(
    children: readonly GitTreeNode[],
): GitNodeStatus | null {
    const childStatuses = Array.from(
        new Set(children.map((child) => child.status).filter(Boolean)),
    ) as GitNodeStatus[];

    if (childStatuses.length === 0) {
        return null;
    }

    if (childStatuses.length === 1) {
        return childStatuses[0] ?? null;
    }

    return "mixed";
}

function compareGitTreeNodes(left: GitTreeNode, right: GitTreeNode): number {
    if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
    }

    return left.path.localeCompare(right.path);
}

function convertSharedGitDiff(
    diff: SharedGitFileDiff,
    change: GitChangeEntry | null,
): GitDiffFile {
    return {
        hunks: diff.hunks.map((hunk) => {
            let oldLine = hunk.oldStart;
            let newLine = hunk.newStart;

            return {
                header: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
                id: hunk.id,
                lines: hunk.lines.map((line) => {
                    if (line.type === "add") {
                        return {
                            id: line.id,
                            kind: "add" as const,
                            newLineNumber: newLine++,
                            oldLineNumber: null,
                            text: line.text,
                        };
                    }

                    if (line.type === "remove") {
                        return {
                            id: line.id,
                            kind: "remove" as const,
                            newLineNumber: null,
                            oldLineNumber: oldLine++,
                            text: line.text,
                        };
                    }

                    return {
                        id: line.id,
                        kind: "context" as const,
                        newLineNumber: newLine++,
                        oldLineNumber: oldLine++,
                        text: line.text,
                    };
                }),
                newCount: hunk.newCount,
                newStart: hunk.newStart,
                oldCount: hunk.oldCount,
                oldStart: hunk.oldStart,
            };
        }),
        id: diff.path,
        isText: diff.isText,
        kind: diff.kind,
        newText: diff.newText,
        oldText: diff.oldText,
        path: diff.path,
        previousPath: diff.previousPath,
        reversible: diff.reversible,
        statusLabel: formatChangeLabel(change),
        summary: formatGitCountLabel(
            change?.additions ?? null,
            change?.deletions ?? null,
        ),
    };
}

function mapChangeKindToDiffKind(
    change: GitChangeEntry | null,
): GitDiffFile["kind"] {
    if (!change) {
        return "update";
    }

    switch (change.kind) {
        case "added":
        case "untracked":
            return "create";
        case "deleted":
            return "delete";
        case "renamed":
            return "move";
        default:
            return "update";
    }
}

function formatChangeLabel(change: GitChangeEntry | null): string | null {
    if (!change) {
        return null;
    }

    switch (change.kind) {
        case "added":
            return "added";
        case "deleted":
            return "deleted";
        case "renamed":
            return "renamed";
        case "conflicted":
            return "conflict";
        case "untracked":
            return "untracked";
        default:
            return change.scope === "staged" ? "staged" : "modified";
    }
}

function formatGitCountMeta(
    additions: number | null,
    deletions: number | null,
    options: {
        readonly zeroIsEmpty?: boolean;
    } = {},
): string {
    const parts: string[] = [];
    const zeroIsEmpty = options.zeroIsEmpty ?? false;

    if (typeof additions === "number" && (!zeroIsEmpty || additions !== 0)) {
        parts.push(`+${additions}`);
    }

    if (typeof deletions === "number" && (!zeroIsEmpty || deletions !== 0)) {
        parts.push(`-${deletions}`);
    }

    return parts.join(" ");
}

function formatGitCountLabel(
    additions: number | null,
    deletions: number | null,
    options: {
        readonly zeroIsEmpty?: boolean;
    } = {},
): string | null {
    const label = formatGitCountMeta(additions, deletions, options);
    return label.length > 0 ? label : null;
}

function sumGitDiffStats(changes: readonly GitChangeEntry[]): {
    readonly additions: number;
    readonly deletions: number;
} {
    let additions = 0;
    let deletions = 0;

    for (const change of changes) {
        additions += change.additions ?? 0;
        deletions += change.deletions ?? 0;
    }

    return { additions, deletions };
}

function describeRepositoryState(
    repositoryState: GitRepositoryState,
    snapshot: GitRepositorySnapshot,
): string | null {
    if (repositoryState !== "ready") {
        switch (repositoryState) {
            case "not_repo":
                return "Not a git repository";
            case "missing":
                return "Missing worktree";
            case "bare":
                return "Bare repository";
            case "error":
                return "Git error";
            default:
                return repositoryState;
        }
    }

    if (snapshot.status.conflictedCount > 0) {
        return "Conflicts";
    }

    switch (snapshot.syncStatus) {
        case "ahead":
            return "Ahead";
        case "behind":
            return "Behind";
        case "diverged":
            return "Diverged";
        default:
            return null;
    }
}

function getPathBase(value: string | null | undefined): string | null {
    if (!value) {
        return null;
    }

    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = normalized.split("/").filter(Boolean);
    return parts.at(-1) ?? null;
}
