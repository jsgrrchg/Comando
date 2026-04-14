import path from "node:path";

import {
    IPC_CHANNELS,
    IPC_EVENTS,
    type AppAppearanceSettings,
    type AppBootstrapSnapshot,
    type AppWindowKind,
    type AppEditorSettings,
    type AiPermissionResponseInput,
    type AiRuntimeAuthLaunchInput,
    type AiRuntimeId,
    type AiSessionConfigOptionMutationInput,
    type AiSessionModeMutationInput,
    type AiSessionModelMutationInput,
    type AiTrackedFileHunkMutationInput,
    type AiTrackedFileMutationInput,
    type AiUserInputResponseInput,
    type ClaudeRuntimeSettingsInput,
    type CodexRuntimeSettings,
    type CreateProjectEntryInput,
    type CreateTerminalSessionInput,
    type DeleteProjectEntryInput,
    type GitBranchListInput,
    type GitBranchSummary as SharedGitBranchSummary,
    type GitChangeEntry as SharedGitChangeEntry,
    type GitChangesListInput,
    type GitCheckoutBranchInput,
    type GitCommitInput,
    type GitCommitResult,
    type GitCreateWorktreeInput,
    type GitDiffInput,
    type GitDiscardPathsInput,
    type GitFetchInput,
    type GitFileDiff as SharedGitFileDiff,
    type GitPullInput,
    type GitPushInput,
    type GitRemoteSummary,
    type GitRemoveWorktreeInput,
    type GitRepositoryInvalidation,
    type GitRepositoryScopeInput,
    type GitRepositorySnapshot as SharedGitRepositorySnapshot,
    type GitRepositoryStatusSummary,
    type GitStagePathsInput,
    type GitSyncStatus as SharedGitSyncStatus,
    type GitUnstagePathsInput,
    type GitWorktreeListInput,
    type GitWorktreeSummary as SharedGitWorktreeSummary,
    type ListProjectTreeInput,
    type OpenProjectFileInput,
    type OpenSettingsWindowInput,
    type PrepareAiSessionInput,
    type PersistedShellState,
    type PersistenceSnapshot,
    type ProjectSettingsSnapshot,
    type ProjectSettingsUpdatedEvent,
    type GeminiRuntimeSettingsInput,
    type KiloRuntimeSettingsInput,
    type RenameProjectEntryInput,
    type RevealProjectEntryInput,
    type ResizeTerminalSessionInput,
    type SearchProjectEntriesInput,
    type SaveProjectFileInput,
    type SendAiPromptInput,
    type SettingsSnapshot,
    type SettingsUpdatedEvent,
    type SystemTheme,
    type WindowContextSnapshot,
    type WriteTerminalInput,
    type WorkspaceSnapshot,
} from "@shared/ipc";

import {
    BrowserWindow,
    dialog,
    ipcMain,
    nativeTheme,
    shell,
    type OpenDialogOptions,
} from "electron";
import { simpleGit } from "simple-git";

import type { AiService } from "@main/ai/service";
import type { GitService } from "@main/git/service";
import type { ProjectService } from "@main/projects/service";
import type { PersistenceService } from "@main/persistence/service";
import type { SettingsService } from "@main/settings/service";
import { openSettingsWindow } from "@main/settings/window";
import type { TerminalService } from "@main/terminals/service";
import type { WorkspaceService } from "@main/workspace/service";
import { windowRegistry } from "@main/windows/registry";

interface RegisterIpcHandlersOptions {
    readonly aiService: AiService;
    readonly gitService: GitService;
    readonly getSnapshot: () => AppBootstrapSnapshot;
    readonly persistenceService: PersistenceService;
    readonly projectService: ProjectService;
    readonly settingsService: SettingsService;
    readonly terminalService: TerminalService;
    readonly workspaceService: WorkspaceService;
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions): void {
    ipcMain.removeHandler(IPC_CHANNELS.getBootstrapSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.getPersistenceSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.getWindowContext);
    ipcMain.removeHandler(IPC_CHANNELS.getSettingsSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.getProjectSettings);
    ipcMain.removeHandler(IPC_CHANNELS.getSystemTheme);
    ipcMain.removeHandler(IPC_CHANNELS.saveSettingsSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.saveProjectSettings);
    ipcMain.removeHandler(IPC_CHANNELS.openSettingsWindow);
    ipcMain.removeHandler(IPC_CHANNELS.saveActiveProjectId);
    ipcMain.removeHandler(IPC_CHANNELS.saveActiveWorktreeId);
    ipcMain.removeHandler(IPC_CHANNELS.saveShellState);
    ipcMain.removeHandler(IPC_CHANNELS.getGitRepositorySnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.listGitBranches);
    ipcMain.removeHandler(IPC_CHANNELS.listGitWorktrees);
    ipcMain.removeHandler(IPC_CHANNELS.listGitChanges);
    ipcMain.removeHandler(IPC_CHANNELS.getGitDiff);
    ipcMain.removeHandler(IPC_CHANNELS.stageGitPaths);
    ipcMain.removeHandler(IPC_CHANNELS.unstageGitPaths);
    ipcMain.removeHandler(IPC_CHANNELS.discardGitPaths);
    ipcMain.removeHandler(IPC_CHANNELS.commitGitChanges);
    ipcMain.removeHandler(IPC_CHANNELS.checkoutGitBranch);
    ipcMain.removeHandler(IPC_CHANNELS.createGitWorktree);
    ipcMain.removeHandler(IPC_CHANNELS.removeGitWorktree);
    ipcMain.removeHandler(IPC_CHANNELS.fetchGitRepository);
    ipcMain.removeHandler(IPC_CHANNELS.pullGitRepository);
    ipcMain.removeHandler(IPC_CHANNELS.pushGitRepository);
    ipcMain.removeHandler(IPC_CHANNELS.listProjects);
    ipcMain.removeHandler(IPC_CHANNELS.openProjects);
    ipcMain.removeHandler(IPC_CHANNELS.addProjectPaths);
    ipcMain.removeHandler(IPC_CHANNELS.removeProject);
    ipcMain.removeHandler(IPC_CHANNELS.touchProject);
    ipcMain.removeHandler(IPC_CHANNELS.listProjectTree);
    ipcMain.removeHandler(IPC_CHANNELS.openProjectFile);
    ipcMain.removeHandler(IPC_CHANNELS.saveProjectFile);
    ipcMain.removeHandler(IPC_CHANNELS.createProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.renameProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.deleteProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.revealProjectEntry);
    ipcMain.removeHandler(IPC_CHANNELS.searchProjectEntries);
    ipcMain.removeHandler(IPC_CHANNELS.getWorkspaceSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.saveWorkspaceSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.getChatSessionState);
    ipcMain.removeHandler(IPC_CHANNELS.createTerminalSession);
    ipcMain.removeHandler(IPC_CHANNELS.writeTerminalInput);
    ipcMain.removeHandler(IPC_CHANNELS.resizeTerminalSession);
    ipcMain.removeHandler(IPC_CHANNELS.closeTerminalSession);
    ipcMain.removeHandler(IPC_CHANNELS.getAiRuntimeStatus);
    ipcMain.removeHandler(IPC_CHANNELS.getAiSessionSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.sendAiPrompt);
    ipcMain.removeHandler(IPC_CHANNELS.setAiSessionMode);
    ipcMain.removeHandler(IPC_CHANNELS.setAiSessionModel);
    ipcMain.removeHandler(IPC_CHANNELS.setAiSessionConfigOption);
    ipcMain.removeHandler(IPC_CHANNELS.cancelAiSession);
    ipcMain.removeHandler(IPC_CHANNELS.closeAiSession);
    ipcMain.removeHandler(IPC_CHANNELS.respondAiPermission);
    ipcMain.removeHandler(IPC_CHANNELS.respondAiUserInput);
    ipcMain.removeHandler(IPC_CHANNELS.keepAiTrackedFile);
    ipcMain.removeHandler(IPC_CHANNELS.rejectAiTrackedFile);
    ipcMain.removeHandler(IPC_CHANNELS.keepAiTrackedFileHunks);
    ipcMain.removeHandler(IPC_CHANNELS.rejectAiTrackedFileHunks);
    ipcMain.removeHandler(IPC_CHANNELS.keepAllAiTrackedFiles);
    ipcMain.removeHandler(IPC_CHANNELS.rejectAllAiTrackedFiles);
    ipcMain.removeHandler(IPC_CHANNELS.saveCodexRuntimeSettings);
    ipcMain.removeHandler(IPC_CHANNELS.saveClaudeRuntimeSettings);
    ipcMain.removeHandler(IPC_CHANNELS.saveGeminiRuntimeSettings);
    ipcMain.removeHandler(IPC_CHANNELS.saveKiloRuntimeSettings);
    ipcMain.removeHandler(IPC_CHANNELS.verifyCodexRuntimeSettings);
    ipcMain.removeHandler(IPC_CHANNELS.launchAiRuntimeAuth);

    ipcMain.handle(IPC_CHANNELS.getBootstrapSnapshot, () =>
        options.getSnapshot(),
    );
    ipcMain.handle(
        IPC_CHANNELS.getPersistenceSnapshot,
        (event): PersistenceSnapshot => {
            const context = windowRegistry.getContextByWebContents(
                event.sender,
            );
            return context
                ? options.persistenceService.loadSnapshot(context.windowId)
                : {
                      activeProjectId: null,
                      shellState: null,
                      windowContext: null,
                      windowState: null,
                  };
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getWindowContext,
        (event): WindowContextSnapshot | null =>
            windowRegistry.getContextByWebContents(event.sender),
    );
    ipcMain.handle(
        IPC_CHANNELS.getSettingsSnapshot,
        (): SettingsSnapshot => options.settingsService.loadSnapshot(),
    );
    ipcMain.handle(
        IPC_CHANNELS.getProjectSettings,
        (_event, projectId: string): ProjectSettingsSnapshot | null =>
            options.settingsService.loadProjectSettings(projectId),
    );
    ipcMain.handle(
        IPC_CHANNELS.getSystemTheme,
        (): SystemTheme => ({
            isDark: nativeTheme.shouldUseDarkColors,
        }),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveSettingsSnapshot,
        (_event, snapshot: SettingsSnapshot) => {
            options.settingsService.saveSnapshot(snapshot);
            if (
                snapshot.appearance !== undefined ||
                snapshot.editor !== undefined ||
                snapshot.aiChat !== undefined
            ) {
                const persisted = options.settingsService.loadSnapshot();
                broadcastSettingsUpdated(
                    persisted.appearance ?? null,
                    persisted.editor ?? null,
                );
            }
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.saveProjectSettings,
        (_event, snapshot: ProjectSettingsSnapshot) => {
            options.settingsService.saveProjectSettings(snapshot);
            broadcastProjectSettingsUpdated({
                projectId: snapshot.projectId,
            });
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.openSettingsWindow,
        (_event, input: OpenSettingsWindowInput) => openSettingsWindow(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveActiveProjectId,
        (event, projectId: string | null) => {
            const context = requireWindowContext(event.sender, "main");
            options.persistenceService.saveActiveProjectId(
                context.windowId,
                projectId,
            );
            windowRegistry.updateMainWindowProjectId(
                context.windowId,
                projectId,
            );
            const ownerWindow = BrowserWindow.fromWebContents(event.sender);
            if (ownerWindow) {
                ownerWindow.setTitle(
                    buildMainWindowTitle(options.projectService, projectId),
                );
            }
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.saveActiveWorktreeId,
        (event, worktreeId: string | null) => {
            const context = requireWindowContext(event.sender, "main");
            const activeProjectId = context.projectId ?? null;
            const nextWorktreeId = activeProjectId ? worktreeId : null;

            options.persistenceService.saveActiveProjectId(
                context.windowId,
                activeProjectId,
                nextWorktreeId,
            );
            windowRegistry.updateMainWindowProjectId(
                context.windowId,
                activeProjectId,
                nextWorktreeId,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.saveShellState,
        (event, shellState: PersistedShellState | null) => {
            const context = requireWindowContext(event.sender, "main");
            options.persistenceService.saveShellState(
                context.windowId,
                shellState,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getGitRepositorySnapshot,
        async (
            _event,
            input: GitRepositoryScopeInput,
        ): Promise<SharedGitRepositorySnapshot | null> =>
            buildSharedGitRepositorySnapshot(
                options.projectService,
                options.gitService,
                input,
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitBranches,
        async (
            _event,
            input: GitBranchListInput,
        ): Promise<readonly SharedGitBranchSummary[]> =>
            buildSharedGitBranches(
                options.projectService,
                options.gitService,
                input,
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitWorktrees,
        async (
            _event,
            input: GitWorktreeListInput,
        ): Promise<readonly SharedGitWorktreeSummary[]> => {
            const snapshot = await buildSharedGitRepositorySnapshot(
                options.projectService,
                options.gitService,
                input,
            );
            if (!snapshot) {
                return [];
            }

            return input.includeDetached === false
                ? snapshot.worktrees.filter(
                      (worktree) => worktree.branchName !== null,
                  )
                : snapshot.worktrees;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.listGitChanges,
        async (
            _event,
            input: GitChangesListInput,
        ): Promise<readonly SharedGitChangeEntry[]> => {
            const snapshot = await buildSharedGitRepositorySnapshot(
                options.projectService,
                options.gitService,
                input,
            );
            if (!snapshot) {
                return [];
            }

            return snapshot.changes.filter((change) => {
                if (
                    input.includeUntracked === false &&
                    change.scope === "untracked"
                ) {
                    return false;
                }

                return input.scope === undefined || input.scope === "all"
                    ? true
                    : change.scope === input.scope;
            });
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getGitDiff,
        async (
            _event,
            input: GitDiffInput,
        ): Promise<SharedGitFileDiff | null> =>
            buildSharedGitDiff(
                options.projectService,
                options.gitService,
                input,
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.stageGitPaths,
        async (
            _event,
            input: GitStagePathsInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "status",
                async (rootPath) =>
                    options.gitService.stagePaths(rootPath, input.paths),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.unstageGitPaths,
        async (
            _event,
            input: GitUnstagePathsInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "status",
                async (rootPath) =>
                    options.gitService.unstagePaths(rootPath, input.paths),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.discardGitPaths,
        async (
            _event,
            input: GitDiscardPathsInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "status",
                async (rootPath) =>
                    options.gitService.discardPaths(rootPath, input.paths),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.commitGitChanges,
        async (_event, input: GitCommitInput): Promise<GitCommitResult> => {
            const scope = resolveGitScope(options.projectService, input);
            const result = await options.gitService.commit(
                scope.rootPath,
                input.message,
                {
                    amend: input.amend,
                    noVerify: input.noVerify,
                },
            );
            const snapshot = await adaptRepositorySnapshot(
                options.projectService,
                input,
                result.snapshot,
            );
            notifyGitSnapshot(snapshot, "status");

            return {
                branchName: snapshot.branch?.name ?? null,
                commitSha: result.commitSha,
                updatedAt: snapshot.updatedAt,
                worktreeId: snapshot.currentWorktreeId,
            };
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.checkoutGitBranch,
        async (
            _event,
            input: GitCheckoutBranchInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "branch",
                async (rootPath) =>
                    options.gitService.checkoutBranch(rootPath, {
                        branchName: input.branchName,
                        force: input.force,
                        newBranchName: input.newBranchName,
                        startPoint: input.startPoint,
                    }),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.createGitWorktree,
        async (
            _event,
            input: GitCreateWorktreeInput,
        ): Promise<SharedGitWorktreeSummary> => {
            const scope = resolveGitScope(options.projectService, input);
            const snapshot = await options.gitService.createWorktree(
                scope.rootPath,
                {
                    branchName: input.branchName,
                    force: input.force,
                    path: input.path,
                    startPoint: input.startPoint,
                },
            );
            const sharedSnapshot = await adaptRepositorySnapshot(
                options.projectService,
                input,
                snapshot,
            );
            notifyGitSnapshot(sharedSnapshot, "worktree");

            const createdWorktree = sharedSnapshot.worktrees.find(
                (worktree) =>
                    path.resolve(worktree.rootPath) ===
                    path.resolve(input.path),
            );
            if (!createdWorktree) {
                throw new Error(
                    "The worktree was created but could not be resolved.",
                );
            }

            return createdWorktree;
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.removeGitWorktree,
        async (
            _event,
            input: GitRemoveWorktreeInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "worktree",
                async (rootPath) =>
                    options.gitService.removeWorktree(rootPath, {
                        force: input.force,
                        path: input.path,
                    }),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.fetchGitRepository,
        async (
            _event,
            input: GitFetchInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "remote",
                async (rootPath) =>
                    options.gitService.fetch(rootPath, {
                        prune: input.prune,
                        remoteName: input.remoteName,
                    }),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.pullGitRepository,
        async (
            _event,
            input: GitPullInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "remote",
                async (rootPath) =>
                    options.gitService.pull(rootPath, {
                        rebase: input.rebase,
                        remoteName: input.remoteName,
                        remoteRef: input.remoteRef,
                    }),
            ),
    );
    ipcMain.handle(
        IPC_CHANNELS.pushGitRepository,
        async (
            _event,
            input: GitPushInput,
        ): Promise<SharedGitRepositorySnapshot> =>
            handleGitSnapshotMutation(
                options.projectService,
                options.gitService,
                input,
                "remote",
                async (rootPath) =>
                    options.gitService.push(rootPath, {
                        force: input.force,
                        remoteName: input.remoteName,
                        remoteRef: input.remoteRef,
                        setUpstream: input.setUpstream,
                    }),
            ),
    );

    nativeTheme.on("updated", () => {
        const theme: SystemTheme = {
            isDark: nativeTheme.shouldUseDarkColors,
        };

        for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(IPC_EVENTS.themeUpdated, theme);
        }
    });
    ipcMain.handle(IPC_CHANNELS.listProjects, () =>
        options.projectService.listProjects(),
    );
    ipcMain.handle(IPC_CHANNELS.openProjects, async (event) => {
        const ownerWindow =
            BrowserWindow.fromWebContents(event.sender) ??
            BrowserWindow.getFocusedWindow();
        const dialogOptions: OpenDialogOptions = {
            buttonLabel: "Add Project",
            message: "Choose one or more folders to add to the workspace.",
            properties: ["multiSelections", "openDirectory"],
            title: "Add projects",
        };
        const result = ownerWindow
            ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
            : await dialog.showOpenDialog(dialogOptions);

        if (result.canceled || result.filePaths.length === 0) {
            return options.projectService.listProjects();
        }

        return options.projectService.addProjectPaths(result.filePaths);
    });
    ipcMain.handle(IPC_CHANNELS.addProjectPaths, (_event, paths: string[]) =>
        options.projectService.addProjectPaths(paths),
    );
    ipcMain.handle(IPC_CHANNELS.removeProject, (_event, projectId: string) => {
        options.projectService.removeProject(projectId);
    });
    ipcMain.handle(IPC_CHANNELS.touchProject, (_event, projectId: string) => {
        options.projectService.touchProject(projectId);
    });
    ipcMain.handle(
        IPC_CHANNELS.listProjectTree,
        (_event, input: ListProjectTreeInput) =>
            options.projectService.listProjectTreeChildren(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.openProjectFile,
        (_event, input: OpenProjectFileInput) =>
            options.projectService.openProjectFile(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveProjectFile,
        (_event, input: SaveProjectFileInput) =>
            options.projectService.saveProjectFile(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.createProjectEntry,
        (_event, input: CreateProjectEntryInput) =>
            options.projectService.createProjectEntry(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.renameProjectEntry,
        (_event, input: RenameProjectEntryInput) =>
            options.projectService.renameProjectEntry(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.deleteProjectEntry,
        (_event, input: DeleteProjectEntryInput) => {
            return options.projectService.deleteProjectEntry(input);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.revealProjectEntry,
        (_event, input: RevealProjectEntryInput) => {
            const absolutePath = options.projectService.resolveProjectEntryPath(
                input.projectId,
                input.relativePath,
                input.worktreeId ?? null,
            );
            shell.showItemInFolder(absolutePath);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.searchProjectEntries,
        (_event, input: SearchProjectEntriesInput) =>
            options.projectService.searchProjectEntries(input),
    );
    ipcMain.handle(IPC_CHANNELS.getWorkspaceSnapshot, (event) => {
        const context = requireWindowContext(event.sender, "main");
        return options.workspaceService.loadSnapshot(context.workspaceId!);
    });
    ipcMain.handle(
        IPC_CHANNELS.saveWorkspaceSnapshot,
        (event, snapshot: WorkspaceSnapshot) => {
            const context = requireWindowContext(event.sender, "main");
            options.workspaceService.saveSnapshot(
                context.workspaceId!,
                snapshot,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getChatSessionState,
        (_event, sessionId: string) =>
            options.workspaceService.loadChatSessionState(sessionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.createTerminalSession,
        (event, input: CreateTerminalSessionInput) => {
            const context = requireWindowContext(event.sender, "main");
            return options.terminalService.createSession(
                input,
                context.windowId,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.writeTerminalInput,
        (_event, input: WriteTerminalInput) => {
            options.terminalService.writeInput(input.sessionId, input.data);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.resizeTerminalSession,
        (_event, input: ResizeTerminalSessionInput) => {
            options.terminalService.resizeSession(
                input.sessionId,
                input.cols,
                input.rows,
            );
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.closeTerminalSession,
        (_event, sessionId: string) => {
            options.terminalService.closeSession(sessionId);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getAiRuntimeStatus,
        (_event, runtimeId: AiRuntimeId) =>
            options.aiService.getRuntimeStatus(runtimeId),
    );
    ipcMain.handle(
        IPC_CHANNELS.prepareAiSession,
        (event, input: PrepareAiSessionInput) => {
            const context = requireWindowContext(event.sender, "main");
            return options.aiService.prepareSession(input, context.windowId);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.getAiSessionSnapshot,
        (_event, sessionId: string) =>
            options.aiService.getSessionSnapshot(sessionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.sendAiPrompt,
        (event, input: SendAiPromptInput) => {
            const context = requireWindowContext(event.sender, "main");
            return options.aiService.sendPrompt(input, context.windowId);
        },
    );
    ipcMain.handle(
        IPC_CHANNELS.setAiSessionMode,
        (_event, input: AiSessionModeMutationInput) =>
            options.aiService.setSessionMode(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.setAiSessionModel,
        (_event, input: AiSessionModelMutationInput) =>
            options.aiService.setSessionModel(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.setAiSessionConfigOption,
        (_event, input: AiSessionConfigOptionMutationInput) =>
            options.aiService.setSessionConfigOption(input),
    );
    ipcMain.handle(IPC_CHANNELS.cancelAiSession, (_event, sessionId: string) =>
        options.aiService.cancelSession(sessionId),
    );
    ipcMain.handle(IPC_CHANNELS.closeAiSession, (_event, sessionId: string) =>
        options.aiService.closeSession(sessionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.launchAiRuntimeAuth,
        (_event, input: AiRuntimeAuthLaunchInput) =>
            options.aiService.launchRuntimeAuth(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.respondAiPermission,
        (_event, input: AiPermissionResponseInput) =>
            options.aiService.respondPermission(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.respondAiUserInput,
        (_event, input: AiUserInputResponseInput) =>
            options.aiService.respondUserInput(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.keepAiTrackedFile,
        (_event, input: AiTrackedFileMutationInput) =>
            options.aiService.keepTrackedFile(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.rejectAiTrackedFile,
        (_event, input: AiTrackedFileMutationInput) =>
            options.aiService.rejectTrackedFile(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.rejectAiTrackedFileHunks,
        (_event, input: AiTrackedFileHunkMutationInput) =>
            options.aiService.rejectTrackedFileHunks(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.keepAiTrackedFileHunks,
        (_event, input: AiTrackedFileHunkMutationInput) =>
            options.aiService.keepTrackedFileHunks(input),
    );
    ipcMain.handle(
        IPC_CHANNELS.keepAllAiTrackedFiles,
        (_event, sessionId: string) =>
            options.aiService.keepAllTrackedFiles(sessionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.rejectAllAiTrackedFiles,
        (_event, sessionId: string) =>
            options.aiService.rejectAllTrackedFiles(sessionId),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveCodexRuntimeSettings,
        (_event, settings: CodexRuntimeSettings) =>
            options.aiService.saveCodexRuntimeSettings(settings),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveClaudeRuntimeSettings,
        (_event, settings: ClaudeRuntimeSettingsInput) =>
            options.aiService.saveClaudeRuntimeSettings(settings),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveGeminiRuntimeSettings,
        (_event, settings: GeminiRuntimeSettingsInput) =>
            options.aiService.saveGeminiRuntimeSettings(settings),
    );
    ipcMain.handle(
        IPC_CHANNELS.saveKiloRuntimeSettings,
        (_event, settings: KiloRuntimeSettingsInput) =>
            options.aiService.saveKiloRuntimeSettings(settings),
    );
    ipcMain.handle(
        IPC_CHANNELS.verifyCodexRuntimeSettings,
        (_event, settings: CodexRuntimeSettings) =>
            options.aiService.verifyCodexRuntimeSettings(settings),
    );
}

function broadcastSettingsUpdated(
    appearance: AppAppearanceSettings | null,
    editor: AppEditorSettings | null,
): void {
    const payload: SettingsUpdatedEvent = { appearance, editor };

    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_EVENTS.settingsUpdated, payload);
    }
}

function broadcastProjectSettingsUpdated(
    payload: ProjectSettingsUpdatedEvent,
): void {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_EVENTS.projectSettingsUpdated, payload);
    }
}

function requireWindowContext(
    sender: Electron.WebContents,
    expectedWindowKind: AppWindowKind,
): WindowContextSnapshot {
    const context = windowRegistry.getContextByWebContents(sender);
    if (!context || context.windowKind !== expectedWindowKind) {
        throw new Error(
            "The current renderer does not own a compatible window context.",
        );
    }

    return context;
}

function buildMainWindowTitle(
    projectService: ProjectService,
    projectId: string | null,
): string {
    if (!projectId) {
        return "Comando";
    }

    try {
        const rootPath = projectService.getProjectRootPath(projectId);
        const projectName =
            rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectId;
        return `Comando · ${projectName}`;
    } catch {
        return "Comando";
    }
}

/*
type ResolvedGitScope = {
    readonly projectId: string;
    readonly rootPath: string;
    readonly worktreeId: string | null;
};

type GitMutationReason = GitRepositoryInvalidation["reason"];

type MainGitRepositorySnapshot = Awaited<
    ReturnType<GitService["getRepositorySnapshot"]>
>;
type MainGitFileDiff = Awaited<ReturnType<GitService["getFileDiff"]>>;
type MainGitBranch = MainGitRepositorySnapshot["branches"][number];
type MainGitWorktree = MainGitRepositorySnapshot["worktrees"][number];
type MainGitChange = MainGitRepositorySnapshot["status"]["entries"][number];

function resolveGitScope(
    projectService: ProjectService,
    input: GitRepositoryScopeInput,
): ResolvedGitScope {
    const worktreeId = input.worktreeId ?? null;
    return {
        projectId: input.projectId,
        rootPath: projectService.getProjectRootPath(
            input.projectId,
            worktreeId,
        ),
        worktreeId,
    };
}

async function buildSharedGitRepositorySnapshot(
    projectService: ProjectService,
    gitService: GitService,
    input: GitRepositoryScopeInput,
): Promise<SharedGitRepositorySnapshot | null> {
    const scope = resolveGitScope(projectService, input);
    const snapshot = await gitService.getRepositorySnapshot(scope.rootPath);

    if (
        snapshot.resolution.state !== "ready" ||
        !snapshot.resolution.canonicalRootPath
    ) {
        return null;
    }

    return adaptRepositorySnapshot(projectService, gitService, input, snapshot);
}

async function buildSharedGitBranches(
    projectService: ProjectService,
    gitService: GitService,
    input: GitBranchListInput,
): Promise<readonly SharedGitBranchSummary[]> {
    const snapshot = await buildSharedGitRepositorySnapshot(
        projectService,
        gitService,
        input,
    );

    if (!snapshot) {
        return [];
    }

    return input.includeRemote === false
        ? snapshot.branches.filter((branch) => !branch.isRemote)
        : snapshot.branches;
}

async function buildSharedGitDiff(
    projectService: ProjectService,
    gitService: GitService,
    input: GitDiffInput,
): Promise<SharedGitFileDiff | null> {
    const scope = resolveGitScope(projectService, input);
    const repositorySnapshot = await buildSharedGitRepositorySnapshot(
        projectService,
        gitService,
        input,
    );
    const matchingChange =
        repositorySnapshot?.changes.find(
            (change) => change.path === input.path,
        ) ?? null;
    const diff = await gitService.getFileDiff(scope.rootPath, input.path, {
        kind: mapMainGitChangeKind(matchingChange?.kind ?? null),
        previousPath: matchingChange?.previousPath ?? null,
        staged: matchingChange?.scope === "staged",
    });

    return adaptGitDiff(diff, matchingChange?.kind ?? null);
}

async function handleGitSnapshotMutation<
    TInput extends GitRepositoryScopeInput,
>(
    projectService: ProjectService,
    gitService: GitService,
    input: TInput,
    reason: GitMutationReason,
    mutate: (rootPath: string) => Promise<MainGitRepositorySnapshot>,
): Promise<SharedGitRepositorySnapshot> {
    void gitService;
    const scope = resolveGitScope(projectService, input);
    const snapshot = await mutate(scope.rootPath);
    const sharedSnapshot = await adaptRepositorySnapshot(
        projectService,
        gitService,
        input,
        snapshot,
    );

    notifyGitSnapshot(sharedSnapshot, reason);
    return sharedSnapshot;
}

async function adaptRepositorySnapshot(
    projectService: ProjectService,
    gitService: GitService,
    input: GitRepositoryScopeInput,
    snapshot: MainGitRepositorySnapshot,
): Promise<SharedGitRepositorySnapshot> {
    void gitService;

    const scope = resolveGitScope(projectService, input);
    const syncedWorktrees = projectService.syncProjectWorktrees(
        scope.projectId,
        snapshot.worktrees.map((worktree) => ({
            branchName: worktree.branchName,
            headSha: worktree.headCommit,
            rootPath: worktree.path,
        })),
    );
    const currentWorktree = selectCurrentProjectWorktree(
        syncedWorktrees,
        scope,
    );
    const currentWorktreeId = currentWorktree?.id ?? null;
    const remotes = await loadGitRemotes(
        scope.rootPath,
        snapshot.status.sync?.trackingBranchName ?? null,
        snapshot.status.sync?.ahead ?? 0,
        snapshot.status.sync?.behind ?? 0,
    );
    const branches = adaptGitBranches(
        snapshot.branches,
        currentWorktree?.branchName ?? null,
        snapshot.status.sync?.trackingBranchName ?? null,
        snapshot.status.sync?.ahead ?? 0,
        snapshot.status.sync?.behind ?? 0,
    );
    const branch = resolveCurrentGitBranch(
        branches,
        currentWorktree?.branchName ?? null,
        currentWorktree?.headSha ?? null,
        snapshot.status.sync?.trackingBranchName ?? null,
        snapshot.status.sync?.ahead ?? 0,
        snapshot.status.sync?.behind ?? 0,
        snapshot.status.sync?.detached ?? false,
    );
    const changes = adaptGitChanges(snapshot.status.entries, currentWorktreeId);
    const selectedRemoteName = extractRemoteName(
        snapshot.status.sync?.trackingBranchName ?? null,
    );

    return {
        aheadBy: snapshot.status.sync?.ahead ?? 0,
        behindBy: snapshot.status.sync?.behind ?? 0,
        branch,
        canonicalRootPath:
            snapshot.resolution.canonicalRootPath ?? scope.rootPath,
        changedPaths: [...new Set(changes.map((change) => change.path))],
        changes,
        currentWorktreeId,
        defaultTreeViewMode: "tree",
        headSha:
            currentWorktree?.headSha ??
            snapshot.status.sync?.commit ??
            branch?.commitSha ??
            null,
        projectId: scope.projectId,
        remotes,
        repositoryState: snapshot.resolution.state,
        rootPath: scope.rootPath,
        selectedRemoteName,
        status: buildSharedGitStatusSummary(snapshot),
        syncStatus: mapSharedGitSyncStatus(snapshot.status.sync ?? null),
        updatedAt: snapshot.fetchedAt,
        worktrees: adaptGitWorktrees(
            scope.projectId,
            scope.rootPath,
            syncedWorktrees,
            snapshot.worktrees,
        ),
        branches,
    };
}

function notifyGitSnapshot(
    snapshot: SharedGitRepositorySnapshot,
    reason: GitMutationReason,
): void {
    const invalidation: GitRepositoryInvalidation = {
        occurredAt: snapshot.updatedAt,
        projectId: snapshot.projectId,
        reason,
        rootPath: snapshot.rootPath,
        worktreeId: snapshot.currentWorktreeId,
    };

    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(
            IPC_EVENTS.gitRepositorySnapshotUpdated,
            snapshot,
        );
        window.webContents.send(
            IPC_EVENTS.gitRepositoryInvalidated,
            invalidation,
        );
        if (reason === "worktree" || reason === "branch") {
            window.webContents.send(
                IPC_EVENTS.gitWorktreesUpdated,
                invalidation,
            );
        }
    }
}

function buildSharedGitStatusSummary(
    snapshot: MainGitRepositorySnapshot,
): GitRepositoryStatusSummary {
    return {
        changedCount: snapshot.status.entries.length,
        conflictedCount: snapshot.status.counts.conflicted,
        stagedCount: snapshot.status.counts.staged,
        unstagedCount: snapshot.status.counts.unstaged,
        untrackedCount: snapshot.status.counts.untracked,
    };
}

function adaptGitWorktrees(
    projectId: string,
    selectedRootPath: string,
    syncedWorktrees: readonly {
        readonly branchName: string | null;
        readonly headSha: string | null;
        readonly id: string;
        readonly isPrimary: boolean;
        readonly projectId: string;
        readonly rootPath: string;
        readonly updatedAt: string;
    }[],
    rawWorktrees: readonly MainGitWorktree[],
): readonly SharedGitWorktreeSummary[] {
    const rawWorktreesByPath = new Map(
        rawWorktrees.map((worktree) => [path.resolve(worktree.path), worktree]),
    );
    const normalizedSelectedRootPath = path.resolve(selectedRootPath);

    return syncedWorktrees.map((worktree) => {
        const rawWorktree = rawWorktreesByPath.get(
            path.resolve(worktree.rootPath),
        );

        return {
            branchName: worktree.branchName,
            commitSha: worktree.headSha,
            id: worktree.id,
            isBare: false,
            isCurrent:
                path.resolve(worktree.rootPath) === normalizedSelectedRootPath,
            isLocked: rawWorktree?.locked ?? false,
            isPrimary: worktree.isPrimary,
            lockedReason: rawWorktree?.lockReason ?? null,
            projectId,
            rootPath: worktree.rootPath,
            updatedAt: worktree.updatedAt,
        };
    });
}

function adaptGitBranches(
    branches: readonly MainGitBranch[],
    currentBranchName: string | null,
    trackingBranchName: string | null,
    aheadBy: number,
    behindBy: number,
): readonly SharedGitBranchSummary[] {
    return branches.map((branch) => {
        const isCurrent = !branch.isRemote && branch.name === currentBranchName;

        return {
            aheadBy: isCurrent ? aheadBy : 0,
            behindBy: isCurrent ? behindBy : 0,
            commitSha: branch.commit || null,
            isCurrent,
            isDetached: false,
            isRemote: branch.isRemote,
            kind: branch.isRemote ? "remote" : "branch",
            name: branch.name,
            upstreamName: isCurrent ? trackingBranchName : null,
        };
    });
}

function resolveCurrentGitBranch(
    branches: readonly SharedGitBranchSummary[],
    currentBranchName: string | null,
    headSha: string | null,
    trackingBranchName: string | null,
    aheadBy: number,
    behindBy: number,
    detached: boolean,
): SharedGitBranchSummary | null {
    if (currentBranchName) {
        const matchingBranch = branches.find(
            (branch) => !branch.isRemote && branch.name === currentBranchName,
        );

        return (
            matchingBranch ?? {
                aheadBy,
                behindBy,
                commitSha: headSha,
                isCurrent: true,
                isDetached: false,
                isRemote: false,
                kind: "branch",
                name: currentBranchName,
                upstreamName: trackingBranchName,
            }
        );
    }

    if (!detached && !headSha) {
        return null;
    }

    return {
        aheadBy,
        behindBy,
        commitSha: headSha,
        isCurrent: true,
        isDetached: true,
        isRemote: false,
        kind: "detached",
        name: headSha ? `HEAD@${headSha.slice(0, 7)}` : "HEAD",
        upstreamName: trackingBranchName,
    };
}

function adaptGitChanges(
    changes: readonly MainGitChange[],
    currentWorktreeId: string | null,
): readonly SharedGitChangeEntry[] {
    return changes.flatMap((change) =>
        change.scopes.map((scope) => ({
            additions: null,
            deletions: null,
            hasChildren: false,
            isBinary: change.isBinary,
            isConflicted: change.conflicted,
            isRenamed: change.isRenamed,
            kind: mapSharedGitChangeKind(change.kind),
            path: change.relativePath,
            previousPath: change.previousPath,
            scope,
            worktreeId: currentWorktreeId,
        })),
    );
}

function adaptGitDiff(
    diff: MainGitFileDiff,
    changeKind: SharedGitChangeEntry["kind"] | null,
): SharedGitFileDiff {
    return {
        hunks: diff.hunks.map((hunk, hunkIndex) => ({
            id: `hunk-${hunkIndex}`,
            lines: hunk.lines.map((line, lineIndex) => ({
                id: `line-${hunkIndex}-${lineIndex}`,
                text: line.text,
                type: line.type,
            })),
            newCount: hunk.newCount,
            newStart: hunk.newStart,
            oldCount: hunk.oldCount,
            oldStart: hunk.oldStart,
        })),
        isText: !diff.isBinary,
        kind: resolveSharedGitDiffKind(diff, changeKind),
        newText: null,
        oldText: null,
        path: diff.changedPath,
        previousPath: diff.previousPath,
        reversible: true,
    };
}

function resolveSharedGitDiffKind(
    diff: MainGitFileDiff,
    changeKind: SharedGitChangeEntry["kind"] | null,
): SharedGitFileDiff["kind"] {
    if (changeKind === "added" || diff.raw.includes("--- /dev/null")) {
        return "create";
    }

    if (changeKind === "deleted" || diff.raw.includes("+++ /dev/null")) {
        return "delete";
    }

    if (diff.previousPath && diff.previousPath !== diff.changedPath) {
        return "move";
    }

    return "update";
}

async function loadGitRemotes(
    rootPath: string,
    trackingBranchName: string | null,
    aheadBy: number,
    behindBy: number,
): Promise<readonly GitRemoteSummary[]> {
    try {
        const remotes = await simpleGit(rootPath).getRemotes(true);
        const selectedRemoteName = extractRemoteName(trackingBranchName);

        return remotes.map((remote) => ({
            aheadBy: remote.name === selectedRemoteName ? aheadBy : 0,
            behindBy: remote.name === selectedRemoteName ? behindBy : 0,
            fetchUrl: remote.refs.fetch ?? null,
            isDefault: remote.name === selectedRemoteName,
            name: remote.name,
            pushUrl: remote.refs.push ?? null,
            refName:
                remote.name === selectedRemoteName ? trackingBranchName : null,
        }));
    } catch {
        return [];
    }
}

function selectCurrentProjectWorktree(
    worktrees: readonly {
        readonly branchName: string | null;
        readonly headSha: string | null;
        readonly id: string;
        readonly isPrimary: boolean;
        readonly projectId: string;
        readonly rootPath: string;
        readonly updatedAt: string;
    }[],
    scope: ResolvedGitScope,
) {
    const normalizedScopeRootPath = path.resolve(scope.rootPath);

    return (
        worktrees.find(
            (worktree) =>
                path.resolve(worktree.rootPath) === normalizedScopeRootPath,
        ) ??
        worktrees.find((worktree) => worktree.isPrimary) ??
        null
    );
}

function mapSharedGitChangeKind(
    kind: MainGitChange["kind"],
): SharedGitChangeEntry["kind"] {
    switch (kind) {
        case "typechanged":
            return "typechange";
        case "copied":
        case "unknown":
            return "modified";
        default:
            return kind;
    }
}

function mapMainGitChangeKind(
    kind: SharedGitChangeEntry["kind"] | null,
):
    | "added"
    | "conflicted"
    | "deleted"
    | "modified"
    | "renamed"
    | "typechanged"
    | "untracked"
    | null {
    switch (kind) {
        case "typechange":
            return "typechanged";
        default:
            return kind;
    }
}

function mapSharedGitSyncStatus(
    sync: MainGitRepositorySnapshot["status"]["sync"],
): SharedGitSyncStatus {
    if (!sync) {
        return "unknown";
    }

    if (sync.ahead > 0 && sync.behind > 0) {
        return "diverged";
    }

    if (sync.ahead > 0) {
        return "ahead";
    }

    if (sync.behind > 0) {
        return "behind";
    }

    return "in_sync";
}

function extractRemoteName(trackingBranchName: string | null): string | null {
    if (!trackingBranchName) {
        return null;
    }

    const [remoteName] = trackingBranchName.split("/", 1);
    return remoteName || null;
}
*/

interface ResolvedGitScope {
    readonly canonicalRootPath: string;
    readonly projectId: string;
    readonly rootPath: string;
    readonly worktreeId: string | null;
}

async function buildSharedGitRepositorySnapshot(
    projectService: ProjectService,
    gitService: GitService,
    input: GitRepositoryScopeInput,
): Promise<SharedGitRepositorySnapshot> {
    const scope = resolveGitScope(projectService, input);
    const snapshot = await gitService.getRepositorySnapshot(scope.rootPath);
    return adaptRepositorySnapshot(projectService, input, snapshot);
}

async function buildSharedGitBranches(
    projectService: ProjectService,
    gitService: GitService,
    input: GitBranchListInput,
): Promise<readonly SharedGitBranchSummary[]> {
    const scope = resolveGitScope(projectService, input);
    const snapshot = await gitService.getRepositorySnapshot(scope.rootPath);
    if (snapshot.resolution.state !== "ready") {
        return [];
    }

    const remotes = await listGitRemotes(
        scope.rootPath,
        snapshot.status.sync?.trackingBranchName ?? null,
        snapshot.status.sync?.ahead ?? 0,
        snapshot.status.sync?.behind ?? 0,
    );
    const branches = adaptGitBranches(snapshot, remotes);

    return input.includeRemote === false
        ? branches.filter((branch) => !branch.isRemote)
        : branches;
}

async function buildSharedGitDiff(
    projectService: ProjectService,
    gitService: GitService,
    input: GitDiffInput,
): Promise<SharedGitFileDiff | null> {
    const scope = resolveGitScope(projectService, input);
    const snapshot = await gitService.getRepositorySnapshot(scope.rootPath);
    if (snapshot.resolution.state !== "ready") {
        return null;
    }

    const normalizedPath = normalizeGitPath(input.path);
    const entry =
        snapshot.status.entries.find(
            (candidate) => candidate.relativePath === normalizedPath,
        ) ?? null;
    const staged =
        entry?.scopes.includes("staged") === true &&
        entry.scopes.includes("unstaged") === false;
    const diff = await gitService.getFileDiff(scope.rootPath, normalizedPath, {
        kind: entry?.kind ?? null,
        previousPath: entry?.previousPath ?? null,
        staged,
    });

    return {
        hunks: diff.hunks.map((hunk, hunkIndex) => ({
            id: `${diff.changedPath}:${hunkIndex}`,
            lines: hunk.lines.map((line, lineIndex) => ({
                id: `${diff.changedPath}:${hunkIndex}:${lineIndex}`,
                text: line.text,
                type: line.type,
            })),
            newCount: hunk.newCount,
            newStart: hunk.newStart,
            oldCount: hunk.oldCount,
            oldStart: hunk.oldStart,
        })),
        isText: !diff.isBinary,
        kind: mapDiffKind(entry?.kind ?? null),
        newText: null,
        oldText: null,
        path: diff.changedPath,
        previousPath: diff.previousPath,
        reversible: entry?.conflicted !== true,
    };
}

async function handleGitSnapshotMutation(
    projectService: ProjectService,
    gitService: GitService,
    input: GitRepositoryScopeInput,
    reason: GitRepositoryInvalidation["reason"],
    mutate: (
        rootPath: string,
    ) => Promise<Awaited<ReturnType<GitService["getRepositorySnapshot"]>>>,
): Promise<SharedGitRepositorySnapshot> {
    void gitService;
    const scope = resolveGitScope(projectService, input);
    const snapshot = await mutate(scope.rootPath);
    const sharedSnapshot = await adaptRepositorySnapshot(
        projectService,
        input,
        snapshot,
    );

    notifyGitSnapshot(sharedSnapshot, reason);
    return sharedSnapshot;
}

async function adaptRepositorySnapshot(
    projectService: ProjectService,
    input: GitRepositoryScopeInput,
    snapshot: Awaited<ReturnType<GitService["getRepositorySnapshot"]>>,
): Promise<SharedGitRepositorySnapshot> {
    const scope = resolveGitScope(projectService, input);
    const remotes =
        snapshot.resolution.state === "ready"
            ? await listGitRemotes(
                  scope.rootPath,
                  snapshot.status.sync?.trackingBranchName ?? null,
                  snapshot.status.sync?.ahead ?? 0,
                  snapshot.status.sync?.behind ?? 0,
              )
            : [];
    const syncedWorktrees =
        snapshot.resolution.state === "ready"
            ? projectService.syncProjectWorktrees(
                  input.projectId,
                  snapshot.worktrees.map((worktree) => ({
                      branchName: worktree.branchName,
                      headSha: worktree.headCommit || null,
                      rootPath: worktree.canonicalPath,
                  })),
              )
            : projectService.listProjectWorktrees(input.projectId);
    const branches = adaptGitBranches(snapshot, remotes);
    const currentBranch =
        branches.find((branch) => branch.isCurrent) ??
        buildDetachedBranch(snapshot, remotes);
    const worktrees = adaptGitWorktrees(scope, syncedWorktrees, snapshot);
    const currentWorktreeId =
        worktrees.find(
            (worktree) =>
                normalizePathKey(worktree.rootPath) ===
                normalizePathKey(scope.rootPath),
        )?.id ?? scope.worktreeId;
    const aheadBy = snapshot.status.sync?.ahead ?? 0;
    const behindBy = snapshot.status.sync?.behind ?? 0;
    const status: GitRepositoryStatusSummary = {
        changedCount: snapshot.status.entries.length,
        conflictedCount: snapshot.status.counts.conflicted,
        stagedCount: snapshot.status.counts.staged,
        unstagedCount: snapshot.status.counts.unstaged,
        untrackedCount: snapshot.status.counts.untracked,
    };

    return {
        aheadBy,
        behindBy,
        branch: currentBranch,
        canonicalRootPath: scope.canonicalRootPath,
        changedPaths: snapshot.status.entries.map(
            (entry) => entry.relativePath,
        ),
        changes: snapshot.status.entries.map((entry) =>
            adaptGitChangeEntry(entry, currentWorktreeId),
        ),
        currentWorktreeId,
        defaultTreeViewMode: "tree",
        headSha:
            snapshot.status.sync?.commit ??
            worktrees.find((worktree) => worktree.isCurrent)?.commitSha ??
            null,
        projectId: input.projectId,
        remotes,
        repositoryState: snapshot.resolution.state,
        rootPath: scope.rootPath,
        selectedRemoteName:
            remotes.find((remote) => remote.isDefault)?.name ?? null,
        status,
        syncStatus: deriveSharedSyncStatus(aheadBy, behindBy),
        updatedAt: snapshot.fetchedAt,
        worktrees,
    };
}

function resolveGitScope(
    projectService: ProjectService,
    input: GitRepositoryScopeInput,
): ResolvedGitScope {
    const fallbackWorktreeId = projectService.getPrimaryWorktreeId(
        input.projectId,
    );
    const worktreeId = input.worktreeId ?? fallbackWorktreeId ?? null;

    return {
        canonicalRootPath: projectService.getProjectCanonicalRootPath(
            input.projectId,
        ),
        projectId: input.projectId,
        rootPath: projectService.getProjectRootPath(
            input.projectId,
            worktreeId,
        ),
        worktreeId,
    };
}

function adaptGitChangeEntry(
    entry: Awaited<
        ReturnType<GitService["getRepositorySnapshot"]>
    >["status"]["entries"][number],
    worktreeId: string | null,
): SharedGitChangeEntry {
    return {
        additions: null,
        deletions: null,
        hasChildren: false,
        isBinary: entry.isBinary,
        isConflicted: entry.conflicted,
        isRenamed: entry.isRenamed,
        kind: mapSharedChangeKind(entry.kind),
        path: entry.relativePath,
        previousPath: entry.previousPath,
        scope: derivePrimaryScope(entry.scopes),
        worktreeId,
    };
}

function adaptGitWorktrees(
    scope: ResolvedGitScope,
    syncedWorktrees: ReturnType<ProjectService["listProjectWorktrees"]>,
    snapshot: Awaited<ReturnType<GitService["getRepositorySnapshot"]>>,
): readonly SharedGitWorktreeSummary[] {
    const internalByPath = new Map(
        snapshot.worktrees.map((worktree) => [
            normalizePathKey(worktree.canonicalPath),
            worktree,
        ]),
    );

    return syncedWorktrees
        .map((worktree) => {
            const internal = internalByPath.get(
                normalizePathKey(worktree.rootPath),
            );

            return {
                branchName: worktree.branchName ?? internal?.branchName ?? null,
                commitSha: worktree.headSha ?? internal?.headCommit ?? null,
                id: worktree.id,
                isBare: snapshot.resolution.state === "bare",
                isCurrent:
                    normalizePathKey(worktree.rootPath) ===
                    normalizePathKey(scope.rootPath),
                isLocked: internal?.locked ?? false,
                isPrimary: worktree.isPrimary,
                lockedReason: internal?.lockReason ?? null,
                projectId: worktree.projectId,
                rootPath: worktree.rootPath,
                updatedAt: worktree.updatedAt,
            } satisfies SharedGitWorktreeSummary;
        })
        .sort((left, right) => {
            if (left.isCurrent !== right.isCurrent) {
                return left.isCurrent ? -1 : 1;
            }

            if (left.isPrimary !== right.isPrimary) {
                return left.isPrimary ? -1 : 1;
            }

            return left.rootPath.localeCompare(right.rootPath);
        });
}

function adaptGitBranches(
    snapshot: Awaited<ReturnType<GitService["getRepositorySnapshot"]>>,
    remotes: readonly GitRemoteSummary[],
): readonly SharedGitBranchSummary[] {
    const trackingBranchName = snapshot.status.sync?.trackingBranchName ?? null;
    const trackingRemoteName = getRemoteNameFromRef(trackingBranchName);

    return snapshot.branches
        .map((branch) => {
            const isCurrent = branch.current;
            const upstreamName = isCurrent
                ? trackingBranchName
                : inferBranchUpstream(branch.name, remotes);

            return {
                aheadBy:
                    isCurrent &&
                    getRemoteNameFromRef(upstreamName) === trackingRemoteName
                        ? (snapshot.status.sync?.ahead ?? 0)
                        : 0,
                behindBy:
                    isCurrent &&
                    getRemoteNameFromRef(upstreamName) === trackingRemoteName
                        ? (snapshot.status.sync?.behind ?? 0)
                        : 0,
                commitSha: branch.commit || null,
                isCurrent,
                isDetached: Boolean(
                    isCurrent && snapshot.status.sync?.detached,
                ),
                isRemote: branch.isRemote,
                kind: branch.isRemote ? "remote" : "branch",
                name: branch.name,
                upstreamName,
            } satisfies SharedGitBranchSummary;
        })
        .sort((left, right) => {
            if (left.isCurrent !== right.isCurrent) {
                return left.isCurrent ? -1 : 1;
            }

            if (left.isRemote !== right.isRemote) {
                return left.isRemote ? 1 : -1;
            }

            return left.name.localeCompare(right.name);
        });
}

function buildDetachedBranch(
    snapshot: Awaited<ReturnType<GitService["getRepositorySnapshot"]>>,
    remotes: readonly GitRemoteSummary[],
): SharedGitBranchSummary | null {
    if (!snapshot.status.sync?.detached) {
        return null;
    }

    return {
        aheadBy: snapshot.status.sync.ahead,
        behindBy: snapshot.status.sync.behind,
        commitSha: snapshot.status.sync.commit,
        isCurrent: true,
        isDetached: true,
        isRemote: false,
        kind: "detached",
        name: snapshot.status.sync.branchName ?? "HEAD",
        upstreamName:
            snapshot.status.sync.trackingBranchName ??
            remotes.find((remote) => remote.isDefault)?.refName ??
            null,
    };
}

async function listGitRemotes(
    rootPath: string,
    trackingBranchName: string | null,
    aheadBy: number,
    behindBy: number,
): Promise<readonly GitRemoteSummary[]> {
    try {
        const git = simpleGit(rootPath);
        const remotes = await git.getRemotes(true);
        const defaultRemoteName =
            getRemoteNameFromRef(trackingBranchName) ??
            (remotes.some((remote) => remote.name === "origin")
                ? "origin"
                : (remotes[0]?.name ?? null));

        return remotes.map((remote) => ({
            aheadBy: remote.name === defaultRemoteName ? aheadBy : 0,
            behindBy: remote.name === defaultRemoteName ? behindBy : 0,
            fetchUrl:
                typeof remote.refs.fetch === "string"
                    ? remote.refs.fetch
                    : null,
            isDefault: remote.name === defaultRemoteName,
            name: remote.name,
            pushUrl:
                typeof remote.refs.push === "string" ? remote.refs.push : null,
            refName:
                remote.name === defaultRemoteName ? trackingBranchName : null,
        }));
    } catch {
        return [];
    }
}

function notifyGitSnapshot(
    snapshot: SharedGitRepositorySnapshot,
    reason: GitRepositoryInvalidation["reason"],
): void {
    const invalidation: GitRepositoryInvalidation = {
        occurredAt: snapshot.updatedAt,
        projectId: snapshot.projectId,
        reason,
        rootPath: snapshot.rootPath,
        worktreeId: snapshot.currentWorktreeId,
    };

    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(
            IPC_EVENTS.gitRepositoryInvalidated,
            invalidation,
        );
        window.webContents.send(
            IPC_EVENTS.gitRepositorySnapshotUpdated,
            snapshot,
        );
        if (reason === "worktree") {
            window.webContents.send(
                IPC_EVENTS.gitWorktreesUpdated,
                invalidation,
            );
        }
    }
}

function derivePrimaryScope(
    scopes: readonly ("conflicted" | "staged" | "untracked" | "unstaged")[],
): "conflicted" | "staged" | "unstaged" | "untracked" {
    if (scopes.includes("conflicted")) {
        return "conflicted";
    }

    if (scopes.includes("unstaged")) {
        return "unstaged";
    }

    if (scopes.includes("staged")) {
        return "staged";
    }

    return "untracked";
}

function mapSharedChangeKind(kind: string): SharedGitChangeEntry["kind"] {
    switch (kind) {
        case "added":
        case "conflicted":
        case "copied":
        case "deleted":
        case "modified":
        case "renamed":
        case "untracked":
            return kind;
        case "typechanged":
            return "typechange";
        default:
            return "modified";
    }
}

function mapDiffKind(kind: string | null): SharedGitFileDiff["kind"] {
    switch (kind) {
        case "added":
        case "copied":
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

function deriveSharedSyncStatus(
    aheadBy: number,
    behindBy: number,
): SharedGitSyncStatus {
    if (aheadBy > 0 && behindBy > 0) {
        return "diverged";
    }

    if (aheadBy > 0) {
        return "ahead";
    }

    if (behindBy > 0) {
        return "behind";
    }

    return "in_sync";
}

function inferBranchUpstream(
    branchName: string,
    remotes: readonly GitRemoteSummary[],
): string | null {
    const defaultRemote =
        remotes.find((remote) => remote.isDefault) ?? remotes[0];
    if (!defaultRemote) {
        return null;
    }

    return `${defaultRemote.name}/${stripRemotePrefix(branchName)}`;
}

function getRemoteNameFromRef(referenceName: string | null): string | null {
    if (!referenceName) {
        return null;
    }

    const [remoteName] = referenceName.split("/");
    return remoteName || null;
}

function stripRemotePrefix(referenceName: string): string {
    const segments = referenceName.split("/");
    return segments.length > 2 && segments[0] === "remotes"
        ? segments.slice(2).join("/")
        : segments.length > 1 && segments[0] !== "refs"
          ? segments.slice(1).join("/")
          : referenceName;
}

function normalizePathKey(filePath: string): string {
    return path.resolve(filePath).split(path.sep).join("/");
}

function normalizeGitPath(filePath: string): string {
    return filePath.split(path.sep).join("/");
}
