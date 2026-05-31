import type {
    KeyboardEvent as ReactKeyboardEvent,
    MouseEvent as ReactMouseEvent,
    ReactNode,
} from "react";

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

export type GitTreeDragPayload =
    | GitTreeDragData
    | readonly GitTreeDragData[];

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

export type GitTreeNodeActivationEvent =
    | ReactMouseEvent<HTMLDivElement>
    | ReactKeyboardEvent<HTMLDivElement>;

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
    readonly actions?: readonly GitAction[];
    readonly emptyState?: ReactNode;
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

export interface GitTreeViewProps {
    readonly activePath?: string | null;
    readonly className?: string;
    readonly constrainWidth?: boolean;
    readonly editingDraftName?: string | null;
    readonly editingPath?: string | null;
    readonly enableNodeDrag?: boolean;
    readonly emptyState?: ReactNode;
    readonly expandedPaths?: readonly string[];
    readonly layout?: GitViewLayout;
    readonly nodes: readonly GitTreeNode[];
    readonly selectedPaths?: ReadonlySet<string>;
    readonly onBackgroundContextMenu?: (position: {
        readonly x: number;
        readonly y: number;
    }) => void;
    readonly onBackgroundDrop?: (dragData: GitTreeDragPayload) => void;
    readonly onNodeClick?: (
        node: GitTreeNode,
        event: GitTreeNodeActivationEvent,
    ) => void;
    readonly onNodeContextMenu?: (
        node: GitTreeNode,
        position: {
            readonly x: number;
            readonly y: number;
        },
    ) => void;
    readonly onNodeDrop?: (
        dragData: GitTreeDragPayload,
        node: GitTreeNode,
    ) => void;
    readonly onExternalFilesDrop?: (
        sourcePaths: readonly string[],
        node: GitTreeNode | null,
    ) => void;
    readonly onNodeDragStart?: (
        node: GitTreeNode,
        dataTransfer: DataTransfer | null,
    ) => GitTreeDragPayload | void;
    readonly onEditingCancel?: () => void;
    readonly onEditingDraftNameChange?: (value: string) => void;
    readonly onEditingSubmit?: () => void;
    readonly onScrollToActivePathConsumed?: () => void;
    readonly onToggleDirectory?: (node: GitTreeNode) => void;
    readonly renderNodeMeta?: (node: GitTreeNode) => ReactNode;
    readonly scrollToActivePathSignal?: number;
    readonly showStatusIndicator?: boolean;
    readonly stickyFolderPaths?: ReadonlySet<string>;
    readonly suppressKeyboardCursor?: boolean;
}

export interface GitChangesViewProps {
    readonly activePath?: string | null;
    readonly className?: string;
    readonly constrainWidth?: boolean;
    readonly emptyState?: ReactNode;
    readonly expandedGroupIds?: readonly GitChangeGroupId[];
    readonly expandedPaths?: readonly string[];
    readonly groups: readonly GitChangeGroup[];
    readonly layout?: GitViewLayout;
    readonly onNodeClick?: (
        node: GitTreeNode,
        event: GitTreeNodeActivationEvent,
    ) => void;
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
    readonly collapsedFileIds?: readonly string[];
    readonly displayMode?: "single" | "stack";
    readonly emptyState?: ReactNode;
    readonly files: readonly GitDiffFile[];
    readonly lineWrapping?: boolean;
    readonly onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
    readonly onSelectFile?: (file: GitDiffFile) => void;
    readonly onToggleFileCollapse?: (fileId: string) => void;
    readonly showFileSelector?: boolean;
    readonly surfaceVariant?: "flat" | "panel";
}
