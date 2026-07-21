import { memo, useEffect, useState, type ReactNode } from "react";

import type {
    AiToolActivity,
    AiToolActivityLocation,
    AiTrackedFile,
} from "@shared/ipc";
import { isAiTrackedFileUnresolved } from "@shared/ai-tracked-file";
import { FIXED_PENDING_REVIEW_CARD_TEXT_ZOOM } from "@renderer/app/ai/sessionReviewContracts";
import { useAiStore } from "@renderer/app/store/ai-store";
import {
    normalizeIndexPath,
    useFileReferenceValidator,
    useProjectFileIndex,
} from "@renderer/app/store/projectFileIndexStore";
import { useRenderProbe } from "@renderer/app/debug/renderProbe";
import { HighlightedCodeText } from "@renderer/app/editor/staticCodeHighlight";
import { useMarkdownCodeLanguageSupport } from "@renderer/app/editor/useCodeLanguageSupport";
import type {
    RuntimeWorkspaceFileOpenLocation,
    RuntimeWorkspaceFileReviewContext,
} from "@renderer/app/workspace/tree";

import { MarkdownContent } from "../MarkdownContent";
import {
    isLikelyProjectFileReference,
    parseProjectFileReference,
    type ResolvedProjectFileReference,
} from "../projectFileReferences";
import { ChangeReviewPanel } from "./ChangeReviewPanel";
import {
    getToolActivityDescriptor,
    getStructuredToolCommand,
    getStructuredToolTarget,
} from "./toolActivityDescriptor";
import {
    isEditedFileToolActivity,
    isFileToolActivity,
    isStatusToolActivity,
    isTerminalToolActivity,
    isTurnStartedActivity,
} from "./toolActivityKinds";
import { usePersistentToolExpansion } from "./toolExpansionStore";

export type ToolPayloadVisibilityChangeHandler = (
    activityId: string,
    visible: boolean,
) => void;

const TOOL_DETAIL_INITIAL_VISIBLE_CHARACTERS = 48_000;
const TOOL_DETAIL_VISIBLE_CHARACTER_PAGE = 48_000;

function useReportToolPayloadVisibility(
    activityId: string,
    visible: boolean,
    onVisibilityChange?: ToolPayloadVisibilityChangeHandler,
): void {
    useEffect(() => {
        if (!visible || !onVisibilityChange) return;
        onVisibilityChange(activityId, true);
        return () => onVisibilityChange(activityId, false);
    }, [activityId, onVisibilityChange, visible]);
}

function VisibleToolPayload({
    activityId,
    children,
    onVisibilityChange,
}: {
    readonly activityId: string;
    readonly children: ReactNode;
    readonly onVisibilityChange?: ToolPayloadVisibilityChangeHandler;
}) {
    useReportToolPayloadVisibility(activityId, true, onVisibilityChange);
    return children;
}

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

function HammerIcon() {
    return (
        <svg
            data-tool-icon="hammer"
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="13"
        >
            <path d="m14 4 6 6" />
            <path d="m12.5 5.5 3-3 6 6-3 3" />
            <path d="m14.5 10.5-9 9a2.12 2.12 0 0 1-3-3l9-9" />
        </svg>
    );
}

function SubagentIcon() {
    return (
        <svg
            fill="currentColor"
            height="13"
            stroke="none"
            viewBox="0 0 24 24"
            width="13"
        >
            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
        </svg>
    );
}

function StatusIcon() {
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
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
        </svg>
    );
}

function Chevron({
    expanded,
    variant = "vertical",
}: {
    readonly expanded: boolean;
    readonly variant?: "disclosure" | "vertical";
}) {
    const transform =
        variant === "disclosure"
            ? expanded
                ? "rotate(0deg)"
                : "rotate(-90deg)"
            : expanded
              ? "rotate(180deg)"
              : "rotate(0deg)";

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
                transform,
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

const TOOL_TITLE_TARGET_MAX_LENGTH = 72;

function getToolAccent(kind: string): string {
    const lk = kind.toLowerCase();
    if (lk === "delete" || lk === "remove") return "#ef4444";
    return "#6b7280";
}

function getToolIcon(activity: AiToolActivity) {
    if (activity.action?.kind === "open_session") return <SubagentIcon />;
    const lk = activity.kind.toLowerCase();
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
    return <HammerIcon />;
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

function parseToolTitleReference(
    title: string,
): {
    readonly displayTarget: string;
    readonly prefix: string;
    readonly target: string;
} | null {
    const match =
        /^(Read|Edit|Write|Create|Delete|Move|Search)\s+(.+)$/i.exec(
            title.trim(),
        );
    const target = match?.[2]?.trim() ?? "";
    if (
        !target ||
        isPlaceholderToolTarget(target) ||
        !isLikelyProjectFileReference(target)
    ) {
        return null;
    }

    return {
        displayTarget: target,
        prefix: `${match?.[1] ?? ""} `,
        target,
    };
}

function isPlaceholderToolTarget(target: string): boolean {
    return /^\.{2,}$/.test(target.trim());
}

function getToolActionPrefix(kind: string): string {
    const lk = kind.toLowerCase();
    if (lk === "read" || lk === "read_file") return "Read ";
    if (lk === "search" || lk === "grep") return "Search ";
    if (lk === "edit" || lk === "update") return "Edit ";
    if (lk === "write") return "Write ";
    if (lk === "create") return "Create ";
    if (lk === "delete" || lk === "remove") return "Delete ";
    if (lk === "move" || lk === "rename") return "Move ";
    return "";
}

function buildCompactedToolPathCandidate({
    leadingSegments,
    separator,
    target,
    trailingSegments,
}: {
    readonly leadingSegments: number;
    readonly separator: string;
    readonly target: readonly string[];
    readonly trailingSegments: number;
}): string | null {
    if (target.length <= leadingSegments + trailingSegments) {
        return null;
    }

    const leading = target.slice(0, leadingSegments);
    const trailing = target.slice(-trailingSegments);
    return [...leading, "...", ...trailing].join(separator);
}

function compactToolTitleTarget(target: string): string {
    const trimmedTarget = target.trim();
    if (trimmedTarget.length <= TOOL_TITLE_TARGET_MAX_LENGTH) {
        return trimmedTarget;
    }

    const separator =
        trimmedTarget.includes("\\") && !trimmedTarget.includes("/")
            ? "\\"
            : "/";
    const rawSegments = trimmedTarget.split(/[\\/]+/).filter(Boolean);
    const segments =
        separator === "/" && trimmedTarget.startsWith("/")
            ? ["", ...rawSegments]
            : rawSegments;
    if (segments.length <= 1) {
        return trimmedTarget;
    }

    const candidates = [
        buildCompactedToolPathCandidate({
            leadingSegments: 2,
            separator,
            target: segments,
            trailingSegments: 2,
        }),
        buildCompactedToolPathCandidate({
            leadingSegments: 1,
            separator,
            target: segments,
            trailingSegments: 2,
        }),
        buildCompactedToolPathCandidate({
            leadingSegments: 0,
            separator,
            target: segments,
            trailingSegments: 2,
        }),
        buildCompactedToolPathCandidate({
            leadingSegments: 0,
            separator,
            target: segments,
            trailingSegments: 1,
        }),
        segments.at(-1) ?? trimmedTarget,
    ].filter((candidate): candidate is string => candidate !== null);

    return (
        candidates.find(
            (candidate) => candidate.length <= TOOL_TITLE_TARGET_MAX_LENGTH,
        ) ?? candidates.at(-1) ?? trimmedTarget
    );
}

function getToolTitleReference(
    activity: AiToolActivity,
): {
    readonly displayTarget: string;
    readonly prefix: string;
    readonly target: string;
} | null {
    const titleReference = parseToolTitleReference(activity.title);
    if (!shouldDeriveStructuredToolTarget(activity.kind)) {
        return titleReference;
    }

    const structuredTarget = getStructuredToolTarget(activity);
    if (structuredTarget && isLikelyProjectFileReference(structuredTarget)) {
        return {
            displayTarget: titleReference?.target ?? structuredTarget,
            prefix: titleReference?.prefix ?? getToolActionPrefix(activity.kind),
            target: structuredTarget,
        };
    }

    return titleReference;
}

function shouldDeriveStructuredToolTarget(kind: string): boolean {
    const lk = kind.toLowerCase();
    return (
        lk === "read" ||
        lk === "read_file" ||
        lk === "search" ||
        lk === "grep"
    );
}

function isPrimaryOpenFileTool(activity: AiToolActivity): boolean {
    return activity.kind.toLowerCase() === "read";
}

function isReadToolActivityKind(kind: string): boolean {
    const lk = kind.toLowerCase();
    return lk === "read" || lk === "read_file";
}

function canOpenToolFileReference({
    canRenderFileReference,
    fileIndex,
    projectId,
    resolveFileReference,
    target,
}: {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly fileIndex?: ReadonlySet<string> | null;
    readonly projectId: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly target: string;
}) {
    return (
        !!projectId &&
        resolveOpenableToolFileReference({
            canRenderFileReference,
            fileIndex,
            resolveFileReference,
            target,
        }) !== null
    );
}

function getOpenLocationFromFileReference(reference: {
    readonly endLine: number | null;
    readonly startLine: number | null;
}): RuntimeWorkspaceFileOpenLocation | null {
    if (reference.startLine === null) {
        return null;
    }

    return {
        endLine: reference.endLine,
        startLine: reference.startLine,
    };
}

function openToolFileReference({
    canRenderFileReference,
    fileIndex,
    onOpenFile,
    onOpenFileReference,
    projectId,
    resolveFileReference,
    target,
    worktreeId,
}: {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly fileIndex?: ReadonlySet<string> | null;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly projectId: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly target: string;
    readonly worktreeId: string | null;
}) {
    const resolvedReference = resolveOpenableToolFileReference({
        canRenderFileReference,
        fileIndex,
        resolveFileReference,
        target,
    });
    if (resolvedReference) {
        if (onOpenFileReference) {
            onOpenFileReference(resolvedReference);
            return;
        }

        if (projectId) {
            const openLocation =
                getOpenLocationFromFileReference(resolvedReference);
            if (openLocation) {
                void onOpenFile(
                    projectId,
                    resolvedReference.relativePath,
                    worktreeId,
                    undefined,
                    openLocation,
                );
            } else {
                void onOpenFile(
                    projectId,
                    resolvedReference.relativePath,
                    worktreeId,
                );
            }
        }
        return;
    }
}

function hasPathSeparator(pathValue: string): boolean {
    return pathValue.includes("/") || pathValue.includes("\\");
}

function getPathBasename(pathValue: string): string {
    return pathValue.split(/[\\/]/).filter(Boolean).at(-1) ?? pathValue;
}

function isBasenameOnlyFileReference(pathValue: string): boolean {
    return !hasPathSeparator(pathValue) && pathValue.includes(".");
}

function resolveIndexedBasenameReference(
    parsedReference: ReturnType<typeof parseProjectFileReference>,
    fileIndex: ReadonlySet<string> | null | undefined,
): ResolvedProjectFileReference | null {
    if (
        !parsedReference ||
        parsedReference.isAbsolute ||
        !fileIndex ||
        !isBasenameOnlyFileReference(parsedReference.path)
    ) {
        return null;
    }

    const targetBasename = getPathBasename(parsedReference.path);
    const matches = [...fileIndex].filter(
        (candidatePath) => getPathBasename(candidatePath) === targetBasename,
    );
    if (matches.length !== 1) {
        return null;
    }

    const [relativePath] = matches;
    if (!relativePath) {
        return null;
    }

    return {
        ...parsedReference,
        relativePath,
    };
}

function isResolvedReferenceOpenable({
    canRenderFileReference,
    rawReference,
    reference,
}: {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly rawReference: string;
    readonly reference: ResolvedProjectFileReference;
}): boolean {
    return canRenderFileReference
        ? canRenderFileReference(rawReference, reference)
        : hasPathSeparator(reference.relativePath);
}

function resolveOpenableToolFileReference({
    canRenderFileReference,
    fileIndex,
    resolveFileReference,
    target,
}: {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly fileIndex?: ReadonlySet<string> | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly target: string;
}): ResolvedProjectFileReference | null {
    const resolvedReference = resolveFileReference?.(target) ?? null;
    if (
        resolvedReference &&
        isResolvedReferenceOpenable({
            canRenderFileReference,
            rawReference: target,
            reference: resolvedReference,
        })
    ) {
        return resolvedReference;
    }

    const parsedReference = parseProjectFileReference(target);
    const basenameReference = resolveIndexedBasenameReference(
        parsedReference,
        fileIndex,
    );
    if (
        basenameReference &&
        isResolvedReferenceOpenable({
            canRenderFileReference,
            rawReference: target,
            reference: basenameReference,
        })
    ) {
        return basenameReference;
    }

    if (
        !resolvedReference &&
        parsedReference &&
        !parsedReference.isAbsolute &&
        hasPathSeparator(parsedReference.path)
    ) {
        const relativeReference: ResolvedProjectFileReference = {
            ...parsedReference,
            relativePath: normalizeIndexPath(parsedReference.path),
        };
        if (
            isResolvedReferenceOpenable({
                canRenderFileReference,
                rawReference: target,
                reference: relativeReference,
            })
        ) {
            return relativeReference;
        }
    }

    return null;
}

function formatToolLocationReference(
    location: AiToolActivityLocation,
): string {
    if (location.line === null) {
        return location.path;
    }

    if (
        location.endLine !== null &&
        location.endLine !== location.line
    ) {
        return `${location.path}:${location.line}-${location.endLine}`;
    }

    return `${location.path}:${location.line}`;
}

function getToolLanguageInfoFromPath(pathValue: string | null): string | null {
    if (!pathValue) {
        return null;
    }

    const pathWithoutRange = pathValue.replace(/:\d+(?:-\d+)?$/, "");
    const basename = pathWithoutRange.split(/[\\/]/).pop() ?? "";
    const dotIndex = basename.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === basename.length - 1) {
        return null;
    }

    return basename.slice(dotIndex + 1).toLowerCase();
}

function shouldDecodeEscapedReadText(value: string): boolean {
    const escapedLineBreaks = value.match(/\\r\\n|\\n|\\r/g)?.length ?? 0;
    if (escapedLineBreaks === 0) {
        return false;
    }

    const actualLineBreaks = value.match(/\r\n|\n|\r/g)?.length ?? 0;
    return actualLineBreaks === 0 || escapedLineBreaks > actualLineBreaks * 2;
}

function looksLikeEncodedJsonString(value: string): boolean {
    const trimmed = value.trim();
    return (
        trimmed.startsWith('"') &&
        trimmed.endsWith('"') &&
        /\\(?:r|n|t|"|\\)/.test(trimmed)
    );
}

function decodeEscapedReadText(value: string): string {
    return value
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
}

function normalizeReadToolStringOutput(value: string): string | null {
    let normalized = value;
    for (let parseAttempt = 0; parseAttempt < 2; parseAttempt += 1) {
        if (!looksLikeEncodedJsonString(normalized)) {
            break;
        }

        try {
            const parsed = parseJsonValue(normalized.trim());
            if (typeof parsed !== "string" || parsed === normalized) {
                break;
            }
            normalized = parsed;
        } catch {
            break;
        }
    }

    if (shouldDecodeEscapedReadText(normalized)) {
        normalized = decodeEscapedReadText(normalized);
    }

    return normalized.length > 0 ? normalized : null;
}

function getReadToolOutput(activity: AiToolActivity): string | null {
    if (!isReadToolActivityKind(activity.kind) || !activity.rawOutputJson) {
        return null;
    }

    try {
        const parsed = parseJsonValue(activity.rawOutputJson);
        if (typeof parsed === "string") {
            return normalizeReadToolStringOutput(parsed);
        }

        if (parsed !== null && parsed !== undefined) {
            return JSON.stringify(parsed, null, 2);
        }
    } catch {
        return activity.rawOutputJson.trim().length > 0
            ? activity.rawOutputJson
            : null;
    }

    return null;
}

function getToolRawOutput(activity: AiToolActivity): string | null {
    if (!activity.rawOutputJson) {
        return null;
    }

    return getReadToolOutput(activity) ?? formatRawJson(activity.rawOutputJson);
}

function ToolDetailCodeBlock({
    accentBorder,
    backgroundColor,
    color,
    content,
    languageInfo,
    preserveLayout = false,
}: {
    readonly accentBorder?: string;
    readonly backgroundColor: string;
    readonly color: string;
    readonly content: string;
    readonly languageInfo?: string | null;
    readonly preserveLayout?: boolean;
}) {
    const languageSupport = useMarkdownCodeLanguageSupport(languageInfo);
    const isLongContent =
        content.length > TOOL_DETAIL_INITIAL_VISIBLE_CHARACTERS;
    const [visibleCharacterCount, setVisibleCharacterCount] = useState(
        () =>
            isLongContent
                ? TOOL_DETAIL_INITIAL_VISIBLE_CHARACTERS
                : content.length,
    );
    const visibleContent = isLongContent
        ? content.slice(0, visibleCharacterCount)
        : content;
    const hasHiddenContent = visibleContent.length < content.length;

    const copyFullContent = async () => {
        // The complete tool payload stays in session state; only its DOM window
        // is bounded, so full copy must never depend on what is currently shown.
        await window.comando?.writeClipboardText(content);
    };

    return (
        <div className="min-w-0">
            <pre
                className="max-h-48 select-text rounded px-2 py-1.5"
                style={{
                    backgroundColor,
                    border: accentBorder ?? "1px solid var(--color-border)",
                    color,
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "0.92em",
                    lineHeight: 1.4,
                    margin: 0,
                    overflowX: preserveLayout ? "auto" : "hidden",
                    overflowY: "auto",
                    overflowWrap: preserveLayout ? "normal" : "anywhere",
                    whiteSpace: preserveLayout ? "pre" : "pre-wrap",
                    wordBreak: preserveLayout ? "normal" : "break-word",
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
                        segmentKeyPrefix={`tool-activity:${languageInfo ?? "plain"}:${content.length}:${visibleContent.length}`}
                        text={visibleContent}
                    />
                </code>
            </pre>
            {isLongContent ? (
                <div className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
                    <span>
                        Showing {visibleContent.length.toLocaleString()} of{" "}
                        {content.length.toLocaleString()} characters
                    </span>
                    {hasHiddenContent ? (
                        <button
                            className="rounded px-1.5 py-0.5 hover:bg-bg-tertiary hover:text-text-primary"
                            onClick={() =>
                                setVisibleCharacterCount((current) =>
                                    Math.min(
                                        content.length,
                                        current +
                                            TOOL_DETAIL_VISIBLE_CHARACTER_PAGE,
                                    ),
                                )
                            }
                            type="button"
                        >
                            Show more
                        </button>
                    ) : null}
                    <button
                        className="rounded px-1.5 py-0.5 hover:bg-bg-tertiary hover:text-text-primary"
                        onClick={() => void copyFullContent()}
                        type="button"
                    >
                        Copy full output
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function ToolDetailSummary({
    accentBorder,
    backgroundColor,
    canRenderFileReference,
    content,
    onOpenFileReference,
    resolveFileReference,
}: {
    readonly accentBorder?: string;
    readonly backgroundColor: string;
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly content: string;
    readonly onOpenFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}) {
    return (
        <div
            className="select-text rounded px-2 py-1.5"
            style={{
                backgroundColor,
                border: accentBorder ?? "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
            }}
        >
            <MarkdownContent
                canRenderFileReference={canRenderFileReference}
                content={content}
                onOpenFile={onOpenFileReference}
                resolveFileReference={resolveFileReference}
            />
        </div>
    );
}

function StatusActivityItem({
    activity,
}: {
    readonly activity: AiToolActivity;
}) {
    const isFailed = activity.status === "failed";
    const isInProgress = activity.status === "in_progress";
    const isCompleted = activity.status === "completed";

    return (
        <div
            className="flex min-w-0 max-w-full select-none items-center gap-2 py-0.5"
            data-testid="status-activity-item"
            style={{
                color: isFailed
                    ? "#ef4444"
                    : "var(--color-text-secondary)",
                fontSize: "0.82em",
                opacity: isCompleted ? 0.72 : 0.88,
                transition: "opacity 0.2s ease",
            }}
        >
            <span className="shrink-0">
                <StatusIcon />
            </span>
            <span
                className="min-w-0 truncate"
                style={{ color: "var(--color-text-primary)" }}
            >
                {activity.title}
            </span>
            {activity.summary ? (
                <span className="min-w-0 flex-1 truncate opacity-75">
                    {activity.summary}
                </span>
            ) : (
                <span className="min-w-0 flex-1" />
            )}
            {isInProgress ? (
                <span
                    className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                    style={{ backgroundColor: "var(--color-accent)" }}
                />
            ) : null}
        </div>
    );
}

/* ─── File tool message (card style) ─── */

function FileToolMessage({
    activity,
    canRenderFileReference,
    fileIndex,
    onOpenFile,
    onOpenFileReference,
    onPayloadVisibilityChange,
    pendingTrackedFiles,
    projectId,
    resolveFileReference,
    worktreeId,
}: {
    readonly activity: AiToolActivity;
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly fileIndex?: ReadonlySet<string> | null;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onPayloadVisibilityChange?: ToolPayloadVisibilityChangeHandler;
    readonly pendingTrackedFiles: readonly AiTrackedFile[];
    readonly projectId: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly worktreeId: string | null;
}) {
    const isInProgress = activity.status === "in_progress";
    const isCompleted = activity.status === "completed";
    const accent = getToolAccent(activity.kind);
    const titleReference = getToolTitleReference(activity);
    const compactTitleTarget = titleReference
        ? compactToolTitleTarget(titleReference.displayTarget)
        : null;
    const titleIsLink =
        titleReference !== null &&
        canOpenToolFileReference({
            canRenderFileReference,
            fileIndex,
            projectId,
            resolveFileReference,
            target: titleReference.target,
        });
    const shouldOpenOnHeaderClick =
        titleReference !== null &&
        titleIsLink &&
        isPrimaryOpenFileTool(activity);
    const readOutput = getReadToolOutput(activity);
    const toolOutput = getToolRawOutput(activity);
    const toolOutputLanguageInfo = readOutput
        ? getToolLanguageInfoFromPath(
              titleReference?.target ??
                  activity.locations.find((location) => location.path)?.path ??
                  null,
          )
        : null;

    const hasDetail =
        (!!activity.summary && !toolOutput) ||
        !!toolOutput ||
        activity.locations.length > 0 ||
        activity.diffs.length > 0 ||
        pendingTrackedFiles.length > 0;
    const [expanded, setExpanded] = usePersistentToolExpansion(
        activity.id,
        false,
    );
    useReportToolPayloadVisibility(
        activity.id,
        expanded,
        onPayloadVisibilityChange,
    );
    const toggleExpanded = () => {
        if (!hasDetail) {
            return;
        }

        setExpanded((previous) => !previous);
    };
    const openTitleReference = () => {
        if (!titleReference || !titleIsLink) {
            return;
        }

        openToolFileReference({
            onOpenFile,
            onOpenFileReference,
            projectId,
            canRenderFileReference,
            fileIndex,
            resolveFileReference,
            target: titleReference.target,
            worktreeId,
        });
    };
    const handleHeaderClick = () => {
        if (shouldOpenOnHeaderClick) {
            openTitleReference();
            return;
        }

        toggleExpanded();
    };

    return (
        <div
            className="min-w-0 max-w-full select-none overflow-hidden rounded-lg"
            style={{
                backgroundColor: `color-mix(in srgb, ${accent} 4%, var(--color-bg-secondary))`,
                border: `1px solid color-mix(in srgb, ${accent} 25%, var(--color-border))`,
                opacity: isCompleted ? 0.72 : 1,
                transition: "opacity 0.2s ease",
            }}
        >
            <div
                aria-expanded={
                    hasDetail && !shouldOpenOnHeaderClick
                        ? expanded
                        : undefined
                }
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
                onClick={handleHeaderClick}
                onKeyDown={(event) => {
                    if (
                        event.target !== event.currentTarget ||
                        (!hasDetail && !shouldOpenOnHeaderClick) ||
                        (event.key !== "Enter" && event.key !== " ")
                    ) {
                        return;
                    }

                    event.preventDefault();
                    handleHeaderClick();
                }}
                role={
                    hasDetail || shouldOpenOnHeaderClick ? "button" : undefined
                }
                style={{
                    background: "none",
                    borderBottom: expanded
                        ? `1px solid color-mix(in srgb, ${accent} 15%, var(--color-border))`
                        : "1px solid transparent",
                    color: accent,
                    cursor:
                        shouldOpenOnHeaderClick ||
                        hasDetail ? "pointer" : "default",
                    fontSize: "0.83em",
                }}
                tabIndex={
                    hasDetail || shouldOpenOnHeaderClick ? 0 : undefined
                }
            >
                <span className="shrink-0">{getToolIcon(activity)}</span>
                <span
                    className="flex min-w-0 flex-1 items-baseline"
                    style={{
                        color: "var(--color-text-primary)",
                        fontWeight: 400,
                    }}
                >
                    {titleReference && titleIsLink ? (
                        <>
                            <span className="shrink-0 whitespace-pre">
                                {titleReference.prefix}
                            </span>
                            <button
                                className="app-no-drag min-w-0 truncate text-left"
                                onBlur={(event) => {
                                    event.currentTarget.style.textDecoration =
                                        "none";
                                }}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    openTitleReference();
                                }}
                                onFocus={(event) => {
                                    event.currentTarget.style.textDecoration =
                                        "underline";
                                }}
                                onMouseEnter={(event) => {
                                    event.currentTarget.style.textDecoration =
                                        "underline";
                                }}
                                onMouseLeave={(event) => {
                                    event.currentTarget.style.textDecoration =
                                        "none";
                                }}
                                style={{
                                    background: "none",
                                    border: "none",
                                    color: "inherit",
                                    cursor: "pointer",
                                    display: "block",
                                    font: "inherit",
                                    lineHeight: "inherit",
                                    margin: 0,
                                    minWidth: 0,
                                    overflow: "hidden",
                                    padding: 0,
                                    textDecoration: "none",
                                    textOverflow: "ellipsis",
                                    textUnderlineOffset: "2px",
                                    verticalAlign: "baseline",
                                    whiteSpace: "nowrap",
                                }}
                                title={`Open ${titleReference.target}`}
                                type="button"
                            >
                                {compactTitleTarget}
                            </button>
                        </>
                    ) : titleReference ? (
                        <>
                            <span className="shrink-0 whitespace-pre">
                                {titleReference.prefix}
                            </span>
                            <span
                                className="min-w-0 truncate"
                                title={titleReference.target}
                            >
                                {compactTitleTarget}
                            </span>
                        </>
                    ) : (
                        <span
                            className="min-w-0 truncate"
                            title={activity.title}
                        >
                            {activity.title}
                        </span>
                    )}
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
                    <button
                        aria-label={
                            expanded ? "Collapse details" : "Expand details"
                        }
                        className="app-no-drag shrink-0"
                        onClick={(event) => {
                            event.stopPropagation();
                            toggleExpanded();
                        }}
                        style={{
                            alignItems: "center",
                            background: "none",
                            border: "none",
                            color: "inherit",
                            cursor: "pointer",
                            display: "inline-flex",
                            margin: 0,
                            padding: 0,
                        }}
                        type="button"
                    >
                        <Chevron expanded={expanded} />
                    </button>
                ) : null}
            </div>

            {expanded ? (
                <div className="px-3 py-1.5" style={{ fontSize: "0.78em" }}>
                    {toolOutput ? (
                        <div className="mb-1">
                            <ToolDetailCodeBlock
                                accentBorder={`1px solid color-mix(in srgb, ${accent} 10%, var(--color-border))`}
                                backgroundColor={`color-mix(in srgb, ${accent} 4%, var(--color-bg-tertiary))`}
                                color="var(--color-text-secondary)"
                                content={toolOutput}
                                languageInfo={toolOutputLanguageInfo}
                                preserveLayout
                            />
                        </div>
                    ) : null}
                    {activity.summary && !toolOutput ? (
                        <div className="mb-1">
                            <ToolDetailSummary
                                accentBorder={`1px solid color-mix(in srgb, ${accent} 10%, var(--color-border))`}
                                backgroundColor={`color-mix(in srgb, ${accent} 4%, var(--color-bg-tertiary))`}
                                canRenderFileReference={
                                    canRenderFileReference
                                }
                                content={activity.summary}
                                onOpenFileReference={onOpenFileReference}
                                resolveFileReference={resolveFileReference}
                            />
                        </div>
                    ) : null}
                    {activity.locations.length > 0 ? (
                        <div className="mb-1 flex flex-wrap gap-1">
                            {activity.locations.map((loc) => {
                                const target = formatToolLocationReference(loc);
                                const locationIsOpenable =
                                    canOpenToolFileReference({
                                        canRenderFileReference,
                                        fileIndex,
                                        projectId,
                                        resolveFileReference,
                                        target,
                                    });

                                return (
                                    <button
                                        className="app-no-drag rounded-md px-2 py-0.5"
                                        disabled={!locationIsOpenable}
                                        key={target}
                                        onClick={() => {
                                            if (!locationIsOpenable) {
                                                return;
                                            }
                                            openToolFileReference({
                                                canRenderFileReference,
                                                fileIndex,
                                                onOpenFile,
                                                onOpenFileReference,
                                                projectId,
                                                resolveFileReference,
                                                target,
                                                worktreeId,
                                            });
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
                                            e.currentTarget.style.filter =
                                                "none";
                                        }}
                                        style={{
                                            backgroundColor:
                                                "var(--color-bg-tertiary)",
                                            border: "1px solid var(--color-border)",
                                            color: "var(--color-text-secondary)",
                                            cursor: locationIsOpenable
                                                ? "pointer"
                                                : "default",
                                            fontSize: "0.9em",
                                            opacity: locationIsOpenable
                                                ? 1
                                                : 0.62,
                                            transition:
                                                "background-color 100ms ease, filter 100ms ease",
                                        }}
                                        type="button"
                                    >
                                        {target}
                                    </button>
                                );
                            })}
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
                                      fontSize: `${FIXED_PENDING_REVIEW_CARD_TEXT_ZOOM}em`,
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

function parseJsonValue(raw: string): unknown {
    return JSON.parse(raw) as unknown;
}

function isCommandDuplicatedByTitle(title: string, command: string): boolean {
    const normalizedTitle = title.trim();
    const normalizedCommand = command.trim();

    return (
        normalizedTitle === normalizedCommand ||
        normalizedTitle === `Run ${normalizedCommand}`
    );
}

type TerminalToolTone = "neutral" | "success" | "danger";

function getTerminalToolTone(activity: AiToolActivity): TerminalToolTone {
    if (
        activity.status === "failed" ||
        (activity.exitCode !== null && activity.exitCode !== 0)
    ) {
        return "danger";
    }

    if (activity.status === "completed" && activity.exitCode === 0) {
        return "success";
    }

    return "neutral";
}

function getTerminalToolToneColor(tone: TerminalToolTone): string {
    if (tone === "danger") {
        return "#ef4444";
    }

    if (tone === "success") {
        return "var(--diff-add)";
    }

    return "#6b7280";
}

function TerminalToolMessage({
    activity,
    compactByDefault,
    onPayloadVisibilityChange,
}: {
    readonly activity: AiToolActivity;
    readonly compactByDefault: boolean;
    readonly onPayloadVisibilityChange?: ToolPayloadVisibilityChangeHandler;
}) {
    const isInProgress = activity.status === "in_progress";
    const isCompleted = activity.status === "completed";

    const terminalTone = getTerminalToolTone(activity);
    const isDangerTone = terminalTone === "danger";
    const accent = getTerminalToolToneColor(terminalTone);
    const command = getStructuredToolCommand(activity);
    const shouldShowCommand =
        !!command && !isCommandDuplicatedByTitle(activity.title, command);
    const hasTerminalOutput = !!activity.terminalOutput;
    const hasDetail = shouldShowCommand || hasTerminalOutput;
    const [expanded, setExpanded] = usePersistentToolExpansion(
        `${activity.id}:terminal`,
        !compactByDefault && isDangerTone && hasTerminalOutput,
    );
    useReportToolPayloadVisibility(
        activity.id,
        expanded,
        onPayloadVisibilityChange,
    );
    const failureLabel = isDangerTone
        ? activity.exitCode !== null && activity.exitCode !== 0
            ? `exit ${activity.exitCode}`
            : "Failed"
        : null;

    return (
        <div
            className="min-w-0 max-w-full select-none"
            data-terminal-activity-surface="rail-row"
            style={{
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-mono), ui-monospace, monospace",
                fontSize: "0.82em",
                opacity: isCompleted ? 0.72 : 1,
                transition: "opacity 0.2s ease",
            }}
        >
            <div className="flex min-h-7 w-full min-w-0 items-center gap-2">
                <span
                    aria-hidden="true"
                    className="shrink-0"
                    style={{ color: accent }}
                >
                    <ExecuteIcon />
                </span>
                <span
                    className="min-w-0 flex-1 truncate"
                    style={{
                        color: "var(--color-text-primary)",
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
                {failureLabel ? (
                    <span
                        className="shrink-0 text-[10px] font-medium"
                        style={{ color: accent }}
                    >
                        {failureLabel}
                    </span>
                ) : null}
                {hasDetail ? (
                    <button
                        aria-label={
                            expanded
                                ? "Collapse terminal output"
                                : "Expand terminal output"
                        }
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--color-accent)]"
                        onClick={() => setExpanded(!expanded)}
                        type="button"
                    >
                        <Chevron expanded={expanded} variant="disclosure" />
                    </button>
                ) : null}
            </div>

            {expanded && hasDetail ? (
                <div
                    className="ml-5 mt-1 space-y-1 overflow-hidden border-l border-border pl-2"
                    style={{ fontSize: "0.78em" }}
                >
                    {activity.terminalOutput ? (
                        <ToolDetailCodeBlock
                            accentBorder="none"
                            backgroundColor="transparent"
                            color={
                                isDangerTone
                                    ? "#ef4444"
                                    : "var(--color-text-secondary)"
                            }
                            content={activity.terminalOutput}
                            languageInfo={command ? "shell" : null}
                        />
                    ) : null}
                    {shouldShowCommand ? (
                        <ToolDetailCodeBlock
                            accentBorder="none"
                            backgroundColor="transparent"
                            color="var(--color-text-primary)"
                            content={command}
                            languageInfo="shell"
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

function getOpenSessionActionLabel(
    activity: AiToolActivity,
    targetSessionTitle: string | null,
): string {
    const name =
        targetSessionTitle?.trim() ||
        activity.title
            .replace(/^(spawned|started|opened)\s+/i, "")
            .trim();
    return name.length > 0 && name.length <= 28 ? `Open ${name}` : "Open";
}

function getOpenSessionActionTitle(
    activity: AiToolActivity,
    targetSessionTitle: string | null,
): string {
    const label = getOpenSessionActionLabel(activity, targetSessionTitle);
    return label === "Open" ? "Open session" : label;
}

function GenericToolMessage({
    activity,
    canRenderFileReference,
    onOpenFileReference,
    onOpenSession,
    onPayloadVisibilityChange,
    openSessionTitle,
    resolveFileReference,
}: {
    readonly activity: AiToolActivity;
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly onOpenFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly onPayloadVisibilityChange?: ToolPayloadVisibilityChangeHandler;
    readonly openSessionTitle: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}) {
    const isFailed = activity.status === "failed";
    const [expanded, setExpanded] = usePersistentToolExpansion(
        `${activity.id}:generic`,
        isFailed,
    );
    useReportToolPayloadVisibility(
        activity.id,
        expanded,
        onPayloadVisibilityChange,
    );
    const isInProgress = activity.status === "in_progress";
    const isCompleted = activity.status === "completed";
    const rawInputJson = activity.rawInputJson;
    const rawOutputJson = activity.rawOutputJson;
    const openSessionAction =
        activity.action?.kind === "open_session" ? activity.action : null;
    const hasRawInput = rawInputJson !== null;
    const hasRawOutput = rawOutputJson !== null;
    const hasDetail = !!activity.summary || hasRawInput || hasRawOutput;

    return (
        <div
            className="min-w-0 max-w-full select-none"
            style={{
                color: isFailed ? "#ef4444" : "var(--color-text-secondary)",
                fontSize: "0.85em",
                opacity: isCompleted ? 0.72 : 0.88,
                transition: "opacity 0.2s ease",
            }}
        >
            <div className="flex w-full items-center gap-2">
                <button
                    className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
                    onClick={() => hasDetail && setExpanded(!expanded)}
                    style={{
                        background: "none",
                        border: "none",
                        color: "inherit",
                        cursor: hasDetail ? "pointer" : "default",
                    }}
                    type="button"
                >
                    <span className="shrink-0">
                        {getToolIcon(activity)}
                    </span>
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
                {openSessionAction && onOpenSession ? (
                    <button
                        className="app-no-drag shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                        onClick={() =>
                            void onOpenSession(openSessionAction.sessionId)
                        }
                        title={getOpenSessionActionTitle(
                            activity,
                            openSessionTitle,
                        )}
                        type="button"
                    >
                        {getOpenSessionActionLabel(
                            activity,
                            openSessionTitle,
                        )}
                    </button>
                ) : null}
            </div>

            {expanded ? (
                <div className="mt-1 space-y-1" style={{ fontSize: "0.82em" }}>
                    {activity.summary ? (
                        <ToolDetailSummary
                            backgroundColor="var(--color-bg-tertiary)"
                            canRenderFileReference={
                                canRenderFileReference
                            }
                            content={activity.summary}
                            onOpenFileReference={onOpenFileReference}
                            resolveFileReference={resolveFileReference}
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

export type ToolActivitySurface = "card" | "rail-row";

function getCompactActivityStatus(
    activity: AiToolActivity,
    category: ReturnType<typeof getToolActivityDescriptor>["category"],
): string | null {
    if (activity.status === "pending") {
        return "Queued";
    }
    if (activity.status === "in_progress") {
        return "Running";
    }
    if (
        category === "command" &&
        activity.status === "completed" &&
        activity.exitCode === 0
    ) {
        return "Done";
    }
    return null;
}

export function shouldShowCompactActivitySummary(
    summary: string | null,
    category: ReturnType<typeof getToolActivityDescriptor>["category"],
    hasTerminalOutput: boolean,
): boolean {
    if (summary === null) {
        return false;
    }

    return !(
        category === "command" &&
        hasTerminalOutput &&
        summary.trim().toLocaleLowerCase() === "terminal output available."
    );
}

function CompactToolActivityRow({
    activity,
    canRenderFileReference,
    fileIndex,
    onOpenFile,
    onOpenFileReference,
    onOpenSession,
    onPayloadVisibilityChange,
    openSessionTitle,
    projectId,
    resolveFileReference,
    trackedFiles,
    worktreeId,
}: {
    readonly activity: AiToolActivity;
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly fileIndex: ReadonlySet<string> | null;
    readonly onOpenFile: ToolActivityItemProps["onOpenFile"];
    readonly onOpenFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly onPayloadVisibilityChange?: ToolPayloadVisibilityChangeHandler;
    readonly openSessionTitle: string | null;
    readonly projectId: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly trackedFiles: readonly AiTrackedFile[];
    readonly worktreeId: string | null;
}) {
    const descriptor = getToolActivityDescriptor(activity);
    const rawTarget =
        descriptor.category === "file" ? descriptor.target : null;
    const canOpenReference =
        rawTarget !== null &&
        canOpenToolFileReference({
            canRenderFileReference,
            fileIndex,
            projectId,
            resolveFileReference,
            target: rawTarget,
        });
    const displayTarget =
        descriptor.target &&
        !activity.title
            .toLocaleLowerCase()
            .includes(descriptor.target.toLocaleLowerCase())
            ? descriptor.target
            : null;
    const hasRawInput = activity.rawInputJson !== null;
    const hasRawOutput = activity.rawOutputJson !== null;
    const hasTerminalOutput = activity.terminalOutput !== null;
    const shouldShowSummary = shouldShowCompactActivitySummary(
        activity.summary,
        descriptor.category,
        hasTerminalOutput,
    );
    const hasLocations = activity.locations.length > 0;
    const hasInlineReview =
        trackedFiles.length > 0 || activity.diffs.length > 0;
    const hasDetail =
        shouldShowSummary ||
        hasLocations ||
        hasRawInput ||
        hasRawOutput ||
        hasTerminalOutput ||
        hasInlineReview;
    const [expanded, setExpanded] = usePersistentToolExpansion(
        `${activity.sessionId}:${activity.id}:rail-row`,
        false,
    );
    useReportToolPayloadVisibility(
        activity.id,
        expanded,
        onPayloadVisibilityChange,
    );
    const detailId = `${activity.sessionId}:${activity.id}:rail-row-details`;
    const status = getCompactActivityStatus(activity, descriptor.category);
    const openSessionAction =
        activity.action?.kind === "open_session" ? activity.action : null;

    return (
        <div
            className="min-w-0 max-w-full select-none text-text-secondary"
            data-tool-activity-surface="rail-row"
            style={{
                fontSize: "0.82em",
                opacity: activity.status === "completed" ? 0.74 : 0.92,
            }}
        >
            <div className="flex min-h-7 w-full items-center gap-2">
                <span className="shrink-0 opacity-75" aria-hidden="true">
                    {getToolIcon(activity)}
                </span>
                {canOpenReference && rawTarget ? (
                    <button
                        className="flex min-w-0 flex-1 items-center gap-2 text-left text-text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--color-accent)]"
                        onClick={() =>
                            openToolFileReference({
                                canRenderFileReference,
                                fileIndex,
                                onOpenFile,
                                onOpenFileReference,
                                projectId,
                                resolveFileReference,
                                target: rawTarget,
                                worktreeId,
                            })
                        }
                        title={rawTarget ?? activity.title}
                        type="button"
                    >
                        <span className="min-w-0 truncate">
                            {activity.title}
                        </span>
                        {displayTarget ? (
                            <span className="min-w-0 truncate font-mono text-[10px] text-text-secondary">
                                {displayTarget}
                            </span>
                        ) : null}
                    </button>
                ) : (
                    <span
                        className="flex min-w-0 flex-1 items-center gap-2 text-text-primary"
                        title={activity.title}
                    >
                        <span className="min-w-0 truncate">
                            {activity.title}
                        </span>
                        {displayTarget ? (
                            <span className="min-w-0 truncate font-mono text-[10px] text-text-secondary">
                                {displayTarget}
                            </span>
                        ) : null}
                    </span>
                )}
                {status ? (
                    <span className="shrink-0 text-[10px] font-medium text-text-secondary">
                        {status}
                    </span>
                ) : null}
                {openSessionAction && onOpenSession ? (
                    <button
                        className="app-no-drag shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                        onClick={() =>
                            void onOpenSession(openSessionAction.sessionId)
                        }
                        title={getOpenSessionActionTitle(
                            activity,
                            openSessionTitle,
                        )}
                        type="button"
                    >
                        {getOpenSessionActionLabel(activity, openSessionTitle)}
                    </button>
                ) : null}
                {hasDetail ? (
                    <button
                        aria-controls={detailId}
                        aria-expanded={expanded}
                        aria-label={
                            expanded ? "Collapse details" : "Expand details"
                        }
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--color-accent)]"
                        onClick={() => setExpanded((current) => !current)}
                        type="button"
                    >
                        <Chevron expanded={expanded} />
                    </button>
                ) : null}
            </div>

            {expanded ? (
                <div
                    aria-label={`${activity.title} details`}
                    className="mb-1 ml-5 space-y-1"
                    id={detailId}
                    role="region"
                >
                    {shouldShowSummary && activity.summary ? (
                        <ToolDetailSummary
                            backgroundColor="var(--color-bg-tertiary)"
                            canRenderFileReference={canRenderFileReference}
                            content={activity.summary}
                            onOpenFileReference={onOpenFileReference}
                            resolveFileReference={resolveFileReference}
                        />
                    ) : null}
                    {hasLocations ? (
                        <div className="flex flex-wrap gap-1">
                            {activity.locations.map((location) => {
                                const target =
                                    formatToolLocationReference(location);
                                const canOpen = canOpenToolFileReference({
                                    canRenderFileReference,
                                    fileIndex,
                                    projectId,
                                    resolveFileReference,
                                    target,
                                });

                                return (
                                    <button
                                        className="app-no-drag rounded-md px-2 py-0.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-default disabled:opacity-60"
                                        disabled={!canOpen}
                                        key={target}
                                        onClick={() => {
                                            if (canOpen) {
                                                openToolFileReference({
                                                    canRenderFileReference,
                                                    fileIndex,
                                                    onOpenFile,
                                                    onOpenFileReference,
                                                    projectId,
                                                    resolveFileReference,
                                                    target,
                                                    worktreeId,
                                                });
                                            }
                                        }}
                                        type="button"
                                    >
                                        {target}
                                    </button>
                                );
                            })}
                        </div>
                    ) : null}
                    {activity.terminalOutput ? (
                        <ToolDetailCodeBlock
                            backgroundColor="var(--color-bg-tertiary)"
                            color="var(--color-text-secondary)"
                            content={activity.terminalOutput}
                            languageInfo={
                                descriptor.category === "command"
                                    ? "shell"
                                    : null
                            }
                        />
                    ) : null}
                    {hasRawInput ? (
                        <ToolDetailCodeBlock
                            backgroundColor="var(--color-bg-tertiary)"
                            color="var(--color-text-secondary)"
                            content={formatRawJson(activity.rawInputJson ?? "")}
                            languageInfo="json"
                        />
                    ) : null}
                    {hasRawOutput && !hasTerminalOutput ? (
                        <ToolDetailCodeBlock
                            backgroundColor="var(--color-bg-tertiary)"
                            color="var(--color-text-secondary)"
                            content={formatRawJson(activity.rawOutputJson ?? "")}
                            languageInfo="json"
                        />
                    ) : null}
                    {hasInlineReview ? (
                        <ChangeReviewPanel
                            activity={activity}
                            onOpenFile={onOpenFile}
                            projectId={projectId}
                            resolveFileReference={resolveFileReference}
                            trackedFiles={trackedFiles}
                            worktreeId={worktreeId}
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

export interface ToolActivityItemProps {
    readonly activity: AiToolActivity;
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly compactTerminal?: boolean;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly onPayloadVisibilityChange?: ToolPayloadVisibilityChangeHandler;
    readonly trackedFiles?: readonly AiTrackedFile[];
    readonly projectId: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly surface?: ToolActivitySurface;
    readonly worktreeId?: string | null;
}

export const ToolActivityItem = memo(function ToolActivityItem({
    activity,
    canRenderFileReference: canRenderFileReferenceOverride,
    compactTerminal = false,
    onOpenFile,
    onOpenFileReference,
    onOpenSession,
    onPayloadVisibilityChange,
    trackedFiles = [],
    projectId,
    resolveFileReference,
    surface = "card",
    worktreeId = null,
}: ToolActivityItemProps) {
    const hydrateToolActivityDetail = useAiStore(
        (state) => state.hydrateToolActivityDetail,
    );
    useEffect(() => {
        if (!activity.toolActivityDetailId) {
            return;
        }
        void hydrateToolActivityDetail(activity.sessionId, activity.id);
    }, [
        activity.id,
        activity.sessionId,
        activity.status,
        activity.toolActivityDetailId,
        hydrateToolActivityDetail,
    ]);
    const pendingTrackedFiles = trackedFiles.filter(
        isAiTrackedFileUnresolved,
    );
    const hasInlineReview = trackedFiles.length > 0 || activity.diffs.length > 0;
    const hasPendingChangeReview =
        isEditedFileToolActivity(activity, trackedFiles) &&
        (activity.status === "in_progress" || activity.status === "pending");

    // Validate file references in tool summaries against the real project file
    // index so only existing files become clickable pills (mirrors chat
    // messages). Derived here since this is where project context lives.
    const projectCanRenderFileReference = useFileReferenceValidator(
        projectId,
        worktreeId ?? null,
    );
    const canRenderFileReference =
        canRenderFileReferenceOverride ?? projectCanRenderFileReference;
    const fileIndex = useProjectFileIndex(projectId, worktreeId ?? null);
    const openSessionId =
        activity.action?.kind === "open_session"
            ? activity.action.sessionId
            : null;
    const openSessionTitle = useAiStore((state) => {
        if (!openSessionId) return null;
        const targetSession = state.sessions[openSessionId];
        return (
            targetSession?.snapshot?.title ??
            targetSession?.meta?.title ??
            null
        );
    });

    useRenderProbe("ToolActivityItem", {
        activityId: activity.id,
        diffs: activity.diffs.length,
        hasInlineReview,
        pendingTrackedFiles: pendingTrackedFiles.length,
        trackedFiles: trackedFiles.length,
    });

    if (isTurnStartedActivity(activity)) {
        return null;
    }

    if (isStatusToolActivity(activity)) {
        return <StatusActivityItem activity={activity} />;
    }

    if (surface === "rail-row") {
        return (
            <CompactToolActivityRow
                activity={activity}
                canRenderFileReference={canRenderFileReference}
                fileIndex={fileIndex}
                onOpenFile={onOpenFile}
                onOpenFileReference={onOpenFileReference}
                onOpenSession={onOpenSession}
                onPayloadVisibilityChange={onPayloadVisibilityChange}
                openSessionTitle={openSessionTitle}
                projectId={projectId}
                resolveFileReference={resolveFileReference}
                trackedFiles={trackedFiles}
                worktreeId={worktreeId}
            />
        );
    }

    if (isFileToolActivity(activity, trackedFiles)) {
        if (hasInlineReview || hasPendingChangeReview) {
            const reviewPanel = (
                <VisibleToolPayload
                    activityId={activity.id}
                    onVisibilityChange={onPayloadVisibilityChange}
                >
                    <ChangeReviewPanel
                        activity={activity}
                        onOpenFile={onOpenFile}
                        projectId={projectId}
                        resolveFileReference={resolveFileReference}
                        trackedFiles={trackedFiles}
                        worktreeId={worktreeId}
                    />
                </VisibleToolPayload>
            );

            if (isTerminalToolActivity(activity)) {
                return (
                    <div className="min-w-0 space-y-2">
                        <TerminalToolMessage
                            activity={activity}
                            compactByDefault={compactTerminal}
                            onPayloadVisibilityChange={onPayloadVisibilityChange}
                        />
                        {reviewPanel}
                    </div>
                );
            }

            return reviewPanel;
        }

        if (isTerminalToolActivity(activity)) {
            return (
                <TerminalToolMessage
                    activity={activity}
                    compactByDefault={compactTerminal}
                    onPayloadVisibilityChange={onPayloadVisibilityChange}
                />
            );
        }

        return (
            <FileToolMessage
                activity={activity}
                canRenderFileReference={canRenderFileReference}
                fileIndex={fileIndex}
                onOpenFile={onOpenFile}
                onOpenFileReference={onOpenFileReference}
                onPayloadVisibilityChange={onPayloadVisibilityChange}
                pendingTrackedFiles={pendingTrackedFiles}
                projectId={projectId}
                resolveFileReference={resolveFileReference}
                worktreeId={worktreeId}
            />
        );
    }

    if (isTerminalToolActivity(activity)) {
        return (
            <TerminalToolMessage
                activity={activity}
                compactByDefault={compactTerminal}
                onPayloadVisibilityChange={onPayloadVisibilityChange}
            />
        );
    }

    return (
        <GenericToolMessage
            activity={activity}
            canRenderFileReference={canRenderFileReference}
            onOpenFileReference={onOpenFileReference}
            onOpenSession={onOpenSession}
            onPayloadVisibilityChange={onPayloadVisibilityChange}
            openSessionTitle={openSessionTitle}
            resolveFileReference={resolveFileReference}
        />
    );
}, areToolActivityItemPropsEqual);

ToolActivityItem.displayName = "ToolActivityItem";

function areToolActivityItemPropsEqual(
    previous: Readonly<ToolActivityItemProps>,
    next: Readonly<ToolActivityItemProps>,
) {
    return (
        previous.activity === next.activity &&
        previous.canRenderFileReference === next.canRenderFileReference &&
        previous.compactTerminal === next.compactTerminal &&
        previous.onOpenFile === next.onOpenFile &&
        previous.onOpenFileReference === next.onOpenFileReference &&
        previous.onOpenSession === next.onOpenSession &&
        previous.onPayloadVisibilityChange === next.onPayloadVisibilityChange &&
        previous.projectId === next.projectId &&
        previous.resolveFileReference === next.resolveFileReference &&
        previous.surface === next.surface &&
        previous.trackedFiles === next.trackedFiles &&
        previous.worktreeId === next.worktreeId
    );
}
