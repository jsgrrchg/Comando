import {
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
    type RefObject,
} from "react";

import type {
    AiAvailableCommand,
    AiFileContextAttachment,
    AiImageAttachment,
    AiUserInputRequest,
    AiRuntimeStatus,
    AiSessionSnapshot,
    ClaudeAuthMethodId,
    GeminiAuthMethodId,
    ProjectTreeNode,
    SecretValuePatch,
} from "@shared/ipc";
import {
    getImageAttachmentLimitMessage,
    MAX_IMAGE_ATTACHMENTS,
    MAX_IMAGE_ATTACHMENT_BYTES,
} from "@shared/ai-attachments";

import { useShallow } from "zustand/react/shallow";

import { DEFAULT_AI_DIFF_ZOOM } from "@renderer/app/ai/sessionReviewContracts";
import { useAiChatSettings } from "@renderer/app/hooks/use-ai-chat-settings";
import { buildChatFontFamily } from "@renderer/app/settings/theme";
import { useAiStore } from "@renderer/app/store/ai-store";
import { useGitStore } from "@renderer/app/store/git-store";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import { useRenderProbe } from "@renderer/app/debug/renderProbe";
import type {
    RuntimeWorkspaceChatTab,
    RuntimeWorkspaceFileReviewContext,
} from "@renderer/app/workspace/tree";

import { AIChatAgentControls } from "./AIChatAgentControls";
import { LanguageIcon } from "./LanguageIcon";
import { AIChatComposer } from "./chat/AIChatComposer";
import { AIChatContextUsageBar } from "./chat/AIChatContextUsageBar";
import { ChatMessageRow } from "./chat/ChatMessageRow";
import { CHAT_PILL_VARIANTS } from "./chat/chatPillPalette";
import {
    reconcileChatTimelineModel,
    type ChatTimelineModel,
    type ChatTimelineRow,
} from "./chat/chatTimelineModel";
import {
    isActiveChatTurnStatus,
    isChatStreamingStatus,
} from "./chat/chatTurnStatus";
import { isScrollViewportNearBottom } from "./chat/chatScroll";
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
import { ToolActivityItem } from "./chat/ToolActivityItem";
import {
    collectProjectFileRoots,
    resolveProjectFileReference,
    type ResolvedProjectFileReference,
} from "./projectFileReferences";
import {
    deriveReviewItems,
    deriveReviewSummary,
    type ReviewFileItem,
} from "./review/editedFilesPresentationModel";

/* ─── Types ─── */

interface ChatTabViewProps {
    readonly onDraftChange: (tabId: string, draft: string) => void;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
    ) => Promise<void>;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onOpenReview: () => Promise<void>;
    readonly tab: RuntimeWorkspaceChatTab;
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

type CodexAuthMethodId = "chatgpt" | "codex-api-key" | "openai-api-key";

const CODEX_AUTH_METHODS: readonly {
    readonly description: string;
    readonly id: CodexAuthMethodId;
    readonly name: string;
}[] = [
    {
        description: "Open a Codex login flow in a terminal.",
        id: "chatgpt",
        name: "Log in with ChatGPT",
    },
    {
        description: "Use a Codex API key stored locally in Comando.",
        id: "codex-api-key",
        name: "Codex API key",
    },
    {
        description: "Use an OpenAI API key stored locally in Comando.",
        id: "openai-api-key",
        name: "OpenAI API key",
    },
] as const;

type AiRuntimeCatalog = Pick<
    AiSessionSnapshot,
    | "availableCommands"
    | "configOptions"
    | "modeId"
    | "modes"
    | "modelId"
    | "models"
>;

/* ─── Main component ─── */

export const ChatTabView = memo(function ChatTabView({
    onDraftChange,
    onOpenFile,
    onOpenImage,
    onOpenReview,
    tab,
}: ChatTabViewProps) {
    const aiChatSettings = useAiChatSettings();
    const cancelQueuedPromptEdit = useAiStore((s) => s.cancelQueuedPromptEdit);
    const claudeSettings = useAiStore((s) => s.claudeSettings);
    const clearQueuedPrompts = useAiStore((s) => s.clearQueuedPrompts);
    const codexBinaryPath = useAiStore((s) => s.codexBinaryPath);
    const codexSettings = useAiStore((s) => s.codexSettings);
    const ensureSession = useAiStore((s) => s.ensureSession);
    const editQueuedPrompt = useAiStore((s) => s.editQueuedPrompt);
    const geminiSettings = useAiStore((s) => s.geminiSettings);
    const kiloSettings = useAiStore((s) => s.kiloSettings);
    const launchRuntimeAuth = useAiStore((s) => s.launchRuntimeAuth);
    const logoutRuntimeAuth = useAiStore((s) => s.logoutRuntimeAuth);
    const refreshRuntimeStatus = useAiStore((s) => s.refreshRuntimeStatus);
    const removeQueuedPrompt = useAiStore((s) => s.removeQueuedPrompt);
    const respondPermission = useAiStore((s) => s.respondPermission);
    const respondUserInput = useAiStore((s) => s.respondUserInput);
    const saveClaudeRuntimeSettings = useAiStore(
        (s) => s.saveClaudeRuntimeSettings,
    );
    const saveGeminiRuntimeSettings = useAiStore(
        (s) => s.saveGeminiRuntimeSettings,
    );
    const saveKiloRuntimeSettings = useAiStore(
        (s) => s.saveKiloRuntimeSettings,
    );
    const saveCodexRuntimeSettings = useAiStore(
        (s) => s.saveCodexRuntimeSettings,
    );
    const verifyCodexRuntimeSettings = useAiStore(
        (s) => s.verifyCodexRuntimeSettings,
    );
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
    const sessionState = useAiStore(
        useShallow((s) => {
            const session = s.sessions[tab.sessionId];
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
            };
        }),
    );
    const projectSummary = useProjectsStore((state) =>
        tab.projectId
            ? (state.projects.find((project) => project.id === tab.projectId) ??
              null)
            : null,
    );
    const gitSnapshot = useGitStore((state) => {
        if (!tab.projectId) {
            return null;
        }

        return (
            state.snapshots[
                `${tab.projectId}::${tab.worktreeId ?? "primary"}`
            ] ?? null
        );
    });
    const runtimeStatus = useAiStore(
        (s) => s.runtimeStatusById[tab.runtimeId] ?? null,
    );
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const timelineContentRef = useRef<HTMLDivElement | null>(null);
    const shouldAutoFollowRef = useRef(true);
    const pendingScrollFrameRef = useRef<number | null>(null);
    const restoreScrollFrameRef = useRef<number | null>(null);
    const scrollPersistTimerRef = useRef<number | null>(null);
    const pendingPersistedScrollTopRef = useRef<number | null>(null);
    const pendingPersistedNearBottomRef = useRef<boolean | null>(null);
    const stableTimelineRef = useRef<{
        readonly model: ChatTimelineModel | null;
        readonly sessionId: string;
    }>({
        model: null,
        sessionId: tab.sessionId,
    });
    const composerPartsRef = useRef<AIComposerPart[]>(
        createEmptyComposerParts(),
    );
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

    const [binaryPathDraft, setBinaryPathDraft] = useState(codexBinaryPath);
    const [codexAuthMethodDraft, setCodexAuthMethodDraft] =
        useState<CodexAuthMethodId>(getDefaultCodexAuthMethod(runtimeStatus));
    const [codexApiKeyDraft, setCodexApiKeyDraft] = useState("");
    const [openAiApiKeyDraft, setOpenAiApiKeyDraft] = useState("");
    const [shouldClearCodexApiKey, setShouldClearCodexApiKey] = useState(false);
    const [shouldClearOpenAiApiKey, setShouldClearOpenAiApiKey] =
        useState(false);
    const [claudeAuthMethodDraft, setClaudeAuthMethodDraft] =
        useState<ClaudeAuthMethodId | null>(claudeSettings.authMethod);
    const [claudeBinaryPathDraft, setClaudeBinaryPathDraft] = useState(
        claudeSettings.binaryPath ?? "",
    );
    const [claudeGatewayAuthTokenDraft, setClaudeGatewayAuthTokenDraft] =
        useState("");
    const [claudeGatewayBaseUrlDraft, setClaudeGatewayBaseUrlDraft] = useState(
        claudeSettings.gatewayBaseUrl ?? "",
    );
    const [
        claudeGatewayCustomHeadersDraft,
        setClaudeGatewayCustomHeadersDraft,
    ] = useState("");
    const [geminiAuthMethodDraft, setGeminiAuthMethodDraft] =
        useState<GeminiAuthMethodId | null>(geminiSettings.authMethod);
    const [geminiBinaryPathDraft, setGeminiBinaryPathDraft] = useState(
        geminiSettings.binaryPath ?? "",
    );
    const [kiloBinaryPathDraft, setKiloBinaryPathDraft] = useState(
        kiloSettings.binaryPath ?? "",
    );
    const [geminiApiKeyDraft, setGeminiApiKeyDraft] = useState("");
    const [googleApiKeyDraft, setGoogleApiKeyDraft] = useState("");
    const [googleCloudProjectDraft, setGoogleCloudProjectDraft] = useState(
        geminiSettings.googleCloudProject ?? "",
    );
    const [googleCloudLocationDraft, setGoogleCloudLocationDraft] = useState(
        geminiSettings.googleCloudLocation ?? "",
    );
    const [composerParts, setComposerParts] = useState<AIComposerPart[]>(
        createEmptyComposerParts,
    );
    const [composerResetNonce, setComposerResetNonce] = useState(0);
    const showRuntimeConfig = false;
    const [isSavingRuntime, setIsSavingRuntime] = useState(false);
    const [isLaunchingRuntimeAuth, setIsLaunchingRuntimeAuth] = useState(false);
    const [runtimeConfigError, setRuntimeConfigError] = useState<string | null>(
        null,
    );
    const [
        shouldClearClaudeGatewayAuthToken,
        setShouldClearClaudeGatewayAuthToken,
    ] = useState(false);
    const [
        shouldClearClaudeGatewayCustomHeaders,
        setShouldClearClaudeGatewayCustomHeaders,
    ] = useState(false);
    const [shouldClearGeminiApiKey, setShouldClearGeminiApiKey] =
        useState(false);
    const [shouldClearGoogleApiKey, setShouldClearGoogleApiKey] =
        useState(false);
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
            tab.sessionId,
            tab.title,
            tab.worktreeId,
        ],
    );

    useEffect(() => {
        if (tab.runtimeId === "codex") {
            setBinaryPathDraft(codexBinaryPath);
            setCodexAuthMethodDraft(getDefaultCodexAuthMethod(runtimeStatus));
            setCodexApiKeyDraft("");
            setOpenAiApiKeyDraft("");
            setShouldClearCodexApiKey(false);
            setShouldClearOpenAiApiKey(false);
        }
    }, [codexBinaryPath, runtimeStatus, tab.runtimeId]);
    useEffect(() => {
        if (tab.runtimeId !== "claude") {
            return;
        }

        setClaudeAuthMethodDraft(claudeSettings.authMethod);
        setClaudeBinaryPathDraft(claudeSettings.binaryPath ?? "");
        setClaudeGatewayBaseUrlDraft(claudeSettings.gatewayBaseUrl ?? "");
        setClaudeGatewayAuthTokenDraft("");
        setClaudeGatewayCustomHeadersDraft("");
        setShouldClearClaudeGatewayAuthToken(false);
        setShouldClearClaudeGatewayCustomHeaders(false);
    }, [
        claudeSettings.authMethod,
        claudeSettings.binaryPath,
        claudeSettings.gatewayBaseUrl,
        tab.runtimeId,
    ]);
    useEffect(() => {
        if (tab.runtimeId !== "gemini") {
            return;
        }

        setGeminiAuthMethodDraft(geminiSettings.authMethod);
        setGeminiBinaryPathDraft(geminiSettings.binaryPath ?? "");
        setGeminiApiKeyDraft("");
        setGoogleApiKeyDraft("");
        setGoogleCloudProjectDraft(geminiSettings.googleCloudProject ?? "");
        setGoogleCloudLocationDraft(geminiSettings.googleCloudLocation ?? "");
        setShouldClearGeminiApiKey(false);
        setShouldClearGoogleApiKey(false);
    }, [
        geminiSettings.authMethod,
        geminiSettings.binaryPath,
        geminiSettings.googleCloudLocation,
        geminiSettings.googleCloudProject,
        tab.runtimeId,
    ]);
    useEffect(() => {
        if (tab.runtimeId !== "kilo") {
            return;
        }

        setKiloBinaryPathDraft(kiloSettings.binaryPath ?? "");
    }, [kiloSettings.binaryPath, tab.runtimeId]);
    useEffect(() => {
        void ensureSession(sessionTab);
    }, [ensureSession, sessionTab]);

    const snapshot =
        sessionState?.snapshot ?? createEmptySnapshot(tab, runtimeCatalog);
    const isStreaming = isChatStreamingStatus(snapshot.status);
    const activeTurnKey = isActiveChatTurnStatus(snapshot.status)
        ? tab.sessionId
        : null;
    const activeTurnStartedAt = getActiveTurnStartedAt(snapshot);
    const currentError = sessionState?.localError ?? snapshot.lastError;
    const availableCommands =
        snapshot.availableCommands.length > 0
            ? snapshot.availableCommands
            : FALLBACK_COMMANDS;
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
                sessionId,
                title: snapshot?.title ?? session?.meta?.title ?? "Chat",
                worktreeId:
                    snapshot?.worktreeId ??
                    session?.meta?.worktreeId ??
                    tab.worktreeId ??
                    null,
            });
        },
        [openChatSessionTab, tab.projectId, tab.runtimeId, tab.worktreeId],
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
        snapshot.configOptions.length > 0 ||
        snapshot.models.length > 0 ||
        snapshot.modes.length > 0;

    const pendingTrackedFiles = useMemo(
        () =>
            snapshot.trackedFiles.filter(
                (trackedFile) => trackedFile.reviewState === "pending",
            ),
        [snapshot.trackedFiles],
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

            void onOpenFile(
                tab.projectId,
                reference.relativePath,
                tab.worktreeId ?? null,
            );
        },
        [onOpenFile, tab.projectId, tab.worktreeId],
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
        if (activeTurnKey === null || activeTurnStartedAt === null) {
            streamStartTimeRef.current = null;
            setElapsed("");
            return undefined;
        }

        const startedAtMs = Date.parse(activeTurnStartedAt);
        streamStartTimeRef.current = Number.isFinite(startedAtMs)
            ? startedAtMs
            : Date.now();
        const updateElapsed = () => {
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
        updateElapsed();
        const interval = window.setInterval(updateElapsed, 500);
        return () => window.clearInterval(interval);
    }, [activeTurnKey, activeTurnStartedAt]);

    const timelineModel = useMemo(() => {
        const previousTimelineModel =
            stableTimelineRef.current.sessionId === tab.sessionId
                ? stableTimelineRef.current.model
                : null;
        return reconcileChatTimelineModel(previousTimelineModel, {
            messages: snapshot.messages,
            status: snapshot.status,
            toolActivity: snapshot.toolActivity,
            trackedFiles: snapshot.trackedFiles,
        });
    }, [
        snapshot.messages,
        snapshot.status,
        snapshot.toolActivity,
        snapshot.trackedFiles,
        tab.sessionId,
    ]);
    // Commit the reconciled timeline to the ref after render so StrictMode's
    // double-render cannot leave a stale/discarded model written during memo.
    useEffect(() => {
        stableTimelineRef.current = {
            model: timelineModel,
            sessionId: tab.sessionId,
        };
    }, [timelineModel, tab.sessionId]);
    const persistedViewState = useMemo(
        () =>
            readPersistedChatViewState(
                tab.projectId,
                tab.worktreeId ?? null,
                tab.sessionId,
            ),
        [tab.projectId, tab.sessionId, tab.worktreeId],
    );

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

    const scheduleScrollToBottom = useCallback(() => {
        if (pendingScrollFrameRef.current !== null) {
            window.cancelAnimationFrame(pendingScrollFrameRef.current);
        }

        pendingScrollFrameRef.current = window.requestAnimationFrame(() => {
            pendingScrollFrameRef.current = null;
            scrollToBottom();
        });
    }, [scrollToBottom]);

    const persistCurrentViewState = useCallback(
        (overrides?: {
            readonly isNearBottom?: boolean;
            readonly scrollTop?: number;
        }) => {
            const scrollEl = scrollRef.current;
            const scrollTop =
                overrides?.scrollTop ??
                scrollEl?.scrollTop ??
                persistedViewState?.scrollTop ??
                0;
            const nextIsNearBottom =
                overrides?.isNearBottom ??
                (scrollEl
                    ? isNearBottom(scrollEl)
                    : persistedViewState?.isNearBottom ?? true);

            persistChatViewState(
                tab.projectId,
                tab.worktreeId ?? null,
                tab.sessionId,
                {
                    isNearBottom: nextIsNearBottom,
                    scrollTop,
                },
            );
        },
        [
            isNearBottom,
            persistedViewState?.isNearBottom,
            persistedViewState?.scrollTop,
            tab.projectId,
            tab.sessionId,
            tab.worktreeId,
        ],
    );

    const flushScheduledScrollPersist = useCallback(() => {
        if (scrollPersistTimerRef.current !== null) {
            window.clearTimeout(scrollPersistTimerRef.current);
            scrollPersistTimerRef.current = null;
        }

        if (
            pendingPersistedScrollTopRef.current !== null ||
            pendingPersistedNearBottomRef.current !== null
        ) {
            persistCurrentViewState({
                isNearBottom:
                    pendingPersistedNearBottomRef.current ?? undefined,
                scrollTop: pendingPersistedScrollTopRef.current ?? undefined,
            });
        }

        pendingPersistedNearBottomRef.current = null;
        pendingPersistedScrollTopRef.current = null;
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

    useEffect(() => {
        return () => {
            if (pendingScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(pendingScrollFrameRef.current);
                pendingScrollFrameRef.current = null;
            }
            if (restoreScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(restoreScrollFrameRef.current);
                restoreScrollFrameRef.current = null;
            }
            flushScheduledScrollPersist();
        };
    }, [flushScheduledScrollPersist]);

    useLayoutEffect(() => {
        const scrollEl = scrollRef.current;
        const restoreScrollTop = persistedViewState?.scrollTop ?? 0;
        const shouldRestoreBottom = persistedViewState?.isNearBottom ?? true;

        if (!scrollEl) {
            shouldAutoFollowRef.current = shouldRestoreBottom;
            return undefined;
        }

        if (shouldRestoreBottom) {
            shouldAutoFollowRef.current = true;
            scheduleScrollToBottom();
        } else {
            shouldAutoFollowRef.current = false;
            scrollEl.scrollTop = restoreScrollTop;
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
                return;
            }

            nextScrollEl.scrollTop = restoreScrollTop;
        });

        return () => {
            if (restoreScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(restoreScrollFrameRef.current);
                restoreScrollFrameRef.current = null;
            }
            flushScheduledScrollPersist();
            persistCurrentViewState({
                isNearBottom:
                    pendingPersistedNearBottomRef.current ??
                    shouldAutoFollowRef.current,
                scrollTop:
                    pendingPersistedScrollTopRef.current ??
                    scrollEl.scrollTop ??
                    restoreScrollTop,
            });
        };
    }, [
        flushScheduledScrollPersist,
        persistCurrentViewState,
        persistedViewState?.isNearBottom,
        persistedViewState?.scrollTop,
        scheduleScrollToBottom,
        scrollToBottom,
        tab.sessionId,
    ]);

    useLayoutEffect(() => {
        if (shouldAutoFollowRef.current) {
            scheduleScrollToBottom();
        }
    }, [scheduleScrollToBottom, snapshot.updatedAt]);

    useEffect(() => {
        const scrollEl = scrollRef.current;
        const contentEl = timelineContentRef.current;
        if (!scrollEl || !contentEl || typeof ResizeObserver === "undefined") {
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
    }, [scheduleScrollToBottom, tab.sessionId]);

    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const nextIsNearBottom = isNearBottom(el);
        shouldAutoFollowRef.current = nextIsNearBottom;
        scheduleScrollPersist(el.scrollTop, nextIsNearBottom);
    }, [isNearBottom, scheduleScrollPersist]);

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
        const plainText = serializeComposerPartsForPrompt(composerParts);
        const prompt = serializePromptWithContexts(
            plainText,
            draftFileContexts,
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

        flushChatDraft("");
        setComposerParts(createEmptyComposerParts());
        setComposerResetNonce((current) => current + 1);
        flushDraftComposerParts(createEmptyComposerParts());
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

            setComposerParts(submittedParts);
            flushChatDraft(composerPartsToPlainText(submittedParts));
            flushDraftComposerParts(submittedParts);
            setDraftAttachments(tab.sessionId, submittedAttachments);
            for (const fileContext of submittedFileContexts) {
                addDraftFileContext(tab.sessionId, fileContext);
            }
        }
    };

    const handleComposerPartsChange = useCallback(
        (newParts: AIComposerPart[]) => {
            setComposerParts(newParts);
        },
        [],
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

            setComposerParts([...restoredParts]);
            flushChatDraft(composerPartsToPlainText(restoredParts));
            flushDraftComposerParts(restoredParts);
            setComposerError(null);
        },
        [
            editQueuedPrompt,
            flushChatDraft,
            flushDraftComposerParts,
            tab.sessionId,
        ],
    );

    const handleCancelQueuedPromptEdit = useCallback(() => {
        const restoredParts = cancelQueuedPromptEdit(tab.sessionId);
        if (!restoredParts) {
            return;
        }

        setComposerParts([...restoredParts]);
        setComposerResetNonce((current) => current + 1);
        flushChatDraft(composerPartsToPlainText(restoredParts));
        flushDraftComposerParts(restoredParts);
        setComposerError(null);
    }, [
        cancelQueuedPromptEdit,
        flushChatDraft,
        flushDraftComposerParts,
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

        setComposerParts(cloneComposerPartsForDraft(draftComposerParts));
        flushChatDraft(composerPartsToPlainText(draftComposerParts));
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
            void keepTrackedFile({
                path: item.file.path,
                sessionId: tab.sessionId,
            });
        },
        [keepTrackedFile, tab.sessionId],
    );

    const handleRejectPendingReviewItem = useCallback(
        (item: ReviewFileItem) => {
            void rejectTrackedFile({
                path: item.file.path,
                sessionId: tab.sessionId,
            });
        },
        [rejectTrackedFile, tab.sessionId],
    );

    const handleKeepPendingReviewHunk = useCallback(
        (item: ReviewFileItem, hunkId: string) => {
            void keepTrackedFileHunks({
                hunkIds: [hunkId],
                path: item.file.path,
                sessionId: tab.sessionId,
            });
        },
        [keepTrackedFileHunks, tab.sessionId],
    );

    const handleRejectPendingReviewHunk = useCallback(
        (item: ReviewFileItem, hunkId: string) => {
            void rejectTrackedFileHunks({
                hunkIds: [hunkId],
                path: item.file.path,
                sessionId: tab.sessionId,
            });
        },
        [rejectTrackedFileHunks, tab.sessionId],
    );
    const handleOpenReviewTab = useCallback(() => {
        void onOpenReview();
    }, [onOpenReview]);

    useEffect(() => {
        composerPartsRef.current = composerParts;
    }, [composerParts]);

    useEffect(() => {
        return registerComposerSelectionMentionHandler(
            tab.sessionId,
            (selection) => {
                setComposerParts((currentParts) =>
                    appendSelectionMentionPart(currentParts, selection),
                );
                setComposerError(null);
            },
        );
    }, [tab.sessionId]);

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

    useEffect(() => {
        return () => {
            if (projectSearchTimeoutRef.current !== null) {
                window.clearTimeout(projectSearchTimeoutRef.current);
                projectSearchTimeoutRef.current = null;
            }

            projectSearchAbortRef.current?.abort();
            projectSearchAbortRef.current = null;

            const pendingResolversRef = pendingProjectSearchResolversRef;
            const pendingResolvers = pendingResolversRef.current.splice(0);
            pendingResolvers.forEach((resolve) => resolve([]));
        };
    }, []);

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

                projectSearchTimeoutRef.current = window.setTimeout(() => {
                    projectSearchTimeoutRef.current = null;
                    const pendingResolvers =
                        pendingProjectSearchResolversRef.current.splice(0);
                    const searchQuery = pendingProjectSearchQueryRef.current;
                    const controller = new AbortController();
                    projectSearchAbortRef.current = controller;

                    void window.comando
                        .searchProjectEntries({
                            limit: 12,
                            projectId,
                            query: searchQuery,
                            worktreeId: tab.worktreeId ?? null,
                        })
                        .then((entries) => {
                            if (projectSearchAbortRef.current === controller) {
                                projectSearchAbortRef.current = null;
                            }
                            const resolved = controller.signal.aborted
                                ? []
                                : entries;
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
                }, 120);
            });
        },
        [tab.projectId, tab.worktreeId],
    );

    const handleChatFocus = useCallback(() => {
        markChatTabFocused(tab.id);
    }, [markChatTabFocused, tab.id]);

    return (
        <div
            className="flex h-full min-h-0 min-w-0"
            onFocusCapture={handleChatFocus}
            onMouseDownCapture={handleChatFocus}
            style={{ backgroundColor: "var(--color-bg-secondary)" }}
        >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                {showRuntimeConfig
                    ? tab.runtimeId === "codex"
                        ? renderCodexRuntimeConfig({
                              authMethodDraft: codexAuthMethodDraft,
                              authMethods: getCodexAuthMethods(runtimeStatus),
                              binaryPathDraft,
                              codexApiKeyDraft,
                              openAiApiKeyDraft,
                              hasStoredCodexApiKey:
                                  codexSettings.hasCodexApiKey,
                              hasStoredOpenAiApiKey:
                                  codexSettings.hasOpenAiApiKey,
                              isAuthenticated:
                                  runtimeStatus?.authReady ?? false,
                              isLaunchingAuth: isLaunchingRuntimeAuth,
                              shouldClearCodexApiKey,
                              shouldClearOpenAiApiKey,
                              isSaving: isSavingRuntime,
                              onAuthMethodChange: setCodexAuthMethodDraft,
                              onChangeBinaryPath: setBinaryPathDraft,
                              onChangeCodexApiKey: (value) => {
                                  setShouldClearCodexApiKey(false);
                                  setCodexApiKeyDraft(value);
                              },
                              onChangeOpenAiApiKey: (value) => {
                                  setShouldClearOpenAiApiKey(false);
                                  setOpenAiApiKeyDraft(value);
                              },
                              onClearCodexApiKey: () => {
                                  setCodexApiKeyDraft("");
                                  setShouldClearCodexApiKey(true);
                              },
                              onClearOpenAiApiKey: () => {
                                  setOpenAiApiKeyDraft("");
                                  setShouldClearOpenAiApiKey(true);
                              },
                              onLaunchAuth: async () => {
                                  if (codexAuthMethodDraft !== "chatgpt") {
                                      setRuntimeConfigError(
                                          "Choose ChatGPT login before launching Codex auth.",
                                      );
                                      return;
                                  }

                                  setRuntimeConfigError(null);
                                  setIsSavingRuntime(true);
                                  try {
                                      await saveCodexRuntimeSettings({
                                          authMethod: codexAuthMethodDraft,
                                          binaryPath:
                                              binaryPathDraft.trim() || null,
                                          codexApiKey: toSecretValuePatch(
                                              codexApiKeyDraft,
                                              shouldClearCodexApiKey,
                                          ),
                                          openaiApiKey: toSecretValuePatch(
                                              openAiApiKeyDraft,
                                              shouldClearOpenAiApiKey,
                                          ),
                                      });
                                      setCodexApiKeyDraft("");
                                      setOpenAiApiKeyDraft("");
                                      setShouldClearCodexApiKey(false);
                                      setShouldClearOpenAiApiKey(false);
                                  } catch (error) {
                                      setRuntimeConfigError(
                                          error instanceof Error
                                              ? error.message
                                              : "Could not save the Codex runtime settings.",
                                      );
                                      return;
                                  } finally {
                                      setIsSavingRuntime(false);
                                  }

                                  setIsLaunchingRuntimeAuth(true);
                                  try {
                                      await launchRuntimeAuth({
                                          methodId: codexAuthMethodDraft,
                                          projectId: tab.projectId,
                                          runtimeId: "codex",
                                          worktreeId: tab.worktreeId ?? null,
                                      });
                                      setRuntimeConfigError(null);
                                  } catch (error) {
                                      setRuntimeConfigError(
                                          error instanceof Error
                                              ? error.message
                                              : "Could not launch the Codex auth flow.",
                                      );
                                  } finally {
                                      setIsLaunchingRuntimeAuth(false);
                                  }
                              },
                              onLogout: async () => {
                                  setRuntimeConfigError(null);
                                  setIsSavingRuntime(true);
                                  try {
                                      const status = await logoutRuntimeAuth({
                                          runtimeId: "codex",
                                      });
                                      setCodexAuthMethodDraft(
                                          getDefaultCodexAuthMethod(status),
                                      );
                                      setCodexApiKeyDraft("");
                                      setOpenAiApiKeyDraft("");
                                      setShouldClearCodexApiKey(false);
                                      setShouldClearOpenAiApiKey(false);
                                  } catch (error) {
                                      setRuntimeConfigError(
                                          error instanceof Error
                                              ? error.message
                                              : "Could not log out of Codex.",
                                      );
                                  } finally {
                                      setIsSavingRuntime(false);
                                  }
                              },
                              onSave: async () => {
                                  setRuntimeConfigError(null);
                                  setIsSavingRuntime(true);
                                  try {
                                      await saveCodexRuntimeSettings({
                                          authMethod: codexAuthMethodDraft,
                                          binaryPath:
                                              binaryPathDraft.trim() || null,
                                          codexApiKey: toSecretValuePatch(
                                              codexApiKeyDraft,
                                              shouldClearCodexApiKey,
                                          ),
                                          openaiApiKey: toSecretValuePatch(
                                              openAiApiKeyDraft,
                                              shouldClearOpenAiApiKey,
                                          ),
                                      });
                                      setCodexApiKeyDraft("");
                                      setOpenAiApiKeyDraft("");
                                      setShouldClearCodexApiKey(false);
                                      setShouldClearOpenAiApiKey(false);
                                  } catch (error) {
                                      setRuntimeConfigError(
                                          error instanceof Error
                                              ? error.message
                                              : "Could not save the Codex runtime settings.",
                                      );
                                  } finally {
                                      setIsSavingRuntime(false);
                                  }
                              },
                              onVerify: async () => {
                                  setRuntimeConfigError(null);
                                  setIsSavingRuntime(true);
                                  try {
                                      await verifyCodexRuntimeSettings({
                                          authMethod: codexAuthMethodDraft,
                                          binaryPath:
                                              binaryPathDraft.trim() || null,
                                          codexApiKey: toSecretValuePatch(
                                              codexApiKeyDraft,
                                              shouldClearCodexApiKey,
                                          ),
                                          openaiApiKey: toSecretValuePatch(
                                              openAiApiKeyDraft,
                                              shouldClearOpenAiApiKey,
                                          ),
                                      });
                                  } catch (error) {
                                      setRuntimeConfigError(
                                          error instanceof Error
                                              ? error.message
                                              : "Could not verify the Codex runtime.",
                                      );
                                  } finally {
                                      setIsSavingRuntime(false);
                                  }
                              },
                              runtimeConfigError,
                          })
                        : tab.runtimeId === "claude"
                          ? renderClaudeRuntimeConfig({
                                authMethodDraft: claudeAuthMethodDraft,
                                authMethods: runtimeStatus?.authMethods ?? [],
                                binaryPathDraft: claudeBinaryPathDraft,
                                gatewayAuthTokenDraft:
                                    claudeGatewayAuthTokenDraft,
                                gatewayBaseUrlDraft: claudeGatewayBaseUrlDraft,
                                gatewayCustomHeadersDraft:
                                    claudeGatewayCustomHeadersDraft,
                                hasStoredGatewayAuthToken:
                                    claudeSettings.hasGatewayAuthToken,
                                hasStoredGatewayCustomHeaders:
                                    claudeSettings.hasGatewayCustomHeaders,
                                isLaunchingAuth: isLaunchingRuntimeAuth,
                                isSaving: isSavingRuntime,
                                onAuthMethodChange: setClaudeAuthMethodDraft,
                                onChangeBinaryPath: setClaudeBinaryPathDraft,
                                onChangeGatewayAuthToken: (value) => {
                                    setShouldClearClaudeGatewayAuthToken(false);
                                    setClaudeGatewayAuthTokenDraft(value);
                                },
                                onChangeGatewayBaseUrl:
                                    setClaudeGatewayBaseUrlDraft,
                                onChangeGatewayCustomHeaders: (value) => {
                                    setShouldClearClaudeGatewayCustomHeaders(
                                        false,
                                    );
                                    setClaudeGatewayCustomHeadersDraft(value);
                                },
                                onClearGatewayAuthToken: () => {
                                    setClaudeGatewayAuthTokenDraft("");
                                    setShouldClearClaudeGatewayAuthToken(true);
                                },
                                onClearGatewayCustomHeaders: () => {
                                    setClaudeGatewayCustomHeadersDraft("");
                                    setShouldClearClaudeGatewayCustomHeaders(
                                        true,
                                    );
                                },
                                onLaunchAuth: async () => {
                                    if (
                                        !claudeAuthMethodDraft ||
                                        claudeAuthMethodDraft === "gateway"
                                    ) {
                                        setRuntimeConfigError(
                                            "Choose a Claude login method before launching auth.",
                                        );
                                        return;
                                    }

                                    setRuntimeConfigError(null);
                                    setIsSavingRuntime(true);
                                    try {
                                        await saveClaudeRuntimeSettings({
                                            authMethod: claudeAuthMethodDraft,
                                            binaryPath:
                                                claudeBinaryPathDraft.trim() ||
                                                null,
                                            gatewayAuthToken:
                                                toSecretValuePatch(
                                                    claudeGatewayAuthTokenDraft,
                                                    shouldClearClaudeGatewayAuthToken,
                                                ),
                                            gatewayBaseUrl:
                                                claudeGatewayBaseUrlDraft.trim() ||
                                                null,
                                            gatewayCustomHeaders:
                                                toSecretValuePatch(
                                                    claudeGatewayCustomHeadersDraft,
                                                    shouldClearClaudeGatewayCustomHeaders,
                                                ),
                                        });
                                    } catch (error) {
                                        setRuntimeConfigError(
                                            error instanceof Error
                                                ? error.message
                                                : "Could not save the Claude runtime settings.",
                                        );
                                        return;
                                    } finally {
                                        setIsSavingRuntime(false);
                                    }

                                    setIsLaunchingRuntimeAuth(true);
                                    try {
                                        await launchRuntimeAuth({
                                            methodId: claudeAuthMethodDraft,
                                            projectId: tab.projectId,
                                            runtimeId: "claude",
                                            worktreeId: tab.worktreeId ?? null,
                                        });
                                        setRuntimeConfigError(null);
                                    } catch (error) {
                                        setRuntimeConfigError(
                                            error instanceof Error
                                                ? error.message
                                                : "Could not launch the Claude auth flow.",
                                        );
                                    } finally {
                                        setIsLaunchingRuntimeAuth(false);
                                    }
                                },
                                onSave: async () => {
                                    setRuntimeConfigError(null);
                                    setIsSavingRuntime(true);
                                    try {
                                        await saveClaudeRuntimeSettings({
                                            authMethod: claudeAuthMethodDraft,
                                            binaryPath:
                                                claudeBinaryPathDraft.trim() ||
                                                null,
                                            gatewayAuthToken:
                                                toSecretValuePatch(
                                                    claudeGatewayAuthTokenDraft,
                                                    shouldClearClaudeGatewayAuthToken,
                                                ),
                                            gatewayBaseUrl:
                                                claudeGatewayBaseUrlDraft.trim() ||
                                                null,
                                            gatewayCustomHeaders:
                                                toSecretValuePatch(
                                                    claudeGatewayCustomHeadersDraft,
                                                    shouldClearClaudeGatewayCustomHeaders,
                                                ),
                                        });
                                        setClaudeGatewayAuthTokenDraft("");
                                        setClaudeGatewayCustomHeadersDraft("");
                                        setShouldClearClaudeGatewayAuthToken(
                                            false,
                                        );
                                        setShouldClearClaudeGatewayCustomHeaders(
                                            false,
                                        );
                                    } catch (error) {
                                        setRuntimeConfigError(
                                            error instanceof Error
                                                ? error.message
                                                : "Could not save the Claude runtime settings.",
                                        );
                                    } finally {
                                        setIsSavingRuntime(false);
                                    }
                                },
                                onVerify: async () => {
                                    setRuntimeConfigError(null);
                                    setIsSavingRuntime(true);
                                    try {
                                        await refreshRuntimeStatus("claude");
                                    } catch (error) {
                                        setRuntimeConfigError(
                                            error instanceof Error
                                                ? error.message
                                                : "Could not verify the Claude runtime.",
                                        );
                                    } finally {
                                        setIsSavingRuntime(false);
                                    }
                                },
                                runtimeConfigError,
                                shouldClearGatewayAuthToken:
                                    shouldClearClaudeGatewayAuthToken,
                                shouldClearGatewayCustomHeaders:
                                    shouldClearClaudeGatewayCustomHeaders,
                            })
                          : tab.runtimeId === "gemini"
                            ? renderGeminiRuntimeConfig({
                                  authMethodDraft: geminiAuthMethodDraft,
                                  authMethods: runtimeStatus?.authMethods ?? [],
                                  binaryPathDraft: geminiBinaryPathDraft,
                                  geminiApiKeyDraft,
                                  googleApiKeyDraft,
                                  googleCloudLocationDraft,
                                  googleCloudProjectDraft,
                                  hasStoredGeminiApiKey:
                                      geminiSettings.hasGeminiApiKey,
                                  hasStoredGoogleApiKey:
                                      geminiSettings.hasGoogleApiKey,
                                  isLaunchingAuth: isLaunchingRuntimeAuth,
                                  isSaving: isSavingRuntime,
                                  onAuthMethodChange: setGeminiAuthMethodDraft,
                                  onChangeBinaryPath: setGeminiBinaryPathDraft,
                                  onChangeGeminiApiKey: (value) => {
                                      setShouldClearGeminiApiKey(false);
                                      setGeminiApiKeyDraft(value);
                                  },
                                  onChangeGoogleApiKey: (value) => {
                                      setShouldClearGoogleApiKey(false);
                                      setGoogleApiKeyDraft(value);
                                  },
                                  onChangeGoogleCloudLocation:
                                      setGoogleCloudLocationDraft,
                                  onChangeGoogleCloudProject:
                                      setGoogleCloudProjectDraft,
                                  onClearGeminiApiKey: () => {
                                      setGeminiApiKeyDraft("");
                                      setShouldClearGeminiApiKey(true);
                                  },
                                  onClearGoogleApiKey: () => {
                                      setGoogleApiKeyDraft("");
                                      setShouldClearGoogleApiKey(true);
                                  },
                                  onLaunchAuth: async () => {
                                      if (
                                          geminiAuthMethodDraft !==
                                          "login_with_google"
                                      ) {
                                          setRuntimeConfigError(
                                              "Choose Google login before launching Gemini auth.",
                                          );
                                          return;
                                      }

                                      setRuntimeConfigError(null);
                                      setIsSavingRuntime(true);
                                      try {
                                          await saveGeminiRuntimeSettings({
                                              authMethod: geminiAuthMethodDraft,
                                              binaryPath:
                                                  geminiBinaryPathDraft.trim() ||
                                                  null,
                                              geminiApiKey: toSecretValuePatch(
                                                  geminiApiKeyDraft,
                                                  shouldClearGeminiApiKey,
                                              ),
                                              googleApiKey: toSecretValuePatch(
                                                  googleApiKeyDraft,
                                                  shouldClearGoogleApiKey,
                                              ),
                                              googleCloudLocation:
                                                  googleCloudLocationDraft.trim() ||
                                                  null,
                                              googleCloudProject:
                                                  googleCloudProjectDraft.trim() ||
                                                  null,
                                          });
                                      } catch (error) {
                                          setRuntimeConfigError(
                                              error instanceof Error
                                                  ? error.message
                                                  : "Could not save the Gemini runtime settings.",
                                          );
                                          return;
                                      } finally {
                                          setIsSavingRuntime(false);
                                      }

                                      setIsLaunchingRuntimeAuth(true);
                                      try {
                                          await launchRuntimeAuth({
                                              methodId: "login_with_google",
                                              projectId: tab.projectId,
                                              runtimeId: "gemini",
                                              worktreeId:
                                                  tab.worktreeId ?? null,
                                          });
                                          setRuntimeConfigError(null);
                                      } catch (error) {
                                          setRuntimeConfigError(
                                              error instanceof Error
                                                  ? error.message
                                                  : "Could not launch the Gemini auth flow.",
                                          );
                                      } finally {
                                          setIsLaunchingRuntimeAuth(false);
                                      }
                                  },
                                  onSave: async () => {
                                      setRuntimeConfigError(null);
                                      setIsSavingRuntime(true);
                                      try {
                                          await saveGeminiRuntimeSettings({
                                              authMethod: geminiAuthMethodDraft,
                                              binaryPath:
                                                  geminiBinaryPathDraft.trim() ||
                                                  null,
                                              geminiApiKey: toSecretValuePatch(
                                                  geminiApiKeyDraft,
                                                  shouldClearGeminiApiKey,
                                              ),
                                              googleApiKey: toSecretValuePatch(
                                                  googleApiKeyDraft,
                                                  shouldClearGoogleApiKey,
                                              ),
                                              googleCloudLocation:
                                                  googleCloudLocationDraft.trim() ||
                                                  null,
                                              googleCloudProject:
                                                  googleCloudProjectDraft.trim() ||
                                                  null,
                                          });
                                          setGeminiApiKeyDraft("");
                                          setGoogleApiKeyDraft("");
                                          setShouldClearGeminiApiKey(false);
                                          setShouldClearGoogleApiKey(false);
                                      } catch (error) {
                                          setRuntimeConfigError(
                                              error instanceof Error
                                                  ? error.message
                                                  : "Could not save the Gemini runtime settings.",
                                          );
                                      } finally {
                                          setIsSavingRuntime(false);
                                      }
                                  },
                                  onVerify: async () => {
                                      setRuntimeConfigError(null);
                                      setIsSavingRuntime(true);
                                      try {
                                          await refreshRuntimeStatus("gemini");
                                      } catch (error) {
                                          setRuntimeConfigError(
                                              error instanceof Error
                                                  ? error.message
                                                  : "Could not verify the Gemini runtime.",
                                          );
                                      } finally {
                                          setIsSavingRuntime(false);
                                      }
                                  },
                                  runtimeConfigError,
                                  shouldClearGeminiApiKey,
                                  shouldClearGoogleApiKey,
                              })
                            : tab.runtimeId === "kilo"
                              ? renderKiloRuntimeConfig({
                                    binaryPathDraft: kiloBinaryPathDraft,
                                    isLaunchingAuth: isLaunchingRuntimeAuth,
                                    isSaving: isSavingRuntime,
                                    onChangeBinaryPath: setKiloBinaryPathDraft,
                                    onLaunchAuth: async () => {
                                        setRuntimeConfigError(null);
                                        setIsSavingRuntime(true);
                                        try {
                                            await saveKiloRuntimeSettings({
                                                binaryPath:
                                                    kiloBinaryPathDraft.trim() ||
                                                    null,
                                            });
                                        } catch (error) {
                                            setRuntimeConfigError(
                                                error instanceof Error
                                                    ? error.message
                                                    : "Could not save the Kilo runtime settings.",
                                            );
                                            return;
                                        } finally {
                                            setIsSavingRuntime(false);
                                        }

                                        setIsLaunchingRuntimeAuth(true);
                                        try {
                                            await launchRuntimeAuth({
                                                methodId: "kilo-login",
                                                projectId: tab.projectId,
                                                runtimeId: "kilo",
                                                worktreeId:
                                                    tab.worktreeId ?? null,
                                            });
                                            setRuntimeConfigError(null);
                                        } catch (error) {
                                            setRuntimeConfigError(
                                                error instanceof Error
                                                    ? error.message
                                                    : "Could not launch the Kilo auth flow.",
                                            );
                                        } finally {
                                            setIsLaunchingRuntimeAuth(false);
                                        }
                                    },
                                    onSave: async () => {
                                        setRuntimeConfigError(null);
                                        setIsSavingRuntime(true);
                                        try {
                                            await saveKiloRuntimeSettings({
                                                binaryPath:
                                                    kiloBinaryPathDraft.trim() ||
                                                    null,
                                            });
                                        } catch (error) {
                                            setRuntimeConfigError(
                                                error instanceof Error
                                                    ? error.message
                                                    : "Could not save the Kilo runtime settings.",
                                            );
                                        } finally {
                                            setIsSavingRuntime(false);
                                        }
                                    },
                                    onVerify: async () => {
                                        setRuntimeConfigError(null);
                                        setIsSavingRuntime(true);
                                        try {
                                            await refreshRuntimeStatus("kilo");
                                        } catch (error) {
                                            setRuntimeConfigError(
                                                error instanceof Error
                                                    ? error.message
                                                    : "Could not verify the Kilo runtime.",
                                            );
                                        } finally {
                                            setIsSavingRuntime(false);
                                        }
                                    },
                                    runtimeConfigError,
                                })
                              : null
                    : null}
                {visiblePlan ? (
                    <div
                        className="shrink-0 px-3 pb-1 pt-2"
                        style={{
                            borderBottom:
                                "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                        }}
                    >
                        <PlanMessage
                            onDismiss={() => {
                                dismissSessionPlan(
                                    snapshot.sessionId,
                                    visiblePlan.updatedAt,
                                );
                            }}
                            plan={visiblePlan}
                        />
                    </div>
                ) : null}

                <ChatTimeline
                    chatFontFamily={chatFontFamily}
                    chatFontSize={aiChatSettings.chatFontSize}
                    elapsed={elapsed}
                    historyRows={timelineModel.historyRows}
                    isStreaming={isStreaming}
                    liveTailRow={timelineModel.liveTailRow}
                    onOpenFile={onOpenFile}
                    onOpenImage={onOpenImage}
                    onOpenResolvedFileReference={
                        handleOpenResolvedFileReference
                    }
                    onOpenSession={openAiSessionById}
                    onScroll={handleScroll}
                    projectId={tab.projectId}
                    resolveFileReference={resolveChatFileReference}
                    scrollRef={scrollRef}
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
                        {queuedPrompts.length > 0 || editingQueuedPrompt ? (
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
                    </div>
                ) : null}

                {/* Composer area */}
                <div
                    className="flex shrink-0 flex-col border-t"
                    style={{
                        backgroundColor:
                            "color-mix(in srgb, var(--color-accent) 4%, var(--color-bg-panel))",
                        borderTopColor:
                            "color-mix(in srgb, var(--color-accent) 14%, var(--color-border))",
                    }}
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
                                    configOptions={snapshot.configOptions}
                                    modeId={snapshot.modeId ?? ""}
                                    modelId={snapshot.modelId ?? ""}
                                    modes={snapshot.modes}
                                    models={snapshot.models}
                                    onConfigOptionChange={(optionId, value) => {
                                        void setSessionConfigOption({
                                            optionId,
                                            sessionId: tab.sessionId,
                                            value,
                                        });
                                    }}
                                    onModeChange={(modeId) => {
                                        void setSessionMode({
                                            modeId,
                                            sessionId: tab.sessionId,
                                        });
                                    }}
                                    onModelChange={(modelId) => {
                                        void setSessionModel({
                                            modelId,
                                            sessionId: tab.sessionId,
                                        });
                                    }}
                                    runtimeId={tab.runtimeId}
                                />
                            ) : undefined
                        }
                        availableCommands={availableCommands}
                        draftAttachments={draftAttachments}
                        draftFileContexts={draftFileContexts}
                        fileInputRef={fileInputRef}
                        onChange={handleComposerPartsChange}
                        onPasteImage={handlePasteImage}
                        onRemoveAttachment={removeDraftAttachment}
                        onRemoveFileContext={(contextId) =>
                            removeDraftFileContext(tab.sessionId, contextId)
                        }
                        onSearchProjectEntries={handleSearchProjectEntries}
                        onStop={() =>
                            void useAiStore
                                .getState()
                                .cancelSession(tab.sessionId)
                        }
                        onSubmit={() => {
                            void handleSubmit();
                        }}
                        resetNonce={composerResetNonce}
                        parts={composerParts}
                        renderFileContextPill={(fc) => (
                            <FileContextPill
                                context={fc}
                                onRemove={() =>
                                    removeDraftFileContext(tab.sessionId, fc.id)
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
                </div>
            </div>
        </div>
    );
}, areChatTabViewPropsEqual);

ChatTabView.displayName = "ChatTabView";

/* ─── Render helpers (static fragments) ─── */

function renderCodexRuntimeConfig(props: {
    readonly authMethodDraft: CodexAuthMethodId;
    readonly authMethods: readonly {
        readonly description: string;
        readonly id: CodexAuthMethodId;
        readonly name: string;
    }[];
    readonly binaryPathDraft: string;
    readonly codexApiKeyDraft: string;
    readonly openAiApiKeyDraft: string;
    readonly hasStoredCodexApiKey: boolean;
    readonly hasStoredOpenAiApiKey: boolean;
    readonly isAuthenticated: boolean;
    readonly isLaunchingAuth: boolean;
    readonly isSaving: boolean;
    readonly onAuthMethodChange: (value: CodexAuthMethodId) => void;
    readonly onChangeBinaryPath: (value: string) => void;
    readonly onChangeCodexApiKey: (value: string) => void;
    readonly onChangeOpenAiApiKey: (value: string) => void;
    readonly onClearCodexApiKey: () => void;
    readonly onClearOpenAiApiKey: () => void;
    readonly onLaunchAuth: () => Promise<void>;
    readonly onLogout: () => Promise<void>;
    readonly onSave: () => Promise<void>;
    readonly onVerify: () => Promise<void>;
    readonly runtimeConfigError: string | null;
    readonly shouldClearCodexApiKey: boolean;
    readonly shouldClearOpenAiApiKey: boolean;
}) {
    const showKeyFields = props.authMethodDraft !== "chatgpt";
    const codexKeyStored =
        props.hasStoredCodexApiKey &&
        !props.shouldClearCodexApiKey &&
        props.codexApiKeyDraft.trim().length === 0;
    const openAiKeyStored =
        props.hasStoredOpenAiApiKey &&
        !props.shouldClearOpenAiApiKey &&
        props.openAiApiKeyDraft.trim().length === 0;

    return (
        <div
            className="flex flex-col gap-3 border-b px-3 py-3"
            style={{
                borderColor: "var(--color-border)",
                backgroundColor: "var(--color-bg-elevated)",
            }}
        >
            <input
                autoCapitalize="off"
                autoCorrect="off"
                className="ide-input app-no-drag"
                onChange={(event) =>
                    props.onChangeBinaryPath(event.target.value)
                }
                placeholder="Custom ACP runtime path (for example codex-acp)"
                spellCheck={false}
                value={props.binaryPathDraft}
            />

            <div className="flex flex-wrap gap-2">
                {props.authMethods.map((method) => {
                    const isSelected = props.authMethodDraft === method.id;

                    return (
                        <button
                            className="app-no-drag rounded-full border px-3 py-1.5 text-[11px] transition"
                            key={method.id}
                            onClick={() => props.onAuthMethodChange(method.id)}
                            style={{
                                backgroundColor: isSelected
                                    ? "var(--color-accent)"
                                    : "transparent",
                                borderColor: isSelected
                                    ? "var(--color-accent)"
                                    : "var(--color-border)",
                                color: isSelected
                                    ? "#fff"
                                    : "var(--color-text-secondary)",
                            }}
                            title={method.description}
                            type="button"
                        >
                            {method.name}
                        </button>
                    );
                })}
            </div>

            {showKeyFields ? (
                <div className="grid gap-2 md:grid-cols-2">
                    <div className="grid gap-2">
                        <div className="flex items-center justify-between text-[11px] text-text-secondary">
                            <span>
                                Codex API key {codexKeyStored ? "(stored)" : ""}
                            </span>
                            <button
                                className="app-no-drag text-text-secondary transition hover:text-text-primary"
                                onClick={props.onClearCodexApiKey}
                                type="button"
                            >
                                Clear stored key
                            </button>
                        </div>
                        <input
                            autoCapitalize="off"
                            autoCorrect="off"
                            className="ide-input app-no-drag"
                            onChange={(event) =>
                                props.onChangeCodexApiKey(event.target.value)
                            }
                            placeholder="Optional CODEX_API_KEY"
                            spellCheck={false}
                            type="password"
                            value={props.codexApiKeyDraft}
                        />
                    </div>

                    <div className="grid gap-2">
                        <div className="flex items-center justify-between text-[11px] text-text-secondary">
                            <span>
                                OpenAI API key{" "}
                                {openAiKeyStored ? "(stored)" : ""}
                            </span>
                            <button
                                className="app-no-drag text-text-secondary transition hover:text-text-primary"
                                onClick={props.onClearOpenAiApiKey}
                                type="button"
                            >
                                Clear stored key
                            </button>
                        </div>
                        <input
                            autoCapitalize="off"
                            autoCorrect="off"
                            className="ide-input app-no-drag"
                            onChange={(event) =>
                                props.onChangeOpenAiApiKey(event.target.value)
                            }
                            placeholder="Optional OPENAI_API_KEY"
                            spellCheck={false}
                            type="password"
                            value={props.openAiApiKeyDraft}
                        />
                    </div>
                </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
                <button
                    className="ide-button app-no-drag"
                    disabled={props.isSaving}
                    onClick={() => {
                        void props.onVerify();
                    }}
                    type="button"
                >
                    Verify
                </button>
                <button
                    className="ide-button app-no-drag"
                    disabled={props.isSaving}
                    onClick={() => {
                        void props.onSave();
                    }}
                    type="button"
                >
                    Save
                </button>
                {props.authMethodDraft === "chatgpt" &&
                !props.isAuthenticated ? (
                    <button
                        className="ide-button app-no-drag"
                        disabled={props.isLaunchingAuth || props.isSaving}
                        onClick={() => {
                            void props.onLaunchAuth();
                        }}
                        type="button"
                    >
                        {props.isLaunchingAuth
                            ? "Opening login…"
                            : "Open login"}
                    </button>
                ) : null}
                {props.isAuthenticated ? (
                    <button
                        className="ide-button app-no-drag"
                        disabled={props.isSaving}
                        onClick={() => {
                            void props.onLogout();
                        }}
                        type="button"
                    >
                        Log out
                    </button>
                ) : null}
            </div>

            {props.runtimeConfigError ? (
                <div className="text-[12px] text-rose-500">
                    {props.runtimeConfigError}
                </div>
            ) : null}
        </div>
    );
}

function renderClaudeRuntimeConfig(props: {
    readonly authMethodDraft: ClaudeAuthMethodId | null;
    readonly authMethods: readonly {
        readonly description: string;
        readonly id: string;
        readonly name: string;
    }[];
    readonly binaryPathDraft: string;
    readonly gatewayAuthTokenDraft: string;
    readonly gatewayBaseUrlDraft: string;
    readonly gatewayCustomHeadersDraft: string;
    readonly hasStoredGatewayAuthToken: boolean;
    readonly hasStoredGatewayCustomHeaders: boolean;
    readonly isLaunchingAuth: boolean;
    readonly isSaving: boolean;
    readonly onAuthMethodChange: (value: ClaudeAuthMethodId | null) => void;
    readonly onChangeBinaryPath: (value: string) => void;
    readonly onChangeGatewayAuthToken: (value: string) => void;
    readonly onChangeGatewayBaseUrl: (value: string) => void;
    readonly onChangeGatewayCustomHeaders: (value: string) => void;
    readonly onClearGatewayAuthToken: () => void;
    readonly onClearGatewayCustomHeaders: () => void;
    readonly onLaunchAuth: () => Promise<void>;
    readonly onSave: () => Promise<void>;
    readonly onVerify: () => Promise<void>;
    readonly runtimeConfigError: string | null;
    readonly shouldClearGatewayAuthToken: boolean;
    readonly shouldClearGatewayCustomHeaders: boolean;
}) {
    const showGatewayFields = props.authMethodDraft === "gateway";

    return (
        <div
            className="flex flex-col gap-3 border-b px-3 py-3"
            style={{
                borderColor: "var(--color-border)",
                backgroundColor: "var(--color-bg-elevated)",
            }}
        >
            <input
                autoCapitalize="off"
                autoCorrect="off"
                className="ide-input app-no-drag"
                onChange={(event) =>
                    props.onChangeBinaryPath(event.target.value)
                }
                placeholder="Custom Claude runtime path (for example claude-agent-acp)"
                spellCheck={false}
                value={props.binaryPathDraft}
            />

            <div className="flex flex-wrap gap-2">
                {props.authMethods.map((method) => {
                    const isSelected = props.authMethodDraft === method.id;

                    return (
                        <button
                            className="app-no-drag rounded-full border px-3 py-1.5 text-[11px] transition"
                            key={method.id}
                            onClick={() =>
                                props.onAuthMethodChange(
                                    method.id as ClaudeAuthMethodId,
                                )
                            }
                            style={{
                                backgroundColor: isSelected
                                    ? "var(--color-accent)"
                                    : "transparent",
                                borderColor: isSelected
                                    ? "var(--color-accent)"
                                    : "var(--color-border)",
                                color: isSelected
                                    ? "#fff"
                                    : "var(--color-text-secondary)",
                            }}
                            title={method.description}
                            type="button"
                        >
                            {method.name}
                        </button>
                    );
                })}
            </div>

            {showGatewayFields ? (
                <div className="grid gap-2">
                    <input
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="ide-input app-no-drag"
                        onChange={(event) =>
                            props.onChangeGatewayBaseUrl(event.target.value)
                        }
                        placeholder="Gateway base URL"
                        spellCheck={false}
                        value={props.gatewayBaseUrlDraft}
                    />
                    <div className="flex items-center justify-between text-[11px] text-text-secondary">
                        <span>
                            Auth token{" "}
                            {props.hasStoredGatewayAuthToken &&
                            !props.shouldClearGatewayAuthToken
                                ? "(stored)"
                                : ""}
                        </span>
                        <button
                            className="app-no-drag text-text-secondary transition hover:text-text-primary"
                            onClick={props.onClearGatewayAuthToken}
                            type="button"
                        >
                            Clear stored token
                        </button>
                    </div>
                    <textarea
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="ide-input app-no-drag min-h-18.5 resize-y"
                        onChange={(event) =>
                            props.onChangeGatewayAuthToken(event.target.value)
                        }
                        placeholder="Optional gateway auth token"
                        spellCheck={false}
                        value={props.gatewayAuthTokenDraft}
                    />
                    <div className="flex items-center justify-between text-[11px] text-text-secondary">
                        <span>
                            Custom headers{" "}
                            {props.hasStoredGatewayCustomHeaders &&
                            !props.shouldClearGatewayCustomHeaders
                                ? "(stored)"
                                : ""}
                        </span>
                        <button
                            className="app-no-drag text-text-secondary transition hover:text-text-primary"
                            onClick={props.onClearGatewayCustomHeaders}
                            type="button"
                        >
                            Clear stored headers
                        </button>
                    </div>
                    <textarea
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="ide-input app-no-drag min-h-22 resize-y"
                        onChange={(event) =>
                            props.onChangeGatewayCustomHeaders(
                                event.target.value,
                            )
                        }
                        placeholder='Optional custom headers JSON, for example {"x-api-key":"..."}'
                        spellCheck={false}
                        value={props.gatewayCustomHeadersDraft}
                    />
                </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
                <button
                    className="ide-button app-no-drag"
                    disabled={props.isSaving}
                    onClick={() => {
                        void props.onVerify();
                    }}
                    type="button"
                >
                    Verify
                </button>
                <button
                    className="ide-button app-no-drag"
                    disabled={props.isSaving}
                    onClick={() => {
                        void props.onSave();
                    }}
                    type="button"
                >
                    Save
                </button>
                {props.authMethodDraft &&
                props.authMethodDraft !== "gateway" ? (
                    <button
                        className="ide-button app-no-drag"
                        disabled={props.isLaunchingAuth || props.isSaving}
                        onClick={() => {
                            void props.onLaunchAuth();
                        }}
                        type="button"
                    >
                        {props.isLaunchingAuth
                            ? "Opening login…"
                            : "Open login"}
                    </button>
                ) : null}
            </div>

            {props.runtimeConfigError ? (
                <div className="text-[12px] text-rose-500">
                    {props.runtimeConfigError}
                </div>
            ) : null}
        </div>
    );
}

function renderKiloRuntimeConfig(props: {
    readonly binaryPathDraft: string;
    readonly isLaunchingAuth: boolean;
    readonly isSaving: boolean;
    readonly onChangeBinaryPath: (value: string) => void;
    readonly onLaunchAuth: () => Promise<void>;
    readonly onSave: () => Promise<void>;
    readonly onVerify: () => Promise<void>;
    readonly runtimeConfigError: string | null;
}) {
    return (
        <div
            className="flex flex-col gap-3 border-b px-3 py-3"
            style={{
                borderColor: "var(--color-border)",
                backgroundColor: "var(--color-bg-elevated)",
            }}
        >
            <input
                autoCapitalize="off"
                autoCorrect="off"
                className="ide-input app-no-drag"
                onChange={(event) =>
                    props.onChangeBinaryPath(event.target.value)
                }
                placeholder="Custom Kilo runtime path (for example kilo)"
                spellCheck={false}
                value={props.binaryPathDraft}
            />

            <div className="text-[11px] leading-5 text-text-secondary">
                Kilo uses the local CLI login state. Open the system terminal to
                run <code>kilo auth login</code>, then verify the runtime again.
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <button
                    className="ide-button app-no-drag"
                    disabled={props.isSaving}
                    onClick={() => {
                        void props.onVerify();
                    }}
                    type="button"
                >
                    Verify
                </button>
                <button
                    className="ide-button app-no-drag"
                    disabled={props.isSaving}
                    onClick={() => {
                        void props.onSave();
                    }}
                    type="button"
                >
                    Save
                </button>
                <button
                    className="ide-button app-no-drag"
                    disabled={props.isLaunchingAuth || props.isSaving}
                    onClick={() => {
                        void props.onLaunchAuth();
                    }}
                    type="button"
                >
                    {props.isLaunchingAuth ? "Opening login…" : "Open login"}
                </button>
            </div>

            {props.runtimeConfigError ? (
                <div className="text-[12px] text-rose-500">
                    {props.runtimeConfigError}
                </div>
            ) : null}
        </div>
    );
}

function renderGeminiRuntimeConfig(props: {
    readonly authMethodDraft: GeminiAuthMethodId | null;
    readonly authMethods: readonly {
        readonly description: string;
        readonly id: string;
        readonly name: string;
    }[];
    readonly binaryPathDraft: string;
    readonly geminiApiKeyDraft: string;
    readonly googleApiKeyDraft: string;
    readonly googleCloudLocationDraft: string;
    readonly googleCloudProjectDraft: string;
    readonly hasStoredGeminiApiKey: boolean;
    readonly hasStoredGoogleApiKey: boolean;
    readonly isLaunchingAuth: boolean;
    readonly isSaving: boolean;
    readonly onAuthMethodChange: (value: GeminiAuthMethodId | null) => void;
    readonly onChangeBinaryPath: (value: string) => void;
    readonly onChangeGeminiApiKey: (value: string) => void;
    readonly onChangeGoogleApiKey: (value: string) => void;
    readonly onChangeGoogleCloudLocation: (value: string) => void;
    readonly onChangeGoogleCloudProject: (value: string) => void;
    readonly onClearGeminiApiKey: () => void;
    readonly onClearGoogleApiKey: () => void;
    readonly onLaunchAuth: () => Promise<void>;
    readonly onSave: () => Promise<void>;
    readonly onVerify: () => Promise<void>;
    readonly runtimeConfigError: string | null;
    readonly shouldClearGeminiApiKey: boolean;
    readonly shouldClearGoogleApiKey: boolean;
}) {
    return (
        <div
            className="flex flex-col gap-3 border-b px-3 py-3"
            style={{
                borderColor: "var(--color-border)",
                backgroundColor: "var(--color-bg-elevated)",
            }}
        >
            <input
                autoCapitalize="off"
                autoCorrect="off"
                className="ide-input app-no-drag"
                onChange={(event) =>
                    props.onChangeBinaryPath(event.target.value)
                }
                placeholder="Custom Gemini runtime path (for example gemini)"
                spellCheck={false}
                value={props.binaryPathDraft}
            />

            <div className="flex flex-wrap gap-2">
                {props.authMethods.map((method) => {
                    const isSelected = props.authMethodDraft === method.id;

                    return (
                        <button
                            className="app-no-drag rounded-full border px-3 py-1.5 text-[11px] transition"
                            key={method.id}
                            onClick={() =>
                                props.onAuthMethodChange(
                                    method.id as GeminiAuthMethodId,
                                )
                            }
                            style={{
                                backgroundColor: isSelected
                                    ? "var(--color-accent)"
                                    : "transparent",
                                borderColor: isSelected
                                    ? "var(--color-accent)"
                                    : "var(--color-border)",
                                color: isSelected
                                    ? "#fff"
                                    : "var(--color-text-secondary)",
                            }}
                            title={method.description}
                            type="button"
                        >
                            {method.name}
                        </button>
                    );
                })}
            </div>

            <div className="grid gap-2 md:grid-cols-2">
                <div className="grid gap-2">
                    <div className="flex items-center justify-between text-[11px] text-text-secondary">
                        <span>
                            Gemini API key{" "}
                            {props.hasStoredGeminiApiKey &&
                            !props.shouldClearGeminiApiKey
                                ? "(stored)"
                                : ""}
                        </span>
                        <button
                            className="app-no-drag text-text-secondary transition hover:text-text-primary"
                            onClick={props.onClearGeminiApiKey}
                            type="button"
                        >
                            Clear stored key
                        </button>
                    </div>
                    <input
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="ide-input app-no-drag"
                        onChange={(event) =>
                            props.onChangeGeminiApiKey(event.target.value)
                        }
                        placeholder="Optional GEMINI_API_KEY"
                        spellCheck={false}
                        type="password"
                        value={props.geminiApiKeyDraft}
                    />
                </div>

                <div className="grid gap-2">
                    <div className="flex items-center justify-between text-[11px] text-text-secondary">
                        <span>
                            Google API key{" "}
                            {props.hasStoredGoogleApiKey &&
                            !props.shouldClearGoogleApiKey
                                ? "(stored)"
                                : ""}
                        </span>
                        <button
                            className="app-no-drag text-text-secondary transition hover:text-text-primary"
                            onClick={props.onClearGoogleApiKey}
                            type="button"
                        >
                            Clear stored key
                        </button>
                    </div>
                    <input
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="ide-input app-no-drag"
                        onChange={(event) =>
                            props.onChangeGoogleApiKey(event.target.value)
                        }
                        placeholder="Optional GOOGLE_API_KEY"
                        spellCheck={false}
                        type="password"
                        value={props.googleApiKeyDraft}
                    />
                </div>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
                <input
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="ide-input app-no-drag"
                    onChange={(event) =>
                        props.onChangeGoogleCloudProject(event.target.value)
                    }
                    placeholder="Optional Google Cloud project"
                    spellCheck={false}
                    value={props.googleCloudProjectDraft}
                />
                <input
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="ide-input app-no-drag"
                    onChange={(event) =>
                        props.onChangeGoogleCloudLocation(event.target.value)
                    }
                    placeholder="Optional Google Cloud location"
                    spellCheck={false}
                    value={props.googleCloudLocationDraft}
                />
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <button
                    className="ide-button app-no-drag"
                    disabled={props.isSaving}
                    onClick={() => {
                        void props.onVerify();
                    }}
                    type="button"
                >
                    Verify
                </button>
                <button
                    className="ide-button app-no-drag"
                    disabled={props.isSaving}
                    onClick={() => {
                        void props.onSave();
                    }}
                    type="button"
                >
                    Save
                </button>
                {props.authMethodDraft === "login_with_google" ? (
                    <button
                        className="ide-button app-no-drag"
                        disabled={props.isLaunchingAuth || props.isSaving}
                        onClick={() => {
                            void props.onLaunchAuth();
                        }}
                        type="button"
                    >
                        {props.isLaunchingAuth
                            ? "Opening login…"
                            : "Open login"}
                    </button>
                ) : null}
            </div>

            {props.runtimeConfigError ? (
                <div className="text-[12px] text-rose-500">
                    {props.runtimeConfigError}
                </div>
            ) : null}
        </div>
    );
}

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

const ChatTimeline = memo(function ChatTimeline({
    chatFontFamily,
    chatFontSize,
    elapsed,
    historyRows,
    isStreaming,
    liveTailRow,
    onOpenFile,
    onOpenImage,
    onOpenResolvedFileReference,
    onOpenSession,
    onScroll,
    projectId,
    resolveFileReference,
    scrollRef,
    timelineContentRef,
    worktreeId,
}: {
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly elapsed: string;
    readonly historyRows: readonly ChatTimelineRow[];
    readonly isStreaming: boolean;
    readonly liveTailRow: ChatTimelineRow | null;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
    ) => Promise<void>;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onOpenResolvedFileReference: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly onScroll: () => void;
    readonly projectId: string | null;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly scrollRef: RefObject<HTMLDivElement | null>;
    readonly timelineContentRef: RefObject<HTMLDivElement | null>;
    readonly worktreeId: string | null;
}) {
    useRenderProbe("ChatTimeline", {
        historyRows: historyRows.length,
        isStreaming,
        rows: historyRows.length + (liveTailRow ? 1 : 0),
    });

    return (
        <div
            ref={scrollRef}
            className="chat-scroll min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3"
            onScroll={onScroll}
        >
            <div
                ref={timelineContentRef}
                className="min-w-0 space-y-2"
                style={{ fontFamily: chatFontFamily }}
            >
                <ChatTimelineHistory
                    chatFontFamily={chatFontFamily}
                    chatFontSize={chatFontSize}
                    historyRows={historyRows}
                    onOpenFile={onOpenFile}
                    onOpenImage={onOpenImage}
                    onOpenResolvedFileReference={onOpenResolvedFileReference}
                    onOpenSession={onOpenSession}
                    projectId={projectId}
                    resolveFileReference={resolveFileReference}
                    worktreeId={worktreeId}
                />
                <ChatTimelineLiveTail
                    chatFontFamily={chatFontFamily}
                    chatFontSize={chatFontSize}
                    onOpenFile={onOpenFile}
                    onOpenImage={onOpenImage}
                    onOpenResolvedFileReference={onOpenResolvedFileReference}
                    onOpenSession={onOpenSession}
                    projectId={projectId}
                    resolveFileReference={resolveFileReference}
                    row={liveTailRow}
                    worktreeId={worktreeId}
                />
                {isStreaming ? <StreamingIndicator elapsed={elapsed} /> : null}
            </div>
        </div>
    );
}, areChatTimelinePropsEqual);

ChatTimeline.displayName = "ChatTimeline";

const ChatTimelineHistory = memo(function ChatTimelineHistory({
    chatFontFamily,
    chatFontSize,
    historyRows,
    onOpenFile,
    onOpenImage,
    onOpenResolvedFileReference,
    onOpenSession,
    projectId,
    resolveFileReference,
    worktreeId,
}: {
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly historyRows: readonly ChatTimelineRow[];
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
    ) => Promise<void>;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onOpenResolvedFileReference: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly projectId: string | null;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly worktreeId: string | null;
}) {
    return historyRows.map((row) => (
        <ChatTimelineRowView
            chatFontFamily={chatFontFamily}
            chatFontSize={chatFontSize}
            key={row.id}
            onOpenFile={onOpenFile}
            onOpenImage={onOpenImage}
            onOpenResolvedFileReference={onOpenResolvedFileReference}
            onOpenSession={onOpenSession}
            projectId={projectId}
            resolveFileReference={resolveFileReference}
            row={row}
            worktreeId={worktreeId}
        />
    ));
}, areChatTimelineHistoryPropsEqual);

ChatTimelineHistory.displayName = "ChatTimelineHistory";

const ChatTimelineLiveTail = memo(function ChatTimelineLiveTail({
    chatFontFamily,
    chatFontSize,
    onOpenFile,
    onOpenImage,
    onOpenResolvedFileReference,
    onOpenSession,
    projectId,
    resolveFileReference,
    row,
    worktreeId,
}: {
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
    ) => Promise<void>;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onOpenResolvedFileReference: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly projectId: string | null;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly row: ChatTimelineRow | null;
    readonly worktreeId: string | null;
}) {
    if (!row) {
        return null;
    }

    return (
        <ChatTimelineRowView
            chatFontFamily={chatFontFamily}
            chatFontSize={chatFontSize}
            key={row.id}
            onOpenFile={onOpenFile}
            onOpenImage={onOpenImage}
            onOpenResolvedFileReference={onOpenResolvedFileReference}
            onOpenSession={onOpenSession}
            projectId={projectId}
            resolveFileReference={resolveFileReference}
            row={row}
            worktreeId={worktreeId}
        />
    );
}, areChatTimelineLiveTailPropsEqual);

ChatTimelineLiveTail.displayName = "ChatTimelineLiveTail";

const ChatTimelineRowView = memo(function ChatTimelineRowView({
    chatFontFamily,
    chatFontSize,
    onOpenFile,
    onOpenImage,
    onOpenResolvedFileReference,
    onOpenSession,
    projectId,
    resolveFileReference,
    row,
    worktreeId,
}: {
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
    ) => Promise<void>;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onOpenResolvedFileReference: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly projectId: string | null;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly row: ChatTimelineRow;
    readonly worktreeId: string | null;
}) {
    if (row.kind === "message") {
        return (
            <ChatMessageRow
                chatFontFamily={chatFontFamily}
                chatFontSize={chatFontSize}
                message={row.message}
                onOpenFile={onOpenResolvedFileReference}
                onOpenImage={onOpenImage}
                resolveFileReference={resolveFileReference}
            />
        );
    }

    return (
        <ToolActivityItem
            activity={row.reviewEntry.activity}
            onOpenFile={onOpenFile}
            onOpenFileReference={onOpenResolvedFileReference}
            onOpenSession={onOpenSession}
            projectId={projectId}
            resolveFileReference={resolveFileReference}
            trackedFiles={row.reviewEntry.trackedFiles}
            worktreeId={worktreeId}
        />
    );
}, areChatTimelineRowViewPropsEqual);

ChatTimelineRowView.displayName = "ChatTimelineRowView";

function areChatTimelinePropsEqual(
    previous: Readonly<{
        readonly chatFontFamily?: string;
        readonly chatFontSize?: number;
        readonly elapsed: string;
        readonly historyRows: readonly ChatTimelineRow[];
        readonly isStreaming: boolean;
        readonly liveTailRow: ChatTimelineRow | null;
        readonly onOpenFile: (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        ) => Promise<void>;
        readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
        readonly onOpenResolvedFileReference: (
            reference: ResolvedProjectFileReference,
        ) => void;
        readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
        readonly onScroll: () => void;
        readonly projectId: string | null;
        readonly resolveFileReference: (
            reference: string,
        ) => ResolvedProjectFileReference | null;
        readonly scrollRef: RefObject<HTMLDivElement | null>;
        readonly timelineContentRef: RefObject<HTMLDivElement | null>;
        readonly worktreeId: string | null;
    }>,
    next: Readonly<{
        readonly chatFontFamily?: string;
        readonly chatFontSize?: number;
        readonly elapsed: string;
        readonly historyRows: readonly ChatTimelineRow[];
        readonly isStreaming: boolean;
        readonly liveTailRow: ChatTimelineRow | null;
        readonly onOpenFile: (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        ) => Promise<void>;
        readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
        readonly onOpenResolvedFileReference: (
            reference: ResolvedProjectFileReference,
        ) => void;
        readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
        readonly onScroll: () => void;
        readonly projectId: string | null;
        readonly resolveFileReference: (
            reference: string,
        ) => ResolvedProjectFileReference | null;
        readonly scrollRef: RefObject<HTMLDivElement | null>;
        readonly timelineContentRef: RefObject<HTMLDivElement | null>;
        readonly worktreeId: string | null;
    }>,
) {
    return (
        previous.chatFontFamily === next.chatFontFamily &&
        previous.chatFontSize === next.chatFontSize &&
        previous.elapsed === next.elapsed &&
        previous.historyRows === next.historyRows &&
        previous.isStreaming === next.isStreaming &&
        previous.liveTailRow === next.liveTailRow &&
        previous.onOpenImage === next.onOpenImage &&
        previous.onOpenSession === next.onOpenSession &&
        previous.projectId === next.projectId &&
        previous.scrollRef === next.scrollRef &&
        previous.timelineContentRef === next.timelineContentRef &&
        previous.worktreeId === next.worktreeId
    );
}

function areChatTimelineHistoryPropsEqual(
    previous: Readonly<{
        readonly chatFontFamily?: string;
        readonly chatFontSize?: number;
        readonly historyRows: readonly ChatTimelineRow[];
        readonly onOpenFile: (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        ) => Promise<void>;
        readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
        readonly onOpenResolvedFileReference: (
            reference: ResolvedProjectFileReference,
        ) => void;
        readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
        readonly projectId: string | null;
        readonly resolveFileReference: (
            reference: string,
        ) => ResolvedProjectFileReference | null;
        readonly worktreeId: string | null;
    }>,
    next: Readonly<{
        readonly chatFontFamily?: string;
        readonly chatFontSize?: number;
        readonly historyRows: readonly ChatTimelineRow[];
        readonly onOpenFile: (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        ) => Promise<void>;
        readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
        readonly onOpenResolvedFileReference: (
            reference: ResolvedProjectFileReference,
        ) => void;
        readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
        readonly projectId: string | null;
        readonly resolveFileReference: (
            reference: string,
        ) => ResolvedProjectFileReference | null;
        readonly worktreeId: string | null;
    }>,
) {
    return (
        previous.chatFontFamily === next.chatFontFamily &&
        previous.chatFontSize === next.chatFontSize &&
        previous.historyRows === next.historyRows &&
        previous.onOpenFile === next.onOpenFile &&
        previous.onOpenImage === next.onOpenImage &&
        previous.onOpenResolvedFileReference ===
            next.onOpenResolvedFileReference &&
        previous.onOpenSession === next.onOpenSession &&
        previous.projectId === next.projectId &&
        previous.resolveFileReference === next.resolveFileReference &&
        previous.worktreeId === next.worktreeId
    );
}

function areChatTimelineLiveTailPropsEqual(
    previous: Readonly<{
        readonly chatFontFamily?: string;
        readonly chatFontSize?: number;
        readonly onOpenFile: (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        ) => Promise<void>;
        readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
        readonly onOpenResolvedFileReference: (
            reference: ResolvedProjectFileReference,
        ) => void;
        readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
        readonly projectId: string | null;
        readonly resolveFileReference: (
            reference: string,
        ) => ResolvedProjectFileReference | null;
        readonly row: ChatTimelineRow | null;
        readonly worktreeId: string | null;
    }>,
    next: Readonly<{
        readonly chatFontFamily?: string;
        readonly chatFontSize?: number;
        readonly onOpenFile: (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        ) => Promise<void>;
        readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
        readonly onOpenResolvedFileReference: (
            reference: ResolvedProjectFileReference,
        ) => void;
        readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
        readonly projectId: string | null;
        readonly resolveFileReference: (
            reference: string,
        ) => ResolvedProjectFileReference | null;
        readonly row: ChatTimelineRow | null;
        readonly worktreeId: string | null;
    }>,
) {
    return (
        previous.chatFontFamily === next.chatFontFamily &&
        previous.chatFontSize === next.chatFontSize &&
        previous.onOpenFile === next.onOpenFile &&
        previous.onOpenImage === next.onOpenImage &&
        previous.onOpenResolvedFileReference ===
            next.onOpenResolvedFileReference &&
        previous.onOpenSession === next.onOpenSession &&
        previous.projectId === next.projectId &&
        previous.resolveFileReference === next.resolveFileReference &&
        previous.row === next.row &&
        previous.worktreeId === next.worktreeId
    );
}

function areChatTimelineRowViewPropsEqual(
    previous: Readonly<{
        readonly chatFontFamily?: string;
        readonly chatFontSize?: number;
        readonly onOpenFile: (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        ) => Promise<void>;
        readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
        readonly onOpenResolvedFileReference: (
            reference: ResolvedProjectFileReference,
        ) => void;
        readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
        readonly projectId: string | null;
        readonly resolveFileReference: (
            reference: string,
        ) => ResolvedProjectFileReference | null;
        readonly row: ChatTimelineRow;
        readonly worktreeId: string | null;
    }>,
    next: Readonly<{
        readonly chatFontFamily?: string;
        readonly chatFontSize?: number;
        readonly onOpenFile: (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        ) => Promise<void>;
        readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
        readonly onOpenResolvedFileReference: (
            reference: ResolvedProjectFileReference,
        ) => void;
        readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
        readonly projectId: string | null;
        readonly resolveFileReference: (
            reference: string,
        ) => ResolvedProjectFileReference | null;
        readonly row: ChatTimelineRow;
        readonly worktreeId: string | null;
    }>,
) {
    return (
        previous.chatFontFamily === next.chatFontFamily &&
        previous.chatFontSize === next.chatFontSize &&
        previous.onOpenFile === next.onOpenFile &&
        previous.onOpenImage === next.onOpenImage &&
        previous.onOpenResolvedFileReference ===
            next.onOpenResolvedFileReference &&
        previous.onOpenSession === next.onOpenSession &&
        previous.projectId === next.projectId &&
        previous.resolveFileReference === next.resolveFileReference &&
        previous.row === next.row &&
        previous.worktreeId === next.worktreeId
    );
}

function areChatTabViewPropsEqual(
    previous: Readonly<ChatTabViewProps>,
    next: Readonly<ChatTabViewProps>,
) {
    return (
        previous.onDraftChange === next.onDraftChange &&
        previous.onOpenFile === next.onOpenFile &&
        previous.onOpenImage === next.onOpenImage &&
        previous.onOpenReview === next.onOpenReview &&
        previous.tab === next.tab
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

function getCodexAuthMethods(status: AiRuntimeStatus | null): readonly {
    readonly description: string;
    readonly id: CodexAuthMethodId;
    readonly name: string;
}[] {
    const authMethods = status?.authMethods ?? [];
    const filtered = authMethods.filter(
        (
            method,
        ): method is {
            readonly description: string;
            readonly id: CodexAuthMethodId;
            readonly name: string;
        } => isCodexAuthMethodId(method.id),
    );

    return filtered.length > 0 ? filtered : CODEX_AUTH_METHODS;
}

function getDefaultCodexAuthMethod(
    status: AiRuntimeStatus | null,
): CodexAuthMethodId {
    const runtimeMethod = status?.authMethod;
    if (isCodexAuthMethodId(runtimeMethod)) {
        return runtimeMethod;
    }

    return getCodexAuthMethods(status)[0]?.id ?? "chatgpt";
}

function toSecretValuePatch(
    value: string,
    shouldClear: boolean,
): SecretValuePatch {
    if (shouldClear) {
        return { kind: "clear" } as const;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
        return {
            kind: "set",
            value: trimmed,
        } as const;
    }

    return { kind: "unchanged" } as const;
}

function isCodexAuthMethodId(
    value: string | null | undefined,
): value is CodexAuthMethodId {
    return (
        value === "chatgpt" ||
        value === "codex-api-key" ||
        value === "openai-api-key"
    );
}

function getRuntimeDisplayName(
    runtimeId: RuntimeWorkspaceChatTab["runtimeId"],
) {
    switch (runtimeId) {
        case "claude":
            return "Claude";
        case "gemini":
            return "Gemini";
        case "kilo":
            return "Kilo";
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

function getActiveTurnStartedAt(snapshot: AiSessionSnapshot): string | null {
    if (!isActiveChatTurnStatus(snapshot.status)) {
        return null;
    }

    if (snapshot.activeTurnStartedAt) {
        return snapshot.activeTurnStartedAt;
    }

    const latestTurnActivity = [...snapshot.toolActivity]
        .reverse()
        .find(
            (activity) =>
                activity.id.startsWith("codex-acp:status:turn:") ||
                activity.id.startsWith("comando:status:turn:"),
        );
    if (latestTurnActivity) {
        return latestTurnActivity.createdAt;
    }

    return (
        [...snapshot.messages]
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

function formatAttachmentSize(sizeBytes: number | null): string {
    if (typeof sizeBytes !== "number") {
        return "Image";
    }

    return formatBytes(sizeBytes);
}
