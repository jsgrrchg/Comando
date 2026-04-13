import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState, } from "react";
import { useAiStore } from "@renderer/app/store/ai-store";
import { MarkdownContent } from "./MarkdownContent";
/* ─── Constants ─── */
const FALLBACK_COMMANDS = [
    {
        description: "Ask Codex to create or update the working plan.",
        id: "plan",
        insertText: "/plan ",
        label: "/plan",
    },
];
const NEAR_BOTTOM_THRESHOLD = 80;
/* ─── Main component ─── */
export function ChatTabView({ onDraftChange, onOpenFile, onOpenReview, tab, }) {
    const codexBinaryPath = useAiStore((s) => s.codexBinaryPath);
    const ensureSession = useAiStore((s) => s.ensureSession);
    const refreshRuntimeStatus = useAiStore((s) => s.refreshRuntimeStatus);
    const removeQueuedPrompt = useAiStore((s) => s.removeQueuedPrompt);
    const respondPermission = useAiStore((s) => s.respondPermission);
    const saveCodexBinaryPath = useAiStore((s) => s.saveCodexBinaryPath);
    const sendPrompt = useAiStore((s) => s.sendPrompt);
    const sessionState = useAiStore((s) => s.sessions[tab.sessionId]);
    const runtimeStatus = useAiStore((s) => s.runtimeStatusById[tab.runtimeId] ?? null);
    const textareaRef = useRef(null);
    const scrollRef = useRef(null);
    const wasNearBottom = useRef(true);
    const [binaryPathDraft, setBinaryPathDraft] = useState(codexBinaryPath);
    const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
    const [composerSelectionStart, setComposerSelectionStart] = useState(tab.draft.length);
    const [isSavingRuntime, setIsSavingRuntime] = useState(false);
    const [showRuntimeConfig, setShowRuntimeConfig] = useState(false);
    const [projectSuggestions, setProjectSuggestions] = useState([]);
    const [streamStartTime, setStreamStartTime] = useState(null);
    const [elapsed, setElapsed] = useState("");
    const sessionTab = useMemo(() => ({
        createdAt: tab.createdAt,
        draft: "",
        id: tab.id,
        kind: tab.kind,
        projectId: tab.projectId,
        runtimeId: tab.runtimeId,
        sessionId: tab.sessionId,
        title: tab.title,
    }), [
        tab.createdAt,
        tab.id,
        tab.kind,
        tab.projectId,
        tab.runtimeId,
        tab.sessionId,
        tab.title,
    ]);
    useEffect(() => {
        setBinaryPathDraft(codexBinaryPath);
    }, [codexBinaryPath]);
    useEffect(() => {
        void ensureSession(sessionTab);
    }, [ensureSession, sessionTab]);
    const snapshot = sessionState?.snapshot ?? createEmptySnapshot(tab);
    const isStreaming = snapshot.status === "starting" || snapshot.status === "streaming";
    const currentError = sessionState?.localError ?? snapshot.lastError;
    const availableCommands = snapshot.availableCommands.length > 0
        ? snapshot.availableCommands
        : FALLBACK_COMMANDS;
    const queuedPrompts = sessionState?.queue ?? [];
    const pendingPermission = snapshot.pendingPermission;
    const pendingReviewCount = useMemo(() => snapshot.trackedFiles.filter((trackedFile) => trackedFile.reviewState === "pending").length, [snapshot.trackedFiles]);
    const activeToken = useMemo(() => findActiveToken(tab.draft, composerSelectionStart), [composerSelectionStart, tab.draft]);
    const composerSuggestions = useMemo(() => {
        if (!activeToken)
            return [];
        if (activeToken.token.startsWith("/")) {
            const q = activeToken.token.slice(1).toLowerCase();
            return availableCommands
                .filter((c) => `${c.label} ${c.description}`.toLowerCase().includes(q))
                .slice(0, 8)
                .map((c) => ({
                description: c.description,
                id: c.id,
                insertText: c.insertText,
                kind: "command",
                label: c.label,
            }));
        }
        if (!activeToken.token.startsWith("@"))
            return [];
        return projectSuggestions.slice(0, 8).map((e) => ({
            description: e.kind === "directory" ? `${e.relativePath}/` : e.relativePath,
            id: e.id,
            insertText: `@${e.relativePath}`,
            kind: "entry",
            label: e.kind === "directory" ? `${e.relativePath}/` : e.relativePath,
        }));
    }, [activeToken, availableCommands, projectSuggestions]);
    useEffect(() => {
        setActiveSuggestionIndex(0);
    }, [composerSuggestions.length, activeToken?.token]);
    useEffect(() => {
        const projectId = tab.projectId;
        if (!activeToken ||
            !activeToken.token.startsWith("@") ||
            !projectId ||
            activeToken.token.length < 2) {
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
                if (!cancelled)
                    setProjectSuggestions(entries);
            })
                .catch(() => {
                if (!cancelled)
                    setProjectSuggestions([]);
            });
        }, 120);
        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [activeToken, tab.projectId]);
    useEffect(() => {
        if (isStreaming) {
            if (streamStartTime === null)
                setStreamStartTime(Date.now());
            const interval = window.setInterval(() => {
                const ms = Date.now() - (streamStartTime ?? Date.now());
                const totalSec = Math.floor(ms / 1000);
                const min = Math.floor(totalSec / 60);
                const sec = totalSec % 60;
                setElapsed(min > 0
                    ? `${min}m ${String(sec).padStart(2, "0")}s`
                    : `${sec}s`);
            }, 500);
            return () => window.clearInterval(interval);
        }
        setStreamStartTime(null);
        setElapsed("");
        return undefined;
    }, [isStreaming, streamStartTime]);
    const timeline = useMemo(() => {
        const rows = [];
        for (const message of snapshot.messages)
            rows.push({ kind: "message", message });
        for (const activity of snapshot.toolActivity)
            rows.push({ activity, kind: "tool" });
        rows.sort((a, b) => {
            const aT = a.kind === "message" ? a.message.id : a.activity.updatedAt;
            const bT = b.kind === "message" ? b.message.id : b.activity.updatedAt;
            return aT.localeCompare(bT);
        });
        return rows;
    }, [snapshot.messages, snapshot.toolActivity]);
    const scrollToBottom = useCallback(() => {
        const el = scrollRef.current;
        if (el)
            el.scrollTop = el.scrollHeight;
    }, []);
    useEffect(() => {
        if (wasNearBottom.current)
            scrollToBottom();
    }, [timeline.length, scrollToBottom]);
    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el)
            return;
        wasNearBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <
                NEAR_BOTTOM_THRESHOLD;
    }, []);
    const handleInsertSuggestion = (suggestion) => {
        if (!activeToken)
            return;
        const nextDraft = replaceToken(tab.draft, activeToken, `${suggestion.insertText} `);
        const nextCursor = activeToken.start + suggestion.insertText.length + 1;
        onDraftChange(nextDraft);
        window.requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
            setComposerSelectionStart(nextCursor);
        });
    };
    const handleSubmit = async () => {
        const prompt = serializePrompt(tab.draft);
        if (!prompt)
            return;
        await sendPrompt(tab, prompt);
        onDraftChange("");
        setComposerSelectionStart(0);
    };
    const handleKeyDown = async (event) => {
        if (composerSuggestions.length > 0) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveSuggestionIndex((i) => Math.min(i + 1, composerSuggestions.length - 1));
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
                if (s)
                    handleInsertSuggestion(s);
                return;
            }
        }
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (composerSuggestions.length > 0) {
                const s = composerSuggestions[activeSuggestionIndex];
                if (s)
                    handleInsertSuggestion(s);
                return;
            }
            await handleSubmit();
        }
    };
    return (_jsx("div", { className: "flex h-full min-h-0 min-w-0", style: { backgroundColor: "var(--color-bg-secondary)" }, children: _jsxs("div", { className: "flex min-h-0 min-w-0 flex-1 flex-col", children: [renderRuntimeBar(runtimeStatus, showRuntimeConfig, setShowRuntimeConfig), showRuntimeConfig
                    ? renderRuntimeConfig(binaryPathDraft, setBinaryPathDraft, isSavingRuntime, setIsSavingRuntime, refreshRuntimeStatus, saveCodexBinaryPath, tab.runtimeId)
                    : null, snapshot.plan ? renderPinnedPlan(snapshot.plan) : null, _jsx("div", { ref: scrollRef, className: "chat-scroll min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3", onScroll: handleScroll, children: _jsxs("div", { className: "min-w-0 space-y-2", children: [timeline.map((row) => row.kind === "message" ? (_jsx(ChatMessageRow, { message: row.message }, row.message.id)) : (_jsx(ToolActivityRow, { activity: row.activity, onOpenFile: onOpenFile, projectId: tab.projectId }, row.activity.id))), isStreaming ? (_jsx(StreamingIndicator, { elapsed: elapsed })) : null] }) }), _jsxs("div", { className: "flex shrink-0 flex-col px-3 pb-3", children: [pendingPermission
                            ? renderPermissionRequest(pendingPermission, respondPermission, tab.sessionId)
                            : null, queuedPrompts.length > 0
                            ? renderQueuedPrompts(queuedPrompts, removeQueuedPrompt, tab.sessionId)
                            : null, currentError ? renderError(currentError) : null, snapshot.trackedFiles.length > 0 ? (_jsxs("div", { className: "mb-2 flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg-panel px-4 py-3", children: [_jsxs("div", { children: [_jsx("div", { className: "text-[11px] uppercase tracking-[0.14em] text-text-secondary", children: "Pending Review" }), _jsxs("div", { className: "mt-1 text-sm text-text-primary", children: [pendingReviewCount, " pending changes across", " ", snapshot.trackedFiles.length, " tracked files"] })] }), _jsx("button", { className: "app-no-drag rounded-full border border-border px-3 py-1.5 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary", onClick: () => {
                                        void onOpenReview();
                                    }, type: "button", children: "Open Review" })] })) : null, _jsxs("div", { className: "relative flex flex-col", style: {
                                backgroundColor: "var(--color-bg-tertiary)",
                                border: "1px solid var(--color-border)",
                                borderRadius: 12,
                            }, children: [composerSuggestions.length > 0
                                    ? renderSuggestions(composerSuggestions, activeSuggestionIndex, handleInsertSuggestion)
                                    : null, _jsx("textarea", { ref: textareaRef, className: "chat-composer-input app-no-drag w-full resize-none bg-transparent outline-none", onChange: (e) => {
                                        onDraftChange(e.target.value);
                                        setComposerSelectionStart(e.target.selectionStart);
                                    }, onClick: (e) => setComposerSelectionStart(e.currentTarget.selectionStart), onKeyDown: (e) => {
                                        void handleKeyDown(e);
                                    }, onKeyUp: (e) => setComposerSelectionStart(e.currentTarget.selectionStart), placeholder: "Message Codex \u2014 @ to include context, / for commands", rows: 3, style: {
                                        color: "var(--color-text-primary)",
                                        fontFamily: "inherit",
                                        fontSize: 14,
                                        lineHeight: 1.5,
                                        maxHeight: 200,
                                        minHeight: 64,
                                        padding: "10px 36px 10px 14px",
                                    }, value: tab.draft }), _jsxs("div", { className: "mt-auto flex items-center justify-between gap-2 px-2 pb-1.5", children: [_jsx("span", { className: "min-w-0 truncate", style: {
                                                color: "var(--color-text-secondary)",
                                                fontSize: 12,
                                                opacity: isStreaming ? 0.8 : 0,
                                                transition: "opacity 0.15s ease",
                                            }, children: isStreaming ? "Codex is working…" : "" }), _jsx("div", { className: "flex shrink-0 items-center gap-1.5", children: isStreaming ||
                                                snapshot.status === "waiting_permission" ? (_jsx("button", { className: "app-no-drag flex shrink-0 items-center justify-center rounded-full", onClick: () => void useAiStore
                                                    .getState()
                                                    .cancelSession(tab.sessionId), style: {
                                                    backgroundColor: "#b91c1c",
                                                    border: "none",
                                                    color: "#fff",
                                                    cursor: "pointer",
                                                    height: 28,
                                                    transition: "all 0.15s ease",
                                                    width: 28,
                                                }, type: "button", children: _jsx("svg", { fill: "currentColor", height: "14", viewBox: "0 0 24 24", width: "14", children: _jsx("rect", { height: "14", rx: "2", width: "14", x: "5", y: "5" }) }) })) : (_jsx("button", { className: "app-no-drag flex shrink-0 items-center justify-center rounded-full", onClick: () => {
                                                    void handleSubmit();
                                                }, style: {
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
                                                }, type: "button", children: _jsxs("svg", { fill: "none", height: "16", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "2", viewBox: "0 0 24 24", width: "16", children: [_jsx("line", { x1: "12", x2: "12", y1: "19", y2: "5" }), _jsx("polyline", { points: "5 12 12 5 19 12" })] }) })) })] })] })] })] }) }));
}
/* ─── Render helpers (static fragments) ─── */
function renderRuntimeBar(runtimeStatus, showConfig, setShowConfig) {
    return (_jsxs("div", { className: "flex items-center gap-2 border-b px-3 py-1.5", style: {
            borderColor: "var(--color-border)",
            backgroundColor: "var(--color-bg-panel)",
        }, children: [_jsx(RuntimeBadge, { state: runtimeStatus?.state ?? "missing" }), _jsx("span", { className: "min-w-0 flex-1 truncate", style: {
                    color: "var(--color-text-secondary)",
                    fontSize: "0.75em",
                }, children: runtimeStatus?.command ?? "codex runtime not resolved" }), runtimeStatus?.message ? (_jsx("span", { style: { color: "#d97706", fontSize: "0.7em" }, children: runtimeStatus.message })) : null, _jsx("button", { className: "app-no-drag", onClick: () => setShowConfig(!showConfig), style: {
                    background: "none",
                    color: "var(--color-text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.75em",
                    opacity: 0.7,
                    padding: "2px 6px",
                }, type: "button", children: showConfig ? "Hide" : "Configure" })] }));
}
function renderRuntimeConfig(binaryPathDraft, setBinaryPathDraft, isSaving, setIsSaving, refreshRuntime, savePath, runtimeId) {
    return (_jsxs("div", { className: "flex items-center gap-2 border-b px-3 py-2", style: {
            borderColor: "var(--color-border)",
            backgroundColor: "var(--color-bg-elevated)",
        }, children: [_jsx("input", { className: "ide-input app-no-drag flex-1", onChange: (e) => setBinaryPathDraft(e.target.value), placeholder: "Custom ACP runtime path (for example codex-acp)", value: binaryPathDraft }), _jsx("button", { className: "ide-button app-no-drag", disabled: isSaving, onClick: () => {
                    setIsSaving(true);
                    void refreshRuntime(runtimeId).finally(() => setIsSaving(false));
                }, type: "button", children: "Verify" }), _jsx("button", { className: "ide-button app-no-drag", disabled: isSaving, onClick: () => {
                    setIsSaving(true);
                    void savePath(binaryPathDraft).finally(() => setIsSaving(false));
                }, type: "button", children: "Save" })] }));
}
function renderPinnedPlan(plan) {
    return (_jsxs("div", { className: "shrink-0 px-3 pb-1 pt-2", style: {
            borderBottom: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
        }, children: [_jsx("div", { className: "mb-1", style: {
                    color: "var(--color-text-secondary)",
                    fontSize: "0.7em",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                }, children: "Plan" }), _jsx("div", { className: "space-y-1 pb-1", children: plan.entries.map((entry, i) => (_jsxs("div", { className: "flex items-start gap-2", children: [_jsx(PlanStatusDot, { status: entry.status }), _jsx("span", { className: "min-w-0 flex-1", style: {
                                color: "var(--color-text-primary)",
                                fontSize: "0.8em",
                                lineHeight: 1.5,
                            }, children: entry.content })] }, `${entry.content}-${i}`))) })] }));
}
function renderPermissionRequest(perm, respond, sessionId) {
    return (_jsxs("div", { className: "mb-2 overflow-hidden rounded-lg", style: {
            backgroundColor: "color-mix(in srgb, #d97706 4%, var(--color-bg-secondary))",
            border: "1px solid color-mix(in srgb, #d97706 25%, var(--color-border))",
        }, children: [_jsx("div", { className: "px-3 py-2", style: {
                    color: "var(--color-text-primary)",
                    fontSize: "0.85em",
                    fontWeight: 500,
                }, children: perm.title }), _jsxs("div", { className: "flex flex-wrap gap-2 px-3 pb-2", children: [perm.options.map((opt) => (_jsx("button", { className: "app-no-drag rounded-md px-3 py-1.5", onClick: () => void respond({
                            optionId: opt.optionId,
                            requestId: perm.requestId,
                            sessionId,
                        }), style: {
                            backgroundColor: "color-mix(in srgb, #d97706 10%, transparent)",
                            border: "1px solid color-mix(in srgb, #d97706 30%, var(--color-border))",
                            color: "var(--color-text-primary)",
                            cursor: "pointer",
                            fontSize: "0.78em",
                        }, type: "button", children: opt.name }, opt.optionId))), _jsx("button", { className: "app-no-drag rounded-md px-3 py-1.5", onClick: () => void respond({
                            optionId: null,
                            requestId: perm.requestId,
                            sessionId,
                        }), style: {
                            backgroundColor: "transparent",
                            border: "1px solid var(--color-border)",
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: "0.78em",
                        }, type: "button", children: "Cancel" })] })] }));
}
function renderQueuedPrompts(queue, remove, sessionId) {
    return (_jsx("div", { className: "mb-2 space-y-1", children: queue.map((q, i) => (_jsxs("div", { className: "flex items-center gap-2 rounded-md px-3 py-1.5", style: {
                backgroundColor: "var(--color-bg-tertiary)",
                border: "1px solid var(--color-border)",
                fontSize: "0.8em",
            }, children: [_jsxs("span", { style: {
                        color: "var(--color-text-secondary)",
                        fontSize: "0.85em",
                    }, children: ["#", i + 1] }), _jsx("span", { className: "min-w-0 flex-1 truncate", style: { color: "var(--color-text-primary)" }, children: q.prompt }), _jsx("button", { className: "app-no-drag", onClick: () => remove(sessionId, q.id), style: {
                        background: "none",
                        color: "var(--color-text-secondary)",
                        cursor: "pointer",
                        fontSize: "0.85em",
                        opacity: 0.7,
                    }, type: "button", children: "\u2715" })] }, q.id))) }));
}
function renderError(error) {
    return (_jsxs("div", { className: "mb-2 flex items-start gap-2 rounded-lg px-2.5 py-2", style: {
            backgroundColor: "color-mix(in srgb, #dc2626 8%, transparent)",
            color: "#fca5a5",
            fontSize: "0.85em",
        }, children: [_jsxs("svg", { className: "mt-0.5 shrink-0", fill: "none", height: "14", stroke: "#f87171", strokeWidth: "2", viewBox: "0 0 24 24", width: "14", children: [_jsx("circle", { cx: "12", cy: "12", r: "10" }), _jsx("line", { x1: "12", x2: "12", y1: "8", y2: "12" }), _jsx("line", { x1: "12", x2: "12.01", y1: "16", y2: "16" })] }), _jsx("span", { className: "min-w-0 whitespace-pre-wrap", children: error })] }));
}
function renderSuggestions(suggestions, activeIndex, onInsert) {
    return (_jsx("div", { className: "absolute inset-x-0 bottom-full mb-1 p-1", style: {
            backgroundColor: "var(--color-bg-elevated)",
            border: "1px solid var(--color-border)",
            borderRadius: 10,
            boxShadow: "var(--shadow-soft)",
        }, children: _jsx("div", { className: "space-y-0.5", children: suggestions.map((s, i) => (_jsxs("button", { className: "app-no-drag flex w-full items-start justify-between gap-3 rounded-md px-3 py-1.5 text-left", onClick: () => onInsert(s), style: {
                    backgroundColor: i === activeIndex
                        ? "var(--color-bg-tertiary)"
                        : "transparent",
                    cursor: "pointer",
                }, type: "button", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "truncate", style: {
                                    color: "var(--color-text-primary)",
                                    fontSize: "0.85em",
                                }, children: s.label }), _jsx("div", { className: "mt-0.5 truncate", style: {
                                    color: "var(--color-text-secondary)",
                                    fontSize: "0.75em",
                                }, children: s.description })] }), _jsx("span", { className: "rounded-full px-2 py-0.5", style: {
                            border: "1px solid var(--color-border)",
                            color: "var(--color-text-secondary)",
                            fontSize: "0.65em",
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                        }, children: s.kind })] }, s.id))) }) }));
}
/* ─── Message row (reference app style) ─── */
function ChatMessageRow({ message, }) {
    if (message.kind === "user")
        return _jsx(UserMessage, { content: message.content });
    if (message.kind === "thinking")
        return (_jsx(ThinkingMessage, { content: message.content, inProgress: message.status === "streaming" }));
    return _jsx(AssistantMessage, { content: message.content });
}
function UserMessage({ content }) {
    return (_jsx("div", { className: "min-w-0 max-w-full whitespace-pre-wrap rounded-lg px-3 py-2", style: {
            backgroundColor: "var(--color-bg-tertiary)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-primary)",
            fontSize: "0.85em",
            lineHeight: 1.6,
            overflowWrap: "anywhere",
            wordBreak: "break-word",
        }, children: content }));
}
function AssistantMessage({ content }) {
    return (_jsx("div", { className: "min-w-0 max-w-full", style: { color: "var(--color-text-primary)", fontSize: "0.85em" }, children: _jsx(MarkdownContent, { content: content }) }));
}
function ThinkingMessage({ content, inProgress, }) {
    const [expanded, setExpanded] = useState(false);
    return (_jsxs("div", { className: "min-w-0 max-w-full", children: [_jsxs("button", { className: "flex items-center gap-2 py-0.5", onClick: () => setExpanded(!expanded), style: {
                    background: "none",
                    border: "none",
                    color: "var(--color-text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.85em",
                    opacity: 0.7,
                }, type: "button", children: [_jsx("svg", { fill: "none", height: "12", stroke: "currentColor", strokeWidth: "2", style: {
                            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                            transition: "transform 120ms ease",
                        }, viewBox: "0 0 24 24", width: "12", children: _jsx("polyline", { points: "9 18 15 12 9 6" }) }), _jsxs("span", { children: ["Thinking", inProgress ? "..." : ""] })] }), expanded && content ? (_jsx("div", { className: "mt-1 whitespace-pre-wrap pl-5 italic", style: {
                    color: "var(--color-text-secondary)",
                    fontSize: "0.82em",
                    lineHeight: 1.6,
                    opacity: 0.7,
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                }, children: content })) : null] }));
}
/* ─── Tool activity row (reference app style) ─── */
function ToolActivityRow({ activity, onOpenFile, projectId, }) {
    const [expanded, setExpanded] = useState(false);
    const isInProgress = activity.status === "in_progress";
    return (_jsxs("div", { className: "min-w-0 max-w-full", style: { opacity: isInProgress ? 1 : 0.7 }, children: [_jsxs("button", { className: "flex w-full items-center gap-2 py-0.5 text-left", onClick: () => setExpanded(!expanded), style: {
                    background: "none",
                    border: "none",
                    color: "var(--color-text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.78em",
                }, type: "button", children: [_jsx("span", { className: "inline-block h-1.5 w-1.5 shrink-0 rounded-full", style: {
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
                        } }), _jsx("span", { className: "min-w-0 flex-1 truncate", children: activity.title }), !isInProgress ? (_jsx("span", { style: { fontSize: "0.9em", opacity: 0.6 }, children: activity.status })) : null] }), expanded ? (_jsxs("div", { className: "mt-1 pl-4", style: { fontSize: "0.78em" }, children: [activity.summary ? (_jsx("div", { className: "mb-1", style: { color: "var(--color-text-secondary)" }, children: activity.summary })) : null, activity.locations.length > 0 ? (_jsx("div", { className: "mb-1 flex flex-wrap gap-1", children: activity.locations.map((loc) => (_jsx("button", { className: "app-no-drag rounded-md px-2 py-0.5", onClick: () => {
                                if (projectId &&
                                    !looksAbsolutePath(loc))
                                    void onOpenFile(projectId, loc);
                            }, style: {
                                backgroundColor: "var(--color-bg-tertiary)",
                                border: "1px solid var(--color-border)",
                                color: "var(--color-text-secondary)",
                                cursor: "pointer",
                                fontSize: "0.9em",
                            }, type: "button", children: loc }, loc))) })) : null, activity.diffs.length > 0
                        ? activity.diffs.map((diff) => (_jsxs("div", { className: "mb-1 rounded-md px-2 py-1.5", style: {
                                backgroundColor: "var(--color-bg-tertiary)",
                                border: "1px solid var(--color-border)",
                            }, children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("span", { className: "min-w-0 truncate", style: {
                                                color: "var(--color-text-primary)",
                                                fontSize: "0.9em",
                                            }, children: diff.path }), _jsx("span", { style: {
                                                color: "var(--color-text-secondary)",
                                                fontSize: "0.8em",
                                                letterSpacing: "0.06em",
                                                textTransform: "uppercase",
                                            }, children: diff.kind })] }), _jsx("div", { className: "mt-0.5", style: {
                                        color: "var(--color-text-secondary)",
                                        fontSize: "0.85em",
                                    }, children: summarizeDiff(diff.oldText, diff.newText) })] }, `${activity.id}:${diff.path}`)))
                        : null] })) : null] }));
}
/* ─── Streaming indicator ─── */
function StreamingIndicator({ elapsed }) {
    return (_jsxs("div", { className: "flex items-baseline gap-2 py-1", style: { fontSize: "0.74em", lineHeight: 1.2 }, children: [_jsx("span", { className: "inline-flex items-baseline gap-[3px]", children: [0, 1, 2].map((i) => (_jsx("span", { className: "inline-block rounded-full", style: {
                        animation: `ai-bounce 1.2s ease-in-out ${i * 0.15}s infinite`,
                        backgroundColor: "var(--color-accent)",
                        height: 5,
                        opacity: 0.6,
                        width: 5,
                    } }, i))) }), elapsed ? (_jsx("span", { style: {
                    color: "var(--color-text-secondary)",
                    opacity: 0.6,
                }, children: elapsed })) : null] }));
}
/* ─── Utility components ─── */
function RuntimeBadge({ state, }) {
    const label = state === "ready" ? "Ready" : state === "error" ? "Error" : "Missing";
    const dotColor = state === "ready"
        ? "#16a34a"
        : state === "error"
            ? "#dc2626"
            : "#d97706";
    return (_jsxs("span", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: "inline-block h-2 w-2 rounded-full", style: { backgroundColor: dotColor } }), _jsx("span", { style: {
                    color: "var(--color-text-secondary)",
                    fontSize: "0.7em",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                }, children: label })] }));
}
function PlanStatusDot({ status, }) {
    const bg = status === "completed"
        ? "#16a34a"
        : status === "in_progress"
            ? "#2563eb"
            : "#94a3b8";
    return (_jsx("span", { className: "mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full", style: { backgroundColor: bg } }));
}
/* ─── Utility functions ─── */
function findActiveToken(draft, cursor) {
    const c = Math.max(0, Math.min(cursor, draft.length));
    let start = c;
    while (start > 0 && !/\s/.test(draft[start - 1] ?? ""))
        start -= 1;
    let end = c;
    while (end < draft.length && !/\s/.test(draft[end] ?? ""))
        end += 1;
    const token = draft.slice(start, end);
    if (!token.startsWith("@") && !token.startsWith("/"))
        return null;
    return { end, start, token };
}
function replaceToken(draft, range, replacement) {
    return `${draft.slice(0, range.start)}${replacement}${draft.slice(range.end)}`;
}
function createEmptySnapshot(tab) {
    return {
        availableCommands: [],
        lastError: null,
        messages: [],
        pendingPermission: null,
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
function serializePrompt(draft) {
    const t = draft.trim();
    if (!t)
        return "";
    const paths = [...t.matchAll(/(^|\s)@([^\s]+)/g)]
        .map((m) => m[2]?.trim())
        .filter((v) => Boolean(v));
    if (paths.length === 0)
        return t;
    return `${t}\n\nContext references:\n${[...new Set(paths)].map((p) => `- ${p}`).join("\n")}`;
}
function summarizeDiff(oldText, newText) {
    if (oldText === null && newText !== null)
        return `Creates ${countLines(newText)} line(s).`;
    if (oldText !== null && newText === null)
        return `Removes ${countLines(oldText)} line(s).`;
    return `Updates ${Math.max(countLines(oldText ?? ""), countLines(newText ?? ""))} line(s).`;
}
function countLines(text) {
    return text ? text.split("\n").length : 0;
}
function looksAbsolutePath(p) {
    return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}
