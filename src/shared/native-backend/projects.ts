import type { NativeProjectId, NativeWindowId, NativeWorktreeId } from "./ids";
import type { NativeFsVisibilityPolicy } from "./fs";

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

export type NativeProjectIdInput = {
    readonly projectId: NativeProjectId;
};

export type NativeProjectRelocateInput = {
    readonly projectId: NativeProjectId;
    readonly projectPath: string;
};

export type NativeProjectSyncWorktree = {
    readonly rootPath: string;
    readonly branchName: string | null;
    readonly headSha: string | null;
};

export type NativeProjectSyncWorktreesInput = {
    readonly projectId: NativeProjectId;
    readonly worktrees: readonly NativeProjectSyncWorktree[];
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

export type NativeProjectMutationResult = {
    readonly state: NativeProjectState;
};

export type NativeProjectRelocateResult = {
    readonly project: NativeProjectSummary;
    readonly state: NativeProjectState;
    readonly touchedRootPaths: readonly string[];
};

export type NativeProjectAppDataSummary = {
    readonly chatSessionCount: number;
    readonly durableWorkspaceCount: number;
    readonly projectSettingsCount: number;
    readonly recentProjectCount: number;
    readonly recoveryLayoutCount: number;
    readonly workspaceLayoutCount: number;
    readonly workspaceSessionCount: number;
    readonly workspaceTabCount: number;
};

export type NativeProjectClearAppDataResult = {
    readonly cleared: NativeProjectAppDataSummary;
    readonly state: NativeProjectState;
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
    readonly absolutePath?: string | null;
    readonly visibility?: NativeFsVisibilityPolicy | null;
};

export type NativeProjectTreeChildrenInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly parentRelativePath: string | null;
};

export type NativeProjectTreeChildrenResult = {
    readonly entries: readonly NativeProjectTreeEntry[];
};

export type NativeProjectListEntriesInput = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly limit?: number | null;
};

export type NativeProjectListEntriesResult = {
    readonly entries: readonly NativeProjectTreeEntry[];
    readonly truncated: boolean;
};
