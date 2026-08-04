import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type {
    WorkspaceSurfaceAgentPresenceState,
    WorkspaceSurfaceActionEnvelope,
    WorkspaceSurfaceHardLease,
    WorkspaceSurfaceLifecycleState,
    WorkspaceSurfaceRuntimeBinding,
} from "@shared/ipc";

import { useSystemTheme } from "./app/hooks/use-system-theme";
import { parseWorkspaceSurfaceRendererDescriptor } from "./app/renderer-mode";
import { setCachedAppEditorSettings } from "./app/settings/client";
import {
    createGitProjectRefreshScheduler,
    gitInvalidationAffectsHistoryForScope,
} from "./app/git/refresh-scheduler";
import { revalidateVisibleGitDiffs } from "./app/git/visible-diff-revalidation";
import { useAiStore } from "./app/store/ai-store";
import { useAppStore } from "./app/store/app-store";
import { useGitStore } from "./app/store/git-store";
import { useProjectsStore } from "./app/store/projects-store";
import { useSettingsStore } from "./app/store/settings-store";
import {
    flushWorkspacePersistenceNow,
    useWorkspaceStore,
} from "./app/store/workspace-store";
import {
    getGitContextKey,
    resolveCommittedProjectWorktreeId,
} from "./app/git/context-key";
import { executeWorkspaceSurfaceAction } from "./app/workspace/surface-actions";
import { collectWorkspaceSurfaceAiAgentPresence } from "./app/workspace/surface-agent-presence";
import { resolveWorkspaceSurfaceActiveFileState } from "./app/workspace/surface-active-file";
import { isWorkspaceSurfaceLifecycleCurrent } from "./app/workspace/surface-presentation-lifecycle";
import {
    collectWorkspaceSurfaceStateLeases,
    workspaceSurfaceLeaseRegistry,
} from "./app/workspace/surface-lease-registry";
import { activateWorkspaceSurfaceLayoutRuntime } from "./app/workspace/workspace-surface-layout-runtime";
import { SIDEBAR_AGENT_DRAG_EVENT } from "./components/sidebar/sidebarAgentDragEvents";
import { SIDEBAR_GITHUB_DRAG_EVENT } from "./components/sidebar/sidebarGitHubDragEvents";
import { SidebarGitScopePicker } from "./components/sidebar/SidebarGitScopePicker";
import { QuickOpenFilePalette } from "./components/workspace/QuickOpenFilePalette";
import {
    isQuickOpenFileShortcut,
    useWorkspaceQuickOpen,
} from "./components/workspace/useWorkspaceQuickOpen";
import { WorkspaceView } from "./components/workspace/WorkspaceView";
import { findPaneById } from "./app/workspace/tree";
import { WorkspaceTerminalHost } from "./features/terminal/WorkspaceTerminalHost";
import { useTerminalRuntimeStore } from "./features/terminal/terminalRuntimeStore";
import {
    getClaudeCodeSidebarSessions,
    reconcileClaudeCodeSidebarSessions,
    refreshClaudeCodeSidebarSessionTranscript,
    subscribeClaudeCodeSidebarSessions,
} from "./features/terminal/claudeCodeSidebarSession";

const descriptor = parseWorkspaceSurfaceRendererDescriptor(
    window.location.search,
);

function collectCurrentWorkspaceSurfaceLeases(): readonly WorkspaceSurfaceHardLease[] {
    const acquiredAt = new Date().toISOString();
    const leasesById = new Map(
        [
            ...collectWorkspaceSurfaceStateLeases(
                useWorkspaceStore.getState(),
                acquiredAt,
            ),
            ...collectRuntimeWorkspaceSurfaceLeases(acquiredAt),
            ...workspaceSurfaceLeaseRegistry.list(),
        ].map((lease) => [lease.id, lease]),
    );
    return [...leasesById.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
    );
}

function collectRuntimeWorkspaceSurfaceLeases(
    acquiredAt: string,
): readonly WorkspaceSurfaceHardLease[] {
    const leases: WorkspaceSurfaceHardLease[] = [];
    for (const [sessionId, session] of Object.entries(
        useAiStore.getState().sessions,
    )) {
        const status = session.snapshot?.status ?? null;
        if (
            status === "starting" ||
            status === "streaming" ||
            status === "waiting_permission" ||
            status === "waiting_user_input" ||
            session.isDispatching
        ) {
            leases.push({
                acquiredAt,
                id: `ai-critical:${sessionId}`,
                kind: "ai-critical",
                message: "An AI session still requires this workspace.",
            });
        }
        const hasStructuredComposer =
            session.draftAttachments.length > 0 ||
            session.draftFileContexts.length > 0 ||
            session.draftComposerParts.some((part) => part.type !== "text");
        if (hasStructuredComposer) {
            leases.push({
                acquiredAt,
                id: `non-durable-composer:${sessionId}`,
                kind: "non-durable-composer",
                message: "A composer contains content that is not durable yet.",
            });
        }
        if (
            session.snapshot?.trackedFiles.some(
                (file) =>
                    file.reviewState === "pending" ||
                    file.reviewState === "conflict",
            )
        ) {
            leases.push({
                acquiredAt,
                id: `pending-review:${sessionId}`,
                kind: "pending-review",
                message: "An AI file review is still pending.",
            });
        }
    }
    for (const runtime of Object.values(
        useTerminalRuntimeStore.getState().runtimesById,
    )) {
        if (!runtime.busy) {
            continue;
        }
        leases.push({
            acquiredAt,
            id: `terminal-busy:${runtime.terminalId}`,
            kind: "terminal-busy",
            message: "A terminal operation is still in progress.",
        });
    }
    return leases;
}

export function WorkspaceSurfaceApp() {
    useSystemTheme();

    const bootstrap = useAppStore((state) => state.bootstrap);
    const hydrateBootstrap = useAppStore((state) => state.hydrate);
    const hydrateSettings = useSettingsStore((state) => state.hydrate);
    const runtimeCatalog = useSettingsStore((state) => state.runtimeCatalog);
    const hydrateAiSettings = useAiStore((state) => state.hydrateSettings);
    const applyAiRuntimeStatus = useAiStore(
        (state) => state.applyRuntimeStatus,
    );
    const applyAiSessionEvent = useAiStore((state) => state.applySessionEvent);
    const applyAiSessionUpdate = useAiStore(
        (state) => state.applySessionUpdate,
    );
    const applyAiPromptQueueSnapshot = useAiStore(
        (state) => state.applyPromptQueueSnapshot,
    );
    const aiSessions = useAiStore((state) => state.sessions);
    const hydrateProjects = useProjectsStore((state) => state.hydrate);
    const projects = useProjectsStore((state) => state.projects);
    const addProjects = useProjectsStore((state) => state.addProjects);
    const gitHydrate = useGitStore((state) => state.hydrate);
    const ingestGitSnapshot = useGitStore((state) => state.ingestSnapshot);
    const refreshGitHistory = useGitStore((state) => state.refreshHistory);
    const refreshGitProject = useGitStore((state) => state.refreshProject);
    const hydrateSurfaceLayout = useWorkspaceStore(
        (state) => state.hydrateSurfaceLayout,
    );
    const refreshProjectTabs = useWorkspaceStore(
        (state) => state.refreshProjectTabs,
    );
    const openFileTab = useWorkspaceStore((state) => state.openFileTab);
    const activePaneId = useWorkspaceStore((state) => state.activePaneId);
    const rootNode = useWorkspaceStore((state) => state.rootNode);
    const tabsById = useWorkspaceStore((state) => state.tabsById);
    const [terminalAgentSessions, setTerminalAgentSessions] = useState(() =>
        getClaudeCodeSidebarSessions(),
    );
    const activeContext = useWorkspaceStore((state) =>
        state.activeContextKey
            ? (state.contextsByKey[state.activeContextKey] ?? null)
            : null,
    );
    const activeFileState = useWorkspaceStore(
        useShallow((state) => {
            const context = state.activeContextKey
                ? (state.contextsByKey[state.activeContextKey] ?? null)
                : null;
            return context
                ? resolveWorkspaceSurfaceActiveFileState(state, context)
                : null;
        }),
    );
    const workspaceError = useWorkspaceStore((state) => state.error);
    const projectsError = useProjectsStore((state) => state.error);
    const [surfaceStatus, setSurfaceStatus] = useState<
        "error" | "loading" | "ready"
    >("loading");
    const [surfaceLifecycle, setSurfaceLifecycle] =
        useState<WorkspaceSurfaceLifecycleState>("suspended");
    const [gitScopeMenuRequest, setGitScopeMenuRequest] = useState<{
        readonly id: number;
        readonly width: number;
        readonly x: number;
    } | null>(null);
    const activeDragLeaseReleaseRef = useRef<(() => void) | null>(null);

    const activeProjectId =
        activeContext?.projectId ?? descriptor?.projectId ?? null;
    const activeWorktreeId = activeProjectId
        ? resolveCommittedProjectWorktreeId(
              activeProjectId,
              activeContext?.worktreeId ?? descriptor?.worktreeId ?? null,
          )
        : null;
    const agentPresence = useMemo<WorkspaceSurfaceAgentPresenceState | null>(
        () => {
            if (!activeContext || !activeProjectId) {
                return null;
            }

            const terminalSessionsByTerminalId = new Map(
                terminalAgentSessions.map((session) => [
                    session.terminalId,
                    session,
                ]),
            );
            const activePane = findPaneById(rootNode, activePaneId);
            const activeTab = activePane?.activeTabId
                ? tabsById[activePane.activeTabId]
                : null;
            const aiSessionPresence = collectWorkspaceSurfaceAiAgentPresence({
                aiSessions,
                projectId: activeProjectId,
                tabsById,
                worktreeId: activeWorktreeId,
            });
            const terminalSessions = terminalAgentSessions.map((session) => ({
                createdAt: session.createdAt,
                kind: "terminal" as const,
                preview: session.preview,
                runtimeId: session.runtimeId,
                runtimeSessionId: session.runtimeSessionId ?? null,
                sessionId: session.sessionId,
                status: null,
                terminalId: session.terminalId,
                title: session.title,
                updatedAt: session.updatedAt,
            }));

            return {
                activeSessionId:
                    activeTab?.kind === "chat" || activeTab?.kind === "review"
                        ? activeTab.sessionId
                        : activeTab?.kind === "terminal"
                          ? (terminalSessionsByTerminalId.get(
                                activeTab.terminalId,
                            )?.sessionId ?? null)
                        : null,
                contextKey: activeContext.key,
                projectId: activeProjectId,
                sessions: [...aiSessionPresence, ...terminalSessions],
                worktreeId: activeWorktreeId,
            };
        },
        [
            activeContext,
            activePaneId,
            activeProjectId,
            activeWorktreeId,
            aiSessions,
            rootNode,
            tabsById,
            terminalAgentSessions,
        ],
    );
    const publishedAgentPresenceSignatureRef = useRef("");
    const runtimeBinding = useMemo<WorkspaceSurfaceRuntimeBinding | null>(
        () =>
            descriptor
                ? {
                      generation: descriptor.generation,
                      runtimeOwnerId: descriptor.runtimeOwnerId,
                      scopeKey: descriptor.scopeKey,
                  }
                : null,
        [],
    );
    const resyncSurfaceRuntime = useCallback(async () => {
        if (!runtimeBinding) {
            return;
        }
        const snapshot = await window.comando.resyncWorkspaceSurfaceRuntime(
            runtimeBinding,
        );
        if (
            snapshot.generation !== runtimeBinding.generation ||
            snapshot.runtimeOwnerId !== runtimeBinding.runtimeOwnerId ||
            snapshot.scopeKey !== runtimeBinding.scopeKey
        ) {
            return;
        }
        for (const session of snapshot.aiSessions) {
            applyAiSessionUpdate({ kind: "snapshot", snapshot: session });
        }
        useTerminalRuntimeStore.getState().resyncSessions(snapshot.terminals);
    }, [applyAiSessionUpdate, runtimeBinding]);

    useEffect(() => {
        if (!runtimeBinding) {
            return;
        }
        return window.comando.onWorkspaceSurfaceLifecycleChanged((event) => {
            if (!isWorkspaceSurfaceLifecycleCurrent(runtimeBinding, event)) {
                return;
            }
            setSurfaceLifecycle(event.state);
            if (event.state === "visible") {
                void resyncSurfaceRuntime().catch(() => undefined);
            }
        });
    }, [resyncSurfaceRuntime, runtimeBinding]);

    useEffect(() => {
        if (!descriptor || !window.comando) {
            return;
        }
        let cancelled = false;
        const runtime = activateWorkspaceSurfaceLayoutRuntime(
            descriptor,
            window.comando,
        );

        void (async () => {
            try {
                const record = await runtime.hydrate();
                if (cancelled || !record) {
                    return;
                }
                await hydrateSurfaceLayout(record);
                if (!cancelled) {
                    // The host can reveal the surface as soon as its durable
                    // layout is installed; auxiliary stores hydrate afterward.
                    setSurfaceStatus("ready");
                    if (runtimeBinding) {
                        await window.comando.notifyWorkspaceSurfaceReady(
                            runtimeBinding,
                        );
                    }
                    void (async () => {
                        const [settingsResult] = await Promise.allSettled([
                            window.comando.getSettingsSnapshot(),
                            hydrateBootstrap(),
                            hydrateSettings(),
                            hydrateProjects(record.projectId),
                        ]);
                        if (cancelled) {
                            return;
                        }
                        if (settingsResult.status === "fulfilled") {
                            setCachedAppEditorSettings(
                                settingsResult.value.editor,
                            );
                            hydrateAiSettings(settingsResult.value.ai ?? null);
                        }
                        await gitHydrate({
                            activeProjectId: record.projectId,
                            activeWorktreeId: record.worktreeId,
                            projects: useProjectsStore.getState().projects,
                        });
                        if (!cancelled) {
                            await resyncSurfaceRuntime();
                        }
                    })().catch((error: unknown) => {
                        console.error(
                            "[workspace] Supplemental surface hydration failed",
                            error,
                        );
                    });
                }
            } catch (error) {
                if (!cancelled) {
                    useWorkspaceStore.setState({
                        error:
                            error instanceof Error
                                ? error.message
                                : "Could not restore the workspace surface.",
                        hydrated: true,
                    });
                    setSurfaceStatus("error");
                    if (runtimeBinding) {
                        void window.comando.notifyWorkspaceSurfaceRestoreFailed(
                            runtimeBinding,
                            error instanceof Error && error.message
                                ? error.message
                                : "Could not restore the workspace surface.",
                        );
                    }
                }
            }
        })();

        return () => {
            cancelled = true;
            runtime.dispose();
        };
    }, [
        gitHydrate,
        hydrateAiSettings,
        hydrateBootstrap,
        hydrateProjects,
        hydrateSettings,
        hydrateSurfaceLayout,
        resyncSurfaceRuntime,
        runtimeBinding,
    ]);

    useEffect(() => {
        if (!runtimeBinding) {
            return;
        }
        let lastSignature = "";
        const reportLeases = () => {
            const leases = collectCurrentWorkspaceSurfaceLeases();
            const signature = JSON.stringify(
                leases.map((lease) => [lease.id, lease.kind, lease.message]),
            );
            if (signature === lastSignature) {
                return;
            }
            lastSignature = signature;
            void window.comando.reportWorkspaceSurfaceLeases({
                ...runtimeBinding,
                leases,
            });
        };
        reportLeases();
        const unsubscribeStore = useWorkspaceStore.subscribe(reportLeases);
        const unsubscribeAi = useAiStore.subscribe(reportLeases);
        const unsubscribeTerminal = useTerminalRuntimeStore.subscribe(reportLeases);
        const unsubscribeRegistry =
            workspaceSurfaceLeaseRegistry.subscribe(reportLeases);
        return () => {
            unsubscribeStore();
            unsubscribeAi();
            unsubscribeTerminal();
            unsubscribeRegistry();
        };
    }, [runtimeBinding]);

    useEffect(() => {
        if (
            surfaceStatus !== "ready" ||
            surfaceLifecycle !== "visible" ||
            !activeFileState
        ) {
            return;
        }

        // The host owns the inspector, so publish only the minimal state it cannot derive.
        void window.comando
            .publishWorkspaceSurfaceActiveFile(activeFileState)
            .then((result) => {
                if (!result.delivered) {
                    console.warn(
                        "[workspace-surface] active file delivery failed",
                        result,
                    );
                }
            })
            .catch((error: unknown) => {
                console.error(
                    "[workspace-surface] active file delivery failed",
                    error,
                );
            });
    }, [activeFileState, surfaceLifecycle, surfaceStatus]);

    useEffect(() => {
        const api = window.comando;
        const unsubscribe = api.onWorkspaceSurfaceActionRequested(
            (envelope: WorkspaceSurfaceActionEnvelope) => {
                void (async () => {
                    if (
                        !(await api.claimWorkspaceSurfaceAction(
                            envelope.actionId,
                        ))
                    ) {
                        return;
                    }
                    try {
                        await executeWorkspaceSurfaceAction(envelope.request);
                        await api.completeWorkspaceSurfaceAction({
                            actionId: envelope.actionId,
                            status: "completed",
                        });
                    } catch (error) {
                        await api.completeWorkspaceSurfaceAction({
                            actionId: envelope.actionId,
                            error:
                                error instanceof Error && error.message
                                    ? error.message.slice(0, 1_000)
                                    : "The workspace action failed.",
                            status: "failed",
                        });
                    }
                })();
            },
        );
        return unsubscribe;
    }, []);

    useEffect(() => {
        if (surfaceLifecycle !== "visible") {
            return;
        }
        const api = window.comando;
        const unsubscribeRuntime = api.onAiRuntimeStatus(applyAiRuntimeStatus);
        const unsubscribeEvent =
            api.onAiSessionEvent?.(applyAiSessionEvent) ?? (() => undefined);
        const unsubscribeSession = api.onAiSessionSnapshot(
            applyAiSessionUpdate,
        );
        const unsubscribeQueue = api.onAiPromptQueue(
            applyAiPromptQueueSnapshot,
        );
        return () => {
            unsubscribeRuntime();
            unsubscribeEvent();
            unsubscribeSession();
            unsubscribeQueue();
        };
    }, [
        applyAiPromptQueueSnapshot,
        applyAiRuntimeStatus,
        applyAiSessionEvent,
        applyAiSessionUpdate,
        surfaceLifecycle,
    ]);

    useEffect(() => {
        if (surfaceLifecycle !== "visible") {
            return;
        }
        const api = window.comando;
        const unsubscribeDrag = api.onWorkspaceSurfaceDrag((event) => {
            const phase = (event.detail as { readonly phase?: unknown }).phase;
            if (phase === "start") {
                activeDragLeaseReleaseRef.current?.();
                activeDragLeaseReleaseRef.current =
                    workspaceSurfaceLeaseRegistry.acquire({
                        id: "active-drag",
                        kind: "active-drag",
                        message: "A drag operation is still in progress.",
                    });
            } else if (phase === "end" || phase === "cancel") {
                activeDragLeaseReleaseRef.current?.();
                activeDragLeaseReleaseRef.current = null;
            }
            window.dispatchEvent(
                new CustomEvent(
                    event.kind === "agent"
                        ? SIDEBAR_AGENT_DRAG_EVENT
                        : SIDEBAR_GITHUB_DRAG_EVENT,
                    { detail: event.detail },
                ),
            );
        });
        const unsubscribeGitMenu =
            api.onWorkspaceSurfaceGitScopeMenuRequested((anchor) => {
                setGitScopeMenuRequest((current) => ({
                    ...anchor,
                    id: (current?.id ?? 0) + 1,
                }));
            });
        return () => {
            activeDragLeaseReleaseRef.current?.();
            activeDragLeaseReleaseRef.current = null;
            unsubscribeDrag();
            unsubscribeGitMenu();
        };
    }, [surfaceLifecycle]);

    useEffect(() => {
        return subscribeClaudeCodeSidebarSessions(() => {
            setTerminalAgentSessions(getClaudeCodeSidebarSessions());
        });
    }, []);

    useEffect(() => {
        reconcileClaudeCodeSidebarSessions(Object.values(tabsById));
    }, [tabsById]);

    useEffect(() => {
        if (
            surfaceLifecycle !== "visible" ||
            terminalAgentSessions.length === 0
        ) {
            return;
        }

        const refresh = () => {
            for (const session of getClaudeCodeSidebarSessions()) {
                void refreshClaudeCodeSidebarSessionTranscript(session).catch(
                    () => undefined,
                );
            }
        };
        refresh();
        const intervalId = window.setInterval(refresh, 4_000);
        return () => {
            window.clearInterval(intervalId);
        };
    }, [surfaceLifecycle, terminalAgentSessions]);

    useEffect(() => {
        if (surfaceStatus !== "ready" || !agentPresence) {
            return;
        }
        const signature = JSON.stringify(agentPresence);
        if (publishedAgentPresenceSignatureRef.current === signature) {
            return;
        }
        // Keep the host informed without duplicating message or transcript payloads.
        void window.comando
            .publishWorkspaceSurfaceAgentPresence(agentPresence)
            .then((result) => {
                if (result.delivered) {
                    publishedAgentPresenceSignatureRef.current = signature;
                }
            })
            .catch(() => undefined);
    }, [agentPresence, surfaceLifecycle, surfaceStatus]);

    useEffect(() => {
        if (surfaceLifecycle !== "visible") {
            return;
        }
        const api = window.comando;
        const revalidateVisibleGitDiff = (
            projectId: string,
            worktreeId: string | null,
        ) =>
            revalidateVisibleGitDiffs({
                ensureBranchDiff: (targetProjectId, targetWorktreeId) =>
                    useGitStore
                        .getState()
                        .ensureBranchDiff(targetProjectId, targetWorktreeId),
                ensureWorktreeDiff: (targetProjectId, targetWorktreeId) =>
                    useGitStore
                        .getState()
                        .ensureWorktreeDiff(targetProjectId, targetWorktreeId),
                getDiffMode: (targetProjectId, targetWorktreeId) =>
                    useGitStore.getState().activeDiffModesByContext[
                        getGitContextKey(targetProjectId, targetWorktreeId)
                    ] ?? "worktree",
                projectId,
                worktreeId,
                workspace: useWorkspaceStore.getState(),
            });
        const projectRefreshScheduler = createGitProjectRefreshScheduler({
            refreshHistory: refreshGitHistory,
            refreshProject: async (projectId, worktreeId) => {
                const snapshot = await refreshGitProject(projectId, worktreeId);
                if (snapshot) {
                    await revalidateVisibleGitDiff(
                        snapshot.projectId,
                        snapshot.currentWorktreeId,
                    );
                }
            },
        });
        const unsubscribeProjects = api.onProjectsUpdated(() => {
            void hydrateProjects(activeProjectId);
        });
        const unsubscribeTree = api.onProjectTreeInvalidated((payload) => {
            if (payload.projectId === activeProjectId) {
                void refreshProjectTabs(
                    payload.projectId,
                    payload.worktreeId ?? activeWorktreeId,
                    payload.relativePaths ?? null,
                );
            }
        });
        const unsubscribeInvalidation = api.onGitRepositoryInvalidated(
            (payload) => {
                if (payload.projectId !== activeProjectId) {
                    return;
                }
                projectRefreshScheduler.schedule(
                    payload.projectId,
                    payload.worktreeId ?? activeWorktreeId,
                    {
                        // One surface represents one scope, so avoid redundant history loads.
                        refreshHistory: gitInvalidationAffectsHistoryForScope(
                            payload,
                            activeWorktreeId,
                        ),
                    },
                );
            },
        );
        const unsubscribeGit = api.onGitRepositorySnapshotUpdated((snapshot) => {
            if (snapshot.projectId !== activeProjectId) {
                return;
            }
            projectRefreshScheduler.cancel(
                snapshot.projectId,
                snapshot.currentWorktreeId,
            );
            projectRefreshScheduler.cancel(snapshot.projectId, null);
            ingestGitSnapshot(snapshot);
            void revalidateVisibleGitDiff(
                snapshot.projectId,
                snapshot.currentWorktreeId,
            );
        });
        // A surface can remain warm while hidden and miss invalidation events.
        // Revalidate its own scope when it becomes visible again.
        if (activeProjectId) {
            projectRefreshScheduler.schedule(activeProjectId, activeWorktreeId);
        }
        return () => {
            unsubscribeProjects();
            unsubscribeTree();
            unsubscribeInvalidation();
            unsubscribeGit();
            projectRefreshScheduler.clear();
        };
    }, [
        activeProjectId,
        activeWorktreeId,
        hydrateProjects,
        ingestGitSnapshot,
        refreshGitHistory,
        refreshGitProject,
        refreshProjectTabs,
        surfaceLifecycle,
    ]);

    useEffect(() => {
        const api = window.comando;
        const closeActiveTab = () => {
            const state = useWorkspaceStore.getState();
            const pane = findPaneById(state.rootNode, state.activePaneId);
            if (pane?.activeTabId) {
                void state.closeTab(pane.activeTabId);
            }
        };
        const unsubscribeClose = api.onWorkspaceCloseActiveTab(closeActiveTab);
        const unsubscribeReopen = api.onWorkspaceReopenLastClosedTab(() => {
            void useWorkspaceStore.getState().reopenLastClosedTab();
        });
        const unsubscribeFlush = api.onWorkspaceFlushRequested(async () => {
            await flushWorkspacePersistenceNow();
            return collectCurrentWorkspaceSurfaceLeases();
        });
        return () => {
            unsubscribeClose();
            unsubscribeReopen();
            unsubscribeFlush();
        };
    }, []);

    useEffect(() => {
        if (!bootstrap?.platform) {
            return;
        }
        document.documentElement.setAttribute(
            "data-platform",
            bootstrap.platform,
        );
    }, [bootstrap?.platform]);

    const requestWorkspaceNavigation = useCallback(
        (projectId: string, worktreeId: string | null = null) => {
            void useWorkspaceStore.getState().requestWorkspaceNavigation(projectId, worktreeId);
        },
        [],
    );
    const openProjects = useCallback(() => {
        void (async () => {
            for (const projectId of await addProjects()) {
                await useWorkspaceStore.getState().requestWorkspaceNavigation(projectId);
            }
        })();
    }, [addProjects]);
    const openSettings = useCallback(() => {
        void window.comando.openSettingsWindow({
            projectId: activeProjectId,
        });
    }, [activeProjectId]);
    const quickOpen = useWorkspaceQuickOpen({
        activePaneId,
        activeProjectId,
        activeWorktreeId,
        openFileTab,
    });
    const openQuickOpenPalette = quickOpen.openPalette;

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (
                event.defaultPrevented ||
                !(event.metaKey || event.ctrlKey) ||
                event.altKey
            ) {
                return;
            }
            if (!event.shiftKey && event.key === ",") {
                event.preventDefault();
                openSettings();
                return;
            }
            if (isQuickOpenFileShortcut(event)) {
                event.preventDefault();
                openQuickOpenPalette();
                return;
            }
            if (
                !event.shiftKey &&
                event.key.toLowerCase() === "w" &&
                bootstrap?.platform !== "darwin"
            ) {
                const state = useWorkspaceStore.getState();
                const pane = findPaneById(state.rootNode, state.activePaneId);
                if (pane?.activeTabId) {
                    event.preventDefault();
                    void state.closeTab(pane.activeTabId);
                }
                return;
            }
            if (
                event.shiftKey &&
                event.key.toLowerCase() === "e" &&
                activeContext
            ) {
                const state = useWorkspaceStore.getState();
                const pane = findPaneById(state.rootNode, state.activePaneId);
                const tab = pane?.activeTabId
                    ? state.tabsById[pane.activeTabId]
                    : null;
                if (tab?.kind === "file" && tab.projectId) {
                    event.preventDefault();
                    void window.comando.revealWorkspaceSurfaceFileInHostTree({
                        contextKey: activeContext.key,
                        projectId: tab.projectId,
                        relativePath: tab.relativePath,
                        worktreeId: tab.worktreeId ?? null,
                    });
                }
            }
        };
        window.addEventListener("keydown", handleKeyDown, true);
        return () => window.removeEventListener("keydown", handleKeyDown, true);
    }, [
        activeContext,
        bootstrap?.platform,
        openSettings,
        openQuickOpenPalette,
    ]);

    const recentProjects = useMemo(
        () =>
            projects
                .filter((project) => project.id !== activeProjectId)
                .toSorted((left, right) =>
                    (right.lastOpenedAt ?? "").localeCompare(
                        left.lastOpenedAt ?? "",
                    ),
                )
                .slice(0, 6)
                .map((project) => ({ id: project.id, name: project.name })),
        [activeProjectId, projects],
    );

    if (!descriptor) {
        return <SurfaceError message="The workspace surface binding is invalid." />;
    }
    if (surfaceStatus === "loading") {
        return <SurfaceRestoreSkeleton />;
    }
    if (surfaceStatus === "error") {
        return (
            <SurfaceError
                message={workspaceError ?? projectsError ?? "Could not restore workspace."}
            />
        );
    }

    return (
        <div
            className="h-screen min-h-0 text-text-primary"
            data-platform={bootstrap?.platform ?? undefined}
        >
            <SidebarGitScopePicker
                externalMenuRequest={gitScopeMenuRequest}
                projectId={activeProjectId}
                triggerHidden
                worktreeId={activeWorktreeId}
            />
            <main
                className="surface-focus h-full min-h-0 bg-bg-primary"
                onFocus={() => {
                    void window.comando.notifyWorkspaceSurfaceFocused();
                }}
                onPointerDown={() => {
                    void window.comando.notifyWorkspaceSurfaceFocused();
                }}
                tabIndex={0}
            >
                <WorkspaceTerminalHost
                    presentationActive={surfaceLifecycle === "visible"}
                />
                <WorkspaceView
                    defaultProjectId={activeProjectId}
                    defaultWorktreeId={activeWorktreeId}
                    onOpenProject={(projectId) => requestWorkspaceNavigation(projectId)}
                    onOpenProjects={openProjects}
                    onRequestCreateFile={() => undefined}
                    presentationActive={surfaceLifecycle === "visible"}
                    recentProjects={recentProjects}
                    runtimeCatalog={runtimeCatalog}
                />
            </main>
            <QuickOpenFilePalette
                loading={quickOpen.loading}
                onChangeQuery={quickOpen.onChangeQuery}
                onClose={quickOpen.close}
                onHoverIndex={quickOpen.onHoverIndex}
                onInputKeyDown={quickOpen.onInputKeyDown}
                onSelect={(item) => {
                    void quickOpen.select(item);
                }}
                open={quickOpen.open}
                projectName={
                    projects.find((project) => project.id === activeProjectId)
                        ?.name ?? null
                }
                query={quickOpen.query}
                results={quickOpen.results}
                selectedIndex={quickOpen.selectedIndex}
            />
        </div>
    );
}

function SurfaceRestoreSkeleton() {
    return (
        <main
            aria-busy="true"
            aria-label="Restoring workspace"
            className="flex h-screen min-h-0 flex-col bg-bg-primary p-4"
        >
            <div className="mb-4 h-7 w-52 animate-pulse rounded bg-bg-tertiary" />
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_12rem] gap-4">
                <div className="animate-pulse rounded-md border border-border bg-bg-secondary" />
                <div className="flex animate-pulse flex-col gap-3 rounded-md border border-border bg-bg-secondary p-3">
                    <div className="h-4 w-3/4 rounded bg-bg-tertiary" />
                    <div className="h-4 w-full rounded bg-bg-tertiary" />
                    <div className="h-4 w-5/6 rounded bg-bg-tertiary" />
                </div>
            </div>
            <span className="sr-only">Restoring workspace…</span>
        </main>
    );
}

function SurfaceError({ message }: { readonly message: string }) {
    return (
        <main className="flex h-screen items-center justify-center bg-bg-primary px-6 text-center text-xs text-text-secondary">
            {message}
        </main>
    );
}
