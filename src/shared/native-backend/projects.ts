import type { NativeProjectId, NativeWindowId, NativeWorktreeId } from "./ids";

export type NativeWorktreeSummary = {
    readonly id: NativeWorktreeId;
    readonly projectId: NativeProjectId;
    readonly rootPath: string;
    readonly branchName: string | null;
    readonly headSha: string | null;
    readonly isPrimary: boolean;
    readonly updatedAt: string;
};

export type NativeProjectSummary = {
    readonly id: NativeProjectId;
    readonly name: string;
    readonly canonicalRootPath: string | null;
    readonly rootPath: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastOpenedAt: string | null;
};

export type NativeProjectOpenState = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly ownerWindowId: NativeWindowId | null;
    readonly openedAt: string;
};

export type NativeProjectAddInput = {
    readonly projectPaths: readonly string[];
    readonly ownerWindowId: NativeWindowId | null;
};

export type NativeProjectState = {
    readonly projects: readonly NativeProjectSummary[];
    readonly worktrees: readonly NativeWorktreeSummary[];
};

export type NativeProjectListResult = {
    readonly projects: readonly NativeProjectSummary[];
    readonly worktrees: readonly NativeWorktreeSummary[];
};

export type NativeProjectAddResult = {
    readonly projectIdsToOpen: readonly NativeProjectId[];
    readonly projects: readonly NativeProjectSummary[];
    readonly state: NativeProjectState;
    readonly touchedRootPaths: readonly string[];
};

export type NativeProjectUpdatedEvent = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly reason: string;
    readonly occurredAt: string;
};

export type NativeProjectTreeEntry = {
    readonly id: string;
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly name: string;
    readonly relativePath: string;
    readonly parentRelativePath: string | null;
    readonly kind: string;
    readonly extension: string | null;
    readonly hasChildren: boolean;
    readonly isGitIgnored: boolean;
    readonly gitStatus: string | null;
};
