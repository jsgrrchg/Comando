import {
    Profiler,
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
    type RefObject,
    type WheelEvent,
} from "react";

import type {
    AiAvailableCommand,
    AiFileContextAttachment,
    AiImageAttachment,
    AiMessage,
    AiToolActivity,
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
    AiTranscriptPayload,
    AiUserInputRequest,
    AiSessionSnapshot,
    ProjectTreeNode,
} from "@shared/ipc";
import {
    getImageAttachmentLimitMessage,
    MAX_IMAGE_ATTACHMENTS,
    MAX_IMAGE_ATTACHMENT_BYTES,
} from "@shared/ai-attachments";
import { deriveTrackedFilesFromActionLog } from "@shared/ai-review-action-log";
import { resolveEditorLanguage } from "@shared/editor-language";

import { useShallow } from "zustand/react/shallow";

import { DEFAULT_AI_DIFF_ZOOM } from "@renderer/app/ai/sessionReviewContracts";
import {
    createReviewFileMutationInput,
    createReviewHunkMutationInput,
} from "@renderer/app/ai/reviewMutationTarget";
import {
    createEmptyAiSessionTranscriptModel,
    buildAiSessionTranscriptModel,
    getAiSessionTranscriptMessages,
    getAiSessionTranscriptToolActivity,
    type AiSessionTranscriptModel,
} from "@renderer/app/ai/transcriptModel";
import { getGitContextKey } from "@renderer/app/git/context-key";
import { useAiChatSettings } from "@renderer/app/hooks/use-ai-chat-settings";
import { buildChatFontFamily } from "@renderer/app/settings/theme";
import { useAiStore } from "@renderer/app/store/ai-store";
import { chatActivationScheduler } from "@renderer/app/workspace/chatActivationScheduler";
import { useGitStore } from "@renderer/app/store/git-store";
import { useFileReferenceValidator } from "@renderer/app/store/projectFileIndexStore";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import { useRenderProbe } from "@renderer/app/debug/renderProbe";
import { getRendererTaskScheduler } from "@renderer/app/runtime/renderer-task-scheduler";
import {
    isChatPerformanceProbeEnabled,
    measureChatPerformance,
    recordChatPerformanceMetric,
} from "@renderer/app/debug/chatPerformanceProbe";
import type {
    RuntimeWorkspaceChatTab,
    RuntimeWorkspaceFileOpenLocation,
    RuntimeWorkspaceFileReviewContext,
} from "@renderer/app/workspace/tree";
import type { MeasuredVirtualRange } from "@renderer/components/virtual/MeasuredVirtualList";

import { AIChatAgentControls } from "./AIChatAgentControls";
import { LanguageIcon } from "./LanguageIcon";
import { AIChatComposer } from "./chat/AIChatComposer";
import { AIChatContextUsageBar } from "./chat/AIChatContextUsageBar";
import { ChatContentColumn } from "./chat/ChatContentColumn";
import { ChatTimelineHistoryRows } from "./chat/ChatTimelineHistoryRows";
import { ToolExpansionStoreProvider } from "./chat/toolExpansionStore";
import { ChatMessageRow } from "./chat/ChatMessageRow";
import { CHAT_PILL_VARIANTS } from "./chat/chatPillPalette";
import {
    reconcileChatTimelineModelIncrementallyFromTranscript,
    type ChatTimelineModel,
    type ChatTimelineRow,
} from "./chat/chatTimelineModel";
import {
    cacheChatTimeline,
    getCachedChatTimeline,
} from "./chat/chatTimelineCache";
import {
    isActiveChatTurnStatus,
    isChatStreamingStatus,
} from "./chat/chatTurnStatus";
import { getChatSessionPreparationKey } from "./chat/chatSessionPreparation";
import {
    isScrollViewportNearBottom,
    resolveChatScrollPersistenceState,
} from "./chat/chatScroll";
import type { AIComposerPart } from "./chat/composerParts";
import {
    appendSelectionMentionPart,
    composerPartsToPlainText,
    createEmptyComposerParts,
    serializeComposerPartsForPrompt,
} from "./chat/composerParts";
import { registerComposerSelectionMentionHandler } from "./chat/composerSelectionBridge";
import {
    persistChatViewState,
    readPersistedChatViewState,
} from "./chat/chatViewPersistence";
import { EditedFilesBufferPanel } from "./chat/EditedFilesBufferPanel";
import { PlanMessage } from "./chat/PlanMessage";
import { shouldShowPlanBanner } from "./chat/planBannerState";
import {
    buildFileContextLabel,
    buildFileContextTitle,
    serializePromptWithContexts,
} from "./chat/promptContextReferences";
import { QueuedMessagesPanel } from "./chat/QueuedMessagesPanel";
import { ToolActivitySegment } from "./chat/ToolActivitySegment";
import { ToolActivityItem } from "./chat/ToolActivityItem";
import { TimelineBlockCache } from "./chat/timelineBlocks";
import { captureTranscriptSemanticAnchor } from "./chat/transcriptBlockVirtualization";
import { requestStopAgentSession } from "./chat/aiSessionLifecycle";
import {
    collectProjectFileRoots,
    resolveProjectFileReference,
    type ResolvedProjectFileReference,
} from "./projectFileReferences";
import {
    deriveReviewItems,
    deriveReviewSummary,
    isReviewConflictFile,
    isReviewUnresolvedFile,
    type ReviewFileItem,
} from "./review/editedFilesPresentationModel";

/* ─── Types ─── */

interface ChatTabViewProps {
    readonly active: boolean;
    readonly onDraftChange: (tabId: string, draft: string) => void;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onOpenReview: () => Promise<void>;
    readonly tab: RuntimeWorkspaceChatTab;
}

function ChatPerformanceProfiler({
    children,
    enabled,
    id,
    onRender,
}: {
    readonly children: ReactNode;
    readonly enabled: boolean;
    readonly id: string;
    readonly onRender: (
        id: string,
        phase: "mount" | "nested-update" | "update",
        actualDuration: number,
        baseDuration: number,
        startTime: number,
        commitTime: number,
    ) => void;
}) {
    return enabled ? <Profiler id={id} onRender={onRender}>{children}</Profiler> : children;
}

type ChatSessionViewState = Pick<
    ReturnType<typeof useAiStore.getState>["sessions"][string],
    | "dismissedPlanUpdatedAt"
    | "draftAttachments"
    | "draftComposerParts"
    | "draftFileContexts"
    | "editingQueuedPrompt"
    | "localError"
    | "queue"
    | "snapshot"
    | "transcript"
    | "transcriptWindow"
>;

function selectChatSessionViewState(
    state: ReturnType<typeof useAiStore.getState>,
    sessionId: string,
): ChatSessionViewState | null {
    const session = state.sessions[sessionId];
    if (!session) {
        return null;
    }

    return {
        dismissedPlanUpdatedAt: session.dismissedPlanUpdatedAt,
        draftAttachments: session.draftAttachments,
        draftComposerParts: session.draftComposerParts,
        draftFileContexts: session.draftFileContexts,
        editingQueuedPrompt: session.editingQueuedPrompt,
        localError: session.localError,
        queue: session.queue,
        snapshot: session.snapshot,
        transcript: session.transcript,
        transcriptWindow: session.transcriptWindow,
    };
}

/* ─── Constants ─── */

const FALLBACK_COMMANDS: readonly AiAvailableCommand[] = [
    {
        description:
            "Ask the active runtime to create or update the working plan.",
        id: "plan",
        insertText: "/plan ",
        label: "/plan",
    },
];

const NEAR_BOTTOM_THRESHOLD = 80;
const BOTTOM_FOLLOW_SETTLE_FRAMES = 3;
const RESIZE_BOTTOM_SETTLE_FRAMES = 2;
const SCROLL_PERSIST_DELAY_MS = 80;
const EMPTY_DRAFT_ATTACHMENTS: readonly AiImageAttachment[] = [];
const EMPTY_COMPOSER_PARTS: readonly AIComposerPart[] =
    createEmptyComposerParts();
const EMPTY_DRAFT_FILE_CONTEXTS: readonly AiFileContextAttachment[] = [];
const EMPTY_TRANSCRIPT_MODEL = createEmptyAiSessionTranscriptModel();
const CLOSED_SUBAGENT_MESSAGE =
    "This subagent was closed by its parent thread and can’t receive new messages.";
const PROJECT_MENTION_SEARCH_FOLLOWUP_DEBOUNCE_MS = 50;
const transcriptTimelineBlockCache = new TimelineBlockCache();

type AiRuntimeCatalog = Pick<
    AiSessionSnapshot,
    | "availableCommands"
    | "configOptions"
    | "modeId"
    | "modes"
    | "modelId"
    | "models"
>;

interface AgentControlDiscoveryAttempt {
    readonly attemptCount: number;
    readonly status: "completed" | "exhausted" | "idle" | "loading" | "retrying";
}

const MAX_AGENT_CONTROL_DISCOVERY_ATTEMPTS = 3;
const AGENT_CONTROL_DISCOVERY_RETRY_DELAY_MS = 250;

function hasAgentControlCatalog(
    catalog: AiRuntimeCatalog | null | undefined,
): boolean {
    return Boolean(
        catalog &&
        (catalog.configOptions.length > 0 ||
            catalog.models.length > 0 ||
            catalog.modes.length > 0),
    );
}

/* ─── Main component ─── */

export const ChatTabView = memo(function ChatTabView({
    active,
    onDraftChange,
    onOpenFile,
    onOpenImage,
    onOpenReview,
    tab,
}: ChatTabViewProps) {
    const aiChatSettings = useAiChatSettings();
    const cancelQueuedPromptEdit = useAiStore((s) => s.cancelQueuedPromptEdit);
    const clearQueuedPrompts = useAiStore((s) => s.clearQueuedPrompts);
    const ensureSession = useAiStore((s) => s.ensureSession);
    const hydrateTranscriptWindow = useAiStore(
        (s) => s.hydrateTranscriptWindow,
    );
    const prefetchTranscriptWindow = useAiStore(
        (s) => s.prefetchTranscriptWindow,
    );
    const editQueuedPrompt = useAiStore((s) => s.editQueuedPrompt);
    const refreshRuntimeStatus = useAiStore((s) => s.refreshRuntimeStatus);
    const registerSessionTab = useAiStore((s) => s.registerSessionTab);
    const removeQueuedPrompt = useAiStore((s) => s.removeQueuedPrompt);
    const respondPermission = useAiStore((s) => s.respondPermission);
    const respondUserInput = useAiStore((s) => s.respondUserInput);
    const addDraftFileContext = useAiStore((s) => s.addDraftFileContext);
    const clearDraftAttachments = useAiStore((s) => s.clearDraftAttachments);
    const dismissSessionPlan = useAiStore((s) => s.dismissSessionPlan);

    const keepAllTrackedFiles = useAiStore((s) => s.keepAllTrackedFiles);
    const keepTrackedFile = useAiStore((s) => s.keepTrackedFile);
    const keepTrackedFileHunks = useAiStore((s) => s.keepTrackedFileHunks);
    const removeDraftFileContext = useAiStore((s) => s.removeDraftFileContext);
    const clearDraftFileContexts = useAiStore((s) => s.clearDraftFileContexts);
    const rejectAllTrackedFiles = useAiStore((s) => s.rejectAllTrackedFiles);
    const rejectTrackedFile = useAiStore((s) => s.rejectTrackedFile);
    const rejectTrackedFileHunks = useAiStore((s) => s.rejectTrackedFileHunks);
    const renameSession = useAiStore((s) => s.renameSession);
    const markChatTabFocused = useWorkspaceStore(
        (state) => state.markChatTabFocused,
    );
    const openChatSessionTab = useWorkspaceStore(
        (state) => state.openChatSessionTab,
    );
    const setSessionConfigOption = useAiStore((s) => s.setSessionConfigOption);
    const setSessionMode = useAiStore((s) => s.setSessionMode);
    const setSessionModel = useAiStore((s) => s.setSessionModel);
    const setDraftComposerParts = useAiStore((s) => s.setDraftComposerParts);
    const setDraftAttachments = useAiStore((s) => s.setDraftAttachments);
    const sendQueuedPromptNow = useAiStore((s) => s.sendQueuedPromptNow);
    const sendPrompt = useAiStore((s) => s.sendPrompt);
    const runtimeCatalog = useAiStore(
        (s) => s.runtimeCatalogById[tab.runtimeId] ?? null,
    );
    const frozenSessionStateRef = useRef<ChatSessionViewState | null>(null);
    const sessionState = useAiStore(
        useShallow((s) => {
            if (!active) {
                return frozenSessionStateRef.current;
            }

            return selectChatSessionViewState(s, tab.sessionId);
        }),
    );
    useEffect(() => {
        if (active) {
            frozenSessionStateRef.current = sessionState;
        }
    }, [active, sessionState]);
    const projectSummary = useProjectsStore((state) =>
        tab.projectId
            ? (state.projects.find((project) => project.id === tab.projectId) ??
              null)
            : null,
    );
    // Validates that a chat file reference points at a real file in this tab's
    // project before it is rendered as a clickable pill.
    const canRenderFileReference = useFileReferenceValidator(
        tab.projectId ?? null,
        tab.worktreeId ?? null,
    );
    const gitSnapshot = useGitStore((state) => {
        if (!tab.projectId) {
            return null;
        }

        return (
            state.snapshots[
                getGitContextKey(tab.projectId, tab.worktreeId ?? null)
            ] ?? null
        );
    });
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const timelineContentRef = useRef<HTMLDivElement | null>(null);
    const shouldAutoFollowRef = useRef(true);
    const pendingScrollFrameRef = useRef<number | null>(null);
    const restoreScrollFrameRef = useRef<number | null>(null);
    const bottomFollowSettleFrameRef = useRef<number | null>(null);
    const bottomFollowSettleActiveRef = useRef(false);
    const resizeBottomSettleFrameRef = useRef<number | null>(null);
    const resizeBottomLockRef = useRef(false);
    const resizeStartedNearBottomRef = useRef(false);
    const scrollPersistTimerRef = useRef<number | null>(null);
    const pendingPersistedScrollTopRef = useRef<number | null>(null);
    const pendingPersistedNearBottomRef = useRef<boolean | null>(null);
    const hasActivatedViewRef = useRef(false);
    const stableTimelineRef = useRef<{
        readonly activeTurnStartedAt: string | null;
        readonly attentionToolCallIds: ReadonlySet<string>;
        readonly model: ChatTimelineModel | null;
        readonly sessionId: string;
        readonly status: AiSessionSnapshot["status"] | null;
        readonly trackedFiles: AiSessionSnapshot["trackedFiles"] | null;
        readonly transcript: AiSessionTranscriptModel | null;
    }>({
        activeTurnStartedAt: null,
        attentionToolCallIds: new Set(),
        model: null,
        sessionId: tab.sessionId,
        status: null,
        trackedFiles: null,
        transcript: null,
    });
    const previousVirtualRangeRef = useRef<MeasuredVirtualRange | null>(null);
    const semanticAnchorRef = useRef<{
        readonly alignment: "center" | "end" | "start";
        readonly entryId: string;
        readonly offsetWithinEntry: number;
    } | null>(null);
    const initialComposerParts = readInitialComposerPartsForTab(tab);
    const composerPartsRef = useRef<AIComposerPart[]>(initialComposerParts);
    const persistedDraftRef = useRef(tab.draft);
    const lastSeenDraftComposerPartsSerializedRef = useRef("");

    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const titleInputRef = useRef<HTMLInputElement | null>(null);
    const skipTitleCommitRef = useRef(false);

    useEffect(() => {
        if (isEditingTitle) {
            titleInputRef.current?.focus();
            titleInputRef.current?.select();
        }
    }, [isEditingTitle]);

    useEffect(() => {
        persistedDraftRef.current = tab.draft;
    }, [tab.draft, tab.sessionId]);

    const flushChatDraft = useCallback(
        (draft: string) => {
            if (persistedDraftRef.current === draft) {
                return;
            }

            persistedDraftRef.current = draft;
            onDraftChange(tab.id, draft);
        },
        [onDraftChange, tab.id],
    );

    useEffect(() => {
        return () => {
            flushChatDraft(composerPartsToPlainText(composerPartsRef.current));
            setDraftComposerParts(
                tab.sessionId,
                cloneComposerPartsForDraft(composerPartsRef.current),
            );
        };
    }, [flushChatDraft, setDraftComposerParts, tab.sessionId]);

    const flushDraftComposerParts = useCallback(
        (parts: readonly AIComposerPart[]) => {
            const serialized = JSON.stringify(parts);
            lastSeenDraftComposerPartsSerializedRef.current = serialized;
            setDraftComposerParts(
                tab.sessionId,
                cloneComposerPartsForDraft(parts),
            );
        },
        [setDraftComposerParts, tab.sessionId],
    );

    const commitTitleEdit = useCallback(() => {
        if (skipTitleCommitRef.current) {
            skipTitleCommitRef.current = false;
            return;
        }
        const currentParentSessionId =
            useAiStore.getState().sessions[tab.sessionId]?.snapshot
                ?.parentSessionId ?? null;
        if (
            currentParentSessionId &&
            currentParentSessionId !== tab.sessionId
        ) {
            setIsEditingTitle(false);
            return;
        }

        const trimmed = titleDraft.trim();
        setIsEditingTitle(false);
        if (trimmed && trimmed !== tab.title) {
            void renameSession({
                sessionId: tab.sessionId,
                title: trimmed,
            });
        }
    }, [titleDraft, renameSession, tab.sessionId, tab.title]);

    const [composerParts, setComposerParts] = useState<AIComposerPart[]>(
        () => cloneComposerPartsForDraft(initialComposerParts),
    );
    const [composerExpanded, setComposerExpanded] = useState(false);
    const [composerResetNonce, setComposerResetNonce] = useState(0);
    const [showJumpToBottom, setShowJumpToBottom] = useState(false);
    const commitComposerParts = useCallback(
        (nextParts: readonly AIComposerPart[]) => {
            const clonedParts = cloneComposerPartsForDraft(nextParts);
            composerPartsRef.current = clonedParts;
            setComposerParts(clonedParts);
            flushChatDraft(composerPartsToPlainText(clonedParts));
            flushDraftComposerParts(clonedParts);
        },
        [flushChatDraft, flushDraftComposerParts],
    );
    const streamStartTimeRef = useRef<number | null>(null);
    const [elapsed, setElapsed] = useState("");
    const [composerError, setComposerError] = useState<string | null>(null);
    const sessionTab = useMemo(
        () => ({
            createdAt: tab.createdAt,
            draft: "",
            id: tab.id,
            kind: tab.kind,
            projectId: tab.projectId,
            runtimeId: tab.runtimeId,
            sessionOpenMode: tab.sessionOpenMode,
            sessionId: tab.sessionId,
            title: tab.title,
            worktreeId: tab.worktreeId ?? null,
        }),
        [
            tab.createdAt,
            tab.id,
            tab.kind,
            tab.projectId,
            tab.runtimeId,
            tab.sessionOpenMode,
            tab.sessionId,
            tab.title,
            tab.worktreeId,
        ],
    );
    const sessionPreparationKey = getChatSessionPreparationKey(sessionTab);
    const latestSessionTabRef = useRef(sessionTab);
    const agentControlDiscoveryAttemptsRef = useRef(
        new Map<string, AgentControlDiscoveryAttempt>(),
    );
    const agentControlDiscoveryMountedRef = useRef(true);
    const agentControlDiscoveryRetryTimersRef = useRef(new Set<number>());
    const [agentControlDiscoveryRetryNonce, setAgentControlDiscoveryRetryNonce] =
        useState(0);
    const liveSessionTab = useMemo(
        () => ({
            ...sessionTab,
            sessionOpenMode: "live" as const,
        }),
        [sessionTab],
    );
    const ensureLiveAgentSession = useCallback(
        async (force: boolean) => {
            const currentSession =
                useAiStore.getState().sessions[tab.sessionId] ?? null;
            if (
                !force &&
                currentSession?.runtimeState === "live" &&
                currentSession.snapshot?.runtimeSessionId
            ) {
                return;
            }

            await ensureSession(liveSessionTab, { force: true });
        },
        [ensureSession, liveSessionTab, tab.sessionId],
    );
    const agentControlMutationOptions = useMemo(
        () => ({ ensureLiveSession: ensureLiveAgentSession }),
        [ensureLiveAgentSession],
    );
    const runAgentControlMutation = useCallback(
        (mutation: () => Promise<void>) => {
            void mutation().catch((error: unknown) => {
                console.warn(
                    "[comando] Failed to update AI session control.",
                    error,
                );
            });
        },
        [],
    );

    useEffect(() => {
        latestSessionTabRef.current = sessionTab;
    }, [sessionTab]);

    useEffect(() => {
        agentControlDiscoveryMountedRef.current = true;
        const retryTimers = agentControlDiscoveryRetryTimersRef.current;
        return () => {
            agentControlDiscoveryMountedRef.current = false;
            for (const retryTimer of retryTimers) {
                window.clearTimeout(retryTimer);
            }
            retryTimers.clear();
        };
    }, []);

    useEffect(() => {
        registerSessionTab(sessionTab);
    }, [registerSessionTab, sessionTab]);

    useEffect(() => {
        if (
            active &&
            latestSessionTabRef.current.sessionOpenMode === "history"
        ) {
            void ensureSession(latestSessionTabRef.current);
        }
    }, [active, ensureSession, sessionPreparationKey]);

    useEffect(() => {
        if (!active) return;
        return chatActivationScheduler.activate(tab.id, async (phase) => {
            if (phase === "window") {
                await hydrateTranscriptWindow(tab.sessionId);
            }
            if (phase === "prefetch") {
                await prefetchTranscriptWindow(tab.sessionId, "backward");
            }
        });
    }, [
        active,
        hydrateTranscriptWindow,
        prefetchTranscriptWindow,
        tab.id,
        tab.sessionId,
    ]);

    const snapshot =
        sessionState?.snapshot ?? createEmptySnapshot(tab, runtimeCatalog);
    const storedTranscript =
        sessionState?.transcript ?? EMPTY_TRANSCRIPT_MODEL;
    const transcriptWindow = sessionState?.transcriptWindow ?? null;
    const transcript = useMemo(
        () =>
            transcriptWindow?.capabilityVersion
                ? buildBlockNativeTranscript(
                      storedTranscript,
                      transcriptWindow.blocksById,
                      transcriptWindow.metadata,
                      transcriptWindow.payloadsByRef,
                      snapshot,
                  )
                : storedTranscript,
        [
            snapshot,
            storedTranscript,
            transcriptWindow?.blocksById,
            transcriptWindow?.capabilityVersion,
            transcriptWindow?.metadata,
            transcriptWindow?.payloadsByRef,
        ],
    );
    const isStreaming = isChatStreamingStatus(snapshot.status);
    const activeTurnKey = isActiveChatTurnStatus(snapshot.status)
        ? tab.sessionId
        : null;
    const activeTurnStartedAt = getActiveTurnStartedAt(snapshot, transcript);
    const currentError = sessionState?.localError ?? snapshot.lastError;
    const availableCommands =
        snapshot.availableCommands.length > 0
            ? snapshot.availableCommands
            : runtimeCatalog?.availableCommands.length
              ? runtimeCatalog.availableCommands
            : FALLBACK_COMMANDS;
    const agentConfigOptions =
        snapshot.configOptions.length > 0
            ? snapshot.configOptions
            : (runtimeCatalog?.configOptions ?? []);
    const agentModes =
        snapshot.modes.length > 0 ? snapshot.modes : (runtimeCatalog?.modes ?? []);
    const agentModels =
        snapshot.models.length > 0
            ? snapshot.models
            : (runtimeCatalog?.models ?? []);
    const agentModeId = snapshot.modeId ?? runtimeCatalog?.modeId ?? "";
    const agentModelId = snapshot.modelId ?? runtimeCatalog?.modelId ?? "";
    const draftAttachments =
        sessionState?.draftAttachments ?? EMPTY_DRAFT_ATTACHMENTS;
    const draftComposerParts =
        sessionState?.draftComposerParts ?? EMPTY_COMPOSER_PARTS;
    const draftFileContexts =
        sessionState?.draftFileContexts ?? EMPTY_DRAFT_FILE_CONTEXTS;
    const dismissedPlanUpdatedAt = sessionState?.dismissedPlanUpdatedAt ?? null;
    const editingQueuedPrompt = sessionState?.editingQueuedPrompt ?? null;
    const queuedPrompts = sessionState?.queue ?? [];
    const pendingPermission = snapshot.pendingPermission;
    const pendingUserInput = snapshot.pendingUserInput;
    const visiblePlan = shouldShowPlanBanner(
        snapshot.plan,
        dismissedPlanUpdatedAt,
    )
        ? snapshot.plan
        : null;
    const runtimeDisplayName = getRuntimeDisplayName(tab.runtimeId);
    const closedSubagentMessage =
        snapshot.parentSessionId &&
        snapshot.parentSessionId !== snapshot.sessionId &&
        snapshot.closedAt
            ? CLOSED_SUBAGENT_MESSAGE
            : null;
    const parentSessionId =
        snapshot.parentSessionId && snapshot.parentSessionId !== tab.sessionId
            ? snapshot.parentSessionId
            : null;
    const parentSessionContext = useAiStore(
        useShallow((state) => {
            if (!parentSessionId) {
                return null;
            }

            const parent = state.sessions[parentSessionId];
            return {
                projectId:
                    parent?.snapshot?.projectId ??
                    parent?.meta?.projectId ??
                    tab.projectId,
                runtimeId:
                    parent?.snapshot?.runtimeId ??
                    parent?.meta?.runtimeId ??
                    tab.runtimeId,
                title:
                    parent?.snapshot?.title ??
                    parent?.meta?.title ??
                    "parent thread",
                worktreeId:
                    parent?.snapshot?.worktreeId ??
                    parent?.meta?.worktreeId ??
                    tab.worktreeId ??
                    null,
            };
        }),
    );
    const openAiSessionById = useCallback(
        async (sessionId: string) => {
            const session = useAiStore.getState().sessions[sessionId];
            let snapshot = session?.snapshot ?? null;

            if (!snapshot && window.comando) {
                snapshot = await window.comando.getAiSessionSnapshot(sessionId);
            }

            if (!snapshot && !session?.meta) {
                return;
            }

            await openChatSessionTab({
                projectId:
                    snapshot?.projectId ??
                    session?.meta?.projectId ??
                    tab.projectId,
                runtimeId:
                    snapshot?.runtimeId ??
                    session?.meta?.runtimeId ??
                    tab.runtimeId,
                sessionOpenMode: tab.sessionOpenMode,
                sessionId,
                title: snapshot?.title ?? session?.meta?.title ?? "Chat",
                worktreeId:
                    snapshot?.worktreeId ??
                    session?.meta?.worktreeId ??
                    tab.worktreeId ??
                    null,
            });
        },
        [
            openChatSessionTab,
            tab.projectId,
            tab.runtimeId,
            tab.sessionOpenMode,
            tab.worktreeId,
        ],
    );

    useEffect(() => {
        if (lastSeenDraftComposerPartsSerializedRef.current.length > 0) {
            return;
        }

        lastSeenDraftComposerPartsSerializedRef.current =
            JSON.stringify(draftComposerParts);
    }, [draftComposerParts]);

    const chatFontFamily = useMemo(
        () => buildChatFontFamily(aiChatSettings.chatFontFamily),
        [aiChatSettings.chatFontFamily],
    );
    const composerFontFamily = useMemo(
        () => buildChatFontFamily(aiChatSettings.composerFontFamily),
        [aiChatSettings.composerFontFamily],
    );
    const hasAgentControls =
        agentConfigOptions.length > 0 ||
        agentModels.length > 0 ||
        agentModes.length > 0;

    useEffect(() => {
        const discoveryKey = `${tab.sessionId}:${tab.runtimeId}`;
        const previousAttempt =
            agentControlDiscoveryAttemptsRef.current.get(discoveryKey);
        if (
            !active ||
            latestSessionTabRef.current.sessionOpenMode === "history" ||
            hasAgentControls ||
            previousAttempt?.status === "completed" ||
            previousAttempt?.status === "exhausted" ||
            previousAttempt?.status === "loading" ||
            previousAttempt?.status === "retrying"
        ) {
            return;
        }

        const attemptCount = (previousAttempt?.attemptCount ?? 0) + 1;
        agentControlDiscoveryAttemptsRef.current.set(discoveryKey, {
            attemptCount,
            status: "loading",
        });
        void (async () => {
            try {
                if (!runtimeCatalog) {
                    await refreshRuntimeStatus(tab.runtimeId);
                }

                const state = useAiStore.getState();
                const currentSnapshot =
                    state.sessions[tab.sessionId]?.snapshot ?? null;
                const currentCatalog =
                    state.runtimeCatalogById[tab.runtimeId] ?? null;
                if (
                    hasAgentControlCatalog(currentSnapshot) ||
                    hasAgentControlCatalog(currentCatalog)
                ) {
                    agentControlDiscoveryAttemptsRef.current.set(discoveryKey, {
                        attemptCount,
                        status: "completed",
                    });
                    return;
                }

                // A provider without a cached catalog must start once to
                // discover its controls before the first prompt.
                await ensureSession(liveSessionTab, { force: true });
                agentControlDiscoveryAttemptsRef.current.set(discoveryKey, {
                    attemptCount,
                    status: "completed",
                });
            } catch (error) {
                console.warn(
                    "[comando] Failed to load AI session controls.",
                    error,
                );
                if (!agentControlDiscoveryMountedRef.current) {
                    return;
                }

                if (
                    attemptCount >= MAX_AGENT_CONTROL_DISCOVERY_ATTEMPTS
                ) {
                    agentControlDiscoveryAttemptsRef.current.set(discoveryKey, {
                        attemptCount,
                        status: "exhausted",
                    });
                    return;
                }

                agentControlDiscoveryAttemptsRef.current.set(discoveryKey, {
                    attemptCount,
                    status: "retrying",
                });
                const retryTimer = window.setTimeout(() => {
                    agentControlDiscoveryRetryTimersRef.current.delete(
                        retryTimer,
                    );
                    const pendingAttempt =
                        agentControlDiscoveryAttemptsRef.current.get(
                            discoveryKey,
                        );
                    if (
                        !agentControlDiscoveryMountedRef.current ||
                        pendingAttempt?.attemptCount !== attemptCount ||
                        pendingAttempt.status !== "retrying"
                    ) {
                        return;
                    }

                    agentControlDiscoveryAttemptsRef.current.set(discoveryKey, {
                        attemptCount,
                        status: "idle",
                    });
                    setAgentControlDiscoveryRetryNonce((nonce) => nonce + 1);
                }, AGENT_CONTROL_DISCOVERY_RETRY_DELAY_MS * 2 ** (attemptCount - 1));
                agentControlDiscoveryRetryTimersRef.current.add(retryTimer);
            }
        })();
    }, [
        active,
        agentControlDiscoveryRetryNonce,
        ensureSession,
        hasAgentControls,
        liveSessionTab,
        refreshRuntimeStatus,
        runtimeCatalog,
        tab.runtimeId,
        tab.sessionId,
    ]);

    const canonicalTrackedFiles = useMemo(
        () =>
            snapshot.reviewActionLog?.sessionId === snapshot.sessionId
                ? deriveTrackedFilesFromActionLog(snapshot.reviewActionLog)
                : snapshot.trackedFiles,
        [snapshot.reviewActionLog, snapshot.sessionId, snapshot.trackedFiles],
    );
    const pendingTrackedFiles = useMemo(
        () => canonicalTrackedFiles.filter(isReviewUnresolvedFile),
        [canonicalTrackedFiles],
    );
    const projectFileRoots = useMemo(() => {
        const activeWorktreeRootPath = tab.worktreeId
            ? (gitSnapshot?.worktrees.find(
                  (worktree) => worktree.id === tab.worktreeId,
              )?.rootPath ?? null)
            : (gitSnapshot?.worktrees.find((worktree) => worktree.isCurrent)
                  ?.rootPath ??
              gitSnapshot?.worktrees.find((worktree) => worktree.isPrimary)
                  ?.rootPath ??
              null);

        return collectProjectFileRoots({
            canonicalProjectRoot: projectSummary?.canonicalRootPath,
            currentWorktreeRoot: activeWorktreeRootPath,
            projectRoot: projectSummary?.rootPath,
            repositoryCanonicalRoot: gitSnapshot?.canonicalRootPath,
            repositoryRoot: gitSnapshot?.rootPath,
        });
    }, [
        gitSnapshot?.canonicalRootPath,
        gitSnapshot?.rootPath,
        gitSnapshot?.worktrees,
        projectSummary?.canonicalRootPath,
        projectSummary?.rootPath,
        tab.worktreeId,
    ]);
    const resolvePendingReviewOpenPath = useCallback(
        (trackedFile: ReviewFileItem["file"]) =>
            trackedFile.kind === "delete"
                ? null
                : (resolveProjectFileReference(trackedFile.path, {
                      projectRoots: projectFileRoots,
                  })?.relativePath ?? null),
        [projectFileRoots],
    );
    const pendingReviewItems = useMemo(
        () =>
            deriveReviewItems(
                pendingTrackedFiles,
                resolvePendingReviewOpenPath,
            ),
        [pendingTrackedFiles, resolvePendingReviewOpenPath],
    );
    const pendingReviewSummary = useMemo(
        () => deriveReviewSummary(pendingReviewItems),
        [pendingReviewItems],
    );
    const pendingReviewCount = pendingReviewItems.length;
    const resolveChatFileReference = useCallback(
        (reference: string): ResolvedProjectFileReference | null => {
            if (!tab.projectId || projectFileRoots.length === 0) {
                return null;
            }

            return resolveProjectFileReference(reference, {
                projectRoots: projectFileRoots,
            });
        },
        [projectFileRoots, tab.projectId],
    );
    const handleOpenResolvedFileReference = useCallback(
        (reference: ResolvedProjectFileReference) => {
            if (!tab.projectId) {
                return;
            }

            if (reference.startLine !== null) {
                void onOpenFile(
                    tab.projectId,
                    reference.relativePath,
                    tab.worktreeId ?? null,
                    undefined,
                    {
                        endLine: reference.endLine,
                        startLine: reference.startLine,
                    },
                );
                return;
            }

            void onOpenFile(
                tab.projectId,
                reference.relativePath,
                tab.worktreeId ?? null,
            );
        },
        [onOpenFile, tab.projectId, tab.worktreeId],
    );
    const handleRevealResolvedFileReference = useCallback(
        (reference: ResolvedProjectFileReference) => {
            if (!tab.projectId) {
                return;
            }

            void getComandoApi().revealProjectEntry({
                projectId: tab.projectId,
                relativePath: reference.relativePath,
                worktreeId: tab.worktreeId ?? null,
            });
        },
        [tab.projectId, tab.worktreeId],
    );
    const handleAddResolvedFileReferenceToChat = useCallback(
        (reference: ResolvedProjectFileReference) => {
            if (!tab.projectId) {
                return;
            }

            const fileName =
                reference.relativePath.split("/").pop() ??
                reference.relativePath;
            const extension = fileName.includes(".")
                ? (fileName.split(".").pop() ?? null)
                : null;
            addDraftFileContext(tab.sessionId, {
                endLine: reference.endLine,
                extension,
                id: `file-ctx:${crypto.randomUUID()}`,
                languageId: resolveEditorLanguage({
                    filePath: reference.relativePath,
                }).id,
                name: fileName,
                projectId: tab.projectId,
                relativePath: reference.relativePath,
                startLine: reference.startLine,
            });
        },
        [addDraftFileContext, tab.projectId, tab.sessionId],
    );
    const diffZoom = DEFAULT_AI_DIFF_ZOOM;
    const hasComposerContext =
        pendingPermission !== null ||
        pendingUserInput !== null ||
        editingQueuedPrompt !== null ||
        queuedPrompts.length > 0 ||
        currentError !== null ||
        composerError !== null ||
        pendingReviewCount > 0;

    useEffect(() => {
        if (!active || activeTurnKey === null || activeTurnStartedAt === null) {
            streamStartTimeRef.current = null;
            let cancelled = false;
            queueMicrotask(() => {
                if (!cancelled) {
                    setElapsed("");
                }
            });
            return () => {
                cancelled = true;
            };
        }

        let cancelled = false;
        const startedAtMs = Date.parse(activeTurnStartedAt);
        streamStartTimeRef.current = Number.isFinite(startedAtMs)
            ? startedAtMs
            : Date.now();
        const updateElapsed = () => {
            if (cancelled) {
                return;
            }

            const startedAt = streamStartTimeRef.current;
            if (startedAt === null) return;
            const totalSec = Math.max(
                0,
                Math.floor((Date.now() - startedAt) / 1000),
            );
            const min = Math.floor(totalSec / 60);
            const sec = totalSec % 60;
            setElapsed(
                min > 0
                    ? `${min}m ${String(sec).padStart(2, "0")}s`
                    : `${sec}s`,
            );
        };
        queueMicrotask(updateElapsed);
        const interval = window.setInterval(updateElapsed, 500);
        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, [active, activeTurnKey, activeTurnStartedAt]);

    /* eslint-disable react-hooks/refs -- The timeline reconciler needs the last committed model to preserve row identity during render. */
    const attentionToolCallIds = useMemo(() => {
        const toolCallIds = new Set<string>();
        if (pendingPermission?.toolCallId) {
            toolCallIds.add(pendingPermission.toolCallId);
        }
        if (pendingUserInput?.toolCallId) {
            toolCallIds.add(pendingUserInput.toolCallId);
        }
        return toolCallIds;
    }, [pendingPermission?.toolCallId, pendingUserInput?.toolCallId]);
    const timelineModel = useMemo(() => {
        const cachedTimeline = getCachedChatTimeline({
            activeTurnStartedAt,
            attentionToolCallIds,
            sessionId: tab.sessionId,
            status: snapshot.status,
            trackedFiles: canonicalTrackedFiles,
            transcript,
        });
        if (cachedTimeline) {
            return cachedTimeline;
        }

        const previousTimelineState = stableTimelineRef.current;
        const previousTimelineModel =
            previousTimelineState.sessionId === tab.sessionId
                ? previousTimelineState.model
                : null;
        const canReconcileIncrementally =
            previousTimelineState.sessionId === tab.sessionId &&
            previousTimelineState.activeTurnStartedAt === activeTurnStartedAt &&
            previousTimelineState.attentionToolCallIds === attentionToolCallIds &&
            previousTimelineState.status === snapshot.status &&
            previousTimelineState.trackedFiles === canonicalTrackedFiles;
        return measureChatPerformance(
            "timeline_reconcile_ms",
            {
                sessionId: tab.sessionId,
                values: {
                    liveTailChars: transcript.messageOrder.length,
                    transcriptRows: transcript.orderedEntryIds.length,
                },
            },
            () =>
                reconcileChatTimelineModelIncrementallyFromTranscript(
                    previousTimelineModel,
                    canReconcileIncrementally
                        ? previousTimelineState.transcript
                        : null,
                    {
                        activeTurnStartedAt,
                        attentionToolCallIds,
                        status: snapshot.status,
                        trackedFiles: canonicalTrackedFiles,
                        transcript,
                    },
                ),
        );
    }, [
        activeTurnStartedAt,
        attentionToolCallIds,
        canonicalTrackedFiles,
        snapshot.status,
        tab.sessionId,
        transcript,
    ]);
    /* eslint-enable react-hooks/refs */
    // Commit the reconciled timeline to the ref after render so StrictMode's
    // double-render cannot leave a stale/discarded model written during memo.
    useEffect(() => {
        stableTimelineRef.current = {
            activeTurnStartedAt,
            attentionToolCallIds,
            model: timelineModel,
            sessionId: tab.sessionId,
            status: snapshot.status,
            trackedFiles: canonicalTrackedFiles,
            transcript,
        };
        cacheChatTimeline({
            activeTurnStartedAt,
            attentionToolCallIds,
            model: timelineModel,
            sessionId: tab.sessionId,
            status: snapshot.status,
            trackedFiles: canonicalTrackedFiles,
            transcript,
        });
    }, [
        activeTurnStartedAt,
        attentionToolCallIds,
        canonicalTrackedFiles,
        snapshot.status,
        tab.sessionId,
        timelineModel,
        transcript,
    ]);
    const persistedViewState = useMemo(
        () =>
            readPersistedChatViewState(
                tab.projectId,
                tab.worktreeId ?? null,
                tab.sessionId,
            ),
        [tab.projectId, tab.sessionId, tab.worktreeId],
    );
    const persistedViewStateRef = useRef<{
        readonly isNearBottom: boolean;
        readonly scrollTop: number;
    } | null>(persistedViewState);

    useEffect(() => {
        persistedViewStateRef.current = persistedViewState;
    }, [persistedViewState]);

    useRenderProbe("ChatTabView", {
        composerPartCount: composerParts.length,
        hasComposerContext,
        pendingReviewCount,
        queuedPrompts: queuedPrompts.length,
        sessionId: tab.sessionId,
        timelineRows: timelineModel.orderedRows.length,
    });

    const isNearBottom = useCallback((el: HTMLDivElement) => {
        return isScrollViewportNearBottom(
            el.scrollTop,
            el.scrollHeight,
            el.clientHeight,
            NEAR_BOTTOM_THRESHOLD,
        );
    }, []);

    const scrollToBottom = useCallback(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, []);

    const cancelPendingScrollToBottom = useCallback(() => {
        if (pendingScrollFrameRef.current === null) {
            return;
        }

        window.cancelAnimationFrame(pendingScrollFrameRef.current);
        pendingScrollFrameRef.current = null;
    }, []);

    const cancelBottomFollowSettle = useCallback(() => {
        bottomFollowSettleActiveRef.current = false;

        if (bottomFollowSettleFrameRef.current === null) {
            return;
        }

        window.cancelAnimationFrame(bottomFollowSettleFrameRef.current);
        bottomFollowSettleFrameRef.current = null;
    }, []);

    const scheduleBottomFollowSettle = useCallback(() => {
        if (bottomFollowSettleFrameRef.current !== null) {
            window.cancelAnimationFrame(bottomFollowSettleFrameRef.current);
            bottomFollowSettleFrameRef.current = null;
        }

        bottomFollowSettleActiveRef.current = true;

        const runSettleFrame = (remainingFrames: number) => {
            bottomFollowSettleFrameRef.current = window.requestAnimationFrame(
                () => {
                    bottomFollowSettleFrameRef.current = null;

                    if (
                        !bottomFollowSettleActiveRef.current ||
                        !shouldAutoFollowRef.current
                    ) {
                        bottomFollowSettleActiveRef.current = false;
                        return;
                    }

                    scrollToBottom();

                    if (remainingFrames > 1) {
                        runSettleFrame(remainingFrames - 1);
                        return;
                    }

                    bottomFollowSettleActiveRef.current = false;
                },
            );
        };

        runSettleFrame(BOTTOM_FOLLOW_SETTLE_FRAMES);
    }, [scrollToBottom]);

    const cancelResizeBottomSettle = useCallback(() => {
        if (resizeBottomSettleFrameRef.current === null) {
            return;
        }

        window.cancelAnimationFrame(resizeBottomSettleFrameRef.current);
        resizeBottomSettleFrameRef.current = null;
    }, []);

    const scheduleScrollToBottom = useCallback(() => {
        cancelPendingScrollToBottom();
        bottomFollowSettleActiveRef.current = true;

        pendingScrollFrameRef.current = window.requestAnimationFrame(() => {
            pendingScrollFrameRef.current = null;
            scrollToBottom();
            scheduleBottomFollowSettle();
        });
    }, [
        cancelPendingScrollToBottom,
        scheduleBottomFollowSettle,
        scrollToBottom,
    ]);

    const handleTimelineVirtualRangeChange = useCallback((range: MeasuredVirtualRange) => {
        semanticAnchorRef.current = captureTranscriptSemanticAnchor({
            entryId: timelineModel.historyRows[range.visibleStartIndex]?.id ?? null,
        });
        recordChatPerformanceMetric("virtual_range", {
            sessionId: tab.sessionId,
            values: {
                mountedRows: Math.max(0, range.endIndex - range.startIndex + 1),
                visibleRows: Math.max(
                    0,
                    range.visibleEndIndex - range.visibleStartIndex + 1,
                ),
            },
        });
        if (shouldAutoFollowRef.current) {
            scheduleScrollToBottom();
        } else if (
            transcriptWindow?.capabilityVersion &&
            range.visibleStartIndex === 0 &&
            previousVirtualRangeRef.current?.visibleStartIndex !== 0
        ) {
            void prefetchTranscriptWindow(tab.sessionId, "backward");
        }
        previousVirtualRangeRef.current = range;
    }, [
        prefetchTranscriptWindow,
        scheduleScrollToBottom,
        tab.sessionId,
        timelineModel.historyRows,
        transcriptWindow?.capabilityVersion,
    ]);

    const handleTimelineVirtualResizeAutoFollow = useCallback(() => {
        scheduleScrollToBottom();
        setShowJumpToBottom(false);
    }, [scheduleScrollToBottom]);

    const shouldPreserveTimelineVirtualResizeAnchor = useCallback(() => {
        return !resizeBottomLockRef.current && !shouldAutoFollowRef.current;
    }, []);

    const shouldPreserveTimelineVirtualMeasureAnchor = useCallback(() => {
        return !resizeBottomLockRef.current;
    }, []);

    const persistCurrentViewState = useCallback(
        (overrides?: {
            readonly isNearBottom?: boolean;
            readonly scrollTop?: number;
        }) => {
            const scrollEl = scrollRef.current;
            const previousViewState = persistedViewStateRef.current;
            const scrollTop =
                overrides?.scrollTop ??
                scrollEl?.scrollTop ??
                previousViewState?.scrollTop ??
                0;
            const nextIsNearBottom =
                overrides?.isNearBottom ??
                (scrollEl
                    ? isNearBottom(scrollEl)
                    : previousViewState?.isNearBottom ?? true);

            // Retained chat views do not remount between tab switches, so keep
            // the latest persisted position in memory for the next activation.
            persistedViewStateRef.current = {
                isNearBottom: nextIsNearBottom,
                scrollTop,
            };

            persistChatViewState(
                tab.projectId,
                tab.worktreeId ?? null,
                tab.sessionId,
                {
                    anchor: semanticAnchorRef.current,
                    isNearBottom: nextIsNearBottom,
                    scrollTop,
                },
            );
        },
        [
            isNearBottom,
            tab.projectId,
            tab.sessionId,
            tab.worktreeId,
        ],
    );

    const flushScheduledScrollPersist = useCallback((): {
        readonly isNearBottom: boolean | null;
        readonly scrollTop: number | null;
    } | null => {
        if (scrollPersistTimerRef.current !== null) {
            window.clearTimeout(scrollPersistTimerRef.current);
            scrollPersistTimerRef.current = null;
        }

        const pendingState =
            pendingPersistedScrollTopRef.current !== null ||
            pendingPersistedNearBottomRef.current !== null
                ? {
                      isNearBottom: pendingPersistedNearBottomRef.current,
                      scrollTop: pendingPersistedScrollTopRef.current,
                  }
                : null;

        if (pendingState) {
            persistCurrentViewState({
                isNearBottom: pendingState.isNearBottom ?? undefined,
                scrollTop: pendingState.scrollTop ?? undefined,
            });
        }

        pendingPersistedNearBottomRef.current = null;
        pendingPersistedScrollTopRef.current = null;

        return pendingState;
    }, [persistCurrentViewState]);

    const scheduleScrollPersist = useCallback(
        (scrollTop: number, nextIsNearBottom: boolean) => {
            pendingPersistedScrollTopRef.current = scrollTop;
            pendingPersistedNearBottomRef.current = nextIsNearBottom;

            if (scrollPersistTimerRef.current !== null) {
                return;
            }

            scrollPersistTimerRef.current = window.setTimeout(() => {
                scrollPersistTimerRef.current = null;

                persistCurrentViewState({
                    isNearBottom:
                        pendingPersistedNearBottomRef.current ??
                        nextIsNearBottom,
                    scrollTop:
                        pendingPersistedScrollTopRef.current ?? scrollTop,
                });

                pendingPersistedNearBottomRef.current = null;
                pendingPersistedScrollTopRef.current = null;
            }, SCROLL_PERSIST_DELAY_MS);
        },
        [persistCurrentViewState],
    );

    // When a splitter drag starts at the bottom, bottom-follow is the user's
    // intent. Keep that intent alive while virtual rows re-measure at the
    // released width, then settle to the final bottom over a couple of frames.
    const settleResizeScrollToBottom = useCallback(() => {
        cancelResizeBottomSettle();

        shouldAutoFollowRef.current = true;
        scrollToBottom();

        const runSettleFrame = (remainingFrames: number) => {
            resizeBottomSettleFrameRef.current = window.requestAnimationFrame(
                () => {
                    resizeBottomSettleFrameRef.current = null;
                    shouldAutoFollowRef.current = true;
                    scrollToBottom();

                    if (remainingFrames > 1) {
                        runSettleFrame(remainingFrames - 1);
                        return;
                    }

                    const scrollEl = scrollRef.current;
                    if (scrollEl) {
                        scheduleScrollPersist(scrollEl.scrollTop, true);
                    }
                    resizeBottomLockRef.current = false;
                    resizeStartedNearBottomRef.current = false;
                },
            );
        };

        runSettleFrame(RESIZE_BOTTOM_SETTLE_FRAMES);
    }, [cancelResizeBottomSettle, scheduleScrollPersist, scrollToBottom]);

    const handleTimelineVirtualResizeStart = useCallback(() => {
        cancelResizeBottomSettle();

        const scrollEl = scrollRef.current;
        const startedNearBottom =
            shouldAutoFollowRef.current ||
            (scrollEl ? isNearBottom(scrollEl) : false);

        resizeStartedNearBottomRef.current = startedNearBottom;
        resizeBottomLockRef.current = startedNearBottom;

        if (startedNearBottom) {
            shouldAutoFollowRef.current = true;
        }
    }, [cancelResizeBottomSettle, isNearBottom]);

    const handleTimelineVirtualResizeEnd = useCallback(() => {
        if (resizeStartedNearBottomRef.current) {
            settleResizeScrollToBottom();
            return;
        }

        resizeBottomLockRef.current = false;
        resizeStartedNearBottomRef.current = false;
    }, [settleResizeScrollToBottom]);

    const handleTimelineWheelCapture = useCallback(
        (event: WheelEvent<HTMLDivElement>) => {
            if (event.deltaY >= 0 || !shouldAutoFollowRef.current) {
                return;
            }

            cancelPendingScrollToBottom();
            cancelBottomFollowSettle();
            cancelResizeBottomSettle();
            shouldAutoFollowRef.current = false;
            resizeBottomLockRef.current = false;
            resizeStartedNearBottomRef.current = false;
        },
        [
            cancelBottomFollowSettle,
            cancelPendingScrollToBottom,
            cancelResizeBottomSettle,
        ],
    );

    useEffect(() => {
        return () => {
            cancelPendingScrollToBottom();
            cancelBottomFollowSettle();
            if (restoreScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(restoreScrollFrameRef.current);
                restoreScrollFrameRef.current = null;
            }
            cancelResizeBottomSettle();
            resizeBottomLockRef.current = false;
            resizeStartedNearBottomRef.current = false;
            flushScheduledScrollPersist();
        };
    }, [
        cancelPendingScrollToBottom,
        cancelBottomFollowSettle,
        cancelResizeBottomSettle,
        flushScheduledScrollPersist,
    ]);

    useLayoutEffect(() => {
        if (!active) {
            return;
        }

        let cancelled = false;
        const setJumpToBottomVisibility = (visible: boolean) => {
            queueMicrotask(() => {
                if (!cancelled) {
                    setShowJumpToBottom(visible);
                }
            });
        };
        const scrollEl = scrollRef.current;
        const restoreScrollTop = persistedViewStateRef.current?.scrollTop ?? 0;
        const shouldRestoreBottom =
            persistedViewStateRef.current?.isNearBottom ?? true;

        if (!scrollEl) {
            shouldAutoFollowRef.current = shouldRestoreBottom;
            setJumpToBottomVisibility(false);
            return () => {
                cancelled = true;
            };
        }

        const wasPreviouslyActivated = hasActivatedViewRef.current;
        hasActivatedViewRef.current = true;

        const persistViewStateOnDeactivate = () => {
            cancelled = true;
            cancelPendingScrollToBottom();
            cancelBottomFollowSettle();
            if (restoreScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(restoreScrollFrameRef.current);
                restoreScrollFrameRef.current = null;
            }
            const flushedState = flushScheduledScrollPersist();
            persistCurrentViewState(
                resolveChatScrollPersistenceState({
                    currentScrollTop: scrollEl.scrollTop,
                    pendingIsNearBottom: flushedState?.isNearBottom ?? null,
                    pendingScrollTop: flushedState?.scrollTop ?? null,
                    restoreScrollTop,
                    shouldAutoFollow: shouldAutoFollowRef.current,
                }),
            );
        };

        // A retained view already owns the correct DOM scroll position. Avoid
        // forcing layout and scheduling follow-up frames on every tab switch.
        if (wasPreviouslyActivated) {
            return persistViewStateOnDeactivate;
        }

        if (shouldRestoreBottom) {
            shouldAutoFollowRef.current = true;
            scheduleScrollToBottom();
            setJumpToBottomVisibility(false);
        } else {
            shouldAutoFollowRef.current = false;
            scrollEl.scrollTop = restoreScrollTop;
            setJumpToBottomVisibility(!isNearBottom(scrollEl));
        }

        if (restoreScrollFrameRef.current !== null) {
            window.cancelAnimationFrame(restoreScrollFrameRef.current);
        }
        restoreScrollFrameRef.current = window.requestAnimationFrame(() => {
            restoreScrollFrameRef.current = null;
            const nextScrollEl = scrollRef.current;
            if (!nextScrollEl) {
                return;
            }

            if (shouldRestoreBottom) {
                scrollToBottom();
                setJumpToBottomVisibility(false);
                return;
            }

            nextScrollEl.scrollTop = restoreScrollTop;
            setJumpToBottomVisibility(!isNearBottom(nextScrollEl));
        });

        return persistViewStateOnDeactivate;
    }, [
        cancelBottomFollowSettle,
        cancelPendingScrollToBottom,
        flushScheduledScrollPersist,
        isNearBottom,
        persistCurrentViewState,
        scheduleScrollToBottom,
        scrollToBottom,
        active,
        tab.sessionId,
    ]);

    useLayoutEffect(() => {
        if (active && shouldAutoFollowRef.current) {
            scheduleScrollToBottom();
        }
    }, [active, scheduleScrollToBottom, snapshot.updatedAt]);

    useEffect(() => {
        const scrollEl = scrollRef.current;
        const contentEl = timelineContentRef.current;
        if (
            !active ||
            !scrollEl ||
            !contentEl ||
            typeof ResizeObserver === "undefined"
        ) {
            return;
        }

        const observer = new ResizeObserver(() => {
            if (shouldAutoFollowRef.current) {
                scheduleScrollToBottom();
            }
        });

        observer.observe(scrollEl);
        observer.observe(contentEl);

        return () => {
            observer.disconnect();
        };
    }, [active, scheduleScrollToBottom, tab.sessionId]);

    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;

        // Ignore programmatic scroll/layout churn while the resize bottom lock
        // is active; otherwise a transient virtual scrollHeight can disable
        // auto-follow even though the user started the resize at the bottom.
        if (resizeBottomLockRef.current) {
            shouldAutoFollowRef.current = true;
            return;
        }

        if (
            shouldAutoFollowRef.current &&
            (bottomFollowSettleActiveRef.current || composerExpanded)
        ) {
            setShowJumpToBottom(false);
            scheduleScrollPersist(el.scrollTop, true);
            return;
        }

        const nextIsNearBottom = isNearBottom(el);
        shouldAutoFollowRef.current = nextIsNearBottom;
        setShowJumpToBottom(!nextIsNearBottom);
        scheduleScrollPersist(el.scrollTop, nextIsNearBottom);
    }, [composerExpanded, isNearBottom, scheduleScrollPersist]);

    const handleJumpToBottom = useCallback(() => {
        cancelPendingScrollToBottom();
        cancelBottomFollowSettle();
        cancelResizeBottomSettle();
        shouldAutoFollowRef.current = true;
        resizeBottomLockRef.current = false;
        resizeStartedNearBottomRef.current = false;
        scrollToBottom();
        scheduleBottomFollowSettle();
        setShowJumpToBottom(false);

        const scrollEl = scrollRef.current;
        scheduleScrollPersist(scrollEl?.scrollTop ?? 0, true);
    }, [
        cancelBottomFollowSettle,
        cancelPendingScrollToBottom,
        cancelResizeBottomSettle,
        scheduleBottomFollowSettle,
        scheduleScrollPersist,
        scrollToBottom,
    ]);

    const updateDraftAttachments = useCallback(
        (attachments: readonly AiImageAttachment[]) => {
            setDraftAttachments(tab.sessionId, attachments);
        },
        [setDraftAttachments, tab.sessionId],
    );

    const appendImageFiles = useCallback(
        async (files: readonly File[]) => {
            const imageFiles = files.filter((file) =>
                file.type.startsWith("image/"),
            );
            if (imageFiles.length === 0) {
                setComposerError("Only image files are supported.");
                return;
            }
            if (draftAttachments.length >= MAX_IMAGE_ATTACHMENTS) {
                setComposerError(getImageAttachmentLimitMessage());
                return;
            }
            const availableSlots =
                MAX_IMAGE_ATTACHMENTS - draftAttachments.length;
            const nextFiles = imageFiles.slice(0, availableSlots);
            try {
                const nextAttachments = await Promise.all(
                    nextFiles.map(readImageFileAsAttachment),
                );
                updateDraftAttachments([
                    ...draftAttachments,
                    ...nextAttachments,
                ]);
                if (imageFiles.length > availableSlots) {
                    setComposerError(
                        `Only the first ${MAX_IMAGE_ATTACHMENTS} images were kept.`,
                    );
                } else {
                    setComposerError(null);
                }
            } catch (error) {
                setComposerError(
                    error instanceof Error
                        ? error.message
                        : "Could not attach the selected image.",
                );
            }
        },
        [draftAttachments, updateDraftAttachments],
    );

    const removeDraftAttachment = useCallback(
        (attachmentId: string) => {
            updateDraftAttachments(
                draftAttachments.filter(
                    (attachment) => attachment.id !== attachmentId,
                ),
            );
            setComposerError(null);
        },
        [draftAttachments, updateDraftAttachments],
    );

    const handleSubmit = async () => {
        if (closedSubagentMessage) {
            return;
        }

        const plainText = serializeComposerPartsForPrompt(composerParts);
        const prompt = serializePromptWithContexts(
            plainText,
            draftFileContexts,
            composerParts,
        );
        if (
            !prompt &&
            draftAttachments.length === 0 &&
            draftFileContexts.length === 0
        )
            return;

        const submittedParts = [...composerParts];
        const submittedAttachments = [...draftAttachments];
        const submittedFileContexts = [...draftFileContexts];

        commitComposerParts(createEmptyComposerParts());
        setComposerResetNonce((current) => current + 1);
        clearDraftAttachments(tab.sessionId);
        clearDraftFileContexts(tab.sessionId);
        setComposerError(null);

        try {
            await sendPrompt(tab, prompt, {
                attachments: submittedAttachments,
                composerPartsSnapshot: submittedParts,
                fileContextsSnapshot: submittedFileContexts,
            });
        } catch {
            const latestSession = useAiStore.getState().sessions[tab.sessionId];
            const latestDraftAttachments =
                latestSession?.draftAttachments ?? EMPTY_DRAFT_ATTACHMENTS;
            const latestDraftFileContexts =
                latestSession?.draftFileContexts ?? EMPTY_DRAFT_FILE_CONTEXTS;
            const shouldRestoreDraft = isComposerDraftEmpty(
                composerPartsRef.current,
                latestDraftAttachments,
                latestDraftFileContexts,
            );

            if (!shouldRestoreDraft) {
                return;
            }

            commitComposerParts(submittedParts);
            setDraftAttachments(tab.sessionId, submittedAttachments);
            for (const fileContext of submittedFileContexts) {
                addDraftFileContext(tab.sessionId, fileContext);
            }
        }
    };

    const handleComposerPartsChange = useCallback(
        (newParts: AIComposerPart[]) => {
            commitComposerParts(newParts);
        },
        [commitComposerParts],
    );

    const handleEditQueuedPrompt = useCallback(
        (promptId: string) => {
            const restoredParts = editQueuedPrompt(
                tab.sessionId,
                promptId,
                composerPartsRef.current,
            );
            if (!restoredParts) {
                return;
            }

            commitComposerParts(restoredParts);
            setComposerError(null);
        },
        [
            commitComposerParts,
            editQueuedPrompt,
            tab.sessionId,
        ],
    );

    const handleCancelQueuedPromptEdit = useCallback(() => {
        const restoredParts = cancelQueuedPromptEdit(tab.sessionId);
        if (!restoredParts) {
            return;
        }

        commitComposerParts(restoredParts);
        setComposerResetNonce((current) => current + 1);
        setComposerError(null);
    }, [
        cancelQueuedPromptEdit,
        commitComposerParts,
        tab.sessionId,
    ]);

    useEffect(() => {
        const nextSerialized = JSON.stringify(draftComposerParts);
        const previousStoreSerialized =
            lastSeenDraftComposerPartsSerializedRef.current;
        lastSeenDraftComposerPartsSerializedRef.current = nextSerialized;

        if (nextSerialized === previousStoreSerialized) {
            return;
        }

        const currentSerialized = JSON.stringify(composerParts);
        if (currentSerialized === nextSerialized) {
            return;
        }

        const clonedParts = cloneComposerPartsForDraft(draftComposerParts);
        composerPartsRef.current = clonedParts;
        flushChatDraft(composerPartsToPlainText(draftComposerParts));
        let cancelled = false;
        queueMicrotask(() => {
            if (!cancelled) {
                setComposerParts(clonedParts);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [composerParts, draftComposerParts, flushChatDraft]);

    const handleClearQueuedPrompts = useCallback(() => {
        clearQueuedPrompts(tab.sessionId);
    }, [clearQueuedPrompts, tab.sessionId]);

    const handleRemoveQueuedPrompt = useCallback(
        (promptId: string) => {
            removeQueuedPrompt(tab.sessionId, promptId);
        },
        [removeQueuedPrompt, tab.sessionId],
    );

    const handleSendQueuedPromptNow = useCallback(
        (promptId: string) => {
            setComposerExpanded(false);
            void sendQueuedPromptNow(tab.sessionId, promptId);
        },
        [sendQueuedPromptNow, tab.sessionId],
    );

    const handleKeepAllPendingReview = useCallback(() => {
        void keepAllTrackedFiles(tab.sessionId);
    }, [keepAllTrackedFiles, tab.sessionId]);

    const handleRejectAllPendingReview = useCallback(() => {
        void rejectAllTrackedFiles(tab.sessionId);
    }, [rejectAllTrackedFiles, tab.sessionId]);

    const handleOpenPendingReviewItem = useCallback(
        (item: ReviewFileItem) => {
            const openRelativePath = item.openRelativePath;
            if (!tab.projectId || !item.canOpen || !openRelativePath) {
                return;
            }

            void onOpenFile(
                tab.projectId,
                openRelativePath,
                tab.worktreeId ?? null,
                {
                    path: item.file.path,
                    sessionId: tab.sessionId,
                },
            );
        },
        [onOpenFile, tab.projectId, tab.sessionId, tab.worktreeId],
    );

    const handleKeepPendingReviewItem = useCallback(
        (item: ReviewFileItem) => {
            if (isReviewConflictFile(item.file)) {
                return;
            }
            void keepTrackedFile(createReviewFileMutationInput(item.file));
        },
        [keepTrackedFile],
    );

    const handleRejectPendingReviewItem = useCallback(
        (item: ReviewFileItem) => {
            void rejectTrackedFile(createReviewFileMutationInput(item.file));
        },
        [rejectTrackedFile],
    );

    const handleKeepPendingReviewHunk = useCallback(
        (item: ReviewFileItem, hunkId: string) => {
            void keepTrackedFileHunks(
                createReviewHunkMutationInput(item.file, [hunkId]),
            );
        },
        [keepTrackedFileHunks],
    );

    const handleRejectPendingReviewHunk = useCallback(
        (item: ReviewFileItem, hunkId: string) => {
            void rejectTrackedFileHunks(
                createReviewHunkMutationInput(item.file, [hunkId]),
            );
        },
        [rejectTrackedFileHunks],
    );
    const handleOpenReviewTab = useCallback(() => {
        void onOpenReview();
    }, [onOpenReview]);
    const handleStopSession = useCallback(() => {
        requestStopAgentSession({
            sessionId: tab.sessionId,
            title: snapshot.title || tab.title || "Chat",
        });
    }, [snapshot.title, tab.sessionId, tab.title]);

    useEffect(() => {
        composerPartsRef.current = composerParts;
    }, [composerParts]);

    useEffect(() => {
        return registerComposerSelectionMentionHandler(
            tab.sessionId,
            (selection) => {
                commitComposerParts(
                    appendSelectionMentionPart(
                        composerPartsRef.current,
                        selection,
                    ),
                );
                setComposerError(null);
            },
        );
    }, [commitComposerParts, tab.sessionId]);

    const handlePasteImage = useCallback(
        (file: File) => {
            void appendImageFiles([file]);
        },
        [appendImageFiles],
    );
    const projectSearchTimeoutRef = useRef<number | null>(null);
    const pendingProjectSearchQueryRef = useRef("");
    const pendingProjectSearchResolversRef = useRef<
        Array<(entries: readonly ProjectTreeNode[]) => void>
    >([]);
    const projectSearchAbortRef = useRef<AbortController | null>(null);
    const projectSearchScheduler = getRendererTaskScheduler();

    useEffect(() => {
        return () => {
            if (projectSearchTimeoutRef.current !== null) {
                window.clearTimeout(projectSearchTimeoutRef.current);
                projectSearchTimeoutRef.current = null;
            }

            projectSearchAbortRef.current?.abort();
            projectSearchAbortRef.current = null;
            projectSearchScheduler.cancelWorkspace(tab.sessionId);

            const pendingResolversRef = pendingProjectSearchResolversRef;
            const pendingResolvers = pendingResolversRef.current.splice(0);
            pendingResolvers.forEach((resolve) => resolve([]));
        };
    }, [projectSearchScheduler, tab.sessionId]);

    useEffect(() => {
        if (active) {
            return;
        }

        projectSearchAbortRef.current?.abort();
        projectSearchAbortRef.current = null;
        projectSearchScheduler.cancelWorkspace(tab.sessionId);
    }, [active, projectSearchScheduler, tab.projectId, tab.sessionId]);

    const handleSearchProjectEntries = useCallback(
        (query: string) => {
            const normalizedQuery = query.trim();
            const projectId = tab.projectId;
            if (!projectId || normalizedQuery.length < 1 || !window.comando) {
                return Promise.resolve([] as const);
            }

            pendingProjectSearchQueryRef.current = normalizedQuery;

            return new Promise<readonly ProjectTreeNode[]>((resolve) => {
                pendingProjectSearchResolversRef.current.push(resolve);

                if (projectSearchTimeoutRef.current !== null) {
                    window.clearTimeout(projectSearchTimeoutRef.current);
                }

                const search = () => {
                    projectSearchTimeoutRef.current = null;
                    const pendingResolvers =
                        pendingProjectSearchResolversRef.current.splice(0);
                    const searchQuery = pendingProjectSearchQueryRef.current;
                    const controller = new AbortController();
                    projectSearchAbortRef.current = controller;

                    void projectSearchScheduler
                        .schedule(
                            {
                                key: `chat-file-search:${tab.sessionId}`,
                                priority: "visible",
                                workspaceId: tab.sessionId,
                            },
                            async ({ signal }) => {
                                const entries = await window.comando.searchProjectEntries({
                                    limit: 12,
                                    projectId,
                                    query: searchQuery,
                                    searchContext: "chat-file-search",
                                    worktreeId: tab.worktreeId ?? null,
                                });
                                return signal.aborted ? [] : entries;
                            },
                        )
                        .then((entries) => {
                            if (projectSearchAbortRef.current === controller) {
                                projectSearchAbortRef.current = null;
                            }
                            const resolved = controller.signal.aborted
                                ? []
                                : (entries ?? []);
                            pendingResolvers.forEach((callback) =>
                                callback(resolved),
                            );
                        })
                        .catch(() => {
                            if (projectSearchAbortRef.current === controller) {
                                projectSearchAbortRef.current = null;
                            }
                            pendingResolvers.forEach((callback) =>
                                callback([]),
                            );
                        });
                };

                const delayMs =
                    normalizedQuery.length <= 1
                        ? 0
                        : PROJECT_MENTION_SEARCH_FOLLOWUP_DEBOUNCE_MS;
                if (delayMs === 0) {
                    search();
                    return;
                }

                projectSearchTimeoutRef.current = window.setTimeout(
                    search,
                    delayMs,
                );
            });
        },
        [projectSearchScheduler, tab.projectId, tab.sessionId, tab.worktreeId],
    );

    const handleChatFocus = useCallback(() => {
        if (active) {
            markChatTabFocused(tab.id);
        }
    }, [active, markChatTabFocused, tab.id]);
    const handleChatPerformanceRender = useCallback(
        (_id: string, _phase: string, actualDuration: number) => {
            recordChatPerformanceMetric("react_commit_ms", {
                durationMs: actualDuration,
                sessionId: tab.sessionId,
                values: {
                    historyRows: timelineModel.historyRows.length,
                    liveTailRows: timelineModel.liveTailRow ? 1 : 0,
                    toolRows: timelineModel.orderedAtomicRows.filter(
                        (row) => row.kind === "tool",
                    ).length,
                },
            });
        },
        [
            tab.sessionId,
            timelineModel.historyRows.length,
            timelineModel.liveTailRow,
            timelineModel.orderedAtomicRows,
        ],
    );
    const chatPerformanceEnabled = isChatPerformanceProbeEnabled();

    return (
        <ChatPerformanceProfiler
            enabled={chatPerformanceEnabled}
            id={`chat:${tab.sessionId}`}
            onRender={handleChatPerformanceRender}
        >
        <div
            className="flex h-full min-h-0 min-w-0"
            onFocusCapture={handleChatFocus}
            onMouseDownCapture={handleChatFocus}
            style={{ backgroundColor: "var(--color-bg-secondary)" }}
        >
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <div
                    className="flex h-6 shrink-0 items-center gap-2 px-3 text-[10.5px] leading-none text-text-secondary"
                    style={{
                        backgroundColor: "var(--color-bg-secondary)",
                        borderBottom:
                            "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                        boxSizing: "border-box",
                        fontFamily: "var(--font-mono)",
                    }}
                >
                    {isEditingTitle && !parentSessionId ? (
                        <input
                            ref={titleInputRef}
                            className="min-w-0 flex-1 rounded bg-transparent outline-none"
                            style={{
                                border: "none",
                                borderBottom:
                                    "1px solid var(--color-accent, var(--color-text-secondary))",
                                color: "var(--color-text-primary)",
                                fontFamily: "var(--font-mono)",
                                fontSize: "10.5px",
                                padding: 0,
                            }}
                            value={titleDraft}
                            onChange={(e) => setTitleDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    commitTitleEdit();
                                } else if (e.key === "Escape") {
                                    skipTitleCommitRef.current = true;
                                    setIsEditingTitle(false);
                                }
                            }}
                            onBlur={() => commitTitleEdit()}
                        />
                    ) : (
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span
                                className="min-w-0 cursor-default truncate"
                                style={{
                                    color: "var(--color-text-primary)",
                                }}
                                onDoubleClick={() => {
                                    if (parentSessionId) {
                                        return;
                                    }

                                    skipTitleCommitRef.current = false;
                                    setTitleDraft(snapshot.title || "");
                                    setIsEditingTitle(true);
                                }}
                                title={
                                    parentSessionId
                                        ? "Subagent names are managed by Codex"
                                        : "Double-click to rename"
                                }
                            >
                                {snapshot.title || "Chat"}
                            </span>
                            {parentSessionId ? (
                                <button
                                    className="app-no-drag min-w-0 shrink truncate rounded px-1 text-[10px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
                                    onClick={() =>
                                        void openAiSessionById(parentSessionId)
                                    }
                                    title={`Open parent ${parentSessionContext?.title ?? "thread"}`}
                                    type="button"
                                >
                                    Subagent of{" "}
                                    {parentSessionContext?.title ??
                                        "parent thread"}
                                </button>
                            ) : null}
                        </div>
                    )}
                </div>
                {visiblePlan ? (
                    <div
                        className="shrink-0 px-3 pb-1 pt-2"
                        style={{
                            borderBottom:
                                "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                        }}
                    >
                        <ChatContentColumn>
                            <PlanMessage
                                onDismiss={() => {
                                    dismissSessionPlan(
                                        snapshot.sessionId,
                                        visiblePlan.updatedAt,
                                    );
                                }}
                                plan={visiblePlan}
                            />
                        </ChatContentColumn>
                    </div>
                ) : null}

                <ChatTimeline
                    active={active}
                    canRenderFileReference={canRenderFileReference}
                    chatFontFamily={chatFontFamily}
                    chatFontSize={aiChatSettings.chatFontSize}
                    elapsed={elapsed}
                    covered={composerExpanded}
                    historyRows={timelineModel.historyRows}
                    isStreaming={isStreaming}
                    liveTailRow={timelineModel.liveTailRow}
                    onAddFileReferenceToChat={
                        handleAddResolvedFileReferenceToChat
                    }
                    onOpenFile={onOpenFile}
                    onOpenImage={onOpenImage}
                    onOpenResolvedFileReference={handleOpenResolvedFileReference}
                    onOpenSession={openAiSessionById}
                    onRevealFileReference={handleRevealResolvedFileReference}
                    onScroll={handleScroll}
                    onWheelCapture={handleTimelineWheelCapture}
                    onJumpToBottom={handleJumpToBottom}
                    onVirtualRangeChange={handleTimelineVirtualRangeChange}
                    onVirtualResizeEnd={handleTimelineVirtualResizeEnd}
                    onVirtualResizeAutoFollow={
                        handleTimelineVirtualResizeAutoFollow
                    }
                    onVirtualResizeStart={handleTimelineVirtualResizeStart}
                    projectId={tab.projectId}
                    resolveFileReference={resolveChatFileReference}
                    scrollRef={scrollRef}
                    sessionId={tab.sessionId}
                    showJumpToBottom={showJumpToBottom}
                    shouldPreserveVirtualMeasureAnchor={
                        shouldPreserveTimelineVirtualMeasureAnchor
                    }
                    shouldPreserveVirtualResizeAnchor={
                        shouldPreserveTimelineVirtualResizeAnchor
                    }
                    timelineContentRef={timelineContentRef}
                    worktreeId={tab.worktreeId ?? null}
                />

                {/* Context cards (edits, queue, errors) */}
                {hasComposerContext ? (
                    <div
                        className="flex shrink-0 flex-col gap-2 px-3 py-3"
                        style={{
                            backgroundColor: "transparent",
                        }}
                    >
                        <ChatContentColumn className="flex flex-col gap-2">
                            {pendingPermission
                                ? renderPermissionRequest(
                                      pendingPermission,
                                      respondPermission,
                                      tab.sessionId,
                                  )
                                : null}
                            {pendingUserInput ? (
                                <UserInputRequestCard
                                    onRespond={respondUserInput}
                                    request={pendingUserInput}
                                />
                            ) : null}
                            {queuedPrompts.length > 0 ||
                            editingQueuedPrompt ? (
                                <QueuedMessagesPanel
                                    editingItem={editingQueuedPrompt}
                                    items={queuedPrompts}
                                    onCancelEdit={handleCancelQueuedPromptEdit}
                                    onClearAll={handleClearQueuedPrompts}
                                    onDelete={handleRemoveQueuedPrompt}
                                    onEdit={handleEditQueuedPrompt}
                                    onSendNow={handleSendQueuedPromptNow}
                                />
                            ) : null}
                            {currentError ? renderError(currentError) : null}
                            {composerError ? renderError(composerError) : null}

                            {pendingReviewCount > 0 ? (
                                <EditedFilesBufferPanel
                                    defaultCollapsed
                                    diffZoom={diffZoom}
                                    items={pendingReviewItems}
                                    onKeepAll={handleKeepAllPendingReview}
                                    onKeepHunk={handleKeepPendingReviewHunk}
                                    onKeepItem={handleKeepPendingReviewItem}
                                    onOpenItem={handleOpenPendingReviewItem}
                                    onOpenReview={handleOpenReviewTab}
                                    onRejectAll={handleRejectAllPendingReview}
                                    onRejectHunk={handleRejectPendingReviewHunk}
                                    onRejectItem={handleRejectPendingReviewItem}
                                    summary={pendingReviewSummary}
                                />
                            ) : null}
                        </ChatContentColumn>
                    </div>
                ) : null}

                {/* Composer area */}
                <div
                    className={
                        composerExpanded
                            ? "flex min-h-0 flex-1 flex-col border-t"
                            : "flex shrink-0 flex-col border-t"
                    }
                    style={{
                        backgroundColor:
                            "color-mix(in srgb, var(--color-accent) 4%, var(--color-bg-panel))",
                        borderTopColor:
                            "color-mix(in srgb, var(--color-accent) 14%, var(--color-border))",
                    }}
                >
                    <ChatContentColumn
                        className={
                            composerExpanded
                                ? "flex min-h-0 flex-1 flex-col"
                                : undefined
                        }
                    >
                        <AIChatComposer
                            autoFocusKey={tab.id}
                            composerFontFamily={composerFontFamily}
                            composerFontSize={aiChatSettings.composerFontSize}
                            requireCmdEnterToSend={
                                aiChatSettings.requireCmdEnterToSend
                            }
                            bottomAccent={
                                aiChatSettings.contextUsageBarEnabled ? (
                                    <AIChatContextUsageBar
                                        usage={snapshot.tokenUsage}
                                    />
                                ) : null
                            }
                            agentControls={
                                hasAgentControls ? (
                                    <AIChatAgentControls
                                        configOptions={agentConfigOptions}
                                        disabled={
                                            closedSubagentMessage !== null
                                        }
                                        modeId={agentModeId}
                                        modelId={agentModelId}
                                        modes={agentModes}
                                        models={agentModels}
                                        onConfigOptionChange={(
                                            optionId,
                                            value,
                                        ) => {
                                            runAgentControlMutation(() =>
                                                setSessionConfigOption(
                                                    {
                                                        optionId,
                                                        sessionId:
                                                            tab.sessionId,
                                                        value,
                                                    },
                                                    agentControlMutationOptions,
                                                ),
                                            );
                                        }}
                                        onModeChange={(modeId) => {
                                            runAgentControlMutation(() =>
                                                setSessionMode(
                                                    {
                                                        modeId,
                                                        sessionId:
                                                            tab.sessionId,
                                                    },
                                                    agentControlMutationOptions,
                                                ),
                                            );
                                        }}
                                        onModelChange={(modelId) => {
                                            runAgentControlMutation(() =>
                                                setSessionModel(
                                                    {
                                                        modelId,
                                                        sessionId:
                                                            tab.sessionId,
                                                    },
                                                    agentControlMutationOptions,
                                                ),
                                            );
                                        }}
                                        runtimeId={tab.runtimeId}
                                    />
                                ) : undefined
                            }
                            availableCommands={availableCommands}
                            disabled={closedSubagentMessage !== null}
                            disabledReason={closedSubagentMessage}
                            draftAttachments={draftAttachments}
                            draftFileContexts={draftFileContexts}
                            expanded={composerExpanded}
                            fileInputRef={fileInputRef}
                            onChange={handleComposerPartsChange}
                            onPasteImage={handlePasteImage}
                            onRemoveAttachment={removeDraftAttachment}
                            onRemoveFileContext={(contextId) =>
                                removeDraftFileContext(tab.sessionId, contextId)
                            }
                            onSearchProjectEntries={handleSearchProjectEntries}
                            onStop={handleStopSession}
                            onSubmit={() => {
                                setComposerExpanded(false);
                                void handleSubmit();
                            }}
                            onToggleExpanded={() =>
                                setComposerExpanded((value) => !value)
                            }
                            resetNonce={composerResetNonce}
                            parts={composerParts}
                            renderFileContextPill={(fc) => (
                                <FileContextPill
                                    context={fc}
                                    onRemove={() =>
                                        removeDraftFileContext(
                                            tab.sessionId,
                                            fc.id,
                                        )
                                    }
                                />
                            )}
                            renderImageChip={(att) => (
                                <ImageAttachmentChip
                                    attachment={att}
                                    onRemove={removeDraftAttachment}
                                />
                            )}
                            runtimeName={runtimeDisplayName}
                            status={snapshot.status}
                        />
                    </ChatContentColumn>
                </div>
            </div>
        </div>
        </ChatPerformanceProfiler>
    );
});

ChatTabView.displayName = "ChatTabView";

/* ─── Render helpers (static fragments) ─── */

function renderPermissionRequest(
    perm: NonNullable<AiSessionSnapshot["pendingPermission"]>,
    respond: (args: {
        optionId: string | null;
        requestId: string;
        sessionId: string;
    }) => Promise<void>,
    sessionId: string,
) {
    return (
        <div
            className="mb-2 overflow-hidden rounded-lg"
            style={{
                backgroundColor:
                    "color-mix(in srgb, #d97706 4%, var(--color-bg-secondary))",
                border: "1px solid color-mix(in srgb, #d97706 25%, var(--color-border))",
            }}
        >
            <div className="flex items-center gap-2 px-3 py-2">
                <svg
                    className="shrink-0"
                    fill="none"
                    height="14"
                    stroke="#d97706"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.5"
                    viewBox="0 0 24 24"
                    width="14"
                >
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" x2="12" y1="9" y2="13" />
                    <line x1="12" x2="12.01" y1="17" y2="17" />
                </svg>
                <span
                    className="min-w-0 flex-1 truncate font-medium"
                    style={{
                        color: "var(--color-text-primary)",
                        fontSize: "0.85em",
                    }}
                >
                    {perm.title}
                </span>
            </div>
            <div
                className="flex flex-wrap gap-2 px-3 py-2"
                style={{
                    borderTop:
                        "1px solid color-mix(in srgb, #d97706 15%, var(--color-border))",
                }}
            >
                {perm.description ? (
                    <div
                        className="w-full whitespace-pre-wrap rounded-md px-2 py-1.5 font-mono"
                        style={{
                            backgroundColor:
                                "color-mix(in srgb, #d97706 5%, var(--color-bg-tertiary))",
                            color: "var(--color-text-secondary)",
                            fontSize: "0.74em",
                            lineHeight: 1.45,
                        }}
                    >
                        {perm.description}
                    </div>
                ) : null}
                {perm.options.map((opt) => {
                    const isApprove =
                        opt.kind === "allow_once" ||
                        opt.kind === "allow_always";
                    return (
                        <button
                            className="app-no-drag rounded-md px-3 py-1 font-medium"
                            key={opt.optionId}
                            onClick={() =>
                                void respond({
                                    optionId: opt.optionId,
                                    requestId: perm.requestId,
                                    sessionId,
                                })
                            }
                            style={{
                                backgroundColor: isApprove
                                    ? "var(--color-accent)"
                                    : "color-mix(in srgb, var(--color-text-secondary) 12%, transparent)",
                                border: "none",
                                color: isApprove
                                    ? "#fff"
                                    : "var(--color-text-secondary)",
                                cursor: "pointer",
                                fontSize: "0.79em",
                                transitionProperty: "opacity",
                            }}
                            type="button"
                        >
                            {opt.name}
                        </button>
                    );
                })}
                <button
                    className="app-no-drag rounded-md px-3 py-1 font-medium"
                    onClick={() =>
                        void respond({
                            optionId: null,
                            requestId: perm.requestId,
                            sessionId,
                        })
                    }
                    style={{
                        backgroundColor:
                            "color-mix(in srgb, var(--color-text-secondary) 12%, transparent)",
                        border: "none",
                        color: "var(--color-text-secondary)",
                        cursor: "pointer",
                        fontSize: "0.79em",
                    }}
                    type="button"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}

function renderError(error: string) {
    return (
        <div
            className="mb-2 flex min-w-0 max-w-full items-start gap-2 rounded-lg px-2.5 py-2"
            style={{
                backgroundColor: "color-mix(in srgb, #dc2626 8%, transparent)",
                color: "#fca5a5",
                fontSize: "0.85em",
            }}
        >
            <svg
                className="mt-0.5 shrink-0"
                fill="none"
                height="14"
                stroke="#f87171"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
                viewBox="0 0 14 14"
                width="14"
            >
                <circle cx="7" cy="7" r="6" />
                <line x1="7" x2="7" y1="4.5" y2="7" />
                <line x1="7" x2="7.01" y1="9.5" y2="9.5" />
            </svg>
            <span
                className="min-w-0 whitespace-pre-wrap"
                style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
            >
                {error}
            </span>
        </div>
    );
}

function AttachmentPillFrame(props: {
    readonly children?: ReactNode;
    readonly label: string;
    readonly onRemove: () => void;
    readonly title?: string;
    readonly variant?: keyof typeof CHAT_PILL_VARIANTS;
}) {
    const palette = CHAT_PILL_VARIANTS[props.variant ?? "file"];

    return (
        <div
            className="flex items-center gap-1 rounded-md py-0.5 pl-2 pr-1"
            style={{
                backgroundColor: palette.background,
            }}
        >
            {props.children ? (
                <span
                    style={{
                        color: palette.color,
                        display: "flex",
                        opacity: 0.8,
                    }}
                >
                    {props.children}
                </span>
            ) : null}
            <span
                className="max-w-37.5 truncate text-xs"
                style={{
                    color: palette.color,
                }}
                title={props.title ?? props.label}
            >
                {props.label}
            </span>
            <button
                className="app-no-drag flex items-center justify-center rounded p-0.5 text-xs"
                onClick={props.onRemove}
                style={{
                    backgroundColor: "transparent",
                    border: "none",
                    color: palette.color,
                    opacity: 0.6,
                }}
                type="button"
            >
                ×
            </button>
        </div>
    );
}

function FileContextPill(props: {
    readonly context: AiFileContextAttachment;
    readonly onRemove: () => void;
}) {
    return (
        <AttachmentPillFrame
            label={buildFileContextLabel(props.context)}
            onRemove={props.onRemove}
            title={buildFileContextTitle(props.context)}
            variant="file"
        >
            <LanguageIcon languageId={props.context.languageId} size={11} />
        </AttachmentPillFrame>
    );
}

function ImageAttachmentChip(props: {
    readonly attachment: AiImageAttachment;
    readonly onRemove: (attachmentId: string) => void;
}) {
    const label = props.attachment.name ?? "Screenshot";
    const sizeLabel = formatAttachmentSize(props.attachment.sizeBytes);

    return (
        <AttachmentPillFrame
            label={label}
            onRemove={() => props.onRemove(props.attachment.id)}
            title={`${label} • ${sizeLabel}`}
            variant="file"
        />
    );
}

type ChatTimelineProps = {
    readonly active: boolean;
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly elapsed: string;
    readonly covered?: boolean;
    readonly historyRows: readonly ChatTimelineRow[];
    readonly isStreaming: boolean;
    readonly liveTailRow: ChatTimelineRow | null;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onOpenResolvedFileReference: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly onJumpToBottom: () => void;
    readonly onRevealFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onScroll: () => void;
    readonly onWheelCapture?: (event: WheelEvent<HTMLDivElement>) => void;
    readonly onVirtualRangeChange?: (range: MeasuredVirtualRange) => void;
    readonly onVirtualResizeEnd?: () => void;
    readonly onVirtualResizeAutoFollow?: () => void;
    readonly onVirtualResizeStart?: () => void;
    readonly projectId: string | null;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly scrollRef: RefObject<HTMLDivElement | null>;
    readonly sessionId: string;
    readonly showJumpToBottom: boolean;
    readonly shouldPreserveVirtualMeasureAnchor?: () => boolean;
    readonly shouldPreserveVirtualResizeAnchor?: () => boolean;
    readonly timelineContentRef: RefObject<HTMLDivElement | null>;
    readonly worktreeId: string | null;
};

function areChatTimelinePropsEqual(
    previous: Readonly<ChatTimelineProps>,
    next: Readonly<ChatTimelineProps>,
): boolean {
    // Hidden warm views should retain their last committed DOM until they are
    // activated again. The next active render receives the latest timeline.
    if (!previous.active && !next.active) {
        return true;
    }

    const previousEntries = Object.entries(previous) as Array<
        [keyof ChatTimelineProps, ChatTimelineProps[keyof ChatTimelineProps]]
    >;
    return previousEntries.every(([key, value]) => Object.is(value, next[key]));
}

const ChatTimeline = memo(function ChatTimeline({
    active,
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    elapsed,
    covered,
    historyRows,
    isStreaming,
    liveTailRow,
    onAddFileReferenceToChat,
    onOpenFile,
    onOpenImage,
    onOpenResolvedFileReference,
    onOpenSession,
    onJumpToBottom,
    onRevealFileReference,
    onScroll,
    onWheelCapture,
    onVirtualRangeChange,
    onVirtualResizeEnd,
    onVirtualResizeAutoFollow,
    onVirtualResizeStart,
    projectId,
    resolveFileReference,
    scrollRef,
    sessionId,
    showJumpToBottom,
    shouldPreserveVirtualMeasureAnchor,
    shouldPreserveVirtualResizeAnchor,
    timelineContentRef,
    worktreeId,
}: ChatTimelineProps) {
    useRenderProbe("ChatTimeline", {
        active,
        historyRows: historyRows.length,
        isStreaming,
        rows: historyRows.length + (liveTailRow ? 1 : 0),
    });

    const timelineContainerClassName = covered
        ? "pointer-events-none invisible absolute inset-0 min-h-0 min-w-0"
        : "relative min-h-0 min-w-0 flex-1";

    return (
        <ToolExpansionStoreProvider scopeKey={sessionId}>
            <div
                aria-hidden={covered}
                className={timelineContainerClassName}
                inert={covered ? true : undefined}
            >
                <div
                    ref={scrollRef}
                    className="chat-scroll h-full min-h-0 min-w-0 overflow-y-auto px-3 py-3"
                    onScroll={onScroll}
                    onWheelCapture={onWheelCapture}
                >
                    <ChatContentColumn
                        ref={timelineContentRef}
                        className="min-w-0 space-y-2"
                        style={{
                            fontFamily: chatFontFamily,
                        }}
                    >
                        <ChatTimelineHistory
                            active={active}
                            canRenderFileReference={
                                canRenderFileReference
                            }
                            chatFontFamily={chatFontFamily}
                            chatFontSize={chatFontSize}
                            historyRows={historyRows}
                            onAddFileReferenceToChat={
                                onAddFileReferenceToChat
                            }
                            onOpenFile={onOpenFile}
                            onOpenImage={onOpenImage}
                            onOpenResolvedFileReference={
                                onOpenResolvedFileReference
                            }
                            onOpenSession={onOpenSession}
                            onRevealFileReference={onRevealFileReference}
                            onVirtualRangeChange={onVirtualRangeChange}
                            onVirtualResizeEnd={onVirtualResizeEnd}
                            onVirtualResizeAutoFollow={
                                onVirtualResizeAutoFollow
                            }
                            onVirtualResizeStart={onVirtualResizeStart}
                            projectId={projectId}
                            resolveFileReference={resolveFileReference}
                            scrollRef={scrollRef}
                            sessionId={sessionId}
                            shouldPreserveVirtualMeasureAnchor={
                                shouldPreserveVirtualMeasureAnchor
                            }
                            shouldPreserveVirtualResizeAnchor={
                                shouldPreserveVirtualResizeAnchor
                            }
                            worktreeId={worktreeId}
                        />
                        <ChatTimelineLiveTail
                            canRenderFileReference={
                                canRenderFileReference
                            }
                            chatFontFamily={chatFontFamily}
                            chatFontSize={chatFontSize}
                            onAddFileReferenceToChat={
                                onAddFileReferenceToChat
                            }
                            onOpenFile={onOpenFile}
                            onOpenImage={onOpenImage}
                            onOpenResolvedFileReference={
                                onOpenResolvedFileReference
                            }
                            onOpenSession={onOpenSession}
                            onRevealFileReference={onRevealFileReference}
                            projectId={projectId}
                            resolveFileReference={resolveFileReference}
                            row={liveTailRow}
                            worktreeId={worktreeId}
                        />
                        {isStreaming ? (
                            <StreamingIndicator elapsed={elapsed} />
                        ) : null}
                    </ChatContentColumn>
                </div>
                <ChatJumpToBottomButton
                    onClick={onJumpToBottom}
                    visible={showJumpToBottom}
                />
            </div>
        </ToolExpansionStoreProvider>
    );
}, areChatTimelinePropsEqual);

ChatTimeline.displayName = "ChatTimeline";

function ChatJumpToBottomButton(props: {
    readonly onClick: () => void;
    readonly visible: boolean;
}) {
    if (!props.visible) {
        return null;
    }

    return (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
            <button
                aria-label="Jump to latest"
                className="app-no-drag pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full transition-colors"
                onClick={props.onClick}
                style={{
                    backgroundColor:
                        "color-mix(in srgb, var(--color-bg-panel) 88%, transparent)",
                    border:
                        "1px solid color-mix(in srgb, var(--color-border) 80%, transparent)",
                    boxShadow: "0 6px 18px rgba(0, 0, 0, 0.22)",
                    color: "var(--color-text-secondary)",
                }}
                title="Jump to latest"
                type="button"
            >
                <svg
                    aria-hidden="true"
                    fill="none"
                    height="16"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                    viewBox="0 0 24 24"
                    width="16"
                >
                    <path d="M12 5v14" />
                    <path d="m19 12-7 7-7-7" />
                </svg>
            </button>
        </div>
    );
}

type ChatTimelineHistoryProps = {
    readonly active: boolean;
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly historyRows: readonly ChatTimelineRow[];
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onOpenResolvedFileReference: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly onRevealFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onVirtualRangeChange?: (range: MeasuredVirtualRange) => void;
    readonly onVirtualResizeEnd?: () => void;
    readonly onVirtualResizeAutoFollow?: () => void;
    readonly onVirtualResizeStart?: () => void;
    readonly projectId: string | null;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly scrollRef: RefObject<HTMLDivElement | null>;
    readonly sessionId: string;
    readonly shouldPreserveVirtualMeasureAnchor?: () => boolean;
    readonly shouldPreserveVirtualResizeAnchor?: () => boolean;
    readonly worktreeId: string | null;
};

const ChatTimelineHistory = memo(function ChatTimelineHistory({
    active,
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    historyRows,
    onAddFileReferenceToChat,
    onOpenFile,
    onOpenImage,
    onOpenResolvedFileReference,
    onOpenSession,
    onRevealFileReference,
    onVirtualRangeChange,
    onVirtualResizeEnd,
    onVirtualResizeAutoFollow,
    onVirtualResizeStart,
    projectId,
    resolveFileReference,
    scrollRef,
    sessionId,
    shouldPreserveVirtualMeasureAnchor,
    shouldPreserveVirtualResizeAnchor,
    worktreeId,
}: ChatTimelineHistoryProps) {
    const renderRow = useCallback(
        ({ row }: { readonly row: ChatTimelineRow }) => (
            // The list `key` is owned by each call site (the virtual list keys
            // its row wrapper; the non-virtual path keys via Fragment), so this
            // renderer only describes a row's content.
            <ChatTimelineRowView
                canRenderFileReference={canRenderFileReference}
                chatFontFamily={chatFontFamily}
                chatFontSize={chatFontSize}
                onAddFileReferenceToChat={onAddFileReferenceToChat}
                onOpenFile={onOpenFile}
                onOpenImage={onOpenImage}
                onOpenResolvedFileReference={onOpenResolvedFileReference}
                onOpenSession={onOpenSession}
                onRevealFileReference={onRevealFileReference}
                projectId={projectId}
                resolveFileReference={resolveFileReference}
                row={row}
                worktreeId={worktreeId}
            />
        ),
        [
            canRenderFileReference,
            chatFontFamily,
            chatFontSize,
            onAddFileReferenceToChat,
            onOpenFile,
            onOpenImage,
            onOpenResolvedFileReference,
            onOpenSession,
            onRevealFileReference,
            projectId,
            resolveFileReference,
            worktreeId,
        ],
    );

    return (
        <ChatTimelineHistoryRows
            active={active}
            chatFontFamily={chatFontFamily}
            chatFontSize={chatFontSize}
            historyRows={historyRows}
            onVirtualRangeChange={onVirtualRangeChange}
            onVirtualResizeEnd={onVirtualResizeEnd}
            onVirtualResizeAutoFollow={onVirtualResizeAutoFollow}
            onVirtualResizeStart={onVirtualResizeStart}
            renderRow={renderRow}
            scrollRef={scrollRef}
            sessionId={sessionId}
            shouldPreserveVirtualMeasureAnchor={
                shouldPreserveVirtualMeasureAnchor
            }
            shouldPreserveVirtualResizeAnchor={
                shouldPreserveVirtualResizeAnchor
            }
        />
    );
});

ChatTimelineHistory.displayName = "ChatTimelineHistory";

type ChatTimelineLiveTailProps = {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onOpenResolvedFileReference: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly onRevealFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly projectId: string | null;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly row: ChatTimelineRow | null;
    readonly worktreeId: string | null;
};

const ChatTimelineLiveTail = memo(function ChatTimelineLiveTail({
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    onAddFileReferenceToChat,
    onOpenFile,
    onOpenImage,
    onOpenResolvedFileReference,
    onOpenSession,
    onRevealFileReference,
    projectId,
    resolveFileReference,
    row,
    worktreeId,
}: ChatTimelineLiveTailProps) {
    if (!row) {
        return null;
    }

    return (
        <ChatTimelineRowView
            canRenderFileReference={canRenderFileReference}
            chatFontFamily={chatFontFamily}
            chatFontSize={chatFontSize}
            key={row.id}
            onAddFileReferenceToChat={onAddFileReferenceToChat}
            onOpenFile={onOpenFile}
            onOpenImage={onOpenImage}
            onOpenResolvedFileReference={onOpenResolvedFileReference}
            onOpenSession={onOpenSession}
            onRevealFileReference={onRevealFileReference}
            projectId={projectId}
            resolveFileReference={resolveFileReference}
            isCurrentTurnTail={true}
            row={row}
            worktreeId={worktreeId}
        />
    );
});

ChatTimelineLiveTail.displayName = "ChatTimelineLiveTail";

type ChatTimelineRowViewProps = {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly isCurrentTurnTail?: boolean;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onOpenResolvedFileReference: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly onRevealFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly projectId: string | null;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly row: ChatTimelineRow;
    readonly worktreeId: string | null;
};

const ChatTimelineRowView = memo(function ChatTimelineRowView({
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    isCurrentTurnTail = false,
    onAddFileReferenceToChat,
    onOpenFile,
    onOpenImage,
    onOpenResolvedFileReference,
    onOpenSession,
    onRevealFileReference,
    projectId,
    resolveFileReference,
    row,
    worktreeId,
}: ChatTimelineRowViewProps) {
    if (row.kind === "message") {
        return (
            <div className="min-w-0 w-full">
                <ChatMessageRow
                    canRenderFileReference={canRenderFileReference}
                    chatFontFamily={chatFontFamily}
                    chatFontSize={chatFontSize}
                    message={row.message}
                    onAddFileReferenceToChat={onAddFileReferenceToChat}
                    onOpenFile={onOpenResolvedFileReference}
                    onOpenImage={onOpenImage}
                    onRevealFileReference={onRevealFileReference}
                    resolveFileReference={resolveFileReference}
                />
            </div>
        );
    }

    if (row.kind === "activity-segment") {
        return (
            <div className="min-w-0 w-full">
                <ToolActivitySegment
                    canRenderFileReference={canRenderFileReference}
                    chatFontFamily={chatFontFamily}
                    chatFontSize={chatFontSize}
                    isCurrentTurnTail={isCurrentTurnTail}
                    onAddFileReferenceToChat={onAddFileReferenceToChat}
                    onOpenFile={onOpenFile}
                    onOpenFileReference={onOpenResolvedFileReference}
                    onOpenSession={onOpenSession}
                    onRevealFileReference={onRevealFileReference}
                    projectId={projectId}
                    resolveFileReference={resolveFileReference}
                    segment={row}
                    worktreeId={worktreeId}
                />
            </div>
        );
    }

    return (
        <div className="min-w-0 w-full">
            <ToolActivityItem
                activity={row.reviewEntry.activity}
                canRenderFileReference={canRenderFileReference}
                onOpenFile={onOpenFile}
                onOpenFileReference={onOpenResolvedFileReference}
                onOpenSession={onOpenSession}
                projectId={projectId}
                resolveFileReference={resolveFileReference}
                trackedFiles={row.reviewEntry.trackedFiles}
                worktreeId={worktreeId}
            />
        </div>
    );
});

ChatTimelineRowView.displayName = "ChatTimelineRowView";

function UserInputRequestCard({
    onRespond,
    request,
}: {
    readonly onRespond: (input: {
        answers: readonly {
            answers: readonly string[];
            questionId: string;
        }[];
        requestId: string;
        sessionId: string;
    }) => Promise<void>;
    readonly request: AiUserInputRequest;
}) {
    const [selectedOptionsByQuestionId, setSelectedOptionsByQuestionId] =
        useState<Record<string, readonly string[]>>({});
    const [freeTextByQuestionId, setFreeTextByQuestionId] = useState<
        Record<string, string>
    >({});
    const [isSubmitting, setIsSubmitting] = useState(false);

    const answers = useMemo(
        () =>
            request.questions
                .map((question) => {
                    const selectedOptions =
                        selectedOptionsByQuestionId[question.id] ?? [];
                    const freeText =
                        freeTextByQuestionId[question.id]?.trim() ?? "";
                    const nextAnswers = freeText
                        ? [...selectedOptions, freeText]
                        : [...selectedOptions];

                    if (nextAnswers.length === 0) {
                        return null;
                    }

                    return {
                        answers: nextAnswers,
                        questionId: question.id,
                    };
                })
                .filter((answer): answer is NonNullable<typeof answer> =>
                    Boolean(answer),
                ),
        [freeTextByQuestionId, request.questions, selectedOptionsByQuestionId],
    );

    return (
        <div
            className="mb-2 overflow-hidden rounded-lg"
            style={{
                backgroundColor:
                    "color-mix(in srgb, #c2410c 4%, var(--color-bg-secondary))",
                border: "1px solid color-mix(in srgb, #c2410c 24%, var(--color-border))",
            }}
        >
            <div className="flex items-center gap-2 px-3 py-2">
                <svg
                    className="shrink-0"
                    fill="none"
                    height="14"
                    stroke="#c2410c"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.5"
                    viewBox="0 0 24 24"
                    width="14"
                >
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span
                    className="flex-1 font-medium"
                    style={{
                        color: "var(--color-text-primary)",
                        fontSize: "0.85em",
                    }}
                >
                    {request.title}
                </span>
                <span
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: "0.76em",
                    }}
                >
                    {request.questions.length} question
                    {request.questions.length === 1 ? "" : "s"}
                </span>
            </div>

            <div className="flex flex-col gap-3 px-3 py-3">
                {request.questions.map((question) => {
                    const selectedOptions =
                        selectedOptionsByQuestionId[question.id] ?? [];
                    const freeText = freeTextByQuestionId[question.id] ?? "";
                    const needsFreeText =
                        question.isOther || question.options.length === 0;

                    return (
                        <div key={question.id}>
                            {question.header ? (
                                <div
                                    className="mb-1"
                                    style={{
                                        color: "var(--color-text-primary)",
                                        fontSize: "0.8em",
                                        fontWeight: 600,
                                    }}
                                >
                                    {question.header}
                                </div>
                            ) : null}
                            <div
                                className="mb-2"
                                style={{
                                    color: "var(--color-text-secondary)",
                                    fontSize: "0.79em",
                                }}
                            >
                                {question.question}
                            </div>
                            {question.isSecret ? (
                                <div
                                    className="mb-2"
                                    style={{
                                        color: "var(--color-text-secondary)",
                                        fontSize: "0.72em",
                                    }}
                                >
                                    This response will be treated as sensitive
                                    input.
                                </div>
                            ) : null}

                            {question.options.length > 0 ? (
                                <div className="flex flex-wrap gap-2">
                                    {question.options.map((option) => {
                                        const isSelected =
                                            selectedOptions.includes(
                                                option.label,
                                            );
                                        return (
                                            <button
                                                className="app-no-drag rounded-md px-2.5 py-1 text-left transition-colors"
                                                key={option.label}
                                                onClick={() =>
                                                    setSelectedOptionsByQuestionId(
                                                        (current) => {
                                                            const existing =
                                                                current[
                                                                    question.id
                                                                ] ?? [];
                                                            const next =
                                                                isSelected
                                                                    ? existing.filter(
                                                                          (
                                                                              value,
                                                                          ) =>
                                                                              value !==
                                                                              option.label,
                                                                      )
                                                                    : [
                                                                          ...existing,
                                                                          option.label,
                                                                      ];
                                                            return {
                                                                ...current,
                                                                [question.id]:
                                                                    next,
                                                            };
                                                        },
                                                    )
                                                }
                                                style={{
                                                    backgroundColor: isSelected
                                                        ? "#c2410c"
                                                        : "color-mix(in srgb, #c2410c 7%, var(--color-bg-tertiary))",
                                                    border: `1px solid color-mix(in srgb, #c2410c 18%, var(--color-border))`,
                                                    color: isSelected
                                                        ? "#fff"
                                                        : "var(--color-text-primary)",
                                                    cursor: "pointer",
                                                    fontSize: "0.78em",
                                                }}
                                                type="button"
                                            >
                                                <div>{option.label}</div>
                                                {option.description ? (
                                                    <div
                                                        className="mt-0.5"
                                                        style={{
                                                            fontSize: "0.9em",
                                                            opacity: isSelected
                                                                ? 0.85
                                                                : 0.7,
                                                        }}
                                                    >
                                                        {option.description}
                                                    </div>
                                                ) : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : null}

                            {needsFreeText ? (
                                <div className="mt-2">
                                    {question.isSecret ? (
                                        <input
                                            autoCapitalize="off"
                                            autoCorrect="off"
                                            className="ide-input app-no-drag w-full rounded-md px-2.5 py-2"
                                            onChange={(event) =>
                                                setFreeTextByQuestionId(
                                                    (current) => ({
                                                        ...current,
                                                        [question.id]:
                                                            event.target.value,
                                                    }),
                                                )
                                            }
                                            placeholder="Type your answer"
                                            style={{
                                                backgroundColor:
                                                    "var(--color-bg-tertiary)",
                                                border: "1px solid var(--color-border)",
                                                color: "var(--color-text-primary)",
                                                fontSize: "0.8em",
                                            }}
                                            spellCheck={false}
                                            type="password"
                                            value={freeText}
                                        />
                                    ) : (
                                        <textarea
                                            autoCapitalize="off"
                                            autoCorrect="off"
                                            className="ide-input app-no-drag w-full resize-y rounded-md px-2.5 py-2"
                                            onChange={(event) =>
                                                setFreeTextByQuestionId(
                                                    (current) => ({
                                                        ...current,
                                                        [question.id]:
                                                            event.target.value,
                                                    }),
                                                )
                                            }
                                            placeholder={
                                                question.options.length > 0
                                                    ? "Add another answer"
                                                    : "Type your answer"
                                            }
                                            rows={
                                                question.options.length > 0
                                                    ? 2
                                                    : 3
                                            }
                                            style={{
                                                backgroundColor:
                                                    "var(--color-bg-tertiary)",
                                                border: "1px solid var(--color-border)",
                                                color: "var(--color-text-primary)",
                                                fontSize: "0.8em",
                                            }}
                                            spellCheck={false}
                                            value={freeText}
                                        />
                                    )}
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>

            <div
                className="flex flex-wrap gap-2 px-3 py-2"
                style={{
                    borderTop:
                        "1px solid color-mix(in srgb, #c2410c 15%, var(--color-border))",
                }}
            >
                <button
                    className="app-no-drag rounded-md px-3 py-1 font-medium"
                    onClick={() =>
                        void onRespond({
                            answers: [],
                            requestId: request.requestId,
                            sessionId: request.sessionId,
                        })
                    }
                    style={{
                        backgroundColor:
                            "color-mix(in srgb, var(--color-text-secondary) 12%, transparent)",
                        border: "none",
                        color: "var(--color-text-secondary)",
                        cursor: "pointer",
                        fontSize: "0.79em",
                    }}
                    type="button"
                >
                    Cancel
                </button>
                <button
                    className="app-no-drag rounded-md px-3 py-1 font-medium text-white disabled:opacity-50"
                    disabled={answers.length === 0 || isSubmitting}
                    onClick={() => {
                        setIsSubmitting(true);
                        void onRespond({
                            answers,
                            requestId: request.requestId,
                            sessionId: request.sessionId,
                        }).finally(() => setIsSubmitting(false));
                    }}
                    style={{
                        backgroundColor: "var(--color-accent)",
                        border: "none",
                        cursor:
                            answers.length === 0 || isSubmitting
                                ? "not-allowed"
                                : "pointer",
                        fontSize: "0.79em",
                    }}
                    type="button"
                >
                    {isSubmitting ? "Sending..." : "Submit"}
                </button>
            </div>
        </div>
    );
}

/* ─── Streaming indicator ─── */

function StreamingIndicator({ elapsed }: { readonly elapsed: string }) {
    return (
        <div
            className="flex items-baseline gap-2 py-1"
            style={{ fontSize: "0.74em", lineHeight: 1.2 }}
        >
            <span className="inline-flex items-baseline gap-0.75">
                {[0, 1, 2].map((i) => (
                    <span
                        className="inline-block rounded-full"
                        key={i}
                        style={{
                            animation: `ai-bounce 1.2s ease-in-out ${i * 0.15}s infinite`,
                            backgroundColor: "var(--color-accent)",
                            height: 5,
                            opacity: 0.6,
                            width: 5,
                        }}
                    />
                ))}
            </span>
            {elapsed ? (
                <span
                    style={{
                        color: "var(--color-text-secondary)",
                        opacity: 0.6,
                    }}
                >
                    {elapsed}
                </span>
            ) : null}
        </div>
    );
}

/* ─── Utility functions ─── */

function getRuntimeDisplayName(
    runtimeId: RuntimeWorkspaceChatTab["runtimeId"],
) {
    switch (runtimeId) {
        case "claude":
            return "Claude";
        case "grok":
            return "Grok";
        case "kilo":
            return "Kilo";
        case "opencode":
            return "OpenCode";
        case "codex":
        default:
            return "Codex";
    }
}

function createEmptySnapshot(
    tab: RuntimeWorkspaceChatTab,
    catalog: AiRuntimeCatalog | null = null,
): AiSessionSnapshot {
    return {
        activeTurnStartedAt: null,
        availableCommands: catalog?.availableCommands ?? [],
        closedAt: null,
        configOptions: catalog?.configOptions ?? [],
        lastError: null,
        messages: [],
        modeId: catalog?.modeId ?? null,
        modes: catalog?.modes ?? [],
        modelId: catalog?.modelId ?? null,
        models: catalog?.models ?? [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: tab.projectId,
        runtimeId: tab.runtimeId,
        runtimeSessionId: null,
        sessionId: tab.sessionId,
        status: "idle",
        title: tab.title,
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: new Date().toISOString(),
        worktreeId: tab.worktreeId ?? null,
    };
}

function buildBlockNativeTranscript(
    liveTranscript: AiSessionTranscriptModel,
    blocksById: ReadonlyMap<string, AiTranscriptBlock>,
    metadata: readonly AiTranscriptBlockMetadata[],
    payloadsByRef: ReadonlyMap<string, AiTranscriptPayload>,
    snapshot: AiSessionSnapshot,
): AiSessionTranscriptModel {
    const sealedEntryIds = new Set<string>();
    const messages: AiMessage[] = [];
    const toolActivity: AiToolActivity[] = [];
    const activeTurnStartedAt = snapshot.activeTurnStartedAt ?? null;

    for (const item of metadata) {
        const block = blocksById.get(item.blockId);
        if (!block) continue;
        const timelineBlock = transcriptTimelineBlockCache.derive(block, {
            activityVisible: true,
            fontKey: "chat",
        });
        for (const { entry } of timelineBlock.rows) {
            sealedEntryIds.add(entry.id);
            const payload = entry.payloadRef
                ? payloadsByRef.get(entry.payloadRef)?.value
                : null;
            if (isTranscriptMessagePayload(payload)) {
                messages.push(payload.message);
            } else if (isTranscriptToolPayload(payload)) {
                toolActivity.push(payload.activity);
            } else if (entry.kind !== "plan" && entry.kind !== "status") {
                messages.push({
                    attachments: [],
                    content: entry.summary.preview ?? entry.summary.label ?? "",
                    createdAt: entry.createdAt,
                    id: `summary:${entry.id}`,
                    kind: entry.kind === "thinking" ? "thinking" : "assistant",
                    status: "completed",
                });
            }
        }
    }

    return buildAiSessionTranscriptModel({
        activeTurnStartedAt,
        messages: [
            ...messages,
            ...liveTranscript.messages.filter(
                (message) =>
                    activeTurnStartedAt !== null &&
                    message.createdAt >= activeTurnStartedAt &&
                    !sealedEntryIds.has(`message:${message.id}`),
            ),
        ],
        status: snapshot.status,
        toolActivity: [
            ...toolActivity,
            ...liveTranscript.toolActivity.filter(
                (activity) =>
                    activeTurnStartedAt !== null &&
                    activity.createdAt >= activeTurnStartedAt &&
                    !sealedEntryIds.has(
                        `tool:${activity.sessionId}:${activity.id}`,
                    ),
            ),
        ],
        updatedAt: snapshot.updatedAt,
    });
}

function isTranscriptMessagePayload(
    value: unknown,
): value is { readonly kind: "message"; readonly message: AiMessage } {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as { kind?: unknown }).kind === "message" &&
        "message" in value
    );
}

function isTranscriptToolPayload(
    value: unknown,
): value is { readonly kind: "tool"; readonly activity: AiToolActivity } {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as { kind?: unknown }).kind === "tool" &&
        "activity" in value
    );
}

function getActiveTurnStartedAt(
    snapshot: AiSessionSnapshot,
    transcript: AiSessionTranscriptModel,
): string | null {
    if (!isActiveChatTurnStatus(snapshot.status)) {
        return null;
    }

    if (snapshot.activeTurnStartedAt) {
        return snapshot.activeTurnStartedAt;
    }

    const transcriptToolActivity = getAiSessionTranscriptToolActivity(transcript);
    const toolActivity =
        transcriptToolActivity.length > 0
            ? transcriptToolActivity
            : snapshot.toolActivity;
    const latestTurnActivity = [...toolActivity]
        .reverse()
        .find(
            (activity) =>
                activity.id.startsWith("codex-acp:status:turn:") ||
                activity.id.startsWith("comando:status:turn:"),
        );
    if (latestTurnActivity) {
        return latestTurnActivity.createdAt;
    }

    const transcriptMessages = getAiSessionTranscriptMessages(transcript);
    const messages =
        transcriptMessages.length > 0 ? transcriptMessages : snapshot.messages;

    return (
        [...messages]
            .reverse()
            .find((message) => message.kind === "user")?.createdAt ?? null
    );
}

function isComposerDraftEmpty(
    parts: readonly AIComposerPart[],
    attachments: readonly AiImageAttachment[],
    fileContexts: readonly AiFileContextAttachment[],
): boolean {
    return (
        parts.every(
            (part) => part.type === "text" && part.text.trim().length === 0,
        ) &&
        attachments.length === 0 &&
        fileContexts.length === 0
    );
}

async function readImageFileAsAttachment(
    file: File,
): Promise<AiImageAttachment> {
    if (!file.type.startsWith("image/")) {
        throw new Error("Only image files are supported.");
    }

    if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        throw new Error(
            `"${file.name}" exceeds the ${formatBytes(
                MAX_IMAGE_ATTACHMENT_BYTES,
            )} limit.`,
        );
    }

    const dataUrl = await readFileAsDataUrl(file);
    const [, dataBase64 = ""] = dataUrl.split(",", 2);

    return {
        dataBase64,
        id: `draft-image:${crypto.randomUUID()}`,
        mimeType: file.type,
        name: file.name || null,
        sizeBytes: file.size,
    };
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onerror = () => {
            reject(new Error(`Could not read "${file.name}".`));
        };
        reader.onload = () => {
            if (typeof reader.result !== "string") {
                reject(new Error(`Could not read "${file.name}".`));
                return;
            }

            resolve(reader.result);
        };

        reader.readAsDataURL(file);
    });
}

function formatBytes(sizeBytes: number): string {
    if (sizeBytes < 1024 * 1024) {
        return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
    }

    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function cloneComposerPartsForDraft(
    parts: readonly AIComposerPart[],
): AIComposerPart[] {
    return parts.map((part) => ({ ...part }));
}

function readInitialComposerPartsForTab(
    tab: RuntimeWorkspaceChatTab,
): AIComposerPart[] {
    const draftParts =
        useAiStore.getState().sessions[tab.sessionId]?.draftComposerParts ??
        null;

    if (draftParts && !isComposerDraftEmpty(draftParts, [], [])) {
        return cloneComposerPartsForDraft(draftParts);
    }

    if (tab.draft.length > 0) {
        return [{ type: "text", text: tab.draft }];
    }

    return createEmptyComposerParts();
}

function formatAttachmentSize(sizeBytes: number | null): string {
    if (typeof sizeBytes !== "number") {
        return "Image";
    }

    return formatBytes(sizeBytes);
}

function getComandoApi() {
    if (!window.comando) {
        throw new Error(
            "The desktop bridge is not available yet. Restart the Electron app and try again.",
        );
    }

    return window.comando;
}
