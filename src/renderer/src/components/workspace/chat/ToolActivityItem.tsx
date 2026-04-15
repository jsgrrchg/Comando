import { useState } from "react";

import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";
import { HighlightedCodeText } from "@renderer/app/editor/staticCodeHighlight";
import { useMarkdownCodeLanguageSupport } from "@renderer/app/editor/useCodeLanguageSupport";
import type { RuntimeWorkspaceFileReviewContext } from "@renderer/app/workspace/tree";

import { MarkdownContent } from "../MarkdownContent";
import { ChangeReviewPanel } from "./ChangeReviewPanel";

/* ─── Tool icon SVGs ─── */

function ReadIcon() {
    return (
        <svg
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="13"
        >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" x2="16.65" y1="21" y2="16.65" />
        </svg>
    );
}

function EditIcon() {
    return (
        <svg
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="13"
        >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <path d="m9 15 2 2 4-4" />
        </svg>
    );
}

function DeleteIcon() {
    return (
        <svg
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="13"
        >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="9" x2="15" y1="13" y2="13" />
        </svg>
    );
}

function ExecuteIcon() {
    return (
        <svg
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="13"
        >
            <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
    );
}

function DefaultIcon() {
    return (
        <svg
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="13"
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    );
}

function Chevron({ expanded }: { readonly expanded: boolean }) {
    return (
        <svg
            fill="none"
            height="10"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            style={{
                opacity: 0.6,
                transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 0.15s ease",
            }}
            viewBox="0 0 24 24"
            width="10"
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    );
}

/* ─── Helpers ─── */

const FILE_TOOL_KINDS = new Set([
    "edit",
    "create",
    "delete",
    "move",
    "read",
    "search",
    "write",
    "Write",
    "Edit",
    "Read",
]);

function getToolAccent(kind: string): string {
    const lk = kind.toLowerCase();
    if (lk === "delete" || lk === "remove") return "#ef4444";
    return "#6b7280";
}

function getToolIcon(kind: string) {
    const lk = kind.toLowerCase();
    if (lk === "read" || lk === "search") return <ReadIcon />;
    if (lk === "delete" || lk === "remove") return <DeleteIcon />;
    if (lk === "execute" || lk === "bash" || lk === "shell")
        return <ExecuteIcon />;
    if (
        lk === "edit" ||
        lk === "write" ||
        lk === "create" ||
        lk === "move" ||
        lk === "update"
    )
        return <EditIcon />;
    return <DefaultIcon />;
}

function isFileToolActivity(
    activity: AiToolActivity,
    trackedFiles: readonly AiTrackedFile[],
): boolean {
    if (trackedFiles.length > 0) return true;
    if (FILE_TOOL_KINDS.has(activity.kind)) return true;
    if (activity.locations.length > 0) return true;
    if (activity.diffs.length > 0) return true;
    return false;
}

function looksAbsolutePath(p: string): boolean {
    return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);
}

function isTurnStartedActivity(activity: AiToolActivity): boolean {
    return activity.id.startsWith("neverwrite:status:turn:");
}

function summarizeDiff(oldText: string | null, newText: string | null): string {
    const ol = (oldText ?? "").split("\n").filter(Boolean).length;
    const nl = (newText ?? "").split("\n").filter(Boolean).length;
    if (ol === 0 && nl > 0) return `Creates ${nl} line(s).`;
    if (nl === 0 && ol > 0) return `Removes ${ol} line(s).`;
    const added = Math.max(0, nl - ol);
    const removed = Math.max(0, ol - nl);
    const parts: string[] = [];
    if (added > 0) parts.push(`+${added}`);
    if (removed > 0) parts.push(`-${removed}`);
    return parts.length > 0
        ? `Updates ${nl} line(s) (${parts.join(", ")}).`
        : `Updates ${nl} line(s).`;
}

function ToolDetailCodeBlock({
    accentBorder,
    backgroundColor,
    color,
    content,
    languageInfo,
}: {
    readonly accentBorder?: string;
    readonly backgroundColor: string;
    readonly color: string;
    readonly content: string;
    readonly languageInfo?: string | null;
}) {
    const languageSupport = useMarkdownCodeLanguageSupport(languageInfo);

    return (
        <pre
            className="max-h-48 overflow-y-auto rounded px-2 py-1.5"
            style={{
                backgroundColor,
                border: accentBorder ?? "1px solid var(--color-border)",
                color,
                fontFamily: "var(--font-mono, monospace)",
                fontSize: "0.92em",
                lineHeight: 1.4,
                margin: 0,
                overflowWrap: "anywhere",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
            }}
        >
            <code
                style={{
                    color: "inherit",
                    whiteSpace: "inherit",
                }}
            >
                <HighlightedCodeText
                    language={languageSupport}
                    segmentKeyPrefix={`tool-activity:${languageInfo ?? "plain"}:${content.length}`}
                    text={content}
                />
            </code>
        </pre>
    );
}

function ToolDetailSummary({
    accentBorder,
    backgroundColor,
    content,
}: {
    readonly accentBorder?: string;
    readonly backgroundColor: string;
    readonly content: string;
}) {
    return (
        <div
            className="rounded px-2 py-1.5"
            style={{
                backgroundColor,
                border: accentBorder ?? "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
            }}
        >
            <MarkdownContent content={content} />
        </div>
    );
}

function TurnStartedDivider({
    activity,
}: {
    readonly activity: AiToolActivity;
}) {
    return (
        <div
            className="min-w-0 max-w-full py-2"
            data-testid="turn-start-divider"
        >
            <div className="flex min-w-0 max-w-full items-center gap-3">
                <div
                    className="h-px flex-1"
                    style={{
                        backgroundColor: "var(--color-border)",
                        opacity: 0.5,
                    }}
                />
                <span
                    className="shrink-0 uppercase tracking-[0.14em]"
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: "0.68em",
                        opacity: 0.7,
                    }}
                >
                    {activity.title}
                </span>
                <div
                    className="h-px flex-1"
                    style={{
                        backgroundColor: "var(--color-border)",
                        opacity: 0.5,
                    }}
                />
            </div>
        </div>
    );
}

/* ─── File tool message (card style) ─── */

function FileToolMessage({
    activity,
    onOpenFile,
    pendingTrackedFiles,
    projectId,
    worktreeId,
}: {
    readonly activity: AiToolActivity;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
    ) => Promise<void>;
    readonly pendingTrackedFiles: readonly AiTrackedFile[];
    readonly projectId: string | null;
    readonly worktreeId: string | null;
}) {
    const [expanded, setExpanded] = useState(false);
    const isInProgress = activity.status === "in_progress";
    const isCompleted = activity.status === "completed";
    const accent = getToolAccent(activity.kind);

    const hasDetail =
        !!activity.summary ||
        activity.locations.length > 0 ||
        activity.diffs.length > 0 ||
        pendingTrackedFiles.length > 0;

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                backgroundColor: `color-mix(in srgb, ${accent} 4%, var(--color-bg-secondary))`,
                border: `1px solid color-mix(in srgb, ${accent} 25%, var(--color-border))`,
                opacity: isCompleted ? 0.65 : 1,
                transition: "opacity 0.2s ease",
            }}
        >
            <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
                onClick={() => hasDetail && setExpanded(!expanded)}
                style={{
                    background: "none",
                    border: "none",
                    borderBottom: expanded
                        ? `1px solid color-mix(in srgb, ${accent} 15%, var(--color-border))`
                        : "1px solid transparent",
                    color: accent,
                    cursor: hasDetail ? "pointer" : "default",
                    fontSize: "0.83em",
                }}
                type="button"
            >
                <span className="shrink-0">{getToolIcon(activity.kind)}</span>
                <span
                    className="min-w-0 flex-1 truncate"
                    style={{
                        color: "var(--color-text-primary)",
                        fontWeight: 500,
                    }}
                >
                    {activity.title}
                </span>
                {isInProgress ? (
                    <span
                        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                        style={{ backgroundColor: "var(--color-accent)" }}
                    />
                ) : null}
                {pendingTrackedFiles.length > 0 ? (
                    <span
                        className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
                        style={{
                            backgroundColor:
                                "color-mix(in srgb, var(--color-accent) 10%, transparent)",
                            color: "var(--color-accent)",
                        }}
                    >
                        {pendingTrackedFiles.length} review
                    </span>
                ) : null}
                {hasDetail ? (
                    <span className="shrink-0">
                        <Chevron expanded={expanded} />
                    </span>
                ) : null}
            </button>

            {expanded ? (
                <div className="px-3 py-1.5" style={{ fontSize: "0.78em" }}>
                    {activity.summary ? (
                        <div className="mb-1">
                            <ToolDetailSummary
                                accentBorder={`1px solid color-mix(in srgb, ${accent} 10%, var(--color-border))`}
                                backgroundColor={`color-mix(in srgb, ${accent} 4%, var(--color-bg-tertiary))`}
                                content={activity.summary}
                            />
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
                                            void onOpenFile(
                                                projectId,
                                                loc,
                                                worktreeId,
                                            );
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.backgroundColor =
                                            "var(--color-bg-secondary)";
                                        e.currentTarget.style.filter =
                                            "brightness(1.05)";
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.backgroundColor =
                                            "var(--color-bg-tertiary)";
                                        e.currentTarget.style.filter = "none";
                                    }}
                                    style={{
                                        backgroundColor:
                                            "var(--color-bg-tertiary)",
                                        border: "1px solid var(--color-border)",
                                        color: "var(--color-text-secondary)",
                                        cursor: "pointer",
                                        fontSize: "0.9em",
                                        transition:
                                            "background-color 100ms ease, filter 100ms ease",
                                    }}
                                    type="button"
                                >
                                    {loc}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    {activity.diffs.map((diff) => (
                        <div
                            className="mb-1 rounded-md px-2 py-1.5"
                            key={`${activity.id}:${diff.path}`}
                            style={{
                                backgroundColor: "var(--color-bg-tertiary)",
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
                                {summarizeDiff(diff.oldText, diff.newText)}
                            </div>
                        </div>
                    ))}
                    {activity.diffs.length === 0
                        ? pendingTrackedFiles.map((trackedFile) => (
                              <div
                                  className="mb-1 rounded-md px-2 py-1.5"
                                  key={`${activity.id}:${trackedFile.identityKey}`}
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
                                          {trackedFile.path}
                                      </span>
                                      <span
                                          style={{
                                              color: "var(--color-text-secondary)",
                                              fontSize: "0.8em",
                                              letterSpacing: "0.06em",
                                              textTransform: "uppercase",
                                          }}
                                      >
                                          pending review
                                      </span>
                                  </div>
                              </div>
                          ))
                        : null}
                </div>
            ) : null}
        </div>
    );
}

/* ─── Terminal tool message (card style for bash/shell/execute) ─── */

const TERMINAL_TOOL_KINDS = new Set(["bash", "shell", "execute"]);

function isTerminalToolActivity(activity: AiToolActivity): boolean {
    return TERMINAL_TOOL_KINDS.has(activity.kind.toLowerCase());
}

function parseJsonValue(raw: string): unknown {
    return JSON.parse(raw) as unknown;
}

function extractCommand(rawInputJson: string | null): string | null {
    if (!rawInputJson) return null;
    try {
        const parsed = parseJsonValue(rawInputJson);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            "command" in parsed &&
            typeof parsed.command === "string"
        ) {
            return parsed.command;
        }
    } catch {
        /* ignore */
    }
    return null;
}

function TerminalToolMessage({
    activity,
}: {
    readonly activity: AiToolActivity;
}) {
    const isFailed = activity.status === "failed";
    const hasNonZeroExit =
        activity.exitCode !== null && activity.exitCode !== 0;
    const [expanded, setExpanded] = useState(isFailed || hasNonZeroExit);
    const isInProgress = activity.status === "in_progress";
    const isCompleted = activity.status === "completed";

    const accent = isFailed || hasNonZeroExit ? "#ef4444" : "#6b7280";
    const command = extractCommand(activity.rawInputJson);
    const hasDetail = !!command || !!activity.terminalOutput;

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                backgroundColor: `color-mix(in srgb, ${accent} 4%, var(--color-bg-secondary))`,
                border: `1px solid color-mix(in srgb, ${accent} 25%, var(--color-border))`,
                opacity: isCompleted ? 0.65 : 1,
                transition: "opacity 0.2s ease",
            }}
        >
            <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
                onClick={() => hasDetail && setExpanded(!expanded)}
                style={{
                    background: "none",
                    border: "none",
                    borderBottom: expanded
                        ? `1px solid color-mix(in srgb, ${accent} 15%, var(--color-border))`
                        : "1px solid transparent",
                    color: accent,
                    cursor: hasDetail ? "pointer" : "default",
                    fontSize: "0.83em",
                }}
                type="button"
            >
                <span className="shrink-0">
                    <ExecuteIcon />
                </span>
                <span
                    className="min-w-0 flex-1 truncate"
                    style={{
                        color: "var(--color-text-primary)",
                        fontWeight: 500,
                    }}
                >
                    {activity.title}
                </span>
                {isInProgress ? (
                    <span
                        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                        style={{ backgroundColor: "var(--color-accent)" }}
                    />
                ) : null}
                {activity.exitCode !== null ? (
                    <span
                        className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
                        style={{
                            backgroundColor:
                                activity.exitCode === 0
                                    ? "color-mix(in srgb, var(--diff-add) 10%, transparent)"
                                    : "color-mix(in srgb, var(--diff-remove) 10%, transparent)",
                            color:
                                activity.exitCode === 0
                                    ? "var(--diff-add)"
                                    : "var(--diff-remove)",
                        }}
                    >
                        exit {activity.exitCode}
                    </span>
                ) : null}
                {hasDetail ? (
                    <span className="shrink-0">
                        <Chevron expanded={expanded} />
                    </span>
                ) : null}
            </button>

            {expanded ? (
                <div
                    className="space-y-1 px-3 py-1.5"
                    style={{ fontSize: "0.78em" }}
                >
                    {command ? (
                        <ToolDetailCodeBlock
                            accentBorder={`1px solid color-mix(in srgb, ${accent} 10%, var(--color-border))`}
                            backgroundColor={`color-mix(in srgb, ${accent} 4%, var(--color-bg-tertiary))`}
                            color="var(--color-text-primary)"
                            content={command}
                            languageInfo="shell"
                        />
                    ) : null}
                    {activity.terminalOutput ? (
                        <ToolDetailCodeBlock
                            accentBorder={
                                isFailed
                                    ? "1px solid color-mix(in srgb, #ef4444 20%, var(--color-border))"
                                    : "1px solid var(--color-border)"
                            }
                            backgroundColor={
                                isFailed
                                    ? "color-mix(in srgb, #ef4444 6%, var(--color-bg-tertiary))"
                                    : "var(--color-bg-tertiary)"
                            }
                            color={
                                isFailed
                                    ? "#ef4444"
                                    : "var(--color-text-secondary)"
                            }
                            content={activity.terminalOutput}
                            languageInfo={command ? "shell" : null}
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

/* ─── Generic tool message (compact single-liner) ─── */

function formatRawJson(raw: string): string {
    try {
        const parsed = parseJsonValue(raw);
        if (typeof parsed === "string") return parsed;
        return JSON.stringify(parsed, null, 2);
    } catch {
        return raw;
    }
}

function GenericToolMessage({
    activity,
}: {
    readonly activity: AiToolActivity;
}) {
    const isFailed = activity.status === "failed";
    const [expanded, setExpanded] = useState(isFailed);
    const isInProgress = activity.status === "in_progress";
    const isCompleted = activity.status === "completed";
    const rawInputJson = activity.rawInputJson;
    const rawOutputJson = activity.rawOutputJson;
    const hasRawInput = rawInputJson !== null;
    const hasRawOutput = rawOutputJson !== null;
    const hasDetail = !!activity.summary || hasRawInput || hasRawOutput;

    return (
        <div
            className="min-w-0 max-w-full"
            style={{
                color: isFailed ? "#ef4444" : "var(--color-text-secondary)",
                fontSize: "0.85em",
                opacity: isCompleted ? 0.45 : 0.7,
                transition: "opacity 0.2s ease",
            }}
        >
            <button
                className="flex w-full items-center gap-2 py-0.5 text-left"
                onClick={() => hasDetail && setExpanded(!expanded)}
                style={{
                    background: "none",
                    border: "none",
                    color: "inherit",
                    cursor: hasDetail ? "pointer" : "default",
                }}
                type="button"
            >
                <span className="shrink-0">{getToolIcon(activity.kind)}</span>
                <span className="min-w-0 flex-1 truncate">
                    {activity.title}
                </span>
                {isInProgress ? (
                    <span
                        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                        style={{ backgroundColor: "var(--color-accent)" }}
                    />
                ) : null}
                {hasDetail ? (
                    <span className="shrink-0">
                        <Chevron expanded={expanded} />
                    </span>
                ) : null}
            </button>

            {expanded ? (
                <div className="mt-1 space-y-1" style={{ fontSize: "0.82em" }}>
                    {activity.summary ? (
                        <ToolDetailSummary
                            backgroundColor="var(--color-bg-tertiary)"
                            content={activity.summary}
                        />
                    ) : null}
                    {hasRawInput ? (
                        <ToolDetailCodeBlock
                            backgroundColor="var(--color-bg-tertiary)"
                            color="var(--color-text-secondary)"
                            content={formatRawJson(rawInputJson)}
                            languageInfo="json"
                        />
                    ) : null}
                    {hasRawOutput ? (
                        <ToolDetailCodeBlock
                            accentBorder={
                                isFailed
                                    ? "1px solid color-mix(in srgb, #ef4444 20%, var(--color-border))"
                                    : "1px solid var(--color-border)"
                            }
                            backgroundColor={
                                isFailed
                                    ? "color-mix(in srgb, #ef4444 6%, var(--color-bg-tertiary))"
                                    : "var(--color-bg-tertiary)"
                            }
                            color={
                                isFailed
                                    ? "#ef4444"
                                    : "var(--color-text-secondary)"
                            }
                            content={formatRawJson(rawOutputJson)}
                            languageInfo="json"
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

/* ─── Public component ─── */

export function ToolActivityItem({
    activity,
    onOpenFile,
    trackedFiles = [],
    projectId,
    worktreeId = null,
}: {
    readonly activity: AiToolActivity;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
    ) => Promise<void>;
    readonly trackedFiles?: readonly AiTrackedFile[];
    readonly projectId: string | null;
    readonly worktreeId?: string | null;
}) {
    const pendingTrackedFiles = trackedFiles.filter(
        (trackedFile) => trackedFile.reviewState === "pending",
    );
    const hasInlineReview =
        activity.diffs.length > 0 || trackedFiles.length > 0;

    if (isTurnStartedActivity(activity)) {
        return <TurnStartedDivider activity={activity} />;
    }

    if (isTerminalToolActivity(activity)) {
        return <TerminalToolMessage activity={activity} />;
    }

    if (isFileToolActivity(activity, trackedFiles)) {
        if (hasInlineReview) {
            return (
                <ChangeReviewPanel
                    activity={activity}
                    onOpenFile={onOpenFile}
                    projectId={projectId}
                    trackedFiles={trackedFiles}
                    worktreeId={worktreeId}
                />
            );
        }

        return (
            <FileToolMessage
                activity={activity}
                onOpenFile={onOpenFile}
                pendingTrackedFiles={pendingTrackedFiles}
                projectId={projectId}
                worktreeId={worktreeId}
            />
        );
    }

    return <GenericToolMessage activity={activity} />;
}
