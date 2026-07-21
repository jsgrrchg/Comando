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
    type TouchEvent,
    type WheelEvent,
} from "react";

import type {
    AiAvailableCommand,
    AiFileContextAttachment,
    AiImageAttachment,
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
import { getChatDisplayTitle } from "@shared/chatTitle";
import { resolveEditorLanguage } from "@shared/editor-language";

import { useShallow } from "zustand/react/shallow";

import { DEFAULT_AI_DIFF_ZOOM } from "@renderer/app/ai/sessionReviewContracts";
import {
    createReviewFileMutationInput,
    createReviewHunkMutationInput,
} from "@renderer/app/ai/reviewMutationTarget";
import {
    createEmptyAiSessionTranscriptModel,
    getAiSessionTranscriptMessages,
    getAiSessionTranscriptToolActivity,
    type AiSessionTranscriptModel,
} from "@renderer/app/ai/transcriptModel";
import {
    buildBlockNativeTranscriptProjection,
    buildTranscriptToolPayloadRefs,
    type BlockNativeTranscriptProjection,
} from "@renderer/app/ai/transcriptWindowProjection";
import { getGitContextKey } from "@renderer/app/git/context-key";
import { useAiChatSettings } from "@renderer/app/hooks/use-ai-chat-settings";
import { buildChatFontFamily } from "@renderer/app/settings/theme";
import { useAiStore } from "@renderer/app/store/ai-store";
import { TranscriptReviewPayloadRetention } from "@renderer/app/ai/transcriptReviewPayloadRetention";
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
    type ChatScrollWriteReason,
} from "@renderer/app/debug/chatPerformanceProbe";
import type {
    RuntimeWorkspaceChatTab,
    RuntimeWorkspaceFileOpenLocation,
    RuntimeWorkspaceFileReviewContext,
} from "@renderer/app/workspace/tree";
import type {
    MeasuredVirtualRange,
    MeasuredVirtualScrollRequest,
} from "@renderer/components/virtual/MeasuredVirtualList";

import { AIChatAgentControls } from "./AIChatAgentControls";
import { LanguageIcon } from "./LanguageIcon";
import { AIChatComposer } from "./chat/AIChatComposer";
import { AIChatContextUsageBar } from "./chat/AIChatContextUsageBar";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatTranscriptSurface } from "./chat/ChatTranscriptSurface";
import { ChatContentColumn } from "./chat/ChatContentColumn";
import { ChatComposerShell } from "./chat/ChatComposerShell";
import { ChatTimelineHistoryRows } from "./chat/ChatTimelineHistoryRows";
import { ChatMessageRow } from "./chat/ChatMessageRow";
import { CHAT_PILL_VARIANTS } from "./chat/chatPillPalette";
import {
    reconcileChatTimelineModelFromProjection,
    reconcileChatTimelineModelIncrementallyFromTranscript,
    type ChatTimelineModel,
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
    shouldHoldChatScrollFollowIntent,
} from "./chat/chatScroll";
import {
    anchorNewChatTurn,
    createChatScrollIntent,
    followChatScrollEnd,
    isAnchoringNewChatTurn,
    isFollowingChatScrollEnd,
    readChatScroll,
} from "./chat/chatScrollIntent";
import {
    createChatScrollCoordinator,
    type ChatScrollCoordinator,
    type ChatScrollTarget,
} from "./chat/chatScrollCoordinator";
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
    type PersistedChatViewState,
} from "./chat/chatViewPersistence";
import { ReviewSurface } from "./chat/ReviewSurface";
import { PlanMessage } from "./chat/PlanMessage";
import { shouldShowPlanBanner } from "./chat/planBannerState";
import {
    buildFileContextLabel,
    buildFileContextTitle,
    serializePromptWithContexts,
} from "./chat/promptContextReferences";
import { QueuedMessagesPanel } from "./chat/QueuedMessagesPanel";
import {
    ActivitySegmentItemRow,
    ToolActivitySegment,
} from "./chat/ToolActivitySegment";
import { ToolActivityItem } from "./chat/ToolActivityItem";
import {
    buildTranscriptTimelineItems,
    captureTranscriptSemanticAnchor,
    flattenTranscriptTimelineItems,
    getTranscriptTimelineItemAnchorEntryId,
    isChatTimelineRowItem,
    isTranscriptActivityEntryItem,
    isTranscriptActivityRangeItem,
    isTranscriptActivitySummaryItem,
    resolveTranscriptBlockIdsInRange,
    resolveTranscriptEntryBlockId,
    resolveUnloadedTranscriptBlockIdsInRange,
    type TranscriptActivityGroupExpansionById,
    type TranscriptTimelineItem,
    type TranscriptTimelineVirtualRow,
} from "./chat/transcriptBlockVirtualization";
import { splitLongContentRows } from "./chat/longContentVirtualization";
import { useChatStreamingFrameProbe } from "./chat/useChatStreamingFrameProbe";
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

function getTrailingUserTimelineRowId(
    rows: readonly TranscriptTimelineItem[],
): string | null {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (
            row &&
            isChatTimelineRowItem(row) &&
            row.kind === "message" &&
            row.message.kind === "user"
        ) {
            return row.id;
        }
    }

    return null;
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
    | "historyHydrationState"
    | "localError"
    | "queue"
    | "snapshot"
    | "transcript"
    | "transcriptWindow"
>;

type ChatSemanticRestoreAnchor = NonNullable<
    PersistedChatViewState["anchor"]
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
        historyHydrationState: session.historyHydrationState,
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
const SCROLL_PERSIST_DELAY_MS = 80;
const EMPTY_DRAFT_ATTACHMENTS: readonly AiImageAttachment[] = [];
const EMPTY_COMPOSER_PARTS: readonly AIComposerPart[] =
    createEmptyComposerParts();
const EMPTY_DRAFT_FILE_CONTEXTS: readonly AiFileContextAttachment[] = [];
const EMPTY_TRANSCRIPT_MODEL = createEmptyAiSessionTranscriptModel();
const EMPTY_ACTIVITY_EXPANSION: TranscriptActivityGroupExpansionById = {};
const CLOSED_SUBAGENT_MESSAGE =
    "This subagent was closed by its parent thread and can’t receive new messages.";
const PROJECT_MENTION_SEARCH_FOLLOWUP_DEBOUNCE_MS = 50;

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
    const loadTranscriptWindowBlock = useAiStore(
        (s) => s.loadTranscriptWindowBlock,
    );
    const loadTranscriptPayload = useAiStore((s) => s.loadTranscriptPayload);
    const releaseTranscriptPayload = useAiStore(
        (s) => s.releaseTranscriptPayload,
    );
    const setTranscriptWindowAnchor = useAiStore(
        (s) => s.setTranscriptWindowAnchor,
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
    const scrollIntentRef = useRef(createChatScrollIntent());
    const pendingNewTurnAnchorRef = useRef<string | null | undefined>(
        undefined,
    );
    const shouldAutoFollowRef = useRef(true);
    const [scrollCoordinator] = useState<ChatScrollCoordinator>(
        createChatScrollCoordinator,
    );
    const resizeBottomLockRef = useRef(false);
    const resizeStartedNearBottomRef = useRef(false);
    const scrollPersistTimerRef = useRef<number | null>(null);
    const pendingPersistedScrollTopRef = useRef<number | null>(null);
    const pendingPersistedNearBottomRef = useRef<boolean | null>(null);
    const stableTimelineRef = useRef<{
        readonly activeTurnStartedAt: string | null;
        readonly attentionToolCallIds: ReadonlySet<string>;
        readonly model: ChatTimelineModel | null;
        readonly projection: BlockNativeTranscriptProjection | null;
        readonly sessionId: string;
        readonly status: AiSessionSnapshot["status"] | null;
        readonly trackedFiles: AiSessionSnapshot["trackedFiles"] | null;
        readonly transcript: AiSessionTranscriptModel | null;
    }>({
        activeTurnStartedAt: null,
        attentionToolCallIds: new Set(),
        model: null,
        projection: null,
        sessionId: tab.sessionId,
        status: null,
        trackedFiles: null,
        transcript: null,
    });
    const semanticAnchorRef = useRef<PersistedChatViewState["anchor"]>(
        null,
    );
    const semanticRestoreFallbackScrollTopRef = useRef<number | null>(null);
    const initialComposerParts = readInitialComposerPartsForTab(tab);
    const composerPartsRef = useRef<AIComposerPart[]>(initialComposerParts);
    const persistedDraftRef = useRef(tab.draft);
    const lastSeenDraftComposerPartsSerializedRef = useRef("");

    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [newTurnAnchorRowId, setNewTurnAnchorRowId] = useState<
        string | null
    >(null);
    const [semanticRestoreAnchor, setSemanticRestoreAnchor] = useState<
        PersistedChatViewState["anchor"]
    >(null);
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

    useEffect(() => {
        if (active) return;
        // Cold tabs retain their metadata and persisted anchor, but must not
        // pin transcript blocks that prevent the global budget from evicting.
        setTranscriptWindowAnchor(tab.sessionId, null, false);
    }, [active, setTranscriptWindowAnchor, tab.sessionId]);

    const snapshot =
        sessionState?.snapshot ?? createEmptySnapshot(tab, runtimeCatalog);
    const chatDisplayTitle = useMemo(
        () =>
            getChatDisplayTitle({
                manualTitle: snapshot.manualTitle,
                messages: snapshot.messages,
                title: snapshot.title || tab.title,
            }),
        [snapshot.manualTitle, snapshot.messages, snapshot.title, tab.title],
    );
    const storedTranscript =
        sessionState?.transcript ?? EMPTY_TRANSCRIPT_MODEL;
    const transcriptWindow = sessionState?.transcriptWindow ?? null;
    /* eslint-disable react-hooks/refs -- Projection and timeline reconciliation read the last committed identities without publishing speculative renders. */
    const transcriptProjection = useMemo(
        () =>
            transcriptWindow?.capabilityVersion
                ? buildBlockNativeTranscriptProjection(
                      storedTranscript,
                      transcriptWindow.blocksById,
                      transcriptWindow.metadata,
                      transcriptWindow.payloadsByRef,
                      stableTimelineRef.current.sessionId === tab.sessionId
                          ? stableTimelineRef.current.projection
                          : null,
                  )
                : null,
        [
            storedTranscript,
            tab.sessionId,
            transcriptWindow?.blocksById,
            transcriptWindow?.capabilityVersion,
            transcriptWindow?.metadata,
            transcriptWindow?.payloadsByRef,
        ],
    );
    const transcript = transcriptProjection?.hot.transcript ?? storedTranscript;
    const toolPayloadRefByActivityId = useMemo(
        () =>
            buildTranscriptToolPayloadRefs(
                transcriptWindow?.blocksById ?? new Map(),
            ),
        [transcriptWindow?.blocksById],
    );
    const reviewPayloadRetentionRef = useRef(
        new TranscriptReviewPayloadRetention(),
    );
    const handleToolPayloadVisibilityChange = useCallback(
        (activityId: string, visible: boolean) => {
            const payloadRef = toolPayloadRefByActivityId.get(activityId);
            if (!payloadRef) return;
            if (!visible) {
                if (reviewPayloadRetentionRef.current.release(payloadRef)) {
                    releaseTranscriptPayload(tab.sessionId, payloadRef);
                }
                return;
            }
            if (!reviewPayloadRetentionRef.current.retain(payloadRef)) return;
            void loadTranscriptPayload(tab.sessionId, payloadRef).then(() => {
                if (!reviewPayloadRetentionRef.current.has(payloadRef)) {
                    releaseTranscriptPayload(tab.sessionId, payloadRef);
                }
            });
        },
        [
            loadTranscriptPayload,
            releaseTranscriptPayload,
            tab.sessionId,
            toolPayloadRefByActivityId,
        ],
    );
    useEffect(
        () => () => {
            for (const payloadRef of reviewPayloadRetentionRef.current.releaseAll()) {
                releaseTranscriptPayload(tab.sessionId, payloadRef);
            }
        },
        [releaseTranscriptPayload, tab.sessionId],
    );
    const isStreaming = isChatStreamingStatus(snapshot.status);
    const activeTurnStartedAt = getActiveTurnStartedAt(snapshot, transcript);
    const currentError = sessionState?.localError ?? snapshot.lastError;
    const hasMissingHistoricalSnapshot =
        sessionState?.historyHydrationState === "missing";
    const retryHistoricalHydration = useCallback(() => {
        void ensureSession(sessionTab);
    }, [ensureSession, sessionTab]);
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
            projection: transcriptProjection,
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
            () => {
                if (transcriptProjection) {
                    return reconcileChatTimelineModelFromProjection(
                        previousTimelineModel,
                        canReconcileIncrementally
                            ? previousTimelineState.projection
                            : null,
                        {
                            activeTurnStartedAt,
                            attentionToolCallIds,
                            projection: transcriptProjection,
                            status: snapshot.status,
                            trackedFiles: canonicalTrackedFiles,
                            updatedAt: snapshot.updatedAt,
                        },
                    );
                }
                return reconcileChatTimelineModelIncrementallyFromTranscript(
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
                );
            },
        );
    }, [
        activeTurnStartedAt,
        attentionToolCallIds,
        canonicalTrackedFiles,
        snapshot.status,
        snapshot.updatedAt,
        tab.sessionId,
        transcript,
        transcriptProjection,
    ]);
    const [activityExpansionBySessionId, setActivityExpansionBySessionId] =
        useState<Record<string, TranscriptActivityGroupExpansionById>>({});
    const activityExpansionByGroupId =
        activityExpansionBySessionId[tab.sessionId] ?? EMPTY_ACTIVITY_EXPANSION;
    const transcriptTimelineItems = useMemo(
        () =>
            measureChatPerformance(
                "presentation_build_ms",
                {
                    sessionId: tab.sessionId,
                    values: {
                        metadataBlocks: transcriptWindow?.metadata.length ?? 0,
                        timelineRows: timelineModel.historyRows.length,
                    },
                },
                () => {
                    const sourceItems = transcriptWindow?.capabilityVersion
                        ? buildTranscriptTimelineItems(
                              transcriptWindow.metadata,
                              transcriptWindow.blocksById,
                              timelineModel.historyRows,
                          )
                        : timelineModel.historyRows;
                    const flattenedItems = flattenTranscriptTimelineItems(
                        sourceItems,
                        {
                            activeGroupId: null,
                            defaultExpanded:
                                aiChatSettings.toolActivityDefaultExpansion ===
                                "expanded",
                            expansionByGroupId: activityExpansionByGroupId,
                        },
                    );
                    return splitLongContentRows(
                        flattenedItems,
                        (item): item is typeof item & {
                            readonly kind: "message";
                        } =>
                            item.kind === "message",
                    );
                },
            ),
        [
            activityExpansionByGroupId,
            aiChatSettings.toolActivityDefaultExpansion,
            timelineModel.historyRows,
            tab.sessionId,
            transcriptWindow?.blocksById,
            transcriptWindow?.capabilityVersion,
            transcriptWindow?.metadata,
        ],
    );
    const hotTailRow =
        timelineModel.liveTailRow ?? timelineModel.retainedTailRow;
    const hotTailRows = useMemo(
        () =>
            hotTailRow
                ? flattenTranscriptTimelineItems([hotTailRow], {
                      activeGroupId:
                          hotTailRow.kind === "activity-segment"
                              ? hotTailRow.id
                              : null,
                      defaultExpanded:
                          aiChatSettings.toolActivityDefaultExpansion ===
                          "expanded",
                      expansionByGroupId: activityExpansionByGroupId,
                  }).filter(isChatTimelineRowItem)
                : [],
        [
            activityExpansionByGroupId,
            aiChatSettings.toolActivityDefaultExpansion,
            hotTailRow,
        ],
    );
    const getPerformanceNavigationGeneration = useCallback(
        () => scrollIntentRef.current.navigationGeneration,
        [],
    );
    useChatStreamingFrameProbe({
        active,
        getNavigationGeneration: getPerformanceNavigationGeneration,
        isStreaming,
        scrollRef,
        sessionId: tab.sessionId,
        timelineContentRef,
    });

    const beginNewTurnAnchor = useCallback(() => {
        if (!shouldAutoFollowRef.current) {
            return;
        }

        pendingNewTurnAnchorRef.current = getTrailingUserTimelineRowId(
            transcriptTimelineItems,
        );
        setNewTurnAnchorRowId(null);
        scrollIntentRef.current = anchorNewChatTurn(scrollIntentRef.current);
    }, [transcriptTimelineItems]);

    useLayoutEffect(() => {
        if (
            pendingNewTurnAnchorRef.current === undefined ||
            !isAnchoringNewChatTurn(scrollIntentRef.current)
        ) {
            return;
        }

        const trailingUserRowId = getTrailingUserTimelineRowId(
            transcriptTimelineItems,
        );
        if (
            !trailingUserRowId ||
            trailingUserRowId === pendingNewTurnAnchorRef.current
        ) {
            return;
        }

        pendingNewTurnAnchorRef.current = undefined;
        setNewTurnAnchorRowId(trailingUserRowId);
        setShowJumpToBottom(false);
    }, [transcriptTimelineItems]);
    const setActivityGroupExpanded = useCallback(
        (groupId: string, expanded: boolean) => {
            setActivityExpansionBySessionId((current) => ({
                ...current,
                [tab.sessionId]: {
                    ...current[tab.sessionId],
                    [groupId]: {
                        ...current[tab.sessionId]?.[groupId],
                        expanded,
                    },
                },
            }));
        },
        [tab.sessionId],
    );
    const setActivityRangeExpanded = useCallback(
        (groupId: string, start: number, expanded: boolean) => {
            setActivityExpansionBySessionId((current) => {
                const currentSession = current[tab.sessionId] ?? {};
                const currentGroup = currentSession[groupId];
                const expandedRangeStarts = new Set(
                    currentGroup?.expandedRangeStarts,
                );
                const collapsedRangeStarts = new Set(
                    currentGroup?.collapsedRangeStarts,
                );
                if (expanded) {
                    expandedRangeStarts.add(start);
                    collapsedRangeStarts.delete(start);
                } else {
                    expandedRangeStarts.delete(start);
                    collapsedRangeStarts.add(start);
                }
                return {
                    ...current,
                    [tab.sessionId]: {
                        ...currentSession,
                        [groupId]: {
                            ...currentGroup,
                            collapsedRangeStarts: [
                                ...collapsedRangeStarts,
                            ].sort((left, right) => left - right),
                            expandedRangeStarts: [...expandedRangeStarts].sort(
                                (left, right) => left - right,
                            ),
                        },
                    },
                };
            });
        },
        [tab.sessionId],
    );
    /* eslint-enable react-hooks/refs */
    // Commit the reconciled timeline to the ref after render so StrictMode's
    // double-render cannot leave a stale/discarded model written during memo.
    useEffect(() => {
        stableTimelineRef.current = {
            activeTurnStartedAt,
            attentionToolCallIds,
            model: timelineModel,
            projection: transcriptProjection,
            sessionId: tab.sessionId,
            status: snapshot.status,
            trackedFiles: canonicalTrackedFiles,
            transcript,
        };
        cacheChatTimeline({
            activeTurnStartedAt,
            attentionToolCallIds,
            model: timelineModel,
            projection: transcriptProjection,
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
        transcriptProjection,
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
    const persistedViewStateRef = useRef<Pick<
        PersistedChatViewState,
        "anchor" | "isNearBottom" | "scrollTop"
    > | null>(persistedViewState);

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

    const requestChatScroll = useCallback(
        (request: {
            readonly reason: Exclude<ChatScrollWriteReason, "settle">;
            readonly target: ChatScrollTarget;
        }) => {
            scrollCoordinator.request(request, {
                element: scrollRef.current,
                navigationGeneration:
                    scrollIntentRef.current.navigationGeneration,
                sessionId: tab.sessionId,
            });
        },
        [scrollCoordinator, tab.sessionId],
    );

    const writeProgrammaticScroll = useCallback(
        (target: ChatScrollTarget, reason: Exclude<ChatScrollWriteReason, "settle">) => {
            requestChatScroll({ reason, target });
            // Layout effects need the followed edge before paint. Requests from
            // the virtualizer stay microtask-coalesced so one commit picks one
            // highest-priority movement instead of competing scroll writes.
            scrollCoordinator.flush();
        },
        [requestChatScroll, scrollCoordinator],
    );

    const scrollToBottom = useCallback(
        (reason: "follow-end" = "follow-end") => {
            writeProgrammaticScroll("end", reason);
        },
        [writeProgrammaticScroll],
    );

    const cancelPendingScrollToBottom = useCallback(() => {
        // A direct user gesture invalidates queued corrections before they can
        // override the reader's position in the next microtask.
        scrollCoordinator.cancelPending();
    }, [scrollCoordinator]);

    const scheduleScrollToBottom = useCallback(() => {
        if (!isFollowingChatScrollEnd(scrollIntentRef.current)) {
            return;
        }

        requestChatScroll({
            reason: "follow-end",
            target: "end",
        });
    }, [requestChatScroll]);

    const handleTimelineVirtualScrollRequest = useCallback(
        (request: MeasuredVirtualScrollRequest) => {
            requestChatScroll(request);
        },
        [requestChatScroll],
    );

    const handleSemanticAnchorRestored = useCallback(() => {
        semanticRestoreFallbackScrollTopRef.current = null;
        setSemanticRestoreAnchor(null);
        setShowJumpToBottom(true);
    }, []);

    const handleSemanticAnchorUnavailable = useCallback(() => {
        const fallbackScrollTop = semanticRestoreFallbackScrollTopRef.current;
        semanticRestoreFallbackScrollTopRef.current = null;
        setSemanticRestoreAnchor(null);
        if (fallbackScrollTop !== null) {
            writeProgrammaticScroll(fallbackScrollTop, "restore");
        }
        setShowJumpToBottom(true);
    }, [writeProgrammaticScroll]);

    useEffect(() => {
        if (!active || !semanticRestoreAnchor) {
            return;
        }
        if (!transcriptWindow?.capabilityVersion) {
            handleSemanticAnchorUnavailable();
            return;
        }

        const blockId =
            semanticRestoreAnchor.blockId ??
            resolveTranscriptEntryBlockId(
                transcriptWindow.blocksById,
                semanticRestoreAnchor.entryId,
            );
        if (!blockId) {
            handleSemanticAnchorUnavailable();
            return;
        }

        // Hydration may discover a legacy anchor's block after activation.
        semanticAnchorRef.current = {
            ...semanticRestoreAnchor,
            blockId,
        };
        if (semanticRestoreAnchor.blockId !== blockId) {
            setSemanticRestoreAnchor((current) =>
                current?.blockId === blockId
                    ? current
                    : current
                      ? { ...current, blockId }
                      : null,
            );
        }
        setTranscriptWindowAnchor(tab.sessionId, blockId, false);
        if (transcriptWindow.blocksById.has(blockId)) {
            return;
        }

        void loadTranscriptWindowBlock(tab.sessionId, blockId).then((block) => {
            if (!block) {
                handleSemanticAnchorUnavailable();
            }
        });
    }, [
        active,
        handleSemanticAnchorUnavailable,
        loadTranscriptWindowBlock,
        semanticRestoreAnchor?.blockId,
        setTranscriptWindowAnchor,
        tab.sessionId,
        transcriptWindow?.blocksById,
        transcriptWindow?.capabilityVersion,
    ]);

    const handleNewTurnScrollTarget = useCallback(
        (target: number) => {
            if (!isAnchoringNewChatTurn(scrollIntentRef.current)) {
                return;
            }

            writeProgrammaticScroll(target, "new-turn");
        },
        [writeProgrammaticScroll],
    );

    const handleTimelineVirtualRangeChange = useCallback((range: MeasuredVirtualRange) => {
        const firstVisibleTimelineRow = transcriptTimelineItems
            .slice(range.visibleStartIndex, range.visibleEndIndex + 1)
            .find(isChatTimelineRowItem);
        const scrollElement = scrollRef.current;
        const listItemElement = firstVisibleTimelineRow
            ? [...(
                  timelineContentRef.current?.querySelectorAll<HTMLElement>(
                      "[data-list-key]",
                  ) ?? []
              )].find((element) => element.dataset.listKey === firstVisibleTimelineRow.id)
            : null;
        const offsetWithinEntry =
            scrollElement && listItemElement
                ? Math.max(
                      0,
                      scrollElement.scrollTop -
                          (scrollElement.scrollTop +
                              listItemElement.getBoundingClientRect().top -
                              scrollElement.getBoundingClientRect().top),
                  )
                : 0;
        const nextAnchor = captureTranscriptSemanticAnchor({
            entryId: firstVisibleTimelineRow
                ? getTranscriptTimelineItemAnchorEntryId(firstVisibleTimelineRow)
                : null,
            offsetWithinEntry,
        });
        semanticAnchorRef.current = nextAnchor
            ? {
                  ...nextAnchor,
                  blockId: resolveTranscriptEntryBlockId(
                      transcriptWindow?.blocksById ?? new Map(),
                      nextAnchor.entryId,
                  ),
              }
            : null;
        const visibleBlockIds = resolveUnloadedTranscriptBlockIdsInRange(
            transcriptTimelineItems,
            range.visibleStartIndex,
            range.visibleEndIndex,
        );
        const residentBlockIds = resolveTranscriptBlockIdsInRange(
            transcriptTimelineItems,
            range.visibleStartIndex,
            range.visibleEndIndex,
        );
        setTranscriptWindowAnchor(
            tab.sessionId,
            residentBlockIds[0] ?? null,
            shouldAutoFollowRef.current,
        );
        for (const blockId of visibleBlockIds) {
            void loadTranscriptWindowBlock(tab.sessionId, blockId);
        }
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
    }, [
        loadTranscriptWindowBlock,
        setTranscriptWindowAnchor,
        tab.sessionId,
        transcriptWindow?.blocksById,
        transcriptTimelineItems,
    ]);

    const handleTimelineVirtualResizeAutoFollow = useCallback(() => {
        if (isAnchoringNewChatTurn(scrollIntentRef.current)) {
            return;
        }
        scheduleScrollToBottom();
        setShowJumpToBottom(false);
    }, [scheduleScrollToBottom]);

    const shouldPreserveTimelineVirtualResizeAnchor = useCallback(() => {
        return !resizeBottomLockRef.current && !shouldAutoFollowRef.current;
    }, []);

    const shouldPreserveTimelineVirtualMeasureAnchor = useCallback(() => {
        return !resizeBottomLockRef.current;
    }, []);

    const shouldDeferTimelineTrailingUserMeasurementAnchor = useCallback(() => {
        return (
            shouldAutoFollowRef.current &&
            isFollowingChatScrollEnd(scrollIntentRef.current) &&
            !resizeBottomLockRef.current
        );
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

            // Inactive chat views can unmount, so keep the last confirmed
            // viewport available for the next activation.
            persistedViewStateRef.current = {
                anchor: semanticAnchorRef.current,
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

    const takeScheduledScrollPersist = useCallback((): {
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

        pendingPersistedNearBottomRef.current = null;
        pendingPersistedScrollTopRef.current = null;

        return pendingState;
    }, []);

    const flushScheduledScrollPersist = useCallback(() => {
        const pendingState = takeScheduledScrollPersist();
        if (pendingState) {
            persistCurrentViewState({
                isNearBottom: pendingState.isNearBottom ?? undefined,
                scrollTop: pendingState.scrollTop ?? undefined,
            });
        }
        return pendingState;
    }, [persistCurrentViewState, takeScheduledScrollPersist]);

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

    const settleResizeScrollToBottom = useCallback(() => {
        shouldAutoFollowRef.current = true;
        scrollToBottom();

        const scrollEl = scrollRef.current;
        if (scrollEl) {
            scheduleScrollPersist(scrollEl.scrollTop, true);
        }
        resizeBottomLockRef.current = false;
        resizeStartedNearBottomRef.current = false;
    }, [scheduleScrollPersist, scrollToBottom]);

    const handleTimelineVirtualResizeStart = useCallback(() => {
        const scrollEl = scrollRef.current;
        const startedNearBottom =
            shouldAutoFollowRef.current ||
            (scrollEl ? isNearBottom(scrollEl) : false);

        resizeStartedNearBottomRef.current = startedNearBottom;
        resizeBottomLockRef.current = startedNearBottom;

        if (startedNearBottom) {
            shouldAutoFollowRef.current = true;
        }
    }, [isNearBottom]);

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
            if (
                !shouldAutoFollowRef.current ||
                (event.deltaY >= 0 &&
                    !isAnchoringNewChatTurn(scrollIntentRef.current))
            ) {
                return;
            }

            cancelPendingScrollToBottom();
            shouldAutoFollowRef.current = false;
            scrollIntentRef.current = readChatScroll(scrollIntentRef.current);
            pendingNewTurnAnchorRef.current = undefined;
            setNewTurnAnchorRowId(null);
            resizeBottomLockRef.current = false;
            resizeStartedNearBottomRef.current = false;
        },
        [cancelPendingScrollToBottom],
    );

    const handleTimelineTouchStart = useCallback(
        () => {
            if (!shouldAutoFollowRef.current) {
                return;
            }

            // Touch scrolling has no wheel event, so invalidate follow eagerly.
            cancelPendingScrollToBottom();
            shouldAutoFollowRef.current = false;
            scrollIntentRef.current = readChatScroll(scrollIntentRef.current);
            pendingNewTurnAnchorRef.current = undefined;
            setNewTurnAnchorRowId(null);
            resizeBottomLockRef.current = false;
            resizeStartedNearBottomRef.current = false;
        },
        [cancelPendingScrollToBottom],
    );

    useEffect(() => {
        return () => {
            cancelPendingScrollToBottom();
            resizeBottomLockRef.current = false;
            resizeStartedNearBottomRef.current = false;
            flushScheduledScrollPersist();
        };
    }, [
        cancelPendingScrollToBottom,
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

        const persistViewStateOnDeactivate = () => {
            cancelled = true;
            cancelPendingScrollToBottom();
            const flushedState = takeScheduledScrollPersist();
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

        if (shouldRestoreBottom) {
            shouldAutoFollowRef.current = true;
            scrollIntentRef.current = followChatScrollEnd(scrollIntentRef.current);
            scrollToBottom();
            setJumpToBottomVisibility(false);
        } else {
            shouldAutoFollowRef.current = false;
            scrollIntentRef.current = readChatScroll(scrollIntentRef.current);
            const persistedAnchor = persistedViewStateRef.current?.anchor ?? null;
            if (persistedAnchor) {
                semanticAnchorRef.current = persistedAnchor;
                semanticRestoreFallbackScrollTopRef.current = restoreScrollTop;
                setSemanticRestoreAnchor(persistedAnchor);
            } else {
                semanticRestoreFallbackScrollTopRef.current = null;
                setSemanticRestoreAnchor(null);
                writeProgrammaticScroll(restoreScrollTop, "restore");
            }
            setJumpToBottomVisibility(!isNearBottom(scrollEl));
        }

        return persistViewStateOnDeactivate;
    }, [
        cancelPendingScrollToBottom,
        isNearBottom,
        persistCurrentViewState,
        scrollToBottom,
        takeScheduledScrollPersist,
        writeProgrammaticScroll,
        active,
        tab.sessionId,
    ]);

    useLayoutEffect(() => {
        if (active && shouldAutoFollowRef.current) {
            // The composer can collapse when a turn starts, changing the viewport
            // height before the new timeline entry has been measured.
            scrollToBottom();
        }
    }, [active, composerExpanded, scrollToBottom, snapshot.updatedAt]);

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

        if (isAnchoringNewChatTurn(scrollIntentRef.current)) {
            // The anchor policy owns programmatic movement until the user
            // explicitly navigates away or chooses to follow the latest tail.
            setShowJumpToBottom(false);
            scheduleScrollPersist(el.scrollTop, false);
            return;
        }

        if (
            shouldHoldChatScrollFollowIntent({
                composerExpanded,
                programmaticFollowSettling: false,
                shouldAutoFollow: shouldAutoFollowRef.current,
            })
        ) {
            setShowJumpToBottom(false);
            scheduleScrollPersist(el.scrollTop, true);
            return;
        }

        const nextIsNearBottom = isNearBottom(el);
        shouldAutoFollowRef.current = nextIsNearBottom;
        scrollIntentRef.current = nextIsNearBottom
            ? followChatScrollEnd(scrollIntentRef.current)
            : readChatScroll(scrollIntentRef.current);
        if (!nextIsNearBottom) {
            // Scrollbar drags and keyboard navigation do not pass through the
            // wheel/touch handlers, so they cancel queued writes here as well.
            cancelPendingScrollToBottom();
            pendingNewTurnAnchorRef.current = undefined;
            setNewTurnAnchorRowId(null);
        }
        setShowJumpToBottom(!nextIsNearBottom);
        scheduleScrollPersist(el.scrollTop, nextIsNearBottom);
    }, [
        cancelPendingScrollToBottom,
        composerExpanded,
        isNearBottom,
        scheduleScrollPersist,
    ]);

    const handleJumpToBottom = useCallback(() => {
        cancelPendingScrollToBottom();
        shouldAutoFollowRef.current = true;
        scrollIntentRef.current = followChatScrollEnd(scrollIntentRef.current);
        pendingNewTurnAnchorRef.current = undefined;
        setNewTurnAnchorRowId(null);
        resizeBottomLockRef.current = false;
        resizeStartedNearBottomRef.current = false;
        scrollToBottom();
        setShowJumpToBottom(false);

        const scrollEl = scrollRef.current;
        scheduleScrollPersist(scrollEl?.scrollTop ?? 0, true);
    }, [
        cancelPendingScrollToBottom,
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
        clearDraftAttachments(tab.sessionId);
        clearDraftFileContexts(tab.sessionId);
        setComposerError(null);

        beginNewTurnAnchor();

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
            title: chatDisplayTitle,
        });
    }, [chatDisplayTitle, tab.sessionId]);

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
                    historyRows: transcriptTimelineItems.length,
                    liveTailRows: timelineModel.liveTailRow ? 1 : 0,
                    toolRows: timelineModel.orderedAtomicRows.filter(
                        (row) => row.kind === "tool",
                    ).length,
                },
            });
        },
        [
            tab.sessionId,
            transcriptTimelineItems.length,
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
                <ChatHeader
                    displayTitle={chatDisplayTitle}
                    editing={isEditingTitle}
                    onBeginEdit={() => {
                        skipTitleCommitRef.current = false;
                        setTitleDraft(chatDisplayTitle);
                        setIsEditingTitle(true);
                    }}
                    onCancelEdit={() => {
                        skipTitleCommitRef.current = true;
                        setIsEditingTitle(false);
                    }}
                    onCommitEdit={commitTitleEdit}
                    onOpenParent={() => {
                        if (parentSessionId) void openAiSessionById(parentSessionId);
                    }}
                    onTitleDraftChange={setTitleDraft}
                    parentSessionId={parentSessionId}
                    parentTitle={parentSessionContext?.title ?? null}
                    titleDraft={titleDraft}
                    titleInputRef={titleInputRef}
                />
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
                    covered={composerExpanded}
                    historyRows={transcriptTimelineItems}
                    hotTailRowId={hotTailRow?.id ?? null}
                    hotTailRows={hotTailRows}
                    liveTailRowId={timelineModel.liveTailRowId}
                    newTurnAnchorRowId={newTurnAnchorRowId}
                    onNewTurnScrollTarget={handleNewTurnScrollTarget}
                    onSemanticAnchorRestored={handleSemanticAnchorRestored}
                    onSemanticAnchorUnavailable={handleSemanticAnchorUnavailable}
                    onVirtualScrollRequest={handleTimelineVirtualScrollRequest}
                    onSetActivityGroupExpanded={setActivityGroupExpanded}
                    onSetActivityRangeExpanded={setActivityRangeExpanded}
                    onAddFileReferenceToChat={
                        handleAddResolvedFileReferenceToChat
                    }
                    onOpenFile={onOpenFile}
                    onOpenImage={onOpenImage}
                    onOpenResolvedFileReference={handleOpenResolvedFileReference}
                    onOpenSession={openAiSessionById}
                    onToolPayloadVisibilityChange={
                        handleToolPayloadVisibilityChange
                    }
                    onRevealFileReference={handleRevealResolvedFileReference}
                    onScroll={handleScroll}
                    onTouchStart={handleTimelineTouchStart}
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
                    semanticAnchorBlockLoaded={
                        semanticRestoreAnchor?.blockId
                            ? (transcriptWindow?.blocksById.has(
                                  semanticRestoreAnchor.blockId,
                              ) ?? false)
                            : false
                    }
                    semanticRestoreAnchor={semanticRestoreAnchor}
                    sessionId={tab.sessionId}
                    showJumpToBottom={showJumpToBottom}
                    showStreamingIndicator={isStreaming}
                    shouldPreserveVirtualMeasureAnchor={
                        shouldPreserveTimelineVirtualMeasureAnchor
                    }
                    shouldDeferTrailingUserMeasurementAnchor={
                        shouldDeferTimelineTrailingUserMeasurementAnchor
                    }
                    shouldPreserveVirtualResizeAnchor={
                        shouldPreserveTimelineVirtualResizeAnchor
                    }
                    timelineContentRef={timelineContentRef}
                    streamingStartedAt={activeTurnStartedAt}
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
                            {currentError
                                ? renderError(
                                      currentError,
                                      hasMissingHistoricalSnapshot
                                          ? retryHistoricalHydration
                                          : undefined,
                                  )
                                : null}
                            {composerError ? renderError(composerError) : null}

                            {pendingReviewCount > 0 ? (
                                <ReviewSurface
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
                <ChatComposerShell expanded={composerExpanded}>
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
                </ChatComposerShell>
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

function renderError(error: string, onRetry?: () => void) {
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
            {onRetry ? (
                <button
                    className="app-no-drag shrink-0 rounded px-2 py-1 text-[11px] font-medium transition-colors hover:bg-white/10"
                    onClick={onRetry}
                    type="button"
                >
                    Retry
                </button>
            ) : null}
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
    readonly covered?: boolean;
    readonly historyRows: readonly TranscriptTimelineItem[];
    readonly hotTailRowId: string | null;
    readonly hotTailRows: readonly TranscriptTimelineVirtualRow[];
    readonly liveTailRowId: string | null;
    readonly newTurnAnchorRowId: string | null;
    readonly onNewTurnScrollTarget?: (target: number) => void;
    readonly onSemanticAnchorRestored?: () => void;
    readonly onSemanticAnchorUnavailable?: () => void;
    readonly onVirtualScrollRequest?: (
        request: MeasuredVirtualScrollRequest,
    ) => void;
    readonly onSetActivityGroupExpanded: (
        groupId: string,
        expanded: boolean,
    ) => void;
    readonly onSetActivityRangeExpanded: (
        groupId: string,
        start: number,
        expanded: boolean,
    ) => void;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onToolPayloadVisibilityChange?: (
        activityId: string,
        visible: boolean,
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
    readonly onTouchStart?: (event: TouchEvent<HTMLDivElement>) => void;
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
    readonly semanticAnchorBlockLoaded?: boolean;
    readonly semanticRestoreAnchor?: ChatSemanticRestoreAnchor | null;
    readonly sessionId: string;
    readonly showJumpToBottom: boolean;
    readonly showStreamingIndicator: boolean;
    readonly shouldDeferTrailingUserMeasurementAnchor?: () => boolean;
    readonly shouldPreserveVirtualMeasureAnchor?: () => boolean;
    readonly shouldPreserveVirtualResizeAnchor?: () => boolean;
    readonly timelineContentRef: RefObject<HTMLDivElement | null>;
    readonly streamingStartedAt: string | null;
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
    covered,
    historyRows,
    hotTailRowId,
    hotTailRows,
    liveTailRowId,
    newTurnAnchorRowId,
    onNewTurnScrollTarget,
    onSemanticAnchorRestored,
    onSemanticAnchorUnavailable,
    onVirtualScrollRequest,
    onSetActivityGroupExpanded,
    onSetActivityRangeExpanded,
    onAddFileReferenceToChat,
    onToolPayloadVisibilityChange,
    onOpenFile,
    onOpenImage,
    onOpenResolvedFileReference,
    onOpenSession,
    onJumpToBottom,
    onRevealFileReference,
    onScroll,
    onTouchStart,
    onWheelCapture,
    onVirtualRangeChange,
    onVirtualResizeEnd,
    onVirtualResizeAutoFollow,
    onVirtualResizeStart,
    projectId,
    resolveFileReference,
    scrollRef,
    semanticAnchorBlockLoaded,
    semanticRestoreAnchor,
    sessionId,
    showJumpToBottom,
    showStreamingIndicator,
    shouldDeferTrailingUserMeasurementAnchor,
    shouldPreserveVirtualMeasureAnchor,
    shouldPreserveVirtualResizeAnchor,
    timelineContentRef,
    streamingStartedAt,
    worktreeId,
}: ChatTimelineProps) {
    useRenderProbe("ChatTimeline", {
        active,
        historyRows: historyRows.length,
        rows: historyRows.length + hotTailRows.length,
    });

    return (
        <ChatTranscriptSurface
            chatFontFamily={chatFontFamily}
            covered={covered ?? false}
            jumpToBottom={
                <ChatJumpToBottomButton
                    onClick={onJumpToBottom}
                    visible={showJumpToBottom}
                />
            }
            onScroll={onScroll}
            onTouchStart={onTouchStart}
            onWheelCapture={onWheelCapture}
            scopeKey={sessionId}
            scrollRef={scrollRef}
            timelineContentRef={timelineContentRef}
        >
                        <ChatTimelineHistory
                            active={active}
                            canRenderFileReference={
                                canRenderFileReference
                            }
                            chatFontFamily={chatFontFamily}
                            chatFontSize={chatFontSize}
                            historyRows={historyRows}
                            hotTailRowId={hotTailRowId}
                            hotTailRows={hotTailRows}
                            liveTailRowId={liveTailRowId}
                            newTurnAnchorRowId={newTurnAnchorRowId}
                            onNewTurnScrollTarget={onNewTurnScrollTarget}
                            onSemanticAnchorRestored={onSemanticAnchorRestored}
                            onSemanticAnchorUnavailable={
                                onSemanticAnchorUnavailable
                            }
                            onVirtualScrollRequest={onVirtualScrollRequest}
                            onSetActivityGroupExpanded={
                                onSetActivityGroupExpanded
                            }
                            onSetActivityRangeExpanded={
                                onSetActivityRangeExpanded
                            }
                            onAddFileReferenceToChat={
                                onAddFileReferenceToChat
                            }
                            onToolPayloadVisibilityChange={
                                onToolPayloadVisibilityChange
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
                            semanticAnchorBlockLoaded={
                                semanticAnchorBlockLoaded
                            }
                            semanticRestoreAnchor={semanticRestoreAnchor}
                            sessionId={sessionId}
                            showStreamingIndicator={showStreamingIndicator}
                            shouldDeferTrailingUserMeasurementAnchor={
                                shouldDeferTrailingUserMeasurementAnchor
                            }
                            shouldPreserveVirtualMeasureAnchor={
                                shouldPreserveVirtualMeasureAnchor
                            }
                            shouldPreserveVirtualResizeAnchor={
                                shouldPreserveVirtualResizeAnchor
                            }
                            streamingStartedAt={streamingStartedAt}
                            worktreeId={worktreeId}
                        />
        </ChatTranscriptSurface>
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

export type ChatTimelineHistoryProps = {
    readonly active: boolean;
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly historyRows: readonly TranscriptTimelineItem[];
    readonly hotTailRowId: string | null;
    readonly hotTailRows: readonly TranscriptTimelineVirtualRow[];
    readonly liveTailRowId: string | null;
    readonly newTurnAnchorRowId: string | null;
    readonly onNewTurnScrollTarget?: (target: number) => void;
    readonly onSemanticAnchorRestored?: () => void;
    readonly onSemanticAnchorUnavailable?: () => void;
    readonly onVirtualScrollRequest?: (
        request: MeasuredVirtualScrollRequest,
    ) => void;
    readonly onSetActivityGroupExpanded: (
        groupId: string,
        expanded: boolean,
    ) => void;
    readonly onSetActivityRangeExpanded: (
        groupId: string,
        start: number,
        expanded: boolean,
    ) => void;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onToolPayloadVisibilityChange?: (
        activityId: string,
        visible: boolean,
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
    readonly semanticAnchorBlockLoaded?: boolean;
    readonly semanticRestoreAnchor?: ChatSemanticRestoreAnchor | null;
    readonly sessionId: string;
    readonly showStreamingIndicator: boolean;
    readonly shouldDeferTrailingUserMeasurementAnchor?: () => boolean;
    readonly shouldPreserveVirtualMeasureAnchor?: () => boolean;
    readonly shouldPreserveVirtualResizeAnchor?: () => boolean;
    readonly streamingStartedAt: string | null;
    readonly worktreeId: string | null;
};

export const ChatTimelineHistory = memo(function ChatTimelineHistory({
    active,
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    historyRows,
    hotTailRowId,
    hotTailRows,
    liveTailRowId,
    newTurnAnchorRowId,
    onNewTurnScrollTarget,
    onSemanticAnchorRestored,
    onSemanticAnchorUnavailable,
    onVirtualScrollRequest,
    onSetActivityGroupExpanded,
    onSetActivityRangeExpanded,
    onAddFileReferenceToChat,
    onToolPayloadVisibilityChange,
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
    semanticAnchorBlockLoaded,
    semanticRestoreAnchor,
    sessionId,
    showStreamingIndicator,
    shouldDeferTrailingUserMeasurementAnchor,
    shouldPreserveVirtualMeasureAnchor,
    shouldPreserveVirtualResizeAnchor,
    streamingStartedAt,
    worktreeId,
}: ChatTimelineHistoryProps) {
    const renderRow = useCallback(
        ({
            isCurrentTurnTail,
            row,
        }: {
            readonly isCurrentTurnTail: boolean;
            readonly row: TranscriptTimelineVirtualRow;
        }) => (
            // The list `key` is owned by each call site (the virtual list keys
            // its row wrapper; the non-virtual path keys via Fragment), so this
            // renderer only describes a row's content.
            <ChatTimelineRowView
                canRenderFileReference={canRenderFileReference}
                chatFontFamily={chatFontFamily}
                chatFontSize={chatFontSize}
                onAddFileReferenceToChat={onAddFileReferenceToChat}
                onToolPayloadVisibilityChange={
                    onToolPayloadVisibilityChange
                }
                onOpenFile={onOpenFile}
                onOpenImage={onOpenImage}
                onOpenResolvedFileReference={onOpenResolvedFileReference}
                onOpenSession={onOpenSession}
                onRevealFileReference={onRevealFileReference}
                projectId={projectId}
                resolveFileReference={resolveFileReference}
                isCurrentTurnTail={isCurrentTurnTail}
                onSetActivityGroupExpanded={onSetActivityGroupExpanded}
                onSetActivityRangeExpanded={onSetActivityRangeExpanded}
                row={row}
                worktreeId={worktreeId}
            />
        ),
        [
            canRenderFileReference,
            chatFontFamily,
            chatFontSize,
            onAddFileReferenceToChat,
            onToolPayloadVisibilityChange,
            onOpenFile,
            onOpenImage,
            onOpenResolvedFileReference,
            onOpenSession,
            onSetActivityGroupExpanded,
            onSetActivityRangeExpanded,
            onRevealFileReference,
            projectId,
            resolveFileReference,
            worktreeId,
        ],
    );
    const renderStreamingIndicator = useCallback(
        () => (
            <StreamingIndicator
                active={active}
                startedAt={streamingStartedAt}
            />
        ),
        [active, streamingStartedAt],
    );

    return (
        <ChatTimelineHistoryRows
            active={active}
            chatFontFamily={chatFontFamily}
            chatFontSize={chatFontSize}
            historyRows={historyRows}
            hotTailRowId={hotTailRowId}
            hotTailRows={hotTailRows}
            liveTailRowId={liveTailRowId}
            newTurnAnchorRowId={newTurnAnchorRowId}
            onNewTurnScrollTarget={onNewTurnScrollTarget}
            onSemanticAnchorRestored={onSemanticAnchorRestored}
            onSemanticAnchorUnavailable={onSemanticAnchorUnavailable}
            onVirtualScrollRequest={onVirtualScrollRequest}
            onVirtualRangeChange={onVirtualRangeChange}
            onVirtualResizeEnd={onVirtualResizeEnd}
            onVirtualResizeAutoFollow={onVirtualResizeAutoFollow}
            onVirtualResizeStart={onVirtualResizeStart}
            renderRow={renderRow}
            renderStreamingIndicator={renderStreamingIndicator}
            scrollRef={scrollRef}
            semanticAnchorBlockLoaded={semanticAnchorBlockLoaded}
            semanticRestoreAnchor={semanticRestoreAnchor}
            sessionId={sessionId}
            showStreamingIndicator={showStreamingIndicator}
            shouldDeferTrailingUserMeasurementAnchor={
                shouldDeferTrailingUserMeasurementAnchor
            }
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

type ChatTimelineRowViewProps = {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly isCurrentTurnTail?: boolean;
    readonly onSetActivityGroupExpanded: (
        groupId: string,
        expanded: boolean,
    ) => void;
    readonly onSetActivityRangeExpanded: (
        groupId: string,
        start: number,
        expanded: boolean,
    ) => void;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onToolPayloadVisibilityChange?: (
        activityId: string,
        visible: boolean,
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
    readonly row: TranscriptTimelineVirtualRow;
    readonly worktreeId: string | null;
};

const ChatTimelineRowView = memo(function ChatTimelineRowView({
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    isCurrentTurnTail = false,
    onSetActivityGroupExpanded,
    onSetActivityRangeExpanded,
    onAddFileReferenceToChat,
    onToolPayloadVisibilityChange,
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
    if (row.kind === "content-chunk") {
        return (
            <div
                className="min-w-0 w-full"
                data-content-chunk={row.chunkIndex}
            >
                <ChatMessageRow
                    canRenderFileReference={canRenderFileReference}
                    chatFontFamily={chatFontFamily}
                    chatFontSize={chatFontSize}
                    // Chunks are only emitted for attachment-free assistant text.
                    // The persisted message retains the complete, copyable payload.
                    message={{ ...row.message, content: row.content }}
                    onAddFileReferenceToChat={onAddFileReferenceToChat}
                    onOpenFile={onOpenResolvedFileReference}
                    onOpenImage={onOpenImage}
                    onRevealFileReference={onRevealFileReference}
                    resolveFileReference={resolveFileReference}
                />
            </div>
        );
    }

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

    if (isTranscriptActivitySummaryItem(row)) {
        return (
            <div className="min-w-0 w-full">
                <ToolActivitySegment
                    canRenderFileReference={canRenderFileReference}
                    chatFontFamily={chatFontFamily}
                    chatFontSize={chatFontSize}
                    expanded={row.expanded}
                    isCurrentTurnTail={isCurrentTurnTail}
                    onExpandedChange={(expanded) =>
                        onSetActivityGroupExpanded(row.groupId, expanded)
                    }
                    onAddFileReferenceToChat={onAddFileReferenceToChat}
                    onToolPayloadVisibilityChange={
                        onToolPayloadVisibilityChange
                    }
                    onOpenFile={onOpenFile}
                    onOpenFileReference={onOpenResolvedFileReference}
                    onOpenSession={onOpenSession}
                    onRevealFileReference={onRevealFileReference}
                    projectId={projectId}
                    resolveFileReference={resolveFileReference}
                    renderDetails={false}
                    segment={row.segment}
                    worktreeId={worktreeId}
                />
            </div>
        );
    }

    if (isTranscriptActivityRangeItem(row)) {
        return (
            <ActivityRangeToggle
                end={row.end}
                expanded={row.expanded}
                onExpandedChange={(expanded) =>
                    onSetActivityRangeExpanded(row.groupId, row.start, expanded)
                }
                start={row.start}
            />
        );
    }

    if (isTranscriptActivityEntryItem(row)) {
        return (
            <ActivitySegmentItemRow
                canRenderFileReference={canRenderFileReference}
                chatFontFamily={chatFontFamily}
                chatFontSize={chatFontSize}
                // Entries are independently mounted by the virtual list; a
                // continuous tree connector would be misleading or broken.
                flat
                item={row.item}
                onAddFileReferenceToChat={onAddFileReferenceToChat}
                onOpenFile={onOpenFile}
                onOpenFileReference={onOpenResolvedFileReference}
                onOpenSession={onOpenSession}
                onRevealFileReference={onRevealFileReference}
                onToolPayloadVisibilityChange={onToolPayloadVisibilityChange}
                projectId={projectId}
                resolveFileReference={resolveFileReference}
                worktreeId={worktreeId}
            />
        );
    }

    if (row.kind === "activity-segment") {
        return (
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
                onToolPayloadVisibilityChange={onToolPayloadVisibilityChange}
                projectId={projectId}
                resolveFileReference={resolveFileReference}
                segment={row}
                worktreeId={worktreeId}
            />
        );
    }

    return (
        <div
            className="min-w-0 w-full"
        >
            <ToolActivityItem
                activity={row.reviewEntry.activity}
                canRenderFileReference={canRenderFileReference}
                onOpenFile={onOpenFile}
                onOpenFileReference={onOpenResolvedFileReference}
                onOpenSession={onOpenSession}
                onPayloadVisibilityChange={onToolPayloadVisibilityChange}
                projectId={projectId}
                resolveFileReference={resolveFileReference}
                trackedFiles={row.reviewEntry.trackedFiles}
                worktreeId={worktreeId}
            />
        </div>
    );
});

ChatTimelineRowView.displayName = "ChatTimelineRowView";

function ActivityRangeToggle({
    end,
    expanded,
    onExpandedChange,
    start,
}: {
    readonly end: number;
    readonly expanded: boolean;
    readonly onExpandedChange: (expanded: boolean) => void;
    readonly start: number;
}) {
    const label = `${expanded ? "Hide" : "Show"} actions ${start + 1}–${end}`;

    return (
        <button
            aria-expanded={expanded}
            className="app-no-drag ml-10 rounded px-2 py-1 text-left text-[11px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
            onClick={() => onExpandedChange(!expanded)}
            type="button"
        >
            {label}
        </button>
    );
}

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

function StreamingIndicator({
    active,
    startedAt,
}: {
    readonly active: boolean;
    readonly startedAt: string | null;
}) {
    const fallbackStartedAtRef = useRef<number | null>(null);
    const [elapsed, setElapsed] = useState("");

    useEffect(() => {
        if (!active) {
            return;
        }

        let cancelled = false;
        const parsedStartedAt = startedAt ? Date.parse(startedAt) : Number.NaN;
        const startedAtMs = Number.isFinite(parsedStartedAt)
            ? parsedStartedAt
            : Date.now();
        fallbackStartedAtRef.current = startedAtMs;
        const updateElapsed = () => {
            if (cancelled || fallbackStartedAtRef.current === null) {
                return;
            }
            const totalSec = Math.max(
                0,
                Math.floor(
                    (Date.now() - fallbackStartedAtRef.current) / 1000,
                ),
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
    }, [active, startedAt]);

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
