import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { GitHubCommentSummary } from "@shared/ipc";

import { getGitHubRepoKey, useGitHubStore } from "@renderer/app/store/github-store";
import type { RuntimeWorkspaceGitHubIssueTab } from "@renderer/app/workspace/tree";

import {
    buildGitHubWebUrl,
    formatGitHubDateTime,
    getGitHubWritePermissionLabel,
    GitHubAuthNotice,
    GitHubCommentComposer,
    GitHubCommentList,
    GitHubEmptyState,
    GitHubErrorState,
    GitHubLabelPill,
    GitHubSectionLabel,
    GitHubStatePill,
    GitHubTabHeader,
    GitHubTabShell,
    GitHubUsers,
    hasGitHubWritePermission,
    openGitHubWebUrl,
} from "./GitHubWorkspacePrimitives";
import { MarkdownContent } from "./MarkdownContent";
import { IdeActionButton } from "./ide-bar";

export function GitHubIssueTabView({
    tab,
}: {
    readonly tab: RuntimeWorkspaceGitHubIssueTab;
}) {
    const repoKey = getGitHubRepoKey(tab.ref);
    const [commentDraft, setCommentDraft] = useState("");
    const [isEditingIssue, setIsEditingIssue] = useState(false);
    const [issueTitleDraft, setIssueTitleDraft] = useState("");
    const [issueBodyDraft, setIssueBodyDraft] = useState("");
    const [isIssueBodyCopied, setIsIssueBodyCopied] = useState(false);
    const [isIssueLinkCopied, setIsIssueLinkCopied] = useState(false);
    const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    );
    const copyLinkResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    );
    const detail = useGitHubStore(
        (state) =>
            state.issueDetailsByRepo[repoKey]?.[tab.issueNumber] ?? null,
    );
    const authStatus = useGitHubStore(
        (state) => state.authStatusByHost[tab.ref.host] ?? null,
    );
    const commentMutatingKeys = useGitHubStore((state) => state.mutatingKeys);
    const commentErrors = useGitHubStore((state) => state.errors);
    const isLoading = useGitHubStore(
        (state) =>
            state.loadingKeys[`${repoKey}:issue:${tab.issueNumber}`] ?? false,
    );
    const { isCommenting, isClosing, isReopening, isUpdatingIssue } =
        useGitHubStore(
            useShallow((state) => ({
                isClosing:
                    state.mutatingKeys[
                        `${repoKey}:issue:${tab.issueNumber}:close`
                    ] ?? false,
                isCommenting:
                    state.mutatingKeys[
                        `${repoKey}:issue:${tab.issueNumber}:comment`
                    ] ?? false,
                isReopening:
                    state.mutatingKeys[
                        `${repoKey}:issue:${tab.issueNumber}:reopen`
                    ] ?? false,
                isUpdatingIssue:
                    state.mutatingKeys[
                        `${repoKey}:issue:${tab.issueNumber}:update`
                    ] ?? false,
            })),
        );
    const {
        detailError,
        commentError,
        closeError,
        reopenError,
        updateIssueError,
    } = useGitHubStore(
        useShallow((state) => ({
            closeError:
                state.errors[`${repoKey}:issue:${tab.issueNumber}:close`] ??
                null,
            commentError:
                state.errors[`${repoKey}:issue:${tab.issueNumber}:comment`] ??
                null,
            detailError:
                state.errors[`${repoKey}:issue:${tab.issueNumber}`] ?? null,
            reopenError:
                state.errors[`${repoKey}:issue:${tab.issueNumber}:reopen`] ??
                null,
            updateIssueError:
                state.errors[`${repoKey}:issue:${tab.issueNumber}:update`] ??
                null,
        })),
    );
    const refreshAuthStatus = useGitHubStore(
        (state) => state.refreshAuthStatus,
    );
    const ensureIssueDetail = useGitHubStore(
        (state) => state.ensureIssueDetail,
    );
    const commentIssue = useGitHubStore((state) => state.commentIssue);
    const updateComment = useGitHubStore((state) => state.updateComment);
    const updateIssue = useGitHubStore((state) => state.updateIssue);
    const closeIssue = useGitHubStore((state) => state.closeIssue);
    const reopenIssue = useGitHubStore((state) => state.reopenIssue);
    const canWriteIssues = hasGitHubWritePermission(authStatus, "issues");
    const writePermissionLabel = getGitHubWritePermissionLabel("issues");
    const issueUrl =
        detail?.url ?? buildGitHubWebUrl(tab.ref, `/issues/${tab.issueNumber}`);

    useEffect(() => {
        let cancelled = false;

        async function loadInitialData() {
            if (
                useGitHubStore.getState().issueDetailsByRepo[repoKey]?.[
                    tab.issueNumber
                ] !== undefined
            ) {
                return;
            }

            const status =
                useGitHubStore.getState().authStatusByHost[tab.ref.host] ??
                (await refreshAuthStatus(tab.ref));
            if (!cancelled && status.state === "authenticated") {
                await ensureIssueDetail(tab.ref, tab.issueNumber);
            }
        }

        void loadInitialData();

        return () => {
            cancelled = true;
        };
    }, [
        ensureIssueDetail,
        refreshAuthStatus,
        repoKey,
        tab.issueNumber,
        tab.ref,
    ]);

    useEffect(() => {
        return () => {
            if (copyResetTimeoutRef.current) {
                clearTimeout(copyResetTimeoutRef.current);
            }
            if (copyLinkResetTimeoutRef.current) {
                clearTimeout(copyLinkResetTimeoutRef.current);
            }
        };
    }, []);

    const handleRefresh = async () => {
        const status = await refreshAuthStatus(tab.ref);
        if (status.state === "authenticated") {
            await ensureIssueDetail(tab.ref, tab.issueNumber, { force: true });
        }
    };

    const handleComment = async () => {
        const body = commentDraft.trim();
        if (!body || !canWriteIssues) {
            return;
        }

        await commentIssue(tab.ref, tab.issueNumber, body);
        setCommentDraft("");
    };

    const handleCommentAndClose = async () => {
        const body = commentDraft.trim();
        if (!body || !canWriteIssues) {
            return;
        }

        await commentIssue(tab.ref, tab.issueNumber, body);
        setCommentDraft("");
        await closeIssue(tab.ref, tab.issueNumber);
    };

    const handleUpdateComment = async (
        comment: GitHubCommentSummary,
        body: string,
    ) => {
        await updateComment(tab.ref, {
            body,
            commentId: comment.id,
        });
    };

    const handleStartEditingIssue = () => {
        if (!canWriteIssues || !detail) {
            return;
        }

        setIssueTitleDraft(detail.title);
        setIssueBodyDraft(detail.body ?? "");
        setIsEditingIssue(true);
    };

    const handleCancelEditingIssue = () => {
        setIssueTitleDraft(detail?.title ?? "");
        setIssueBodyDraft(detail?.body ?? "");
        setIsEditingIssue(false);
    };

    const handleSaveIssue = async () => {
        const title = issueTitleDraft.trim();
        if (!canWriteIssues || !detail || !title) {
            return;
        }

        await updateIssue(tab.ref, tab.issueNumber, {
            body: issueBodyDraft,
            title,
        });
        setIsEditingIssue(false);
    };

    const handleCopyIssueBody = async () => {
        if (!detail?.body) {
            return;
        }

        await navigator.clipboard.writeText(detail.body);
        setIsIssueBodyCopied(true);
        if (copyResetTimeoutRef.current) {
            clearTimeout(copyResetTimeoutRef.current);
        }
        copyResetTimeoutRef.current = setTimeout(() => {
            setIsIssueBodyCopied(false);
            copyResetTimeoutRef.current = null;
        }, 1600);
    };

    const handleCopyIssueLink = async () => {
        await navigator.clipboard.writeText(issueUrl);
        setIsIssueLinkCopied(true);
        if (copyLinkResetTimeoutRef.current) {
            clearTimeout(copyLinkResetTimeoutRef.current);
        }
        copyLinkResetTimeoutRef.current = setTimeout(() => {
            setIsIssueLinkCopied(false);
            copyLinkResetTimeoutRef.current = null;
        }, 1600);
    };

    const handleClose = async () => {
        if (
            !canWriteIssues ||
            !window.confirm(`Close issue #${tab.issueNumber}?`)
        ) {
            return;
        }

        await closeIssue(tab.ref, tab.issueNumber);
    };

    const handleReopen = async () => {
        if (
            !canWriteIssues ||
            !window.confirm(`Reopen issue #${tab.issueNumber}?`)
        ) {
            return;
        }

        await reopenIssue(tab.ref, tab.issueNumber);
    };

    const titleChanged = issueTitleDraft.trim() !== (detail?.title ?? "").trim();
    const bodyChanged = issueBodyDraft !== (detail?.body ?? "");
    const saveIssueDisabled =
        !canWriteIssues ||
        isUpdatingIssue ||
        issueTitleDraft.trim().length === 0 ||
        (!titleChanged && !bodyChanged);
    const pageError = detailError ?? closeError ?? reopenError ?? null;

    return (
        <GitHubTabShell
            header={
                <GitHubTabHeader
                    actions={
                        <>
                            <IdeActionButton
                                onClick={() => void handleCopyIssueLink()}
                                title="Copy GitHub issue link to clipboard"
                            >
                                {isIssueLinkCopied ? "Copied" : "Copy Link"}
                            </IdeActionButton>
                            <IdeActionButton
                                onClick={() => openGitHubWebUrl(issueUrl)}
                            >
                                Open in GitHub
                            </IdeActionButton>
                            <IdeActionButton
                                disabled={isLoading}
                                onClick={() => void handleRefresh()}
                            >
                                Refresh
                            </IdeActionButton>
                        </>
                    }
                    meta={
                        detail ? (
                            <>
                                <GitHubStatePill tone={detail.state}>
                                    {detail.state}
                                </GitHubStatePill>
                            </>
                        ) : null
                    }
                    repo={tab.ref}
                    title={`#${tab.issueNumber}`}
                />
            }
            scrollScope={{
                entityId: `${repoKey}/issues/${tab.issueNumber}`,
                projectId: tab.projectId,
                surface: "github_issue",
                worktreeId: tab.worktreeId ?? null,
            }}
        >
            <div className="space-y-4 p-4">
                <GitHubAuthNotice authStatus={authStatus} />
                {pageError ? (
                    <GitHubErrorState>{pageError}</GitHubErrorState>
                ) : null}
                {isLoading && !detail ? (
                    <div className="text-[12px] text-text-secondary">
                        Loading issue...
                    </div>
                ) : null}
                {!isLoading && !detail ? (
                    <GitHubEmptyState>
                        Issue #{tab.issueNumber} could not be loaded.
                    </GitHubEmptyState>
                ) : null}
                {detail ? (
                    <>
                        <article className="rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary">
                            <div className="border-b border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] px-4 py-3">
                                {isEditingIssue ? (
                                    <input
                                        className="h-9 w-full rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 text-[18px] font-semibold leading-7 text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))] disabled:cursor-not-allowed disabled:opacity-50"
                                        disabled={isUpdatingIssue}
                                        onChange={(event) =>
                                            setIssueTitleDraft(
                                                event.currentTarget.value,
                                            )
                                        }
                                        placeholder="Issue title"
                                        value={issueTitleDraft}
                                    />
                                ) : (
                                    <h1 className="text-[18px] font-semibold leading-7 text-text-primary">
                                        {detail.title}
                                    </h1>
                                )}
                                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
                                    <span>
                                        by {detail.author?.login ?? "ghost"}
                                    </span>
                                    <span>updated {formatGitHubDateTime(detail.updatedAt)}</span>
                                    <GitHubUsers users={detail.assignees} />
                                </div>
                                <div className="mt-2 flex flex-wrap gap-1">
                                    {detail.labels.map((label) => (
                                        <GitHubLabelPill
                                            key={label.id}
                                            label={label}
                                        />
                                    ))}
                                </div>
                            </div>
                            {!isEditingIssue ? (
                                <div className="flex justify-end gap-2 px-4 pt-3">
                                    <IdeActionButton
                                        disabled={!canWriteIssues}
                                        onClick={handleStartEditingIssue}
                                        title={
                                            canWriteIssues
                                                ? undefined
                                                : writePermissionLabel
                                        }
                                    >
                                        Edit details
                                    </IdeActionButton>
                                    <IdeActionButton
                                        disabled={!detail.body}
                                        onClick={() =>
                                            void handleCopyIssueBody()
                                        }
                                        title="Copy issue description to clipboard"
                                    >
                                        {isIssueBodyCopied
                                            ? "Copied"
                                            : "Copy"}
                                    </IdeActionButton>
                                </div>
                            ) : null}
                            {isEditingIssue ? (
                                <div className="space-y-3 px-4 py-4">
                                    <textarea
                                        className="min-h-48 w-full resize-y rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))] disabled:cursor-not-allowed disabled:opacity-50"
                                        disabled={isUpdatingIssue}
                                        onChange={(event) =>
                                            setIssueBodyDraft(
                                                event.currentTarget.value,
                                            )
                                        }
                                        placeholder="Describe this issue..."
                                        value={issueBodyDraft}
                                    />
                                    {updateIssueError ? (
                                        <div className="text-[11px] text-[color:var(--diff-remove)]">
                                            {updateIssueError}
                                        </div>
                                    ) : null}
                                    <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2">
                                        <GitHubSectionLabel>
                                            Preview
                                        </GitHubSectionLabel>
                                        <div className="mt-2 max-h-72 overflow-y-auto text-[12px] leading-5 text-text-secondary">
                                            <MarkdownContent
                                                content={
                                                    issueBodyDraft.trim() ||
                                                    "_No description._"
                                                }
                                            />
                                        </div>
                                    </div>
                                    <div className="flex justify-end gap-2">
                                        <IdeActionButton
                                            disabled={isUpdatingIssue}
                                            onClick={handleCancelEditingIssue}
                                        >
                                            Cancel
                                        </IdeActionButton>
                                        <IdeActionButton
                                            disabled={saveIssueDisabled}
                                            onClick={() =>
                                                void handleSaveIssue()
                                            }
                                            title={
                                                canWriteIssues
                                                    ? undefined
                                                    : writePermissionLabel
                                            }
                                        >
                                            {isUpdatingIssue
                                                ? "Saving..."
                                                : "Save changes"}
                                        </IdeActionButton>
                                    </div>
                                </div>
                            ) : (
                                <div className="px-4 py-4 text-[13px] leading-6 text-text-secondary">
                                    <MarkdownContent
                                        content={
                                            detail.body || "_No description._"
                                        }
                                    />
                                </div>
                            )}
                            <div className="flex justify-end gap-2 border-t border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] px-4 py-3">
                                {detail.state === "open" ? (
                                    <IdeActionButton
                                        disabled={
                                            !canWriteIssues || isClosing
                                        }
                                        onClick={() => void handleClose()}
                                        title={
                                            canWriteIssues
                                                ? undefined
                                                : writePermissionLabel
                                        }
                                    >
                                        {isClosing ? "Closing..." : "Close Issue"}
                                    </IdeActionButton>
                                ) : (
                                    <IdeActionButton
                                        disabled={
                                            !canWriteIssues || isReopening
                                        }
                                        onClick={() => void handleReopen()}
                                        title={
                                            canWriteIssues
                                                ? undefined
                                                : writePermissionLabel
                                        }
                                    >
                                        {isReopening
                                            ? "Reopening..."
                                            : "Reopen Issue"}
                                    </IdeActionButton>
                                )}
                            </div>
                        </article>
                        <section className="space-y-3">
                            <GitHubSectionLabel>Comments</GitHubSectionLabel>
                            <GitHubCommentList
                                canEdit={canWriteIssues}
                                comments={detail.comments}
                                getUpdateError={(comment) =>
                                    commentErrors[
                                        `${repoKey}:comment:${comment.id}:update`
                                    ] ?? null
                                }
                                isUpdatingComment={(comment) =>
                                    commentMutatingKeys[
                                        `${repoKey}:comment:${comment.id}:update`
                                    ] ?? false
                                }
                                onUpdateComment={(comment, body) =>
                                    handleUpdateComment(comment, body)
                                }
                                permissionLabel={writePermissionLabel}
                            />
                            <GitHubCommentComposer
                                disabled={!canWriteIssues}
                                error={commentError}
                                initialPreviewExpanded={false}
                                isSubmitting={isCommenting || isClosing}
                                onChange={setCommentDraft}
                                onSubmit={() => void handleComment()}
                                permissionLabel={writePermissionLabel}
                                secondaryAction={
                                    detail.state === "open"
                                        ? {
                                              armedLabel:
                                                  "Click again to comment and close",
                                              disabled: !canWriteIssues,
                                              isSubmitting: isClosing,
                                              label: "Close issue with comment",
                                              loadingLabel: "Closing...",
                                              onConfirm: () =>
                                                  void handleCommentAndClose(),
                                              title: canWriteIssues
                                                  ? undefined
                                                  : writePermissionLabel,
                                          }
                                        : undefined
                                }
                                value={commentDraft}
                            />
                        </section>
                    </>
                ) : null}
            </div>
        </GitHubTabShell>
    );
}
