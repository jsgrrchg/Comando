import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type {
    AiAvailableCommand,
    AiUserInputRequest,
    AiSessionSnapshot,
    AiToolActivity,
    ProjectTreeNode,
} from "@shared/ipc";

import { useAiStore } from "@renderer/app/store/ai-store";
import type { RuntimeWorkspaceChatTab } from "@renderer/app/workspace/tree";

import { MarkdownContent } from "./MarkdownContent";

/* ─── Types ─── */

interface ChatTabViewProps {
    readonly onDraftChange: (draft: string) => void;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
    ) => Promise<void>;
    readonly onOpenReview: () => Promise<void>;
    readonly tab: RuntimeWorkspaceChatTab;
}

interface TokenRange {
    readonly end: number;
    readonly start: number;
    readonly token: string;
}

type ComposerSuggestion =
    | {
          readonly description: string;
          readonly id: string;
          readonly insertText: string;
          readonly kind: "command";
          readonly label: string;
      }
    | {
          readonly description: string;
          readonly id: string;
          readonly insertText: string;
          readonly kind: "entry";
          readonly label: string;
      };

type TimelineRow =
    | {
          readonly kind: "message";
          readonly message: AiSessionSnapshot["messages"][number];
      }
    | { readonly kind: "tool"; readonly activity: AiToolActivity };

/* ─── Constants ─── */

const FALLBACK_COMMANDS: readonly AiAvailableCommand[] = [
    {
        description: "Ask Codex to create or update the working plan.",
        id: "plan",
        insertText: "/plan ",
        label: "/plan",
    },
];

const NEAR_BOTTOM_THRESHOLD = 80;

/* ─── Main component ─── */

export function ChatTabView({
    onDraftChange,
    onOpenFile,
    onOpenReview,
    tab,
}: ChatTabViewProps) {
    const codexBinaryPath = useAiStore((s) => s.codexBinaryPath);
    const ensureSession = useAiStore((s) => s.ensureSession);
    const refreshRuntimeStatus = useAiStore((s) => s.refreshRuntimeStatus);
    const removeQueuedPrompt = useAiStore((s) => s.removeQueuedPrompt);
    const respondPermission = useAiStore((s) => s.respondPermission);
    const respondUserInput = useAiStore((s) => s.respondUserInput);
    const saveCodexBinaryPath = useAiStore((s) => s.saveCodexBinaryPath);
    const sendPrompt = useAiStore((s) => s.sendPrompt);
    const sessionState = useAiStore((s) => s.sessions[tab.sessionId]);
    const runtimeStatus = useAiStore(
        (s) => s.runtimeStatusById[tab.runtimeId] ?? null,
    );

    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const wasNearBottom = useRef(true);

    const [binaryPathDraft, setBinaryPathDraft] = useState(codexBinaryPath);
    const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
    const [composerSelectionStart, setComposerSelectionStart] = useState(
        tab.draft.length,
    );
    const [pendingComposerSelection, setPendingComposerSelection] = useState<{
        readonly cursor: number;
    } | null>(null);
    const [isSavingRuntime, setIsSavingRuntime] = useState(false);
    const [showRuntimeConfig, setShowRuntimeConfig] = useState(false);
    const [projectSuggestions, setProjectSuggestions] = useState<
        readonly ProjectTreeNode[]
    >([]);
    const [streamStartTime, setStreamStartTime] = useState<number | null>(null);
    const [elapsed, setElapsed] = useState("");

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
        }),
        [
            tab.createdAt,
            tab.id,
            tab.kind,
            tab.projectId,
            tab.runtimeId,
            tab.sessionId,
            tab.title,
        ],
    );

    useEffect(() => {
        setBinaryPathDraft(codexBinaryPath);
    }, [codexBinaryPath]);
    useEffect(() => {
        void ensureSession(sessionTab);
    }, [ensureSession, sessionTab]);

    const snapshot = sessionState?.snapshot ?? createEmptySnapshot(tab);
    const isStreaming =
        snapshot.status === "starting" || snapshot.status === "streaming";
    const currentError = sessionState?.localError ?? snapshot.lastError;
    const availableCommands =
        snapshot.availableCommands.length > 0
            ? snapshot.availableCommands
            : FALLBACK_COMMANDS;
    const queuedPrompts = sessionState?.queue ?? [];
    const pendingPermission = snapshot.pendingPermission;
    const pendingUserInput = snapshot.pendingUserInput;

    const pendingReviewCount = useMemo(
        () =>
            snapshot.trackedFiles.filter(
                (trackedFile) => trackedFile.reviewState === "pending",
            ).length,
        [snapshot.trackedFiles],
    );

    const activeToken = useMemo(
        () => findActiveToken(tab.draft, composerSelectionStart),
        [composerSelectionStart, tab.draft],
    );

    const composerSuggestions = useMemo(() => {
        if (!activeToken) return [];
        if (activeToken.token.startsWith("/")) {
            const q = activeToken.token.slice(1).toLowerCase();
            return availableCommands
                .filter((c) =>
                    `${c.label} ${c.description}`.toLowerCase().includes(q),
                )
                .slice(0, 8)
                .map((c) => ({
                    description: c.description,
                    id: c.id,
                    insertText: c.insertText,
                    kind: "command" as const,
                    label: c.label,
                }));
        }
        if (!activeToken.token.startsWith("@")) return [];
        return projectSuggestions.slice(0, 8).map((e) => ({
            description:
                e.kind === "directory" ? `${e.relativePath}/` : e.relativePath,
            id: e.id,
            insertText: `@${e.relativePath}`,
            kind: "entry" as const,
            label:
                e.kind === "directory" ? `${e.relativePath}/` : e.relativePath,
        }));
    }, [activeToken, availableCommands, projectSuggestions]);

    useEffect(() => {
        setActiveSuggestionIndex(0);
    }, [composerSuggestions.length, activeToken?.token]);

    useEffect(() => {
        const projectId = tab.projectId;
        if (
            !activeToken ||
            !activeToken.token.startsWith("@") ||
            !projectId ||
            activeToken.token.length < 2
        ) {
            setProjectSuggestions([]);
            return;
        }
        let cancelled = false;
        const timeout = window.setTimeout(() => {
            void window.comando
                .searchProjectEntries({
                    limit: 8,
                    projectId,
                    query: activeToken.token.slice(1),
                })
                .then((entries) => {
                    if (!cancelled) setProjectSuggestions(entries);
                })
                .catch(() => {
                    if (!cancelled) setProjectSuggestions([]);
                });
        }, 120);
        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [activeToken, tab.projectId]);

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

    useEffect(() => {
        if (!pendingComposerSelection) {
            return;
        }

        const nextCursor = pendingComposerSelection.cursor;

        window.requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
            setComposerSelectionStart(nextCursor);
        });
    }, [pendingComposerSelection]);

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

    const handleInsertSuggestion = (suggestion: ComposerSuggestion) => {
        if (!activeToken) return;
        const nextDraft = replaceToken(
            tab.draft,
            activeToken,
            `${suggestion.insertText} `,
        );
        const nextCursor = activeToken.start + suggestion.insertText.length + 1;
        onDraftChange(nextDraft);
        setPendingComposerSelection({ cursor: nextCursor });
    };

    const handleSubmit = async () => {
        const prompt = serializePrompt(tab.draft);
        if (!prompt) return;
        await sendPrompt(tab, prompt);
        onDraftChange("");
        setComposerSelectionStart(0);
    };

    const handleKeyDown = async (
        event: ReactKeyboardEvent<HTMLTextAreaElement>,
    ) => {
        if (composerSuggestions.length > 0) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveSuggestionIndex((i) =>
                    Math.min(i + 1, composerSuggestions.length - 1),
                );
                return;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveSuggestionIndex((i) => Math.max(i - 1, 0));
                return;
            }
            if (event.key === "Tab") {
                event.preventDefault();
                const s = composerSuggestions[activeSuggestionIndex];
                if (s) handleInsertSuggestion(s);
                return;
            }
        }
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (composerSuggestions.length > 0) {
                const s = composerSuggestions[activeSuggestionIndex];
                if (s) handleInsertSuggestion(s);
                return;
            }
            await handleSubmit();
        }
    };

    return (
        <div
            className="flex h-full min-h-0 min-w-0"
            style={{ backgroundColor: "var(--color-bg-secondary)" }}
        >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {renderRuntimeBar(
                    runtimeStatus,
                    showRuntimeConfig,
                    setShowRuntimeConfig,
                )}
                {showRuntimeConfig
                    ? renderRuntimeConfig(
                          binaryPathDraft,
                          setBinaryPathDraft,
                          isSavingRuntime,
                          setIsSavingRuntime,
                          refreshRuntimeStatus,
                          saveCodexBinaryPath,
                          tab.runtimeId,
                      )
                    : null}
                {snapshot.plan ? renderPinnedPlan(snapshot.plan) : null}

                {/* Message timeline */}
                <div
                    ref={scrollRef}
                    className="chat-scroll min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3"
                    onScroll={handleScroll}
                >
                    <div className="min-w-0 space-y-2">
                        {timeline.map((row) =>
                            row.kind === "message" ? (
                                <ChatMessageRow
                                    key={row.message.id}
                                    message={row.message}
                                />
                            ) : (
                                <ToolActivityRow
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

                    <div
                        className="relative flex flex-col"
                        style={{
                            backgroundColor: "var(--color-bg-tertiary)",
                            border: "1px solid var(--color-border)",
                            borderRadius: 12,
                        }}
                    >
                        {composerSuggestions.length > 0
                            ? renderSuggestions(
                                  composerSuggestions,
                                  activeSuggestionIndex,
                                  handleInsertSuggestion,
                              )
                            : null}
                        <textarea
                            ref={textareaRef}
                            className="chat-composer-input app-no-drag w-full resize-none bg-transparent outline-none"
                            onChange={(e) => {
                                onDraftChange(e.target.value);
                                setComposerSelectionStart(
                                    e.target.selectionStart,
                                );
                            }}
                            onClick={(e) =>
                                setComposerSelectionStart(
                                    e.currentTarget.selectionStart,
                                )
                            }
                            onKeyDown={(e) => {
                                void handleKeyDown(e);
                            }}
                            onKeyUp={(e) =>
                                setComposerSelectionStart(
                                    e.currentTarget.selectionStart,
                                )
                            }
                            placeholder="Message Codex — @ to include context, / for commands"
                            rows={3}
                            style={{
                                color: "var(--color-text-primary)",
                                fontFamily: "inherit",
                                fontSize: 14,
                                lineHeight: 1.5,
                                maxHeight: 200,
                                minHeight: 64,
                                padding: "10px 36px 10px 14px",
                            }}
                            value={tab.draft}
                        />
                        <div className="mt-auto flex items-center justify-between gap-2 px-2 pb-1.5">
                            <span
                                className="min-w-0 truncate"
                                style={{
                                    color: "var(--color-text-secondary)",
                                    fontSize: 12,
                                    opacity: isStreaming ? 0.8 : 0,
                                    transition: "opacity 0.15s ease",
                                }}
                            >
                                {isStreaming ? "Codex is working…" : ""}
                            </span>
                            <div className="flex shrink-0 items-center gap-1.5">
                                {isStreaming ||
                                snapshot.status === "waiting_permission" ||
                                snapshot.status === "waiting_user_input" ? (
                                    <button
                                        className="app-no-drag flex shrink-0 items-center justify-center rounded-full"
                                        onClick={() =>
                                            void useAiStore
                                                .getState()
                                                .cancelSession(tab.sessionId)
                                        }
                                        style={{
                                            backgroundColor: "#b91c1c",
                                            border: "none",
                                            color: "#fff",
                                            cursor: "pointer",
                                            height: 28,
                                            transition: "all 0.15s ease",
                                            width: 28,
                                        }}
                                        type="button"
                                    >
                                        <svg
                                            fill="currentColor"
                                            height="14"
                                            viewBox="0 0 24 24"
                                            width="14"
                                        >
                                            <rect
                                                height="14"
                                                rx="2"
                                                width="14"
                                                x="5"
                                                y="5"
                                            />
                                        </svg>
                                    </button>
                                ) : (
                                    <button
                                        className="app-no-drag flex shrink-0 items-center justify-center rounded-full"
                                        onClick={() => {
                                            void handleSubmit();
                                        }}
                                        style={{
                                            backgroundColor: tab.draft.trim()
                                                ? "var(--color-accent)"
                                                : "transparent",
                                            border: "none",
                                            color: tab.draft.trim()
                                                ? "#fff"
                                                : "var(--color-text-secondary)",
                                            cursor: tab.draft.trim()
                                                ? "pointer"
                                                : "default",
                                            height: 28,
                                            opacity: tab.draft.trim() ? 1 : 0.4,
                                            transition: "all 0.15s ease",
                                            width: 28,
                                        }}
                                        type="button"
                                    >
                                        <svg
                                            fill="none"
                                            height="16"
                                            stroke="currentColor"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth="2"
                                            viewBox="0 0 24 24"
                                            width="16"
                                        >
                                            <line
                                                x1="12"
                                                x2="12"
                                                y1="19"
                                                y2="5"
                                            />
                                            <polyline points="5 12 12 5 19 12" />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

/* ─── Render helpers (static fragments) ─── */

function renderRuntimeBar(
    runtimeStatus: {
        command?: string | null;
        message?: string | null;
        state: "error" | "missing" | "ready";
    } | null,
    showConfig: boolean,
    setShowConfig: (v: boolean) => void,
) {
    return (
        <div
            className="flex items-center gap-2 border-b px-3 py-1.5"
            style={{
                borderColor: "var(--color-border)",
                backgroundColor: "var(--color-bg-panel)",
            }}
        >
            <RuntimeBadge state={runtimeStatus?.state ?? "missing"} />
            <span
                className="min-w-0 flex-1 truncate"
                style={{
                    color: "var(--color-text-secondary)",
                    fontSize: "0.75em",
                }}
            >
                {runtimeStatus?.command ?? "codex runtime not resolved"}
            </span>
            {runtimeStatus?.message ? (
                <span style={{ color: "#d97706", fontSize: "0.7em" }}>
                    {runtimeStatus.message}
                </span>
            ) : null}
            <button
                className="app-no-drag"
                onClick={() => setShowConfig(!showConfig)}
                style={{
                    background: "none",
                    color: "var(--color-text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.75em",
                    opacity: 0.7,
                    padding: "2px 6px",
                }}
                type="button"
            >
                {showConfig ? "Hide" : "Configure"}
            </button>
        </div>
    );
}

function renderRuntimeConfig(
    binaryPathDraft: string,
    setBinaryPathDraft: (v: string) => void,
    isSaving: boolean,
    setIsSaving: (v: boolean) => void,
    refreshRuntime: (id: "codex") => Promise<unknown>,
    savePath: (v: string) => Promise<unknown>,
    runtimeId: "codex",
) {
    return (
        <div
            className="flex items-center gap-2 border-b px-3 py-2"
            style={{
                borderColor: "var(--color-border)",
                backgroundColor: "var(--color-bg-elevated)",
            }}
        >
            <input
                className="ide-input app-no-drag flex-1"
                onChange={(e) => setBinaryPathDraft(e.target.value)}
                placeholder="Custom ACP runtime path (for example codex-acp)"
                value={binaryPathDraft}
            />
            <button
                className="ide-button app-no-drag"
                disabled={isSaving}
                onClick={() => {
                    setIsSaving(true);
                    void refreshRuntime(runtimeId).finally(() =>
                        setIsSaving(false),
                    );
                }}
                type="button"
            >
                Verify
            </button>
            <button
                className="ide-button app-no-drag"
                disabled={isSaving}
                onClick={() => {
                    setIsSaving(true);
                    void savePath(binaryPathDraft).finally(() =>
                        setIsSaving(false),
                    );
                }}
                type="button"
            >
                Save
            </button>
        </div>
    );
}

function renderPinnedPlan(plan: NonNullable<AiSessionSnapshot["plan"]>) {
    return (
        <div
            className="shrink-0 px-3 pb-1 pt-2"
            style={{
                borderBottom:
                    "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
            }}
        >
            <div
                className="mb-1"
                style={{
                    color: "var(--color-text-secondary)",
                    fontSize: "0.7em",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                }}
            >
                Plan
            </div>
            <div className="space-y-1 pb-1">
                {plan.entries.map((entry, i) => (
                    <div
                        className="flex items-start gap-2"
                        key={`${entry.content}-${i}`}
                    >
                        <PlanStatusDot status={entry.status} />
                        <span
                            className="min-w-0 flex-1"
                            style={{
                                color: "var(--color-text-primary)",
                                fontSize: "0.8em",
                                lineHeight: 1.5,
                            }}
                        >
                            {entry.content}
                        </span>
                    </div>
                ))}
            </div>
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
            <div
                className="px-3 py-2"
                style={{
                    color: "var(--color-text-primary)",
                    fontSize: "0.85em",
                    fontWeight: 500,
                }}
            >
                {perm.title}
            </div>
            <div className="flex flex-wrap gap-2 px-3 pb-2">
                {perm.options.map((opt) => (
                    <button
                        className="app-no-drag rounded-md px-3 py-1.5"
                        key={opt.optionId}
                        onClick={() =>
                            void respond({
                                optionId: opt.optionId,
                                requestId: perm.requestId,
                                sessionId,
                            })
                        }
                        style={{
                            backgroundColor:
                                "color-mix(in srgb, #d97706 10%, transparent)",
                            border: "1px solid color-mix(in srgb, #d97706 30%, var(--color-border))",
                            color: "var(--color-text-primary)",
                            cursor: "pointer",
                            fontSize: "0.78em",
                        }}
                        type="button"
                    >
                        {opt.name}
                    </button>
                ))}
                <button
                    className="app-no-drag rounded-md px-3 py-1.5"
                    onClick={() =>
                        void respond({
                            optionId: null,
                            requestId: perm.requestId,
                            sessionId,
                        })
                    }
                    style={{
                        backgroundColor: "transparent",
                        border: "1px solid var(--color-border)",
                        color: "var(--color-text-secondary)",
                        cursor: "pointer",
                        fontSize: "0.78em",
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
            className="mb-2 flex items-start gap-2 rounded-lg px-2.5 py-2"
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
                strokeWidth="2"
                viewBox="0 0 24 24"
                width="14"
            >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" x2="12" y1="8" y2="12" />
                <line x1="12" x2="12.01" y1="16" y2="16" />
            </svg>
            <span className="min-w-0 whitespace-pre-wrap">{error}</span>
        </div>
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
            className="mb-2 overflow-hidden rounded-2xl border px-4 py-3"
            style={{
                backgroundColor:
                    "color-mix(in srgb, #2563eb 5%, var(--color-bg-secondary))",
                borderColor:
                    "color-mix(in srgb, #2563eb 18%, var(--color-border))",
            }}
        >
            <div className="flex items-start justify-between gap-3">
                <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-text-secondary">
                        Input Required
                    </div>
                    <div className="mt-1 text-sm font-medium text-text-primary">
                        {request.title}
                    </div>
                </div>
                <div className="text-[11px] text-text-secondary">
                    {request.questions.length} question
                    {request.questions.length === 1 ? "" : "s"}
                </div>
            </div>

            <div className="mt-3 space-y-3">
                {request.questions.map((question) => {
                    const selectedOptions =
                        selectedOptionsByQuestionId[question.id] ?? [];
                    const freeText = freeTextByQuestionId[question.id] ?? "";
                    const needsFreeText =
                        question.isOther || question.options.length === 0;

                    return (
                        <div
                            className="rounded-xl border border-border bg-bg-panel px-3 py-3"
                            key={question.id}
                        >
                            {question.header ? (
                                <div className="text-[11px] uppercase tracking-[0.14em] text-text-secondary">
                                    {question.header}
                                </div>
                            ) : null}
                            <div className="mt-1 text-sm text-text-primary">
                                {question.question}
                            </div>
                            {question.isSecret ? (
                                <div className="mt-1 text-[11px] text-text-secondary">
                                    This response will be treated as sensitive
                                    input.
                                </div>
                            ) : null}

                            {question.options.length > 0 ? (
                                <div className="mt-3 flex flex-wrap gap-2">
                                    {question.options.map((option) => {
                                        const isSelected =
                                            selectedOptions.includes(
                                                option.label,
                                            );
                                        return (
                                            <button
                                                className="app-no-drag rounded-full border px-3 py-1.5 text-left text-[12px] transition"
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
                                                        ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
                                                        : "transparent",
                                                    borderColor: isSelected
                                                        ? "var(--color-accent)"
                                                        : "var(--color-border)",
                                                    color: "var(--color-text-primary)",
                                                }}
                                                type="button"
                                            >
                                                <div>{option.label}</div>
                                                {option.description ? (
                                                    <div className="mt-0.5 text-[11px] text-text-secondary">
                                                        {option.description}
                                                    </div>
                                                ) : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : null}

                            {needsFreeText ? (
                                <div className="mt-3">
                                    {question.isSecret ? (
                                        <input
                                            className="ide-input app-no-drag w-full"
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
                                            type="password"
                                            value={freeText}
                                        />
                                    ) : (
                                        <textarea
                                            className="ide-input app-no-drag w-full resize-y"
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
                                            value={freeText}
                                        />
                                    )}
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>

            <div className="mt-3 flex items-center justify-end">
                <button
                    className="app-no-drag rounded-full px-4 py-2 text-[12px] font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={answers.length === 0 || isSubmitting}
                    onClick={() => {
                        setIsSubmitting(true);
                        void onRespond({
                            answers,
                            requestId: request.requestId,
                            sessionId: request.sessionId,
                        }).finally(() => setIsSubmitting(false));
                    }}
                    style={{ backgroundColor: "var(--color-accent)" }}
                    type="button"
                >
                    {isSubmitting ? "Sending..." : "Send Response"}
                </button>
            </div>
        </div>
    );
}

function renderSuggestions(
    suggestions: readonly ComposerSuggestion[],
    activeIndex: number,
    onInsert: (s: ComposerSuggestion) => void,
) {
    return (
        <div
            className="absolute inset-x-0 bottom-full mb-1 p-1"
            style={{
                backgroundColor: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border)",
                borderRadius: 10,
                boxShadow: "var(--shadow-soft)",
            }}
        >
            <div className="space-y-0.5">
                {suggestions.map((s, i) => (
                    <button
                        className="app-no-drag flex w-full items-start justify-between gap-3 rounded-md px-3 py-1.5 text-left"
                        key={s.id}
                        onClick={() => onInsert(s)}
                        style={{
                            backgroundColor:
                                i === activeIndex
                                    ? "var(--color-bg-tertiary)"
                                    : "transparent",
                            cursor: "pointer",
                        }}
                        type="button"
                    >
                        <div className="min-w-0">
                            <div
                                className="truncate"
                                style={{
                                    color: "var(--color-text-primary)",
                                    fontSize: "0.85em",
                                }}
                            >
                                {s.label}
                            </div>
                            <div
                                className="mt-0.5 truncate"
                                style={{
                                    color: "var(--color-text-secondary)",
                                    fontSize: "0.75em",
                                }}
                            >
                                {s.description}
                            </div>
                        </div>
                        <span
                            className="rounded-full px-2 py-0.5"
                            style={{
                                border: "1px solid var(--color-border)",
                                color: "var(--color-text-secondary)",
                                fontSize: "0.65em",
                                letterSpacing: "0.08em",
                                textTransform: "uppercase",
                            }}
                        >
                            {s.kind}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}

/* ─── Message row (reference app style) ─── */

function ChatMessageRow({
    message,
}: {
    readonly message: AiSessionSnapshot["messages"][number];
}) {
    if (message.kind === "user")
        return <UserMessage content={message.content} />;
    if (message.kind === "user_input_request") {
        return <UserInputRequestMessage content={message.content} />;
    }
    if (message.kind === "thinking")
        return (
            <ThinkingMessage
                content={message.content}
                inProgress={message.status === "streaming"}
            />
        );
    return <AssistantMessage content={message.content} />;
}

function UserMessage({ content }: { readonly content: string }) {
    return (
        <div
            className="min-w-0 max-w-full whitespace-pre-wrap rounded-lg px-3 py-2"
            style={{
                backgroundColor: "var(--color-bg-tertiary)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-primary)",
                fontSize: "0.85em",
                lineHeight: 1.6,
                overflowWrap: "anywhere",
                wordBreak: "break-word",
            }}
        >
            {content}
        </div>
    );
}

function AssistantMessage({ content }: { readonly content: string }) {
    return (
        <div
            className="min-w-0 max-w-full"
            style={{ color: "var(--color-text-primary)", fontSize: "0.85em" }}
        >
            <MarkdownContent content={content} />
        </div>
    );
}

function UserInputRequestMessage({ content }: { readonly content: string }) {
    return (
        <div
            className="max-w-full rounded-xl border px-3 py-2"
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--color-accent) 8%, var(--color-bg-panel))",
                borderColor:
                    "color-mix(in srgb, var(--color-accent) 22%, var(--color-border))",
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
    content,
    inProgress,
}: {
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
                    fontSize: "0.85em",
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

function ToolActivityRow({
    activity,
    onOpenFile,
    projectId,
}: {
    readonly activity: AiToolActivity;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
    ) => Promise<void>;
    readonly projectId: string | null;
}) {
    const [expanded, setExpanded] = useState(false);
    const isInProgress = activity.status === "in_progress";

    return (
        <div
            className="min-w-0 max-w-full"
            style={{ opacity: isInProgress ? 1 : 0.7 }}
        >
            <button
                className="flex w-full items-center gap-2 py-0.5 text-left"
                onClick={() => setExpanded(!expanded)}
                style={{
                    background: "none",
                    border: "none",
                    color: "var(--color-text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.78em",
                }}
                type="button"
            >
                <span
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                        backgroundColor: isInProgress
                            ? "var(--color-accent)"
                            : activity.status === "completed"
                              ? "#16a34a"
                              : activity.status === "failed"
                                ? "#dc2626"
                                : "#94a3b8",
                        animation: isInProgress
                            ? "pulse 2s infinite"
                            : undefined,
                    }}
                />
                <span className="min-w-0 flex-1 truncate">
                    {activity.title}
                </span>
                {!isInProgress ? (
                    <span style={{ fontSize: "0.9em", opacity: 0.6 }}>
                        {activity.status}
                    </span>
                ) : null}
            </button>

            {expanded ? (
                <div className="mt-1 pl-4" style={{ fontSize: "0.78em" }}>
                    {activity.summary ? (
                        <div
                            className="mb-1"
                            style={{ color: "var(--color-text-secondary)" }}
                        >
                            {activity.summary}
                        </div>
                    ) : null}
                    {activity.locations.length > 0 ? (
                        <div className="mb-1 flex flex-wrap gap-1">
                            {activity.locations.map((loc) => (
                                <button
                                    className="app-no-drag rounded-md px-2 py-0.5"
                                    key={loc}
                                    onClick={() => {
                                        if (
                                            projectId &&
                                            !looksAbsolutePath(loc)
                                        )
                                            void onOpenFile(projectId, loc);
                                    }}
                                    style={{
                                        backgroundColor:
                                            "var(--color-bg-tertiary)",
                                        border: "1px solid var(--color-border)",
                                        color: "var(--color-text-secondary)",
                                        cursor: "pointer",
                                        fontSize: "0.9em",
                                    }}
                                    type="button"
                                >
                                    {loc}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    {activity.diffs.length > 0
                        ? activity.diffs.map((diff) => (
                              <div
                                  className="mb-1 rounded-md px-2 py-1.5"
                                  key={`${activity.id}:${diff.path}`}
                                  style={{
                                      backgroundColor:
                                          "var(--color-bg-tertiary)",
                                      border: "1px solid var(--color-border)",
                                  }}
                              >
                                  <div className="flex items-center justify-between gap-2">
                                      <span
                                          className="min-w-0 truncate"
                                          style={{
                                              color: "var(--color-text-primary)",
                                              fontSize: "0.9em",
                                          }}
                                      >
                                          {diff.path}
                                      </span>
                                      <span
                                          style={{
                                              color: "var(--color-text-secondary)",
                                              fontSize: "0.8em",
                                              letterSpacing: "0.06em",
                                              textTransform: "uppercase",
                                          }}
                                      >
                                          {diff.kind}
                                      </span>
                                  </div>
                                  <div
                                      className="mt-0.5"
                                      style={{
                                          color: "var(--color-text-secondary)",
                                          fontSize: "0.85em",
                                      }}
                                  >
                                      {summarizeDiff(
                                          diff.oldText,
                                          diff.newText,
                                      )}
                                  </div>
                              </div>
                          ))
                        : null}
                </div>
            ) : null}
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

/* ─── Utility components ─── */

function RuntimeBadge({
    state,
}: {
    readonly state: "error" | "missing" | "ready";
}) {
    const label =
        state === "ready" ? "Ready" : state === "error" ? "Error" : "Missing";
    const dotColor =
        state === "ready"
            ? "#16a34a"
            : state === "error"
              ? "#dc2626"
              : "#d97706";
    return (
        <span className="flex items-center gap-1.5">
            <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: dotColor }}
            />
            <span
                style={{
                    color: "var(--color-text-secondary)",
                    fontSize: "0.7em",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                }}
            >
                {label}
            </span>
        </span>
    );
}

function PlanStatusDot({
    status,
}: {
    readonly status: "completed" | "in_progress" | "pending";
}) {
    const bg =
        status === "completed"
            ? "#16a34a"
            : status === "in_progress"
              ? "#2563eb"
              : "#94a3b8";
    return (
        <span
            className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: bg }}
        />
    );
}

/* ─── Utility functions ─── */

function findActiveToken(draft: string, cursor: number): TokenRange | null {
    const c = Math.max(0, Math.min(cursor, draft.length));
    let start = c;
    while (start > 0 && !/\s/.test(draft[start - 1] ?? "")) start -= 1;
    let end = c;
    while (end < draft.length && !/\s/.test(draft[end] ?? "")) end += 1;
    const token = draft.slice(start, end);
    if (!token.startsWith("@") && !token.startsWith("/")) return null;
    return { end, start, token };
}

function replaceToken(
    draft: string,
    range: TokenRange,
    replacement: string,
): string {
    return `${draft.slice(0, range.start)}${replacement}${draft.slice(range.end)}`;
}

function createEmptySnapshot(tab: RuntimeWorkspaceChatTab): AiSessionSnapshot {
    return {
        availableCommands: [],
        lastError: null,
        messages: [],
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
    };
}

function serializePrompt(draft: string): string {
    const t = draft.trim();
    if (!t) return "";
    const paths = [...t.matchAll(/(^|\s)@([^\s]+)/g)]
        .map((m) => m[2]?.trim())
        .filter((v): v is string => Boolean(v));
    if (paths.length === 0) return t;
    return `${t}\n\nContext references:\n${[...new Set(paths)].map((p) => `- ${p}`).join("\n")}`;
}

function summarizeDiff(oldText: string | null, newText: string | null): string {
    if (oldText === null && newText !== null)
        return `Creates ${countLines(newText)} line(s).`;
    if (oldText !== null && newText === null)
        return `Removes ${countLines(oldText)} line(s).`;
    return `Updates ${Math.max(countLines(oldText ?? ""), countLines(newText ?? ""))} line(s).`;
}

function countLines(text: string): number {
    return text ? text.split("\n").length : 0;
}

function looksAbsolutePath(p: string): boolean {
    return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}
