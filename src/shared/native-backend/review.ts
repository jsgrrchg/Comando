import type {
    NativeProjectId,
    NativeSessionId,
    NativeToolCallId,
    NativeWorktreeId,
} from "./ids";
import type { NativeGitDiffHunk, NativeGitDiffLine } from "./git";

export type NativeDiffHunk = NativeGitDiffHunk;
export type NativeDiffLine = NativeGitDiffLine;
export type NativeTrackedFileStatus = "conflict" | "kept" | "pending" | "rejected";
export type NativeReviewDecision =
    | "keep"
    | "keep_hunks"
    | "reject"
    | "reject_hunks";

export type NativeTrackedFile = {
    readonly sessionId: NativeSessionId;
    readonly toolCallId: NativeToolCallId | null;
    readonly path: string;
    readonly previousPath: string | null;
    readonly status: NativeTrackedFileStatus;
    readonly isText: boolean;
    readonly isTooLarge: boolean;
    readonly updatedAt: string;
};

export type NativeReviewState = {
    readonly sessionId: NativeSessionId;
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
    readonly trackedFiles: readonly NativeTrackedFile[];
    readonly updatedAt: string;
};

export type NativeAgentSpan = {
    readonly sessionId: NativeSessionId;
    readonly toolCallId: NativeToolCallId | null;
    readonly startedAt: string;
    readonly completedAt: string | null;
};

export type NativeInlineAnchor = {
    readonly path: string;
    readonly line: number;
    readonly column: number | null;
};

export type NativeReviewConflict = {
    readonly path: string;
    readonly reason: string;
    readonly externalChangeHash: string | null;
};
