import { useEffect, useMemo, useState } from "react";

import { buildGitRemoteCommitLink } from "@renderer/app/git/remote-link";
import { useResolvedEditorSettings } from "@renderer/app/hooks/use-resolved-editor-settings";
import { buildEditorFontFamily } from "@renderer/app/settings/theme";
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

function getContextKey(projectId: string, worktreeId: string | null): string {
    return `${projectId}::${worktreeId ?? "primary"}`;
}

export function GitCommitTabView({
    tab,
}: {
    readonly tab: RuntimeWorkspaceGitCommitTab;
}) {
    const ensureCommitDetail = useGitStore((state) => state.ensureCommitDetail);
    const commitDetailsByContext = useGitStore(
        (state) => state.commitDetailsByContext,
    );
    const errors = useGitStore((state) => state.errors);
    const loadingCommitShas = useGitStore((state) => state.loadingCommitShas);
    const snapshots = useGitStore((state) => state.snapshots);
    const openGitTab = useWorkspaceStore((state) => state.openGitTab);
    const selectCommit = useGitStore((state) => state.selectCommit);

    const projectId = tab.projectId;
    const editorSettings = useResolvedEditorSettings(projectId);
    const worktreeId = tab.worktreeId ?? null;
    const contextKey = projectId ? getContextKey(projectId, worktreeId) : null;
    const detail =
        contextKey && projectId
            ? (commitDetailsByContext[contextKey]?.[tab.commitSha] ?? null)
            : null;
    const snapshot = contextKey ? (snapshots[contextKey] ?? null) : null;
    const error = contextKey ? (errors[contextKey] ?? null) : null;
    const isLoading =
        contextKey != null
            ? (loadingCommitShas[contextKey] ?? []).includes(tab.commitSha)
            : false;
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
        <div className="flex h-full min-h-0 flex-col bg-bg-primary">
            <header className="border-b border-border px-5 py-4">
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

                    <button
                        className="ide-button shrink-0 px-2.5 py-1"
                        onClick={() => {
                            void openGitTab(projectId, worktreeId);
                            void selectCommit(
                                projectId,
                                tab.commitSha,
                                worktreeId,
                            );
                        }}
                        type="button"
                    >
                        Show in Git Graph
                    </button>
                </div>

                <div
                    className="text-text-primary"
                    style={{ fontSize: subjectFontSize, lineHeight: 1.5 }}
                >
                    {detail.subject}
                </div>
                {detail.body ? (
                    <div
                        className="mt-2 text-text-secondary"
                        style={{ fontSize: codeFontSize, lineHeight: 1.6 }}
                    >
                        <MarkdownContent
                            chatFontSize={codeFontSize}
                            content={detail.body}
                        />
                    </div>
                ) : null}

                <div
                    className="mt-3 flex flex-wrap items-center gap-2 text-text-secondary"
                    style={{ fontSize: metadataFontSize }}
                >
                    <CopyableHash
                        className="rounded-md border border-border px-2 py-1 font-mono transition-colors hover:bg-bg-secondary hover:text-text-primary"
                        display={detail.sha.slice(0, 8)}
                        sha={detail.sha}
                    />
                    <button
                        className="rounded-md border border-border px-2 py-1 transition-colors hover:bg-bg-secondary hover:text-text-primary"
                        onClick={() => void copyToClipboard(detail.authorEmail)}
                        type="button"
                    >
                        {detail.authorEmail}
                    </button>
                    {remoteLink ? (
                        <button
                            className="rounded-md border border-border px-2 py-1 transition-colors hover:bg-bg-secondary hover:text-text-primary"
                            onClick={() =>
                                window.open(remoteLink.url, "_blank")
                            }
                            type="button"
                        >
                            {remoteLink.label}
                        </button>
                    ) : null}
                    <span className="ml-auto flex items-center gap-1.5">
                        <span>
                            {detail.changedFileCount}{" "}
                            {detail.changedFileCount === 1 ? "file" : "files"}
                        </span>
                        {detail.insertions > 0 ? (
                            <span style={{ color: "var(--diff-add)" }}>
                                +{detail.insertions}
                            </span>
                        ) : null}
                        {detail.deletions > 0 ? (
                            <span style={{ color: "var(--diff-remove)" }}>
                                -{detail.deletions}
                            </span>
                        ) : null}
                    </span>
                </div>
            </header>

            <section className="flex min-h-0 flex-1 px-3 py-3">
                <GitDiffsView
                    codeFontFamily={codeFontFamily}
                    codeFontSize={codeFontSize}
                    codeLineHeight={codeLineHeight}
                    displayMode="stack"
                    files={diffFiles}
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
    } catch (error) {
        console.error(error);
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
