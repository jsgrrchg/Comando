import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo } from "react";
import { useAiStore } from "@renderer/app/store/ai-store";
export function ReviewTabView({ onOpenFile, tab }) {
    const ensureSession = useAiStore((state) => state.ensureSession);
    const keepAllTrackedFiles = useAiStore((state) => state.keepAllTrackedFiles);
    const keepTrackedFile = useAiStore((state) => state.keepTrackedFile);
    const rejectAllTrackedFiles = useAiStore((state) => state.rejectAllTrackedFiles);
    const rejectTrackedFile = useAiStore((state) => state.rejectTrackedFile);
    const sessionState = useAiStore((state) => state.sessions[tab.sessionId]);
    const sessionTab = useMemo(() => ({
        createdAt: tab.createdAt,
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
        void ensureSession(sessionTab);
    }, [ensureSession, sessionTab]);
    const snapshot = sessionState?.snapshot ?? createEmptySnapshot(tab);
    const currentError = sessionState?.localError ?? snapshot.lastError;
    const trackedFiles = useMemo(() => [...snapshot.trackedFiles].sort((left, right) => Number(right.reviewState === "pending") -
        Number(left.reviewState === "pending") ||
        right.updatedAt.localeCompare(left.updatedAt)), [snapshot.trackedFiles]);
    const pendingCount = useMemo(() => trackedFiles.filter((trackedFile) => trackedFile.reviewState === "pending").length, [trackedFiles]);
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col bg-bg-secondary", children: [_jsx("div", { className: "border-b border-border bg-bg-panel px-4 py-3", children: _jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { children: [_jsx("div", { className: "text-[11px] uppercase tracking-[0.16em] text-text-secondary", children: "Pending Review" }), _jsxs("div", { className: "mt-1 text-sm text-text-primary", children: [pendingCount, " pending changes"] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("button", { className: "app-no-drag rounded-full border border-border px-3 py-1.5 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary", onClick: () => void keepAllTrackedFiles(tab.sessionId), type: "button", children: "Keep All" }), _jsx("button", { className: "app-no-drag rounded-full border border-border px-3 py-1.5 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary", onClick: () => void rejectAllTrackedFiles(tab.sessionId), type: "button", children: "Reject All" })] })] }) }), _jsxs("div", { className: "min-h-0 flex-1 overflow-y-auto p-4", children: [currentError ? (_jsx("div", { className: "mb-4 rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800", children: currentError })) : null, trackedFiles.length === 0 ? (_jsx("div", { className: "rounded-2xl border border-dashed border-border bg-bg-panel px-4 py-5 text-sm text-text-secondary", children: "Codex changes will appear here for review as soon as files are edited." })) : (_jsx("div", { className: "space-y-3", children: trackedFiles.map((trackedFile) => (_jsx(TrackedFileCard, { onKeep: () => void keepTrackedFile({
                                path: trackedFile.path,
                                sessionId: tab.sessionId,
                            }), onOpen: () => {
                                if (tab.projectId &&
                                    !looksAbsolutePath(trackedFile.path)) {
                                    void onOpenFile(tab.projectId, trackedFile.path);
                                }
                            }, onReject: () => void rejectTrackedFile({
                                path: trackedFile.path,
                                sessionId: tab.sessionId,
                            }), tab: tab, trackedFile: trackedFile }, trackedFile.identityKey))) }))] })] }));
}
function TrackedFileCard({ onKeep, onOpen, onReject, tab, trackedFile, }) {
    return (_jsxs("div", { className: "rounded-2xl border border-border bg-bg-tertiary p-3", children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "truncate text-sm text-text-primary", children: trackedFile.path }), _jsxs("div", { className: "mt-1 text-[11px] uppercase tracking-[0.14em] text-text-secondary", children: [trackedFile.kind, " \u00B7 ", trackedFile.reviewState] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [tab.projectId && !looksAbsolutePath(trackedFile.path) ? (_jsx("button", { className: "app-no-drag rounded-full border border-border px-2 py-1 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary", onClick: onOpen, type: "button", children: "Open" })) : null, _jsx("button", { className: "app-no-drag rounded-full border border-border px-2 py-1 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary", onClick: onKeep, type: "button", children: "Keep" }), _jsx("button", { className: "app-no-drag rounded-full border border-border px-2 py-1 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary", onClick: onReject, type: "button", children: "Reject" })] })] }), _jsxs("div", { className: "mt-3 grid gap-3", children: [trackedFile.oldText !== null ? (_jsx(DiffPreview, { label: "Before", text: trackedFile.oldText })) : null, trackedFile.newText !== null ? (_jsx(DiffPreview, { label: "After", text: trackedFile.newText })) : null] })] }));
}
function DiffPreview({ label, text, }) {
    return (_jsxs("div", { className: "rounded-xl border border-border bg-bg-panel", children: [_jsx("div", { className: "border-b border-border px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-text-secondary", children: label }), _jsx("pre", { className: "max-h-40 overflow-auto px-3 py-3 text-[11px] leading-5 text-text-primary", children: truncateDiffText(text) })] }));
}
function createEmptySnapshot(tab) {
    const now = new Date().toISOString();
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
        updatedAt: now,
    };
}
function truncateDiffText(text) {
    const maxLength = 1600;
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength)}\n…`;
}
function looksAbsolutePath(candidatePath) {
    return candidatePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidatePath);
}
