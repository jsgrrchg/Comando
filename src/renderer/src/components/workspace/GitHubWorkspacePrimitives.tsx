import {
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from "react";

import type {
    GitHubAuthStatus,
    GitHubCommentSummary,
    GitHubLabelSummary,
    GitHubPullRequestChecksState,
    GitHubRepositoryRef,
    GitHubUserSummary,
} from "@shared/ipc";

import { openExternalUrl } from "@renderer/app/utils/external-url";
import {
    usePersistedWorkspaceScroll,
    type WorkspaceScrollScope,
} from "@renderer/components/workspace/usePersistedWorkspaceScroll";
import { MarkdownContent } from "./MarkdownContent";
import {
    IdeActionButton,
    IdeBarDotSeparator,
    IdeBarHeader,
    IdeBarLabel,
    IdeBarSearchIcon,
} from "./ide-bar";

export type GitHubAuthCapability = "issues" | "pull_requests";

export type GitHubMergeableState = "computing" | "conflicts" | "mergeable";

export function GitHubTabShell({
    children,
    header,
    scrollScope,
}: {
    readonly children: ReactNode;
    readonly header: ReactNode;
    readonly scrollScope: WorkspaceScrollScope;
}) {
    const { handleScroll, scrollRef } =
        usePersistedWorkspaceScroll<HTMLDivElement>(scrollScope);

    return (
        <div className="flex h-full min-h-0 flex-col bg-editor text-text-primary">
            {header}
            <div
                className="shell-scrollbar min-h-0 flex-1 overflow-y-auto"
                onScroll={handleScroll}
                ref={scrollRef}
            >
                {children}
            </div>
        </div>
    );
}

export function GitHubTabHeader({
    actions,
    count,
    meta,
    repo,
    title,
}: {
    readonly actions?: ReactNode;
    readonly count?: number | null;
    readonly meta?: ReactNode;
    readonly repo: GitHubRepositoryRef;
    readonly title: string;
}) {
    return (
        <IdeBarHeader className="select-none">
            <IdeBarLabel>{title}</IdeBarLabel>
            {count != null ? (
                <>
                    <IdeBarDotSeparator />
                    <span className="text-[10px] text-text-secondary">
                        {count} {count === 1 ? "item" : "items"}
                    </span>
                </>
            ) : null}
            <IdeBarDotSeparator />
            <span className="min-w-0 truncate text-[10px] text-text-secondary">
                {repo.owner}/{repo.repo}
            </span>
            {meta}
            <div className="ml-auto flex items-center gap-1">{actions}</div>
        </IdeBarHeader>
    );
}

export function GitHubSearchBox({
    onChange,
    placeholder,
    value,
}: {
    readonly onChange: (value: string) => void;
    readonly placeholder: string;
    readonly value: string;
}) {
    return (
        <div className="relative min-w-[180px] flex-1">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary">
                <IdeBarSearchIcon />
            </span>
            <input
                className="h-[22px] w-full rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary pl-6 pr-2 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                onChange={(event) => onChange(event.currentTarget.value)}
                placeholder={placeholder}
                value={value}
            />
        </div>
    );
}

export function GitHubFilterButton({
    active,
    children,
    onClick,
}: {
    readonly active?: boolean;
    readonly children: ReactNode;
    readonly onClick: () => void;
}) {
    return (
        <IdeActionButton active={active} onClick={onClick}>
            {children}
        </IdeActionButton>
    );
}

export function GitHubStatePill({
    children,
    tone,
}: {
    readonly children: ReactNode;
    readonly tone: "closed" | "draft" | "merged" | "neutral" | "open";
}) {
    const colors: Record<typeof tone, string> = {
        closed:
            "border-[color-mix(in_srgb,var(--diff-remove)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-remove)_8%,transparent)] text-[color-mix(in_srgb,var(--diff-remove)_84%,var(--color-text-primary))]",
        draft: "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-tertiary text-text-secondary",
        merged:
            "border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-text-primary",
        neutral:
            "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-tertiary text-text-secondary",
        open: "border-[color-mix(in_srgb,var(--diff-add)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-add)_8%,transparent)] text-[color-mix(in_srgb,var(--diff-add)_78%,var(--color-text-primary))]",
    };

    return (
        <span
            className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium ${colors[tone]}`}
        >
            {children}
        </span>
    );
}

export function GitHubChecksPill({
    state,
}: {
    readonly state: GitHubPullRequestChecksState | "loading";
}) {
    const colors: Record<typeof state, string> = {
        failure:
            "border-[color-mix(in_srgb,var(--diff-remove)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-remove)_8%,transparent)] text-[color-mix(in_srgb,var(--diff-remove)_84%,var(--color-text-primary))]",
        loading:
            "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-tertiary text-text-secondary",
        pending:
            "border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-text-primary",
        success:
            "border-[color-mix(in_srgb,var(--diff-add)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-add)_8%,transparent)] text-[color-mix(in_srgb,var(--diff-add)_78%,var(--color-text-primary))]",
        unknown:
            "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-tertiary text-text-secondary",
    };
    const label: Record<typeof state, string> = {
        failure: "checks failed",
        loading: "checks...",
        pending: "checks pending",
        success: "checks passing",
        unknown: "checks unknown",
    };

    return (
        <span
            className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium ${colors[state]}`}
        >
            {label[state]}
        </span>
    );
}

export function GitHubMergeablePill({
    state,
}: {
    readonly state: GitHubMergeableState;
}) {
    const colors: Record<GitHubMergeableState, string> = {
        computing:
            "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-tertiary text-text-secondary",
        conflicts:
            "border-[color-mix(in_srgb,var(--diff-remove)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-remove)_8%,transparent)] text-[color-mix(in_srgb,var(--diff-remove)_84%,var(--color-text-primary))]",
        mergeable:
            "border-[color-mix(in_srgb,var(--diff-add)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-add)_8%,transparent)] text-[color-mix(in_srgb,var(--diff-add)_78%,var(--color-text-primary))]",
    };
    const label: Record<GitHubMergeableState, string> = {
        computing: "checking mergeability",
        conflicts: "conflicts",
        mergeable: "no conflicts",
    };

    return (
        <span
            className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium ${colors[state]}`}
        >
            {label[state]}
        </span>
    );
}

export function deriveGitHubMergeableState(
    mergeable: boolean | null | undefined,
): GitHubMergeableState {
    if (mergeable === true) {
        return "mergeable";
    }
    if (mergeable === false) {
        return "conflicts";
    }
    return "computing";
}

export function GitHubInput({
    disabled,
    onChange,
    placeholder,
    value,
}: {
    readonly disabled?: boolean;
    readonly onChange: (value: string) => void;
    readonly placeholder: string;
    readonly value: string;
}) {
    return (
        <input
            className="h-[22px] w-full rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-2 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.value)}
            placeholder={placeholder}
            value={value}
        />
    );
}

export function GitHubConfirmActionButton({
    armedLabel = "Click again to confirm",
    children,
    disabled,
    onConfirm,
    title,
}: {
    readonly armedLabel?: string;
    readonly children: ReactNode;
    readonly disabled?: boolean;
    readonly onConfirm: () => void;
    readonly title?: string;
}) {
    const [armed, setArmed] = useState(false);

    useEffect(() => {
        if (disabled && armed) {
            let cancelled = false;
            queueMicrotask(() => {
                if (!cancelled) {
                    setArmed(false);
                }
            });
            return () => {
                cancelled = true;
            };
        }
    }, [armed, disabled]);

    const handleClick = () => {
        if (!armed) {
            setArmed(true);
            return;
        }
        setArmed(false);
        onConfirm();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === "Escape" && armed) {
            event.preventDefault();
            setArmed(false);
        }
    };

    return (
        <span aria-live="polite">
            <button
                className="review-action-btn"
                disabled={disabled}
                onBlur={() => setArmed(false)}
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                style={{
                    background: armed
                        ? "color-mix(in srgb, var(--color-accent) 18%, transparent)"
                        : "transparent",
                    border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                    borderRadius: 3,
                    color: armed
                        ? "var(--color-text-primary)"
                        : "var(--color-text-secondary)",
                    cursor: disabled ? "not-allowed" : "pointer",
                    fontSize: "10px",
                    fontWeight: 500,
                    lineHeight: "20px",
                    opacity: disabled ? 0.4 : 1,
                    padding: "0 8px",
                }}
                title={title}
                type="button"
            >
                {armed ? armedLabel : children}
            </button>
        </span>
    );
}

export function GitHubLabelPill({
    className,
    label,
}: {
    readonly className?: string;
    readonly label: GitHubLabelSummary;
}) {
    return (
        <span
            className={[
                "inline-flex max-w-[140px] items-center rounded-md border px-1.5 py-0.5 text-[9.5px] font-medium",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
            style={{
                backgroundColor: `color-mix(in srgb, #${label.color} 10%, transparent)`,
                borderColor: `color-mix(in srgb, #${label.color} 30%, var(--color-border))`,
                color: "var(--color-text-primary)",
            }}
            title={label.description ?? label.name}
        >
            <span className="truncate">{label.name}</span>
        </span>
    );
}

export function GitHubUsers({
    users,
}: {
    readonly users: readonly GitHubUserSummary[];
}) {
    if (users.length === 0) {
        return <span className="text-text-secondary">Unassigned</span>;
    }

    return (
        <div className="flex min-w-0 items-center gap-1">
            {users.slice(0, 3).map((user) => (
                <span
                    className="inline-flex h-5 w-5 items-center justify-center overflow-hidden rounded-full border border-border bg-bg-tertiary text-[9px] font-semibold"
                    key={user.id}
                    title={user.login}
                >
                    {user.avatarUrl ? (
                        <img
                            alt=""
                            className="h-full w-full object-cover"
                            src={user.avatarUrl}
                        />
                    ) : (
                        user.login.slice(0, 2).toUpperCase()
                    )}
                </span>
            ))}
            {users.length > 3 ? (
                <span className="text-[10px] text-text-secondary">
                    +{users.length - 3}
                </span>
            ) : null}
        </div>
    );
}

export function GitHubCommentList({
    canEdit = false,
    comments,
    getUpdateError,
    isUpdatingComment,
    onUpdateComment,
    permissionLabel,
}: {
    readonly canEdit?: boolean;
    readonly comments: readonly GitHubCommentSummary[];
    readonly getUpdateError?: (comment: GitHubCommentSummary) => string | null;
    readonly isUpdatingComment?: (comment: GitHubCommentSummary) => boolean;
    readonly onUpdateComment?: (
        comment: GitHubCommentSummary,
        body: string,
    ) => Promise<void> | void;
    readonly permissionLabel?: string;
}) {
    const [copiedCommentId, setCopiedCommentId] = useState<string | null>(null);
    const [editingCommentId, setEditingCommentId] = useState<number | null>(
        null,
    );
    const [commentDraft, setCommentDraft] = useState("");
    const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    );

    useEffect(() => {
        return () => {
            if (copyResetTimeoutRef.current) {
                clearTimeout(copyResetTimeoutRef.current);
            }
        };
    }, []);

    const handleCopyComment = async (commentId: string, body: string) => {
        await navigator.clipboard.writeText(body);
        setCopiedCommentId(commentId);

        if (copyResetTimeoutRef.current) {
            clearTimeout(copyResetTimeoutRef.current);
        }
        copyResetTimeoutRef.current = setTimeout(() => {
            setCopiedCommentId(null);
            copyResetTimeoutRef.current = null;
        }, 1600);
    };

    const handleStartEditingComment = (comment: GitHubCommentSummary) => {
        if (!canEdit || !onUpdateComment) {
            return;
        }

        setEditingCommentId(comment.id);
        setCommentDraft(comment.body);
    };

    const handleCancelEditingComment = () => {
        setEditingCommentId(null);
        setCommentDraft("");
    };

    const handleSaveComment = async (comment: GitHubCommentSummary) => {
        if (!canEdit || !onUpdateComment || !commentDraft.trim()) {
            return;
        }

        await onUpdateComment(comment, commentDraft);
        setEditingCommentId(null);
        setCommentDraft("");
    };

    if (comments.length === 0) {
        return (
            <GitHubEmptyState>
                No comments yet. Start the thread from the composer below.
            </GitHubEmptyState>
        );
    }

    return (
        <div className="space-y-3">
            {comments.map((comment) => {
                const commentId = String(comment.id);
                const isCopied = copiedCommentId === commentId;
                const isEditing = editingCommentId === comment.id;
                const isUpdating = isUpdatingComment?.(comment) ?? false;
                const updateError = getUpdateError?.(comment) ?? null;
                const draftChanged = commentDraft !== comment.body;
                const editDisabled =
                    !canEdit || isUpdating || editingCommentId !== null;
                const saveDisabled =
                    !canEdit ||
                    isUpdating ||
                    commentDraft.trim().length === 0 ||
                    !draftChanged;

                return (
                    <article
                        className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary"
                        key={comment.id}
                    >
                        <div className="flex items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] px-3 py-2">
                            <div className="min-w-0 text-[11px] font-medium">
                                {comment.author?.login ?? "ghost"}
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                                <div className="text-[10px] text-text-secondary">
                                    {formatGitHubRelativeTime(comment.updatedAt)}
                                </div>
                                {onUpdateComment && !isEditing ? (
                                    <IdeActionButton
                                        disabled={editDisabled}
                                        onClick={() =>
                                            handleStartEditingComment(comment)
                                        }
                                        title={
                                            canEdit
                                                ? "Edit comment"
                                                : permissionLabel
                                        }
                                    >
                                        Edit
                                    </IdeActionButton>
                                ) : null}
                                <IdeActionButton
                                    onClick={() =>
                                        void handleCopyComment(
                                            commentId,
                                            comment.body,
                                        )
                                    }
                                    title="Copy comment to clipboard"
                                >
                                    {isCopied ? "Copied" : "Copy"}
                                </IdeActionButton>
                            </div>
                        </div>
                        {isEditing ? (
                            <div className="space-y-3 px-3 py-3">
                                <textarea
                                    className="min-h-32 w-full resize-y rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))] disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={isUpdating}
                                    onChange={(event) =>
                                        setCommentDraft(
                                            event.currentTarget.value,
                                        )
                                    }
                                    placeholder="Edit this comment..."
                                    value={commentDraft}
                                />
                                {updateError ? (
                                    <div className="text-[11px] text-[color:var(--diff-remove)]">
                                        {updateError}
                                    </div>
                                ) : null}
                                <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2">
                                    <GitHubSectionLabel>
                                        Preview
                                    </GitHubSectionLabel>
                                    <div className="mt-2 max-h-48 overflow-y-auto text-[12px] leading-5 text-text-secondary">
                                            <MarkdownContent
                                                content={
                                                    commentDraft.trim() ||
                                                "_No body._"
                                            }
                                        />
                                    </div>
                                </div>
                                <div className="flex justify-end gap-2">
                                    <IdeActionButton
                                        disabled={isUpdating}
                                        onClick={handleCancelEditingComment}
                                    >
                                        Cancel
                                    </IdeActionButton>
                                    <IdeActionButton
                                        disabled={saveDisabled}
                                        onClick={() =>
                                            void handleSaveComment(comment)
                                        }
                                    >
                                        {isUpdating ? "Saving..." : "Save"}
                                    </IdeActionButton>
                                </div>
                            </div>
                        ) : (
                            <div className="px-3 py-3 text-[12px] leading-6 text-text-secondary">
                                <MarkdownContent
                                    content={comment.body || "_No body._"}
                                />
                            </div>
                        )}
                    </article>
                );
            })}
        </div>
    );
}

export function GitHubCommentComposer({
    armedSubmitLabel = "Click again to publish",
    disabled,
    error,
    initialPreviewExpanded = true,
    isSubmitting,
    secondaryAction,
    onChange,
    onSubmit,
    permissionLabel,
    value,
}: {
    readonly armedSubmitLabel?: string;
    readonly disabled?: boolean;
    readonly error?: string | null;
    readonly initialPreviewExpanded?: boolean;
    readonly isSubmitting?: boolean;
    readonly secondaryAction?: {
        readonly armedLabel: string;
        readonly disabled?: boolean;
        readonly isSubmitting?: boolean;
        readonly label: string;
        readonly loadingLabel: string;
        readonly onConfirm: () => void;
        readonly title?: string;
    };
    readonly onChange: (value: string) => void;
    readonly onSubmit: () => void;
    readonly permissionLabel: string;
    readonly value: string;
}) {
    const [isPreviewExpanded, setIsPreviewExpanded] = useState(
        initialPreviewExpanded,
    );
    const trimmed = value.trim();
    const submitDisabled = disabled || isSubmitting || trimmed.length === 0;
    const secondaryDisabled =
        disabled ||
        isSubmitting ||
        secondaryAction?.disabled ||
        secondaryAction?.isSubmitting ||
        trimmed.length === 0;

    useEffect(() => {
        if (trimmed.length === 0) {
            let cancelled = false;
            queueMicrotask(() => {
                if (!cancelled) {
                    setIsPreviewExpanded(initialPreviewExpanded);
                }
            });
            return () => {
                cancelled = true;
            };
        }
    }, [initialPreviewExpanded, trimmed.length]);

    return (
        <div className="rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary p-3">
            <textarea
                className="min-h-28 w-full resize-y rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={disabled || isSubmitting}
                onChange={(event) => onChange(event.currentTarget.value)}
                placeholder="Write a comment..."
                value={value}
            />
            {error ? (
                <div className="mt-2 text-[11px] text-[color:var(--diff-remove)]">
                    {error}
                </div>
            ) : null}
            <div className="mt-3 flex items-center justify-between gap-3">
                <div className="text-[10px] text-text-secondary">
                    Draft is kept locally if publishing fails.
                </div>
                <div className="flex items-center gap-2">
                    <IdeActionButton
                        disabled
                        onClick={() => undefined}
                        title="Agent-assisted drafts land in a follow-up phase."
                    >
                        Draft with Agent
                    </IdeActionButton>
                    {secondaryAction ? (
                        <GitHubConfirmActionButton
                            armedLabel={secondaryAction.armedLabel}
                            disabled={secondaryDisabled}
                            onConfirm={secondaryAction.onConfirm}
                            title={
                                disabled
                                    ? permissionLabel
                                    : secondaryAction.title
                            }
                        >
                            {secondaryAction.isSubmitting
                                ? secondaryAction.loadingLabel
                                : secondaryAction.label}
                        </GitHubConfirmActionButton>
                    ) : null}
                    <GitHubConfirmActionButton
                        armedLabel={armedSubmitLabel}
                        disabled={submitDisabled}
                        onConfirm={onSubmit}
                        title={disabled ? permissionLabel : undefined}
                    >
                        {isSubmitting ? "Commenting..." : "Comment"}
                    </GitHubConfirmActionButton>
                </div>
            </div>
            {trimmed ? (
                <div className="mt-3 rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                        <GitHubSectionLabel>
                            Preview before publishing
                        </GitHubSectionLabel>
                        <button
                            aria-expanded={isPreviewExpanded}
                            className="text-[10px] font-medium text-text-secondary transition hover:text-text-primary"
                            onClick={() =>
                                setIsPreviewExpanded((value) => !value)
                            }
                            type="button"
                        >
                            {isPreviewExpanded ? "Hide preview" : "Show preview"}
                        </button>
                    </div>
                    {isPreviewExpanded ? (
                        <div className="mt-2 max-h-48 overflow-y-auto text-[12px] leading-5 text-text-secondary">
                            <MarkdownContent content={trimmed} />
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

export function GitHubDraftPreview({
    body,
    collapsible = false,
    defaultExpanded = true,
    meta,
    title,
}: {
    readonly body: string;
    readonly collapsible?: boolean;
    readonly defaultExpanded?: boolean;
    readonly meta?: ReactNode;
    readonly title: string;
}) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);
    const normalizedTitle = title.trim();
    const normalizedBody = body.trim();
    if (!normalizedTitle && !normalizedBody && !meta) {
        return null;
    }

    return (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2">
            <div className="flex items-center justify-between gap-3">
                <GitHubSectionLabel>Preview before publishing</GitHubSectionLabel>
                {collapsible ? (
                    <button
                        aria-expanded={isExpanded}
                        className="text-[10px] font-medium text-text-secondary transition hover:text-text-primary"
                        onClick={() => setIsExpanded((value) => !value)}
                        type="button"
                    >
                        {isExpanded ? "Hide preview" : "Show preview"}
                    </button>
                ) : null}
            </div>
            {isExpanded ? (
                <div>
                    {normalizedTitle ? (
                        <div className="mt-2 text-[12px] font-semibold text-text-primary">
                            {normalizedTitle}
                        </div>
                    ) : null}
                    {meta ? (
                        <div className="mt-1 text-[10px] text-text-secondary">
                            {meta}
                        </div>
                    ) : null}
                    <div className="mt-2 max-h-48 overflow-y-auto text-[12px] leading-5 text-text-secondary">
                        <MarkdownContent
                            content={normalizedBody || "_No description._"}
                        />
                    </div>
                </div>
            ) : null}
        </div>
    );
}

export function GitHubEmptyState({
    children,
}: {
    readonly children: ReactNode;
}) {
    return (
        <div className="flex min-h-32 items-center justify-center px-6 py-8 text-center text-[12px] leading-6 text-text-secondary">
            {children}
        </div>
    );
}

export function GitHubErrorState({
    children,
}: {
    readonly children: ReactNode;
}) {
    return (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--diff-remove)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-remove)_8%,transparent)] px-4 py-3 text-[12px] leading-6 text-[color-mix(in_srgb,var(--diff-remove)_84%,var(--color-text-primary))]">
            {children}
        </div>
    );
}

export function GitHubSectionLabel({
    children,
}: {
    readonly children: ReactNode;
}) {
    return (
        <span
            style={{
                color: "var(--color-text-secondary)",
                display: "inline-block",
                fontSize: "10px",
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
            }}
        >
            {children}
        </span>
    );
}

export type GitHubSectionTone =
    | "accent"
    | "danger"
    | "info"
    | "neutral"
    | "success"
    | "warn";

const GITHUB_SECTION_TONE_BAR: Record<GitHubSectionTone, string> = {
    accent: "var(--color-accent)",
    danger: "var(--diff-remove)",
    info: "color-mix(in srgb, var(--color-accent) 60%, var(--color-text-secondary))",
    neutral:
        "color-mix(in srgb, var(--color-text-secondary) 55%, transparent)",
    success: "var(--diff-add)",
    warn: "var(--diff-warn, #d99a3a)",
};

export function GitHubSection({
    actions,
    bodyClassName,
    children,
    count,
    eyebrow,
    title,
    tone = "neutral",
}: {
    readonly actions?: ReactNode;
    readonly bodyClassName?: string;
    readonly children: ReactNode;
    readonly count?: number | string | null;
    readonly eyebrow?: ReactNode;
    readonly title: ReactNode;
    readonly tone?: GitHubSectionTone;
}) {
    return (
        <section className="overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary">
            <header className="flex select-none flex-wrap items-center justify-between gap-2 border-b border-[color-mix(in_srgb,var(--color-border)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-tertiary)_55%,transparent)] px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                    <span
                        aria-hidden="true"
                        className="inline-block h-3.5 w-[3px] shrink-0 rounded-full"
                        style={{
                            background: GITHUB_SECTION_TONE_BAR[tone],
                        }}
                    />
                    <span className="truncate text-[12px] font-semibold text-text-primary">
                        {title}
                    </span>
                    {count != null ? (
                        <span className="shrink-0 rounded-full bg-bg-tertiary px-1.5 py-[1px] font-mono text-[10px] text-text-secondary">
                            {count}
                        </span>
                    ) : null}
                    {eyebrow}
                </div>
                {actions ? (
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        {actions}
                    </div>
                ) : null}
            </header>
            <div className={bodyClassName ?? "px-4 py-3"}>{children}</div>
        </section>
    );
}

export function GitHubAuthNotice({
    authStatus,
}: {
    readonly authStatus: GitHubAuthStatus | null;
}) {
    if (!authStatus || authStatus.state === "authenticated") {
        return null;
    }

    const message =
        authStatus.state === "missing"
            ? "Connect GitHub in Settings to load repository data."
            : authStatus.state === "invalid"
              ? "The saved GitHub token is invalid or expired."
              : "GitHub authentication could not be verified.";

    return <GitHubErrorState>{message}</GitHubErrorState>;
}

export function hasGitHubWritePermission(
    authStatus: GitHubAuthStatus | null,
    capability: GitHubAuthCapability,
): boolean {
    if (authStatus?.state !== "authenticated") {
        return false;
    }

    return capability === "issues"
        ? authStatus.canWriteIssues
        : authStatus.canWritePullRequests;
}

export function getGitHubWritePermissionLabel(
    capability: GitHubAuthCapability,
): string {
    return capability === "issues"
        ? "Your GitHub token cannot write issues."
        : "Your GitHub token cannot write pull requests.";
}

export function formatGitHubRelativeTime(value: string | null): string {
    if (!value) {
        return "Never";
    }

    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) {
        return value;
    }

    const diffMs = Date.now() - timestamp;
    const absMs = Math.abs(diffMs);
    const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
        ["year", 365 * 24 * 60 * 60 * 1000],
        ["month", 30 * 24 * 60 * 60 * 1000],
        ["week", 7 * 24 * 60 * 60 * 1000],
        ["day", 24 * 60 * 60 * 1000],
        ["hour", 60 * 60 * 1000],
        ["minute", 60 * 1000],
    ];

    for (const [unit, ms] of units) {
        if (absMs >= ms) {
            return new Intl.RelativeTimeFormat(undefined, {
                numeric: "auto",
            }).format(Math.round(-diffMs / ms), unit);
        }
    }

    return "just now";
}

export function formatGitHubDateTime(value: string | null): string {
    if (!value) {
        return "Never";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

export function buildGitHubWebUrl(
    ref: GitHubRepositoryRef,
    path = "",
): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `https://${ref.host}/${ref.owner}/${ref.repo}${normalizedPath}`;
}

export function openGitHubWebUrl(url: string): void {
    openExternalUrl(url);
}
