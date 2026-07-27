import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildGitRemoteCommitLink } from "@renderer/app/git/remote-link";
import { getGitContextKey } from "@renderer/app/git/context-key";
import { useResolvedEditorSettings } from "@renderer/app/hooks/use-resolved-editor-settings";
import { openExternalUrl } from "@renderer/app/utils/external-url";
import {
    formatGitCommitDateTime,
    getRefPillStyle,
} from "@renderer/app/git/history-presentation";
import { useGitStore } from "@renderer/app/store/git-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceGitCommitTab } from "@renderer/app/workspace/tree";
import {
    GitAuthorAvatar,
    GitEmptyState,
} from "@renderer/components/git";
import { usePersistedWorkspaceScroll } from "@renderer/components/workspace/usePersistedWorkspaceScroll";
import {
    getGitCommitDiffCollapseStorageKey,
} from "./gitCommitDiffCollapsePersistence";
import { MarkdownContent } from "./MarkdownContent";
import { GitRevisionDiffView } from "./GitRevisionDiffView";
import { IdeActionButton } from "./ide-bar";

const EMPTY_LOADING_SHAS: readonly string[] = [];

function getContextKey(projectId: string, worktreeId: string | null): string {
    return getGitContextKey(projectId, worktreeId);
}

export function GitCommitTabView({
    tab,
}: {
    readonly tab: RuntimeWorkspaceGitCommitTab;
}) {
    const projectId = tab.projectId;
    const editorSettings = useResolvedEditorSettings();
    const worktreeId = tab.worktreeId ?? null;
    const contextKey = projectId ? getContextKey(projectId, worktreeId) : null;
    const commitSha = tab.commitSha;
    const {
        handleScrollTop: persistCommitScrollTop,
        scrollRef: commitScrollRef,
    } =
        usePersistedWorkspaceScroll<HTMLDivElement>({
            entityId: commitSha,
            projectId,
            surface: tab.kind,
            worktreeId,
        });

    const detail = useGitStore((state) =>
        contextKey && projectId
            ? (state.commitDetailsByContext[contextKey]?.[commitSha] ?? null)
            : null,
    );
    const snapshot = useGitStore((state) =>
        contextKey ? (state.snapshots[contextKey] ?? null) : null,
    );
    const error = useGitStore((state) =>
        contextKey ? (state.errors[contextKey] ?? null) : null,
    );
    const isLoading = useGitStore((state) =>
        contextKey
            ? (
                  state.loadingCommitShas[contextKey] ?? EMPTY_LOADING_SHAS
              ).includes(commitSha)
            : false,
    );
    const ensureCommitDetail = useGitStore((state) => state.ensureCommitDetail);
    const openGitTab = useWorkspaceStore((state) => state.openGitTab);
    const selectCommit = useGitStore((state) => state.selectCommit);
    const remoteLink = buildGitRemoteCommitLink(
        snapshot?.remotes ?? [],
        tab.commitSha,
    );
    const codeFontSize = editorSettings.fontSize;
    const authorFontSize = Math.max(13, Math.round(codeFontSize * 0.92));
    const metadataFontSize = Math.max(11, Math.round(codeFontSize * 0.82));
    const refFontSize = Math.max(10, Math.round(codeFontSize * 0.76));
    const subjectFontSize = Math.max(16, Math.round(codeFontSize * 1.14));

    const [isBodyCollapsed, setIsBodyCollapsed] = useState(false);
    const collapsedRef = useRef(false);

    const diffCollapseStorageKey = useMemo(
        () =>
            getGitCommitDiffCollapseStorageKey({
                commitSha,
                projectId,
                surface: tab.kind,
                worktreeId,
            }),
        [commitSha, projectId, tab.kind, worktreeId],
    );

    const handleDiffScroll = useCallback((scrollTop: number) => {
        const shouldCollapse = scrollTop > 0;
        if (shouldCollapse !== collapsedRef.current) {
            collapsedRef.current = shouldCollapse;
            setIsBodyCollapsed(shouldCollapse);
        }
    }, []);

    const handleCommitScrollTop = useCallback(
        (scrollTop: number) => {
            persistCommitScrollTop(scrollTop);
            if (detail?.body) {
                handleDiffScroll(scrollTop);
            }
        },
        [detail?.body, handleDiffScroll, persistCommitScrollTop],
    );

    useEffect(() => {
        if (!projectId) {
            return;
        }

        void ensureCommitDetail(projectId, tab.commitSha, worktreeId);
    }, [ensureCommitDetail, projectId, tab.commitSha, worktreeId]);

    if (!projectId) {
        return (
            <div className="flex h-full items-center justify-center px-6">
                <GitEmptyState>
                    Commit tabs need an attached project to render commit
                    details.
                </GitEmptyState>
            </div>
        );
    }

    if (!detail && !isLoading && error) {
        return (
            <div className="flex h-full items-center justify-center px-6">
                <GitEmptyState>{error}</GitEmptyState>
            </div>
        );
    }

    if (!detail) {
        return (
            <div className="flex h-full items-center justify-center px-6">
                <GitEmptyState>Loading commit details...</GitEmptyState>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 select-none flex-col bg-bg-primary">
            <header className="px-5 py-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                        <GitAuthorAvatar
                            email={detail.authorEmail}
                            name={detail.authorName}
                            size={32}
                        />
                        <div className="min-w-0">
                            <div
                                className="font-medium text-text-primary"
                                style={{ fontSize: authorFontSize }}
                            >
                                {detail.authorName}
                            </div>
                            <div
                                className="text-text-secondary"
                                style={{ fontSize: metadataFontSize }}
                            >
                                {formatGitCommitDateTime(detail.authoredAt)}
                            </div>
                        </div>
                        {detail.refs.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-1">
                                {detail.refs.map((reference) => {
                                    const tone = getRefPillStyle(
                                        reference.kind,
                                    );
                                    return (
                                        <span
                                            className={[
                                                "inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono",
                                                tone.className,
                                            ].join(" ")}
                                            key={`${detail.sha}:${reference.label}`}
                                            style={{
                                                fontSize: refFontSize,
                                                ...tone.style,
                                            }}
                                        >
                                            {reference.label}
                                        </span>
                                    );
                                })}
                            </div>
                        ) : null}
                    </div>

                    <IdeActionButton
                        onClick={() => {
                            void openGitTab(projectId, worktreeId);
                            void selectCommit(
                                projectId,
                                tab.commitSha,
                                worktreeId,
                            );
                        }}
                        title="Show this commit in the Git graph"
                    >
                        show in git graph
                    </IdeActionButton>
                </div>

                <div
                    className="text-text-primary"
                    style={{ fontSize: subjectFontSize, lineHeight: 1.5 }}
                >
                    {detail.subject}
                </div>
                {detail.body ? (
                    <div
                        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
                            isBodyCollapsed
                                ? "grid-rows-[0fr] opacity-0"
                                : "grid-rows-[1fr] opacity-100"
                        }`}
                    >
                        <div className="min-h-0 overflow-hidden">
                            <div
                                className="mt-2 text-text-secondary"
                                style={{
                                    fontSize: codeFontSize,
                                    lineHeight: 1.6,
                                }}
                            >
                                <MarkdownContent
                                    chatFontSize={codeFontSize}
                                    content={detail.body}
                                />
                            </div>
                        </div>
                    </div>
                ) : null}

            </header>

            <section className="flex min-h-0 flex-1">
                <GitRevisionDiffView
                    additions={detail.insertions}
                    collapseStorageKey={diffCollapseStorageKey}
                    deletions={detail.deletions}
                    files={detail.files}
                    key={diffCollapseStorageKey}
                    leadingContent={
                        <>
                            <CopyableHash
                                className="rounded px-1 py-0.5 transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                                display={detail.sha.slice(0, 8)}
                                sha={detail.sha}
                            />
                            <button
                                className="rounded px-1 py-0.5 transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                                onClick={() =>
                                    void copyToClipboard(detail.authorEmail)
                                }
                                type="button"
                            >
                                {detail.authorEmail}
                            </button>
                            {remoteLink ? (
                                <button
                                    className="rounded px-1 py-0.5 transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                                    onClick={() =>
                                        openExternalUrl(remoteLink.url)
                                    }
                                    type="button"
                                >
                                    {remoteLink.label}
                                </button>
                            ) : null}
                        </>
                    }
                    onScrollTop={handleCommitScrollTop}
                    scrollRef={commitScrollRef}
                    totalFileCount={detail.changedFileCount}
                />
            </section>
        </div>
    );
}

async function copyToClipboard(value: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(value);
    } catch {
        return;
    }
}

function CopyableHash({
    sha,
    display,
    className,
}: {
    sha: string;
    display: string;
    className?: string;
}) {
    const [copied, setCopied] = useState(false);

    const handleClick = () => {
        void copyToClipboard(sha).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    };

    return (
        <button
            className={className}
            onClick={handleClick}
            title={sha}
            type="button"
        >
            {copied ? "Copied" : display}
        </button>
    );
}
