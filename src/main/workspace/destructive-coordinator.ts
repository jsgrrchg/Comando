import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
    DeleteWorktreeInput,
    DeleteWorktreePreflightInput,
    DeleteWorktreePreflightResult,
    DeleteWorktreeResult,
    ProjectAppDataSummary,
    WorkspaceSurfaceCloseResult,
} from "@shared/ipc";
import type { NativeWorkspaceDeletionJournalEntry } from "@shared/native-backend";
import { normalizePathKey } from "@shared/path-identity";
import { getWorkspaceScopeKey } from "@shared/workspace-context";

import type { AiService } from "@main/ai/service";
import type { GitGateway } from "@main/git/service";
import type { NativePersistenceGateway } from "@main/native-backend/persistence";
import type { ProjectService } from "@main/projects/service";
import type { SettingsGateway } from "@main/settings/service";
import type { TerminalGateway } from "@main/terminals/service";
import type { WorkspaceSurfaceManager } from "./surface-manager";

const ACTIVE_GIT_OPERATION_MARKERS = [
    "BISECT_LOG",
    "CHERRY_PICK_HEAD",
    "MERGE_HEAD",
    "REBASE_HEAD",
    "REVERT_HEAD",
    "rebase-apply",
    "rebase-merge",
] as const;

interface WorkspaceDestructiveCoordinatorOptions {
    readonly aiService: AiService;
    readonly durableWorkspaceRepository: NativePersistenceGateway;
    readonly gitService: GitGateway;
    readonly onWorkspaceClosed?: (
        hostWindowId: string,
        scopeKey: string,
    ) => Promise<void> | void;
    readonly projectService: ProjectService;
    readonly settingsService?: SettingsGateway;
    readonly surfaceManager: WorkspaceSurfaceManager;
    readonly terminalService: TerminalGateway;
}

/**
 * Coordinates destructive filesystem and SQLite work that cannot share one transaction.
 */
export class WorkspaceDestructiveCoordinator {
    readonly #aiService: AiService;
    readonly #durableWorkspaceRepository: NativePersistenceGateway;
    readonly #gitService: GitGateway;
    readonly #onWorkspaceClosed: WorkspaceDestructiveCoordinatorOptions["onWorkspaceClosed"];
    readonly #projectService: ProjectService;
    readonly #settingsService: SettingsGateway | null;
    readonly #surfaceManager: WorkspaceSurfaceManager;
    readonly #terminalService: TerminalGateway;

    constructor(options: WorkspaceDestructiveCoordinatorOptions) {
        this.#aiService = options.aiService;
        this.#durableWorkspaceRepository = options.durableWorkspaceRepository;
        this.#gitService = options.gitService;
        this.#onWorkspaceClosed = options.onWorkspaceClosed;
        this.#projectService = options.projectService;
        this.#settingsService = options.settingsService ?? null;
        this.#surfaceManager = options.surfaceManager;
        this.#terminalService = options.terminalService;
    }

    async preflightDeleteWorktree(
        hostWindowId: string,
        input: DeleteWorktreePreflightInput,
    ): Promise<DeleteWorktreePreflightResult> {
        this.#assertCanonicalWorktreeScope(input);
        const worktree = this.#resolveSecondaryWorktree(
            input.projectId,
            input.worktreeId,
        );
        const [workspaces, sessions, status, resolution, gitWorktrees] =
            await Promise.all([
                this.#durableWorkspaceRepository.listDurableWorkspaces(),
                this.#listScopeSessions(input.projectId, input.worktreeId),
                this.#gitService.getStatus(worktree.rootPath),
                this.#gitService.resolveRepository(worktree.rootPath),
                this.#gitService.listWorktrees(
                    this.#projectService.getProjectRootPath(input.projectId),
                ),
            ]);
        const durable = workspaces.find(
            (candidate) => candidate.scopeKey === input.scopeKey,
        );
        const gitWorktree = gitWorktrees.find(
            (candidate) =>
                normalizePathKey(candidate.canonicalPath) ===
                normalizePathKey(worktree.rootPath),
        );
        const blockers: string[] = [];
        const warnings: string[] = [];
        if (
            durable &&
            (durable.projectId !== input.projectId ||
                durable.worktreeId !== input.worktreeId)
        ) {
            blockers.push("The durable workspace identity does not match this worktree.");
        }
        if (!gitWorktree) {
            blockers.push("Git no longer reports this checkout as a worktree.");
        } else if (gitWorktree.locked) {
            blockers.push(
                gitWorktree.lockReason
                    ? `The worktree is locked: ${gitWorktree.lockReason}`
                    : "The worktree is locked by Git.",
            );
        }
        if (resolution.gitDirPath && hasActiveGitOperation(resolution.gitDirPath)) {
            blockers.push("A Git merge, rebase, cherry-pick, revert, or bisect is active.");
        }
        const surface = this.#surfaceManager
            .getSurfaceDiagnostics(hostWindowId)
            .surfaces.find((candidate) => candidate.scopeKey === input.scopeKey);
        const [liveAiSessions, terminalSessions] = durable
            ? await Promise.all([
                  Promise.resolve(
                      this.#aiService.getLiveSessionSnapshotsForWindow(
                          durable.runtimeOwnerId,
                      ),
                  ),
                  Promise.resolve(
                      this.#terminalService.listOwnedSessions?.(
                          durable.runtimeOwnerId,
                      ) ?? [],
                  ),
              ])
            : [[], []];
        if (surface?.leases.length) {
            blockers.push(...surface.leases.map((lease) => lease.message));
        }
        if (!status.isClean) {
            warnings.push(
                `${status.entries.length} tracked or untracked path${status.entries.length === 1 ? "" : "s"} will be permanently deleted.`,
            );
        }
        return {
            blockers: [...new Set(blockers)],
            inventory: {
                chatSessionCount: sessions.length,
                checkoutPath: worktree.rootPath,
                recoveryLayoutCount: 0,
                runtimeCount:
                    liveAiSessions.length +
                    terminalSessions.length +
                    (surface ? 1 : 0),
                workspaceLayoutCount: durable ? 1 : 0,
            },
            requiresForce: !status.isClean,
            warnings,
        };
    }

    async deleteWorktree(
        hostWindowId: string,
        input: DeleteWorktreeInput,
    ): Promise<DeleteWorktreeResult> {
        this.#assertCanonicalWorktreeScope(input);
        const existingOperation = (
            await this.#durableWorkspaceRepository.listIncompleteWorkspaceDeletions()
        ).find(
            (operation) =>
                operation.kind === "delete_worktree" &&
                operation.scopeKey === input.scopeKey,
        );
        if (existingOperation && shouldResume(existingOperation)) {
            await this.#resumeOperation(existingOperation);
            return {
                operationId: existingOperation.operationId,
                status: "completed",
            };
        }
        if (existingOperation?.status === "pending") {
            await this.#markFailed(
                existingOperation.operationId,
                "pre_checkout",
                new Error("interrupted before checkout deletion"),
            );
        }
        const preflight = await this.preflightDeleteWorktree(hostWindowId, input);
        if (preflight.blockers.length > 0) {
            throw new Error(preflight.blockers.join(" "));
        }
        if (preflight.requiresForce && !input.forceApproved) {
            throw new Error(
                "Deleting this worktree requires the additional uncommitted-changes confirmation.",
            );
        }
        const worktree = this.#resolveSecondaryWorktree(
            input.projectId,
            input.worktreeId,
        );
        const durable = (
            await this.#durableWorkspaceRepository.listDurableWorkspaces()
        ).find((candidate) => candidate.scopeKey === input.scopeKey);
        const closeResult = await this.#surfaceManager.closeWorkspaceSurface(
            hostWindowId,
            input.scopeKey,
        );
        assertWorkspaceClosed(closeResult);
        if (closeResult.status === "closed") {
            await this.#onWorkspaceClosed?.(hostWindowId, input.scopeKey);
        }
        const sessions = await this.#listScopeSessions(
            input.projectId,
            input.worktreeId,
        );
        const operation = await this.#durableWorkspaceRepository.beginWorkspaceDeletion({
            checkoutPath: worktree.rootPath,
            forceApproved: input.forceApproved,
            kind: "delete_worktree",
            operationId: randomUUID(),
            projectId: input.projectId,
            scopeKey: input.scopeKey,
            sessionIds: sessions.map((session) => session.sessionId),
            worktreeId: input.worktreeId,
        });
        const operationId = operation.operationId;

        try {
            await Promise.all(
                rootSessionIds(sessions).map((sessionId) =>
                    this.#aiService.closeSession(sessionId),
                ),
            );
            if (durable) {
                this.#terminalService.closeOwnedByWindow(durable.runtimeOwnerId);
            }
            const snapshot = await this.#gitService.removeWorktree(
                this.#projectService.getProjectRootPath(input.projectId),
                { force: input.forceApproved, path: worktree.rootPath },
            );
            await this.#projectService.syncProjectWorktrees(
                input.projectId,
                snapshot.worktrees.map((candidate) => ({
                    branchName: candidate.branchName,
                    headSha: candidate.headCommit || null,
                    rootPath: candidate.canonicalPath,
                })),
            );
            await this.#durableWorkspaceRepository.updateWorkspaceDeletion({
                errorCode: null,
                operationId,
                status: "checkout_deleted",
            });
        } catch (error) {
            if (!fs.existsSync(worktree.rootPath)) {
                await this.#durableWorkspaceRepository
                    .updateWorkspaceDeletion({
                        errorCode: "post_checkout:registry sync failed",
                        operationId,
                        status: "checkout_deleted",
                    })
                    .catch(() => undefined);
                throw new Error(
                    "The checkout was deleted, but app-data cleanup is pending and can be retried from the navigator.",
                    { cause: error },
                );
            }
            await this.#markFailed(operationId, "pre_checkout", error);
            throw error;
        }

        try {
            await this.#purgeSessionFiles(sessions);
            await this.#durableWorkspaceRepository.updateWorkspaceDeletion({
                errorCode: null,
                operationId,
                status: "purging",
            });
            await this.#durableWorkspaceRepository.completeWorkspaceDeletion(
                operationId,
            );
        } catch (error) {
            await this.#markFailed(operationId, "post_checkout", error);
            throw new Error(
                "The checkout was deleted, but app-data cleanup is pending and will resume automatically.",
                { cause: error },
            );
        }
        return { operationId, status: "completed" };
    }

    async clearProjectAppData(
        hostWindowId: string,
        projectId: string,
    ): Promise<ProjectAppDataSummary> {
        const nativeSummary =
            await this.#projectService.getProjectAppDataSummary(projectId);
        const summary = this.#settingsService?.loadProjectSettings(projectId)
            ? {
                  ...nativeSummary,
                  projectSettingsCount: nativeSummary.projectSettingsCount + 1,
              }
            : nativeSummary;
        const [sessions, workspaces] = await Promise.all([
            this.#aiService.listSessionHistory({ limit: null, projectId }),
            this.#durableWorkspaceRepository.listDurableWorkspaces(),
        ]);
        const projectWorkspaces = workspaces.filter(
            (workspace) => workspace.projectId === projectId,
        );
        for (const workspace of projectWorkspaces) {
            const result = await this.#surfaceManager.closeWorkspaceSurface(
                hostWindowId,
                workspace.scopeKey,
            );
            assertWorkspaceClosed(result);
            if (result.status === "closed") {
                await this.#onWorkspaceClosed?.(
                    hostWindowId,
                    workspace.scopeKey,
                );
            }
            this.#terminalService.closeOwnedByWindow(workspace.runtimeOwnerId);
        }

        const operationId = randomUUID();
        await this.#durableWorkspaceRepository.beginWorkspaceDeletion({
            checkoutPath: null,
            forceApproved: true,
            kind: "clear_project_data",
            operationId,
            projectId,
            scopeKey: `project-data::${projectId}`,
            sessionIds: sessions.map((session) => session.sessionId),
            worktreeId: null,
        });
        try {
            await this.#durableWorkspaceRepository.updateWorkspaceDeletion({
                errorCode: null,
                operationId,
                status: "purging",
            });
            await this.#purgeSessionFiles(sessions);
            // Keep the journal resumable until both the project registry purge
            // and the durable cross-domain purge have succeeded.
            await this.#projectService.clearProjectAppData(projectId);
            await this.#settingsService?.clearProjectSettings?.(projectId);
            await this.#durableWorkspaceRepository.completeWorkspaceDeletion(
                operationId,
            );
            return summary;
        } catch (error) {
            await this.#markFailed(operationId, "project_purge", error);
            throw error;
        }
    }

    async resumePendingOperations(): Promise<void> {
        const operations =
            await this.#durableWorkspaceRepository.listIncompleteWorkspaceDeletions();
        for (const operation of operations) {
            if (
                operation.kind === "delete_worktree" &&
                operation.status === "pending" &&
                operation.checkoutPath &&
                fs.existsSync(operation.checkoutPath)
            ) {
                await this.#markFailed(
                    operation.operationId,
                    "pre_checkout",
                    new Error("interrupted before checkout deletion"),
                );
                continue;
            }
            if (!shouldResume(operation)) {
                continue;
            }
            try {
                await this.#resumeOperation(operation);
            } catch (error) {
                await this.#markFailed(
                    operation.operationId,
                    "resume_purge",
                    error,
                );
            }
        }
    }

    async #listScopeSessions(projectId: string, worktreeId: string) {
        return await this.#aiService.listSessionHistory({
            limit: null,
            projectId,
            worktreeId,
        });
    }

    async #sessionsForOperation(operation: NativeWorkspaceDeletionJournalEntry) {
        const sessions = await this.#aiService.listSessionHistory({
            limit: null,
            projectId: operation.projectId,
        });
        const expected = new Set(operation.sessionIds);
        const found = sessions.filter((session) => expected.has(session.sessionId));
        const foundIds = new Set(found.map((session) => session.sessionId));
        return [
            ...found,
            ...operation.sessionIds
                .filter((sessionId) => !foundIds.has(sessionId))
                .map((sessionId) => ({ parentSessionId: null, sessionId })),
        ];
    }

    async #resumeOperation(
        operation: NativeWorkspaceDeletionJournalEntry,
    ): Promise<void> {
        if (operation.kind === "delete_worktree") {
            const worktrees = await this.#gitService.listWorktrees(
                this.#projectService.getProjectRootPath(operation.projectId),
            );
            await this.#projectService.syncProjectWorktrees(
                operation.projectId,
                worktrees.map((worktree) => ({
                    branchName: worktree.branchName,
                    headSha: worktree.headCommit || null,
                    rootPath: worktree.canonicalPath,
                })),
            );
        }
        const sessions = await this.#sessionsForOperation(operation);
        await this.#purgeSessionFiles(sessions);
        await this.#durableWorkspaceRepository.updateWorkspaceDeletion({
            errorCode: null,
            operationId: operation.operationId,
            status: "purging",
        });
        if (operation.kind === "clear_project_data") {
            await this.#projectService.clearProjectAppData(operation.projectId);
            await this.#settingsService?.clearProjectSettings?.(
                operation.projectId,
            );
        }
        await this.#durableWorkspaceRepository.completeWorkspaceDeletion(
            operation.operationId,
        );
    }

    async #purgeSessionFiles(
        sessions: readonly {
            readonly parentSessionId?: string | null;
            readonly sessionId: string;
        }[],
    ): Promise<void> {
        for (const sessionId of rootSessionIds(sessions)) {
            await this.#aiService.deleteSession(sessionId);
        }
    }

    #resolveSecondaryWorktree(projectId: string, worktreeId: string) {
        const worktree = this.#projectService
            .listProjectWorktrees(projectId)
            .find((candidate) => candidate.id === worktreeId);
        if (!worktree || worktree.projectId !== projectId) {
            throw new Error("The requested worktree does not exist anymore.");
        }
        if (worktree.isPrimary) {
            throw new Error("The Primary checkout cannot be deleted.");
        }
        return worktree;
    }

    #assertCanonicalWorktreeScope(input: {
        readonly projectId: string;
        readonly scopeKey: string;
        readonly worktreeId: string;
    }): void {
        if (
            input.scopeKey !==
            getWorkspaceScopeKey(input.projectId, input.worktreeId)
        ) {
            throw new Error(
                "The durable workspace identity does not match this worktree.",
            );
        }
    }

    async #markFailed(
        operationId: string,
        stage: string,
        error: unknown,
    ): Promise<void> {
        await this.#durableWorkspaceRepository
            .updateWorkspaceDeletion({
                errorCode: `${stage}:${error instanceof Error ? error.message : "unknown"}`,
                operationId,
                status: "failed",
            })
            .catch(() => undefined);
    }
}

function hasActiveGitOperation(gitDirPath: string): boolean {
    return ACTIVE_GIT_OPERATION_MARKERS.some((marker) =>
        fs.existsSync(path.join(gitDirPath, marker)),
    );
}

function assertWorkspaceClosed(result: WorkspaceSurfaceCloseResult): void {
    if (result.status === "blocked") {
        throw new Error(result.leases.map((lease) => lease.message).join(" "));
    }
    if (result.status === "failed") {
        throw new Error(result.message);
    }
}

function rootSessionIds(
    sessions: readonly {
        readonly parentSessionId?: string | null;
        readonly sessionId: string;
    }[],
): readonly string[] {
    const ids = new Set(sessions.map((session) => session.sessionId));
    return sessions
        .filter(
            (session) =>
                !session.parentSessionId || !ids.has(session.parentSessionId),
        )
        .map((session) => session.sessionId);
}

function shouldResume(operation: NativeWorkspaceDeletionJournalEntry): boolean {
    if (operation.kind === "clear_project_data") {
        return operation.status !== "completed";
    }
    if (
        operation.status === "checkout_deleted" ||
        operation.status === "purging"
    ) {
        return true;
    }
    if (
        operation.status === "failed" &&
        !operation.errorCode?.startsWith("pre_checkout:")
    ) {
        return true;
    }
    return Boolean(operation.checkoutPath && !fs.existsSync(operation.checkoutPath));
}
