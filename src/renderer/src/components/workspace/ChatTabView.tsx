import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";

import type {
    AiAvailableCommand,
    AiFileContextAttachment,
    AiImageAttachment,
    AiUserInputRequest,
    AiSessionSnapshot,
    AiToolActivity,
    ClaudeAuthMethodId,
    GeminiAuthMethodId,
} from "@shared/ipc";

import { useAiChatSettings } from "@renderer/app/hooks/use-ai-chat-settings";
import { buildChatFontFamily } from "@renderer/app/settings/theme";
import { useAiStore } from "@renderer/app/store/ai-store";
import type { RuntimeWorkspaceChatTab } from "@renderer/app/workspace/tree";

import { AIChatAgentControls } from "./AIChatAgentControls";
import { LanguageIcon } from "./LanguageIcon";
import { MarkdownContent } from "./MarkdownContent";
import { AIChatComposer } from "./chat/AIChatComposer";
import { CHAT_PILL_VARIANTS } from "./chat/chatPillPalette";
import type { AIComposerPart } from "./chat/composerParts";
import {
    composerPartsToPlainText,
    createEmptyComposerParts,
} from "./chat/composerParts";
import { PlanMessage } from "./chat/PlanMessage";
import { ToolActivityItem } from "./chat/ToolActivityItem";

/* ─── Types ─── */

interface ChatTabViewProps {
    readonly onDraftChange: (draft: string) => void;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
    ) => Promise<void>;
    readonly onOpenReview: () => Promise<void>;
    readonly tab: RuntimeWorkspaceChatTab;
}

type TimelineRow =
    | {
          readonly kind: "message";
          readonly message: AiSessionSnapshot["messages"][number];
      }
    | { readonly kind: "tool"; readonly activity: AiToolActivity };

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
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const EMPTY_DRAFT_ATTACHMENTS: readonly AiImageAttachment[] = [];
const EMPTY_DRAFT_FILE_CONTEXTS: readonly AiFileContextAttachment[] = [];
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

export function ChatTabView({
    onDraftChange,
    onOpenFile,
    onOpenReview,
    tab,
}: ChatTabViewProps) {
    const aiChatSettings = useAiChatSettings();
    const claudeSettings = useAiStore((s) => s.claudeSettings);
    const codexBinaryPath = useAiStore((s) => s.codexBinaryPath);
    const ensureSession = useAiStore((s) => s.ensureSession);
    const geminiSettings = useAiStore((s) => s.geminiSettings);
    const kiloSettings = useAiStore((s) => s.kiloSettings);
    const launchRuntimeAuth = useAiStore((s) => s.launchRuntimeAuth);
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
    const saveCodexBinaryPath = useAiStore((s) => s.saveCodexBinaryPath);
    const addDraftFileContext = useAiStore((s) => s.addDraftFileContext);
    const clearDraftAttachments = useAiStore((s) => s.clearDraftAttachments);

    const removeDraftFileContext = useAiStore((s) => s.removeDraftFileContext);
    const clearDraftFileContexts = useAiStore((s) => s.clearDraftFileContexts);
    const setSessionConfigOption = useAiStore((s) => s.setSessionConfigOption);
    const setSessionMode = useAiStore((s) => s.setSessionMode);
    const setSessionModel = useAiStore((s) => s.setSessionModel);
    const setDraftAttachments = useAiStore((s) => s.setDraftAttachments);
    const verifyCodexBinaryPath = useAiStore((s) => s.verifyCodexBinaryPath);
    const sendPrompt = useAiStore((s) => s.sendPrompt);
    const runtimeCatalog = useAiStore(
        (s) => s.runtimeCatalogById[tab.runtimeId] ?? null,
    );
    const sessionState = useAiStore((s) => s.sessions[tab.sessionId]);
    const runtimeStatus = useAiStore(
        (s) => s.runtimeStatusById[tab.runtimeId] ?? null,
    );

    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const wasNearBottom = useRef(true);
    const composerPartsRef = useRef<AIComposerPart[]>(
        createEmptyComposerParts(),
    );

    const [binaryPathDraft, setBinaryPathDraft] = useState(codexBinaryPath);
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
    const [isSavingRuntime, setIsSavingRuntime] = useState(false);
    const [isLaunchingRuntimeAuth, setIsLaunchingRuntimeAuth] = useState(false);
    const [runtimeConfigError, setRuntimeConfigError] = useState<string | null>(
        null,
    );
    const [showRuntimeConfig] = useState(false);
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
    const [streamStartTime, setStreamStartTime] = useState<number | null>(null);
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
        }
    }, [codexBinaryPath, tab.runtimeId]);
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
    const isStreaming =
        snapshot.status === "starting" || snapshot.status === "streaming";
    const currentError = sessionState?.localError ?? snapshot.lastError;
    const availableCommands =
        snapshot.availableCommands.length > 0
            ? snapshot.availableCommands
            : FALLBACK_COMMANDS;
    const draftAttachments =
        sessionState?.draftAttachments ?? EMPTY_DRAFT_ATTACHMENTS;
    const draftFileContexts =
        sessionState?.draftFileContexts ?? EMPTY_DRAFT_FILE_CONTEXTS;
    const queuedPrompts = sessionState?.queue ?? [];
    const pendingPermission = snapshot.pendingPermission;
    const pendingUserInput = snapshot.pendingUserInput;
    const runtimeDisplayName = getRuntimeDisplayName(tab.runtimeId);
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

    const pendingReviewCount = useMemo(
        () =>
            snapshot.trackedFiles.filter(
                (trackedFile) => trackedFile.reviewState === "pending",
            ).length,
        [snapshot.trackedFiles],
    );

    useEffect(() => {
        if (isStreaming) {
            if (streamStartTime === null) setStreamStartTime(Date.now());
            const interval = window.setInterval(() => {
                const ms = Date.now() - (streamStartTime ?? Date.now());
                const totalSec = Math.floor(ms / 1000);
                const min = Math.floor(totalSec / 60);
                const sec = totalSec % 60;
                setElapsed(
                    min > 0
                        ? `${min}m ${String(sec).padStart(2, "0")}s`
                        : `${sec}s`,
                );
            }, 500);
            return () => window.clearInterval(interval);
        }
        setStreamStartTime(null);
        setElapsed("");
        return undefined;
    }, [isStreaming, streamStartTime]);

    const timeline = useMemo((): TimelineRow[] => {
        const rows: TimelineRow[] = [];
        for (const message of snapshot.messages)
            rows.push({ kind: "message", message });
        for (const activity of snapshot.toolActivity)
            rows.push({ activity, kind: "tool" });
        rows.sort((a, b) => {
            const aT =
                a.kind === "message"
                    ? a.message.createdAt
                    : a.activity.updatedAt;
            const bT =
                b.kind === "message"
                    ? b.message.createdAt
                    : b.activity.updatedAt;
            return aT.localeCompare(bT);
        });
        return rows;
    }, [snapshot.messages, snapshot.toolActivity]);

    const scrollToBottom = useCallback(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, []);

    useEffect(() => {
        if (wasNearBottom.current) scrollToBottom();
    }, [timeline.length, scrollToBottom]);

    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        wasNearBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <
            NEAR_BOTTOM_THRESHOLD;
    }, []);

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
                setComposerError(
                    `You can attach up to ${MAX_IMAGE_ATTACHMENTS} images per message.`,
                );
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
        const plainText = composerPartsToPlainText(composerParts);
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

        onDraftChange("");
        setComposerParts(createEmptyComposerParts());
        setComposerResetNonce((current) => current + 1);
        clearDraftAttachments(tab.sessionId);
        clearDraftFileContexts(tab.sessionId);
        setComposerError(null);

        try {
            await sendPrompt(tab, prompt, submittedAttachments);
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
            onDraftChange(plainText);
            setDraftAttachments(tab.sessionId, submittedAttachments);
            for (const fileContext of submittedFileContexts) {
                addDraftFileContext(tab.sessionId, fileContext);
            }
        }
    };

    const handleComposerPartsChange = useCallback(
        (newParts: AIComposerPart[]) => {
            setComposerParts(newParts);
            onDraftChange(composerPartsToPlainText(newParts));
        },
        [onDraftChange],
    );

    useEffect(() => {
        composerPartsRef.current = composerParts;
    }, [composerParts]);

    const handlePasteImage = useCallback(
        (file: File) => {
            void appendImageFiles([file]);
        },
        [appendImageFiles],
    );

    const handleSearchProjectEntries = useCallback(
        async (query: string) => {
            if (!tab.projectId || query.length < 1) return [];
            try {
                return await window.comando.searchProjectEntries({
                    limit: 10,
                    projectId: tab.projectId,
                    query,
                });
            } catch {
                return [];
            }
        },
        [tab.projectId],
    );

    return (
        <div
            className="flex h-full min-h-0 min-w-0"
            style={{ backgroundColor: "var(--color-bg-secondary)" }}
        >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {renderRuntimeBar()}
                {showRuntimeConfig
                    ? tab.runtimeId === "codex"
                        ? renderCodexRuntimeConfig({
                              binaryPathDraft,
                              isSaving: isSavingRuntime,
                              onChangeBinaryPath: setBinaryPathDraft,
                              onSave: async () => {
                                  setRuntimeConfigError(null);
                                  setIsSavingRuntime(true);
                                  try {
                                      await saveCodexBinaryPath(
                                          binaryPathDraft,
                                      );
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
                                      await verifyCodexBinaryPath(
                                          binaryPathDraft,
                                      );
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
                {snapshot.plan ? (
                    <div
                        className="shrink-0 px-3 pb-1 pt-2"
                        style={{
                            borderBottom:
                                "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                        }}
                    >
                        <PlanMessage plan={snapshot.plan} />
                    </div>
                ) : null}

                {/* Message timeline */}
                <div
                    ref={scrollRef}
                    className="chat-scroll min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3"
                    onScroll={handleScroll}
                >
                    <div
                        className="min-w-0 space-y-2"
                        style={{ fontFamily: chatFontFamily }}
                    >
                        {timeline.map((row) =>
                            row.kind === "message" ? (
                                <ChatMessageRow
                                    chatFontFamily={chatFontFamily}
                                    chatFontSize={aiChatSettings.chatFontSize}
                                    key={row.message.id}
                                    message={row.message}
                                />
                            ) : (
                                <ToolActivityItem
                                    key={row.activity.id}
                                    activity={row.activity}
                                    onOpenFile={onOpenFile}
                                    projectId={tab.projectId}
                                />
                            ),
                        )}
                        {isStreaming ? (
                            <StreamingIndicator elapsed={elapsed} />
                        ) : null}
                    </div>
                </div>

                {/* Composer area */}
                <div className="flex shrink-0 flex-col px-3 pb-3">
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
                    {queuedPrompts.length > 0
                        ? renderQueuedPrompts(
                              queuedPrompts,
                              removeQueuedPrompt,
                              tab.sessionId,
                          )
                        : null}
                    {currentError ? renderError(currentError) : null}
                    {composerError ? renderError(composerError) : null}

                    {pendingReviewCount > 0 ? (
                        <div className="mb-2 flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg-panel px-4 py-3">
                            <div>
                                <div className="text-[11px] uppercase tracking-[0.14em] text-text-secondary">
                                    Pending Review
                                </div>
                                <div className="mt-1 text-sm text-text-primary">
                                    {pendingReviewCount} pending tracked file
                                    {pendingReviewCount === 1 ? "" : "s"}
                                </div>
                            </div>
                            <button
                                className="app-no-drag rounded-full border border-border px-3 py-1.5 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary"
                                onClick={() => {
                                    void onOpenReview();
                                }}
                                type="button"
                            >
                                Open Review
                            </button>
                        </div>
                    ) : null}

                    <AIChatComposer
                        composerFontFamily={composerFontFamily}
                        composerFontSize={aiChatSettings.composerFontSize}
                        agentControls={
                            hasAgentControls ? (
                                <AIChatAgentControls
                                    configOptions={snapshot.configOptions}
                                    disabled={
                                        isStreaming ||
                                        snapshot.status ===
                                            "waiting_permission" ||
                                        snapshot.status === "waiting_user_input"
                                    }
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
                        onAttachFile={() => fileInputRef.current?.click()}
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
}

/* ─── Render helpers (static fragments) ─── */

function renderRuntimeBar() {
    return null;
}

function renderCodexRuntimeConfig(props: {
    readonly binaryPathDraft: string;
    readonly isSaving: boolean;
    readonly onChangeBinaryPath: (value: string) => void;
    readonly onSave: () => Promise<void>;
    readonly onVerify: () => Promise<void>;
    readonly runtimeConfigError: string | null;
}) {
    return (
        <div
            className="flex flex-col gap-2 border-b px-3 py-2"
            style={{
                borderColor: "var(--color-border)",
                backgroundColor: "var(--color-bg-elevated)",
            }}
        >
            <input
                className="ide-input app-no-drag flex-1"
                onChange={(event) =>
                    props.onChangeBinaryPath(event.target.value)
                }
                placeholder="Custom ACP runtime path (for example codex-acp)"
                value={props.binaryPathDraft}
            />
            <div className="flex items-center gap-2">
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
                className="ide-input app-no-drag"
                onChange={(event) =>
                    props.onChangeBinaryPath(event.target.value)
                }
                placeholder="Custom Claude runtime path (for example claude-agent-acp)"
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
                        className="ide-input app-no-drag"
                        onChange={(event) =>
                            props.onChangeGatewayBaseUrl(event.target.value)
                        }
                        placeholder="Gateway base URL"
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
                        className="ide-input app-no-drag min-h-[74px] resize-y"
                        onChange={(event) =>
                            props.onChangeGatewayAuthToken(event.target.value)
                        }
                        placeholder="Optional gateway auth token"
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
                        className="ide-input app-no-drag min-h-[88px] resize-y"
                        onChange={(event) =>
                            props.onChangeGatewayCustomHeaders(
                                event.target.value,
                            )
                        }
                        placeholder='Optional custom headers JSON, for example {"x-api-key":"..."}'
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
                className="ide-input app-no-drag"
                onChange={(event) =>
                    props.onChangeBinaryPath(event.target.value)
                }
                placeholder="Custom Kilo runtime path (for example kilo)"
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
                className="ide-input app-no-drag"
                onChange={(event) =>
                    props.onChangeBinaryPath(event.target.value)
                }
                placeholder="Custom Gemini runtime path (for example gemini)"
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
                        className="ide-input app-no-drag"
                        onChange={(event) =>
                            props.onChangeGeminiApiKey(event.target.value)
                        }
                        placeholder="Optional GEMINI_API_KEY"
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
                        className="ide-input app-no-drag"
                        onChange={(event) =>
                            props.onChangeGoogleApiKey(event.target.value)
                        }
                        placeholder="Optional GOOGLE_API_KEY"
                        type="password"
                        value={props.googleApiKeyDraft}
                    />
                </div>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
                <input
                    className="ide-input app-no-drag"
                    onChange={(event) =>
                        props.onChangeGoogleCloudProject(event.target.value)
                    }
                    placeholder="Optional Google Cloud project"
                    value={props.googleCloudProjectDraft}
                />
                <input
                    className="ide-input app-no-drag"
                    onChange={(event) =>
                        props.onChangeGoogleCloudLocation(event.target.value)
                    }
                    placeholder="Optional Google Cloud location"
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

function renderQueuedPrompts(
    queue: readonly { id: string; prompt: string }[],
    remove: (sessionId: string, id: string) => void,
    sessionId: string,
) {
    return (
        <div className="mb-2 space-y-1">
            {queue.map((q, i) => (
                <div
                    className="flex items-center gap-2 rounded-md px-3 py-1.5"
                    key={q.id}
                    style={{
                        backgroundColor: "var(--color-bg-tertiary)",
                        border: "1px solid var(--color-border)",
                        fontSize: "0.8em",
                    }}
                >
                    <span
                        style={{
                            color: "var(--color-text-secondary)",
                            fontSize: "0.85em",
                        }}
                    >
                        #{i + 1}
                    </span>
                    <span
                        className="min-w-0 flex-1 truncate"
                        style={{ color: "var(--color-text-primary)" }}
                    >
                        {q.prompt}
                    </span>
                    <button
                        className="app-no-drag"
                        onClick={() => remove(sessionId, q.id)}
                        style={{
                            background: "none",
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: "0.85em",
                            opacity: 0.7,
                        }}
                        type="button"
                    >
                        ✕
                    </button>
                </div>
            ))}
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
                className="max-w-[150px] truncate text-xs"
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
            label={props.context.name}
            onRemove={props.onRemove}
            title={props.context.relativePath}
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
                                            type="password"
                                            value={freeText}
                                        />
                                    ) : (
                                        <textarea
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

/* ─── Message row ─── */

function ChatMessageRow({
    chatFontFamily,
    chatFontSize,
    message,
}: {
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly message: AiSessionSnapshot["messages"][number];
}) {
    if (message.kind === "user")
        return (
            <UserMessage
                attachments={message.attachments}
                chatFontSize={chatFontSize}
                content={message.content}
            />
        );
    if (message.kind === "user_input_request") {
        return (
            <UserInputRequestMessage
                chatFontSize={chatFontSize}
                content={message.content}
            />
        );
    }
    if (message.kind === "thinking")
        return (
            <ThinkingMessage
                chatFontSize={chatFontSize}
                content={message.content}
                inProgress={message.status === "streaming"}
            />
        );
    return (
        <AssistantMessage
            attachments={message.attachments}
            chatFontFamily={chatFontFamily}
            chatFontSize={chatFontSize}
            content={message.content}
        />
    );
}

function UserMessage(props: {
    readonly attachments: readonly AiImageAttachment[];
    readonly chatFontSize?: number;
    readonly content: string;
}) {
    return (
        <div
            className="min-w-0 max-w-full whitespace-pre-wrap rounded-lg px-3 py-2"
            style={{
                backgroundColor: "var(--color-bg-tertiary)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-primary)",
                fontSize: props.chatFontSize,
                lineHeight: 1.6,
                overflowWrap: "anywhere",
                wordBreak: "break-word",
            }}
        >
            {props.content ? <div>{props.content}</div> : null}
            {props.attachments.length > 0 ? (
                <MessageImageGrid attachments={props.attachments} />
            ) : null}
        </div>
    );
}

function AssistantMessage(props: {
    readonly attachments: readonly AiImageAttachment[];
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly content: string;
}) {
    return (
        <div
            className="min-w-0 max-w-full"
            style={{
                color: "var(--color-text-primary)",
                fontSize: props.chatFontSize,
            }}
        >
            {props.content ? (
                <MarkdownContent
                    content={props.content}
                    chatFontFamily={props.chatFontFamily}
                    chatFontSize={props.chatFontSize}
                />
            ) : null}
            {props.attachments.length > 0 ? (
                <MessageImageGrid attachments={props.attachments} />
            ) : null}
        </div>
    );
}

function MessageImageGrid(props: {
    readonly attachments: readonly AiImageAttachment[];
}) {
    return (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {props.attachments.map((attachment) => (
                <a
                    className="overflow-hidden rounded-xl border border-border bg-bg-panel"
                    href={toAttachmentDataUrl(attachment)}
                    key={attachment.id}
                    rel="noreferrer"
                    target="_blank"
                >
                    <img
                        alt={attachment.name ?? "Chat image"}
                        className="h-48 w-full object-cover"
                        src={toAttachmentDataUrl(attachment)}
                    />
                </a>
            ))}
        </div>
    );
}

function UserInputRequestMessage({
    chatFontSize,
    content,
}: {
    readonly chatFontSize?: number;
    readonly content: string;
}) {
    return (
        <div
            className="max-w-full rounded-xl border px-3 py-2"
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--color-accent) 8%, var(--color-bg-panel))",
                borderColor:
                    "color-mix(in srgb, var(--color-accent) 22%, var(--color-border))",
                fontSize: chatFontSize,
            }}
        >
            <div
                style={{
                    color: "var(--color-text-secondary)",
                    fontSize: "0.7em",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                }}
            >
                Input Requested
            </div>
            <div
                className="mt-1 whitespace-pre-wrap"
                style={{
                    color: "var(--color-text-primary)",
                    fontSize: "0.84em",
                    lineHeight: 1.55,
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                }}
            >
                {content}
            </div>
        </div>
    );
}

function ThinkingMessage({
    chatFontSize,
    content,
    inProgress,
}: {
    readonly chatFontSize?: number;
    readonly content: string;
    readonly inProgress: boolean;
}) {
    const [expanded, setExpanded] = useState(false);
    return (
        <div className="min-w-0 max-w-full">
            <button
                className="flex items-center gap-2 py-0.5"
                onClick={() => setExpanded(!expanded)}
                style={{
                    background: "none",
                    border: "none",
                    color: "var(--color-text-secondary)",
                    cursor: "pointer",
                    fontSize: chatFontSize,
                    opacity: 0.7,
                }}
                type="button"
            >
                <svg
                    fill="none"
                    height="12"
                    stroke="currentColor"
                    strokeWidth="2"
                    style={{
                        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                        transition: "transform 120ms ease",
                    }}
                    viewBox="0 0 24 24"
                    width="12"
                >
                    <polyline points="9 18 15 12 9 6" />
                </svg>
                <span>Thinking{inProgress ? "..." : ""}</span>
            </button>
            {expanded && content ? (
                <div
                    className="mt-1 whitespace-pre-wrap pl-5 italic"
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: "0.82em",
                        lineHeight: 1.6,
                        opacity: 0.7,
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                    }}
                >
                    {content}
                </div>
            ) : null}
        </div>
    );
}

/* ─── Tool activity row (reference app style) ─── */

/* ─── Streaming indicator ─── */

function StreamingIndicator({ elapsed }: { readonly elapsed: string }) {
    return (
        <div
            className="flex items-baseline gap-2 py-1"
            style={{ fontSize: "0.74em", lineHeight: 1.2 }}
        >
            <span className="inline-flex items-baseline gap-[3px]">
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

function toSecretValuePatch(value: string, shouldClear: boolean) {
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
        toolActivity: [],
        trackedFiles: [],
        updatedAt: new Date().toISOString(),
        worktreeId: tab.worktreeId ?? null,
    };
}

function serializePromptWithContexts(
    draft: string,
    fileContexts: readonly AiFileContextAttachment[],
): string {
    const t = draft.trim();
    const textMentions = [...(t.matchAll(/(^|\s)@([^\s]+)/g) ?? [])]
        .map((m) => m[2]?.trim())
        .filter((v): v is string => Boolean(v));
    const pillPaths = fileContexts.map((fc) => fc.relativePath);
    const allPaths = [...new Set([...textMentions, ...pillPaths])];
    if (!t && allPaths.length === 0) return "";
    const body = t || "Review these files";
    if (allPaths.length === 0) return body;
    return `${body}\n\nContext references:\n${allPaths.map((p) => `- ${p}`).join("\n")}`;
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

function formatAttachmentSize(sizeBytes: number | null): string {
    if (typeof sizeBytes !== "number") {
        return "Image";
    }

    return formatBytes(sizeBytes);
}

function toAttachmentDataUrl(attachment: AiImageAttachment): string {
    return `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
}
