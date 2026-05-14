import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildGitRemoteCommitLink } from "@renderer/app/git/remote-link";
import { useResolvedEditorSettings } from "@renderer/app/hooks/use-resolved-editor-settings";
import { buildEditorFontFamily } from "@renderer/app/settings/theme";
import { openExternalUrl } from "@renderer/app/utils/external-url";
import {
    convertCommitFilesToDiffFiles,
    formatGitCommitDateTime,
    getRefPillStyle,
} from "@renderer/app/git/history-presentation";
import { useGitStore } from "@renderer/app/store/git-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceGitCommitTab } from "@renderer/app/workspace/tree";
import {
    GitAuthorAvatar,
    GitDiffsView,
    GitEmptyState,
} from "@renderer/components/git";
import { MarkdownContent } from "./MarkdownContent";
import { IdeActionButton } from "./ide-bar";

const EMPTY_LOADING_SHAS: readonly string[] = [];

function getContextKey(projectId: string, worktreeId: string | null): string {
    return `${projectId}::${worktreeId ?? "primary"}`;
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
    const diffFiles = useMemo(
        () => (detail ? convertCommitFilesToDiffFiles(detail.files) : []),
        [detail],
    );
    const remoteLink = buildGitRemoteCommitLink(
        snapshot?.remotes ?? [],
        tab.commitSha,
    );
    const codeFontFamily = buildEditorFontFamily(editorSettings.fontFamily);
    const codeFontSize = editorSettings.fontSize;
    const codeLineHeight = editorSettings.lineHeight;
    const authorFontSize = Math.max(13, Math.round(codeFontSize * 0.92));
    const metadataFontSize = Math.max(11, Math.round(codeFontSize * 0.82));
    const refFontSize = Math.max(10, Math.round(codeFontSize * 0.76));
    const subjectFontSize = Math.max(16, Math.round(codeFontSize * 1.14));

    const [isBodyCollapsed, setIsBodyCollapsed] = useState(false);
    const collapsedRef = useRef(false);

    const diffFileIdsKey = useMemo(
        () => diffFiles.map((file) => file.id).join("|"),
        [diffFiles],
    );
    const [collapsedFileIds, setCollapsedFileIds] = useState<readonly string[]>(
        () => diffFiles.map((file) => file.id),
    );
    const [lastDiffFileIdsKey, setLastDiffFileIdsKey] =
        useState(diffFileIdsKey);

    // Reset collapsed state when the file identity set changes (React's
    // derived-state-from-props pattern: setState during render is cheap and
    // skips an extra effect pass).
    if (lastDiffFileIdsKey !== diffFileIdsKey) {
        setLastDiffFileIdsKey(diffFileIdsKey);
        setCollapsedFileIds(diffFiles.map((file) => file.id));
    }

    const allCollapsed =
        diffFiles.length > 0 && collapsedFileIds.length === diffFiles.length;

    const handleToggleFileCollapse = useCallback((fileId: string) => {
        setCollapsedFileIds((currentIds) =>
            currentIds.includes(fileId)
                ? currentIds.filter((id) => id !== fileId)
                : [...currentIds, fileId],
        );
    }, []);

    const handleToggleAllFiles = useCallback(() => {
        setCollapsedFileIds((currentIds) =>
            currentIds.length === diffFiles.length
                ? []
                : diffFiles.map((file) => file.id),
        );
    }, [diffFiles]);

    const handleDiffScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const shouldCollapse = e.currentTarget.scrollTop > 0;
        if (shouldCollapse !== collapsedRef.current) {
            collapsedRef.current = shouldCollapse;
            setIsBodyCollapsed(shouldCollapse);
        }
    }, []);

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

            <div
                className="px-5 py-1.5"
                style={{
                    backgroundColor: "var(--color-bg-secondary)",
                    borderBottom:
                        "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                    borderTop:
                        "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                    fontFamily: "var(--font-mono)",
                }}
            >
                <div className="flex w-full flex-wrap items-center gap-3 text-[10.5px] text-text-secondary">
                    <CopyableHash
                        className="rounded px-1 py-0.5 transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                        display={detail.sha.slice(0, 8)}
                        sha={detail.sha}
                    />
                    <button
                        className="rounded px-1 py-0.5 transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                        onClick={() => void copyToClipboard(detail.authorEmail)}
                        type="button"
                    >
                        {detail.authorEmail}
                    </button>
                    {remoteLink ? (
                        <button
                            className="rounded px-1 py-0.5 transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                            onClick={() => openExternalUrl(remoteLink.url)}
                            type="button"
                        >
                            {remoteLink.label}
                        </button>
                    ) : null}
                    <div className="ml-auto flex items-center gap-3">
                        {diffFiles.length > 0 ? (
                            <IdeActionButton
                                onClick={handleToggleAllFiles}
                                title={
                                    allCollapsed
                                        ? "Expand all files"
                                        : "Collapse all files"
                                }
                            >
                                {allCollapsed ? "expand all" : "collapse all"}
                            </IdeActionButton>
                        ) : null}
                        <span className="shrink-0">
                            {detail.changedFileCount}{" "}
                            {detail.changedFileCount === 1 ? "file" : "files"}
                        </span>
                        {detail.insertions > 0 ? (
                            <span
                                className="shrink-0"
                                style={{ color: "var(--diff-add)" }}
                            >
                                +{detail.insertions}
                            </span>
                        ) : null}
                        {detail.deletions > 0 ? (
                            <span
                                className="shrink-0"
                                style={{ color: "var(--diff-remove)" }}
                            >
                                -{detail.deletions}
                            </span>
                        ) : null}
                    </div>
                </div>
            </div>

            <section className="flex min-h-0 flex-1 px-3 py-3">
                <GitDiffsView
                    codeFontFamily={codeFontFamily}
                    codeFontSize={codeFontSize}
                    codeLineHeight={codeLineHeight}
                    collapsedFileIds={collapsedFileIds}
                    displayMode="stack"
                    files={diffFiles}
                    lineWrapping={false}
                    onScroll={detail.body ? handleDiffScroll : undefined}
                    onToggleFileCollapse={handleToggleFileCollapse}
                    showFileSelector={false}
                    surfaceVariant="flat"
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
