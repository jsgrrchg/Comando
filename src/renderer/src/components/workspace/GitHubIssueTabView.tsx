import { useEffect, useState } from "react";

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
    const detail = useGitHubStore(
        (state) =>
            state.issueDetailsByRepo[repoKey]?.[tab.issueNumber] ?? null,
    );
    const authStatus = useGitHubStore(
        (state) => state.authStatusByHost[tab.ref.host] ?? null,
    );
    const isLoading = useGitHubStore(
        (state) =>
            state.loadingKeys[`${repoKey}:issue:${tab.issueNumber}`] ?? false,
    );
    const isCommenting = useGitHubStore(
        (state) =>
            state.mutatingKeys[`${repoKey}:issue:${tab.issueNumber}:comment`] ??
            false,
    );
    const isClosing = useGitHubStore(
        (state) =>
            state.mutatingKeys[`${repoKey}:issue:${tab.issueNumber}:close`] ??
            false,
    );
    const isReopening = useGitHubStore(
        (state) =>
            state.mutatingKeys[`${repoKey}:issue:${tab.issueNumber}:reopen`] ??
            false,
    );
    const error = useGitHubStore(
        (state) =>
            state.errors[`${repoKey}:issue:${tab.issueNumber}`] ??
            state.errors[`${repoKey}:issue:${tab.issueNumber}:comment`] ??
            state.errors[`${repoKey}:issue:${tab.issueNumber}:close`] ??
            state.errors[`${repoKey}:issue:${tab.issueNumber}:reopen`] ??
            null,
    );
    const refreshAuthStatus = useGitHubStore(
        (state) => state.refreshAuthStatus,
    );
    const ensureIssueDetail = useGitHubStore(
        (state) => state.ensureIssueDetail,
    );
    const commentIssue = useGitHubStore((state) => state.commentIssue);
    const closeIssue = useGitHubStore((state) => state.closeIssue);
    const reopenIssue = useGitHubStore((state) => state.reopenIssue);
    const canWriteIssues = hasGitHubWritePermission(authStatus, "issues");
    const writePermissionLabel = getGitHubWritePermissionLabel("issues");

    useEffect(() => {
        let cancelled = false;

        async function refreshInitialData() {
            const status = await refreshAuthStatus(tab.ref);
            if (!cancelled && status.state === "authenticated") {
                await ensureIssueDetail(tab.ref, tab.issueNumber);
            }
        }

        void refreshInitialData();

        return () => {
            cancelled = true;
        };
    }, [ensureIssueDetail, refreshAuthStatus, tab.issueNumber, tab.ref]);

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

    return (
        <GitHubTabShell
            header={
                <GitHubTabHeader
                    actions={
                        <>
                            <IdeActionButton
                                onClick={() =>
                                    openGitHubWebUrl(
                                        detail?.url ??
                                            buildGitHubWebUrl(
                                                tab.ref,
                                                `/issues/${tab.issueNumber}`,
                                            ),
                                    )
                                }
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
        >
            <div className="space-y-4 p-4">
                <GitHubAuthNotice authStatus={authStatus} />
                {error ? <GitHubErrorState>{error}</GitHubErrorState> : null}
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
                                <h1 className="text-[18px] font-semibold leading-7 text-text-primary">
                                    {detail.title}
                                </h1>
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
                            <div className="px-4 py-4 text-[13px] leading-6 text-text-secondary">
                                <MarkdownContent
                                    content={detail.body || "_No description._"}
                                />
                            </div>
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
                            <GitHubCommentList comments={detail.comments} />
                            <GitHubCommentComposer
                                disabled={!canWriteIssues}
                                error={error}
                                isSubmitting={isCommenting}
                                onChange={setCommentDraft}
                                onSubmit={() => void handleComment()}
                                permissionLabel={writePermissionLabel}
                                value={commentDraft}
                            />
                        </section>
                    </>
                ) : null}
            </div>
        </GitHubTabShell>
    );
}
