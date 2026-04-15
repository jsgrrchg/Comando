import type { ReactNode } from "react";

export type GitPanelTabId = "changes" | "diffs";

export type GitViewLayout = "list" | "tree";

export type GitStatusTone =
    | "accent"
    | "danger"
    | "neutral"
    | "success"
    | "warning";

export type GitChangeGroupId = "changes" | "conflicts" | "staged" | "untracked";

export type GitNodeKind = "directory" | "file";

export type GitNodeStatus =
    | "added"
    | "clean"
    | "conflict"
    | "deleted"
    | "mixed"
    | "modified"
    | "renamed"
    | "staged"
    | "untracked";

export type GitActionTone = GitStatusTone;

export interface GitAction {
    readonly id: string;
    readonly label: string;
    readonly onClick: () => void;
    readonly ariaLabel?: string;
    readonly busy?: boolean;
    readonly disabled?: boolean;
    readonly tone?: GitActionTone;
}

export interface GitTreeDragData {
    readonly kind: GitNodeKind;
    readonly name: string;
    readonly relativePath: string;
}

export interface GitTreeNode {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly kind: GitNodeKind;
    readonly isProjectRoot?: boolean;
    readonly status: GitNodeStatus | null;
    readonly secondaryText?: string | null;
    readonly meta?: ReactNode;
    readonly hasChildren?: boolean;
    readonly children?: readonly GitTreeNode[];
    readonly actions?: readonly GitAction[];
}

export interface GitChangeGroup {
    readonly id: GitChangeGroupId;
    readonly title: string;
    readonly count: number;
    readonly description?: string | null;
    readonly emptyLabel?: string | null;
    readonly nodes: readonly GitTreeNode[];
    readonly actions?: readonly GitAction[];
}

export type GitDiffLineKind = "add" | "context" | "remove";

export type GitDiffFileKind = "create" | "delete" | "move" | "update";

export interface GitDiffLine {
    readonly id: string;
    readonly kind: GitDiffLineKind;
    readonly oldLineNumber: number | null;
    readonly newLineNumber: number | null;
    readonly text: string;
}

export interface GitDiffHunk {
    readonly id: string;
    readonly header: string;
    readonly oldCount: number;
    readonly oldStart: number;
    readonly newCount: number;
    readonly newStart: number;
    readonly lines: readonly GitDiffLine[];
}

export interface GitDiffFile {
    readonly id: string;
    readonly kind: GitDiffFileKind;
    readonly path: string;
    readonly previousPath: string | null;
    readonly statusLabel: string | null;
    readonly summary?: string | null;
    readonly isText: boolean;
    readonly reversible: boolean;
    readonly hunks: readonly GitDiffHunk[];
    readonly oldText?: string | null;
    readonly newText?: string | null;
}

export interface GitRepositorySummary {
    readonly repositoryName: string | null;
    readonly worktreeName: string | null;
    readonly worktreePath: string | null;
    readonly branchName: string | null;
    readonly upstreamName: string | null;
    readonly aheadBy: number | null;
    readonly behindBy: number | null;
    readonly detached: boolean;
    readonly stateLabel: string | null;
}

export interface GitCommitControls {
    readonly message: string;
    readonly placeholder?: string;
    readonly commitLabel?: string;
    readonly disabled?: boolean;
    readonly error?: string | null;
    readonly hint?: string | null;
    readonly lines?: number;
    readonly onChange: (message: string) => void;
    readonly onCommit: () => void;
}

export interface GitPanelToolbarProps {
    readonly summary: GitRepositorySummary | null;
    readonly commit?: GitCommitControls | null;
    readonly primaryActions?: readonly GitAction[];
    readonly secondaryActions?: readonly GitAction[];
    readonly syncActions?: {
        readonly fetch?: GitAction | null;
        readonly pull?: GitAction | null;
        readonly push?: GitAction | null;
    } | null;
    readonly className?: string;
}

export interface GitTreeViewProps {
    readonly activePath?: string | null;
    readonly className?: string;
    readonly constrainWidth?: boolean;
    readonly enableNodeDrag?: boolean;
    readonly emptyState?: ReactNode;
    readonly expandedPaths?: readonly string[];
    readonly layout?: GitViewLayout;
    readonly nodes: readonly GitTreeNode[];
    readonly onBackgroundContextMenu?: (position: {
        readonly x: number;
        readonly y: number;
    }) => void;
    readonly onBackgroundDrop?: (dragData: GitTreeDragData) => void;
    readonly onNodeClick?: (node: GitTreeNode) => void;
    readonly onNodeContextMenu?: (
        node: GitTreeNode,
        position: {
            readonly x: number;
            readonly y: number;
        },
    ) => void;
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
    readonly scrollToActivePathSignal?: number;
    readonly showStatusIndicator?: boolean;
    readonly stickyFolderPaths?: ReadonlySet<string>;
}

export type GitFilesViewProps = GitTreeViewProps;

export interface GitChangesViewProps {
    readonly activePath?: string | null;
    readonly className?: string;
    readonly constrainWidth?: boolean;
    readonly emptyState?: ReactNode;
    readonly expandedGroupIds?: readonly GitChangeGroupId[];
    readonly expandedPaths?: readonly string[];
    readonly groups: readonly GitChangeGroup[];
    readonly layout?: GitViewLayout;
    readonly onNodeClick?: (node: GitTreeNode) => void;
    readonly onToggleDirectory?: (node: GitTreeNode) => void;
    readonly onToggleGroup?: (groupId: GitChangeGroupId) => void;
    readonly renderNodeMeta?: (node: GitTreeNode) => ReactNode;
}

export interface GitDiffsViewProps {
    readonly activeFileId?: string | null;
    readonly className?: string;
    readonly codeFontFamily?: string | null;
    readonly codeFontSize?: number | null;
    readonly codeLineHeight?: number | null;
    readonly displayMode?: "single" | "stack";
    readonly emptyState?: ReactNode;
    readonly files: readonly GitDiffFile[];
    readonly onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
    readonly onSelectFile?: (file: GitDiffFile) => void;
    readonly showFileSelector?: boolean;
    readonly surfaceVariant?: "flat" | "panel";
}

export interface GitPanelProps {
    readonly activeTab: GitPanelTabId;
    readonly changes: GitChangesViewProps;
    readonly className?: string;
    readonly diffs: GitDiffsViewProps;
    readonly onTabChange: (tab: GitPanelTabId) => void;
    readonly tabCounts?: Partial<Record<GitPanelTabId, number>>;
    readonly title?: string;
    readonly toolbar?: GitPanelToolbarProps | null;
}
