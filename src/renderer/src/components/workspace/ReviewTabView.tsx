import { useEffect, useMemo } from "react";

import type { AiDiffHunk, AiSessionSnapshot, AiTrackedFile } from "@shared/ipc";

import { useAiStore } from "@renderer/app/store/ai-store";
import type {
    RuntimeWorkspaceFileReviewContext,
    RuntimeWorkspaceReviewTab,
} from "@renderer/app/workspace/tree";

interface ReviewTabViewProps {
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
    ) => Promise<void>;
    readonly tab: RuntimeWorkspaceReviewTab;
}

export function ReviewTabView({ onOpenFile, tab }: ReviewTabViewProps) {
    const ensureSession = useAiStore((state) => state.ensureSession);
    const keepAllTrackedFiles = useAiStore(
        (state) => state.keepAllTrackedFiles,
    );
    const keepTrackedFile = useAiStore((state) => state.keepTrackedFile);
    const keepTrackedFileHunks = useAiStore(
        (state) => state.keepTrackedFileHunks,
    );
    const rejectAllTrackedFiles = useAiStore(
        (state) => state.rejectAllTrackedFiles,
    );
    const rejectTrackedFile = useAiStore((state) => state.rejectTrackedFile);
    const rejectTrackedFileHunks = useAiStore(
        (state) => state.rejectTrackedFileHunks,
    );
    const sessionState = useAiStore((state) => state.sessions[tab.sessionId]);

    const sessionTab = useMemo(
        () => ({
            createdAt: tab.createdAt,
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
        void ensureSession(sessionTab);
    }, [ensureSession, sessionTab]);

    const snapshot = sessionState?.snapshot ?? createEmptySnapshot(tab);
    const currentError = sessionState?.localError ?? snapshot.lastError;
    const trackedFiles = useMemo(
        () =>
            snapshot.trackedFiles
                .filter((trackedFile) => trackedFile.reviewState === "pending")
                .sort((left, right) =>
                    right.updatedAt.localeCompare(left.updatedAt),
                ),
        [snapshot.trackedFiles],
    );
    const pendingCount = trackedFiles.length;

    return (
        <div className="flex h-full min-h-0 flex-col bg-bg-secondary">
            <div className="border-b border-border bg-bg-panel px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <div className="text-[11px] uppercase tracking-[0.16em] text-text-secondary">
                            Pending Review
                        </div>
                        <div className="mt-1 text-sm text-text-primary">
                            {pendingCount} pending file{pendingCount === 1 ? "" : "s"}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            className="app-no-drag rounded-full border border-border px-3 py-1.5 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary"
                            onClick={() => void keepAllTrackedFiles(tab.sessionId)}
                            type="button"
                        >
                            Keep All
                        </button>
                        <button
                            className="app-no-drag rounded-full border border-border px-3 py-1.5 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary"
                            onClick={() =>
                                void rejectAllTrackedFiles(tab.sessionId)
                            }
                            type="button"
                        >
                            Reject All
                        </button>
                    </div>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {currentError ? (
                    <div className="mb-4 rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
                        {currentError}
                    </div>
                ) : null}

                {trackedFiles.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-border bg-bg-panel px-4 py-5 text-sm text-text-secondary">
                        Codex changes will appear here for review as soon as
                        files are edited.
                    </div>
                ) : (
                    <div className="space-y-3">
                        {trackedFiles.map((trackedFile) => (
                            <TrackedFileCard
                                key={trackedFile.identityKey}
                                onKeep={() =>
                                    void keepTrackedFile({
                                        path: trackedFile.path,
                                        sessionId: tab.sessionId,
                                    })
                                }
                                onKeepHunk={(hunkId) =>
                                    void keepTrackedFileHunks({
                                        hunkIds: [hunkId],
                                        path: trackedFile.path,
                                        sessionId: tab.sessionId,
                                    })
                                }
                                onOpen={() => {
                                    if (
                                        tab.projectId &&
                                        !looksAbsolutePath(trackedFile.path)
                                    ) {
                                        void onOpenFile(
                                            tab.projectId,
                                            trackedFile.path,
                                            {
                                                path: trackedFile.path,
                                                sessionId: tab.sessionId,
                                            },
                                        );
                                    }
                                }}
                                onReject={() =>
                                    void rejectTrackedFile({
                                        path: trackedFile.path,
                                        sessionId: tab.sessionId,
                                    })
                                }
                                onRejectHunk={(hunkId) =>
                                    void rejectTrackedFileHunks({
                                        hunkIds: [hunkId],
                                        path: trackedFile.path,
                                        sessionId: tab.sessionId,
                                    })
                                }
                                tab={tab}
                                trackedFile={trackedFile}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function TrackedFileCard({
    onKeep,
    onKeepHunk,
    onOpen,
    onReject,
    onRejectHunk,
    tab,
    trackedFile,
}: {
    readonly onKeep: () => void;
    readonly onKeepHunk: (hunkId: string) => void;
    readonly onOpen: () => void;
    readonly onReject: () => void;
    readonly onRejectHunk: (hunkId: string) => void;
    readonly tab: RuntimeWorkspaceReviewTab;
    readonly trackedFile: AiTrackedFile;
}) {
    const hasHunks = trackedFile.hunks.length > 0;

    return (
        <div className="rounded-2xl border border-border bg-bg-tertiary p-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-sm text-text-primary">
                        {trackedFile.path}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-text-secondary">
                        <span>{trackedFile.kind}</span>
                        <span>pending</span>
                        {trackedFile.previousPath ? (
                            <span className="normal-case tracking-normal text-text-secondary/80">
                                from {trackedFile.previousPath}
                            </span>
                        ) : null}
                        {hasHunks ? (
                            <span>
                                {trackedFile.hunks.length} hunk
                                {trackedFile.hunks.length === 1 ? "" : "s"}
                            </span>
                        ) : null}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {tab.projectId && !looksAbsolutePath(trackedFile.path) ? (
                        <button
                            className="app-no-drag rounded-full border border-border px-2 py-1 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary"
                            onClick={onOpen}
                            type="button"
                        >
                            Open
                        </button>
                    ) : null}
                    <button
                        className="app-no-drag rounded-full border border-border px-2 py-1 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary"
                        onClick={onKeep}
                        type="button"
                    >
                        Keep File
                    </button>
                    <button
                        className="app-no-drag rounded-full border border-border px-2 py-1 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary"
                        onClick={onReject}
                        type="button"
                    >
                        Reject File
                    </button>
                </div>
            </div>

            {hasHunks ? (
                <div className="mt-3 space-y-3">
                    {trackedFile.hunks.map((hunk) => (
                        <HunkCard
                            hunk={hunk}
                            key={hunk.id}
                            onKeep={() => onKeepHunk(hunk.id)}
                            onReject={() => onRejectHunk(hunk.id)}
                        />
                    ))}
                </div>
            ) : (
                <div className="mt-3 grid gap-3">
                    {trackedFile.oldText !== null ? (
                        <DiffPreview label="Before" text={trackedFile.oldText} />
                    ) : null}
                    {trackedFile.newText !== null ? (
                        <DiffPreview label="After" text={trackedFile.newText} />
                    ) : null}
                </div>
            )}
        </div>
    );
}

function HunkCard({
    hunk,
    onKeep,
    onReject,
}: {
    readonly hunk: AiDiffHunk;
    readonly onKeep: () => void;
    readonly onReject: () => void;
}) {
    return (
        <div className="overflow-hidden rounded-2xl border border-border bg-bg-panel">
            <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                <div className="text-[11px] font-medium tracking-[0.08em] text-text-secondary">
                    {formatHunkHeader(hunk)}
                </div>
                <div className="flex items-center gap-2">
                    <button
                        className="app-no-drag rounded-full border border-border px-2 py-1 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary"
                        onClick={onKeep}
                        type="button"
                    >
                        Keep Hunk
                    </button>
                    <button
                        className="app-no-drag rounded-full border border-border px-2 py-1 text-[11px] text-text-secondary transition hover:border-accent hover:text-text-primary"
                        onClick={onReject}
                        type="button"
                    >
                        Reject Hunk
                    </button>
                </div>
            </div>
            <div className="max-h-72 overflow-auto font-mono text-[11px] leading-5">
                {hunk.lines.map((line) => (
                    <div
                        className="flex items-start gap-3 px-3 py-0.5"
                        key={line.id}
                        style={{ backgroundColor: getHunkLineBackground(line.type) }}
                    >
                        <span className="w-4 shrink-0 text-center text-text-secondary/70">
                            {getHunkLinePrefix(line.type)}
                        </span>
                        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-text-primary">
                            {line.text || " "}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function DiffPreview({
    label,
    text,
}: {
    readonly label: string;
    readonly text: string;
}) {
    return (
        <div className="rounded-xl border border-border bg-bg-panel">
            <div className="border-b border-border px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-text-secondary">
                {label}
            </div>
            <pre className="max-h-40 overflow-auto px-3 py-3 text-[11px] leading-5 text-text-primary">
                {truncateDiffText(text)}
            </pre>
        </div>
    );
}

function createEmptySnapshot(
    tab: RuntimeWorkspaceReviewTab,
): AiSessionSnapshot {
    const now = new Date().toISOString();

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
        updatedAt: now,
    };
}

function formatHunkHeader(hunk: AiDiffHunk): string {
    return `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
}

function getHunkLineBackground(
    type: AiDiffHunk["lines"][number]["type"],
): string {
    if (type === "add") {
        return "color-mix(in srgb, #16a34a 12%, transparent)";
    }
    if (type === "remove") {
        return "color-mix(in srgb, #dc2626 12%, transparent)";
    }
    return "transparent";
}

function getHunkLinePrefix(
    type: AiDiffHunk["lines"][number]["type"],
): string {
    if (type === "add") {
        return "+";
    }
    if (type === "remove") {
        return "-";
    }
    return " ";
}

function truncateDiffText(text: string): string {
    const maxLength = 1600;
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength)}\n…`;
}

function looksAbsolutePath(candidatePath: string): boolean {
    return (
        candidatePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidatePath)
    );
}
