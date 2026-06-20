import type { NativeProjectId, NativeWindowId, NativeWorktreeId } from "./ids";

export type NativeWorktreeSummary = {
    readonly id: NativeWorktreeId;
    readonly projectId: NativeProjectId;
    readonly rootPath: string;
    readonly branchName: string | null;
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
    readonly rootPath: string;
    readonly ownerWindowId: NativeWindowId | null;
};

export type NativeProjectListResult = {
    readonly projects: readonly NativeProjectSummary[];
};

export type NativeProjectUpdatedEvent = {
    readonly projectId: NativeProjectId;
    readonly worktreeId: NativeWorktreeId | null;
    readonly reason: string;
    readonly occurredAt: string;
};
