import { useEffect, useMemo, useState } from "react";

import type {
    GitHubAuthStatus,
    GitHubNotificationSummary,
    GitHubReleaseSummary,
    GitHubRepositoryRef,
} from "@shared/ipc";

import {
    EMPTY_GITHUB_LIST,
    EMPTY_GITHUB_RECORD,
    getGitHubRepoKey,
    useGitHubStore,
} from "@renderer/app/store/github-store";

import {
    formatGitHubDateTime,
    formatGitHubRelativeTime,
    GitHubDraftPreview,
    GitHubEmptyState,
    GitHubErrorState,
    GitHubSectionLabel,
    openGitHubWebUrl,
} from "./GitHubWorkspacePrimitives";
import { IdeActionButton } from "./ide-bar";

export function GitHubCoordinationPanel({
    authStatus,
    repo,
}: {
    readonly authStatus: GitHubAuthStatus | null;
    readonly repo: GitHubRepositoryRef;
}) {
    const repoKey = getGitHubRepoKey(repo);
    const host = repo.host.toLowerCase();
    const notifications = useGitHubStore(
        (state) => state.notificationsByHost[host] ?? EMPTY_GITHUB_LIST,
    );
    const releases = useGitHubStore(
        (state) => state.releasesByRepo[repoKey] ?? EMPTY_GITHUB_LIST,
    );
    const releaseNotesByTag = useGitHubStore(
        (state) =>
            state.generatedReleaseNotesByRepo[repoKey] ?? EMPTY_GITHUB_RECORD,
    );
    const milestones = useGitHubStore(
        (state) => state.milestonesByRepo[repoKey] ?? EMPTY_GITHUB_LIST,
    );
    const loadingKeys = useGitHubStore((state) => state.loadingKeys);
    const mutatingKeys = useGitHubStore((state) => state.mutatingKeys);
    const errors = useGitHubStore((state) => state.errors);
    const refreshNotifications = useGitHubStore(
        (state) => state.refreshNotifications,
    );
    const refreshReleases = useGitHubStore((state) => state.refreshReleases);
    const generateReleaseNotes = useGitHubStore(
        (state) => state.generateReleaseNotes,
    );
    const createRelease = useGitHubStore((state) => state.createRelease);
    const publishRelease = useGitHubStore((state) => state.publishRelease);
    const refreshMilestones = useGitHubStore(
        (state) => state.refreshMilestones,
    );
    const [tagName, setTagName] = useState("");
    const [releaseName, setReleaseName] = useState("");
    const [releaseBody, setReleaseBody] = useState("");
    const [targetCommitish, setTargetCommitish] = useState("");
    const [previousTagName, setPreviousTagName] = useState("");
    const [isExpanded, setIsExpanded] = useState(false);
    const canCoordinate = authStatus?.state === "authenticated";
    const canWriteReleases = canCoordinate && !authStatus.readOnly;
    const currentRepoNotifications = useMemo(
        () =>
            notifications.filter(
                (notification) =>
                    notification.repository.owner.toLowerCase() ===
                        repo.owner.toLowerCase() &&
                    notification.repository.repo.toLowerCase() ===
                        repo.repo.toLowerCase(),
            ),
        [notifications, repo.owner, repo.repo],
    );
    const coordinationError =
        errors[`notifications:${host}`] ??
        errors[`${repoKey}:releases`] ??
        errors[`${repoKey}:milestones`] ??
        errors[`${repoKey}:release:create:${tagName.trim()}`] ??
        null;
    const generatedNotes = tagName.trim()
        ? releaseNotesByTag[tagName.trim()]
        : null;

    useEffect(() => {
        if (!canCoordinate || !isExpanded) {
            return;
        }

        void refreshNotifications(repo).catch(() => undefined);
        void refreshReleases(repo).catch(() => undefined);
        void refreshMilestones(repo).catch(() => undefined);
    }, [
        canCoordinate,
        isExpanded,
        repo,
        refreshMilestones,
        refreshNotifications,
        refreshReleases,
    ]);

    const handleRefresh = async () => {
        await Promise.all([
            refreshNotifications(repo),
            refreshReleases(repo, { force: true }),
            refreshMilestones(repo, { force: true }),
        ]);
    };

    const handleGenerateNotes = async () => {
        const tag = tagName.trim();
        if (!tag) {
            return;
        }

        const notes = await generateReleaseNotes(repo, {
            previousTagName: previousTagName.trim() || null,
            tagName: tag,
            targetCommitish: targetCommitish.trim() || null,
        });
        setReleaseName(notes.name);
        setReleaseBody(notes.body);
    };

    const handleCreateDraftRelease = async () => {
        const tag = tagName.trim();
        if (!tag || !canWriteReleases) {
            return;
        }
        if (!window.confirm(`Create draft release ${tag}?`)) {
            return;
        }

        const release = await createRelease(repo, {
            body: releaseBody.trim() || null,
            draft: true,
            name: releaseName.trim() || null,
            prerelease: false,
            tagName: tag,
            targetCommitish: targetCommitish.trim() || null,
        });
        setTagName("");
        setReleaseName("");
        setReleaseBody("");
        setPreviousTagName("");
        setTargetCommitish("");
        openGitHubWebUrl(release.url);
    };

    const handlePublishRelease = async (release: GitHubReleaseSummary) => {
        if (!canWriteReleases) {
            return;
        }
        if (!window.confirm(`Publish release ${release.tagName}?`)) {
            return;
        }

        await publishRelease(repo, release.id);
    };

    return (
        <section className="rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary">
            <button
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                onClick={() => setIsExpanded((value) => !value)}
                type="button"
            >
                <div>
                    <GitHubSectionLabel>Coordination</GitHubSectionLabel>
                    <div className="mt-1 text-[10px] text-text-secondary">
                        Inbox, releases and milestones
                    </div>
                </div>
                <span className="text-[10px] text-text-secondary">
                    {isExpanded ? "Hide" : "Show"}
                </span>
            </button>
            {isExpanded ? (
                <div className="space-y-4 border-t border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] p-3">
                    {coordinationError ? (
                        <GitHubErrorState>{coordinationError}</GitHubErrorState>
                    ) : null}
                    {!canCoordinate ? (
                        <GitHubEmptyState>
                            Connect GitHub to load coordination data.
                        </GitHubEmptyState>
                    ) : (
                        <>
                            <div className="flex justify-end">
                                <IdeActionButton
                                    disabled={
                                        loadingKeys[`notifications:${host}`] ??
                                        false
                                    }
                                    onClick={() => void handleRefresh()}
                                >
                                    Refresh Coordination
                                </IdeActionButton>
                            </div>
                            <InboxSection
                                notifications={currentRepoNotifications}
                            />
                            <ReleasesSection
                                canWrite={canWriteReleases}
                                createDraftRelease={() =>
                                    void handleCreateDraftRelease()
                                }
                                generateNotes={() => void handleGenerateNotes()}
                                generatedNotes={generatedNotes}
                                isCreating={
                                    mutatingKeys[
                                        `${repoKey}:release:create:${tagName.trim()}`
                                    ] ?? false
                                }
                                previousTagName={previousTagName}
                                publishRelease={(release) =>
                                    void handlePublishRelease(release)
                                }
                                releaseBody={releaseBody}
                                releaseName={releaseName}
                                releases={releases}
                                setPreviousTagName={setPreviousTagName}
                                setReleaseBody={setReleaseBody}
                                setReleaseName={setReleaseName}
                                setTagName={setTagName}
                                setTargetCommitish={setTargetCommitish}
                                tagName={tagName}
                                targetCommitish={targetCommitish}
                            />
                            <MilestonesSection milestones={milestones} />
                        </>
                    )}
                </div>
            ) : null}
        </section>
    );
}

function InboxSection({
    notifications,
}: {
    readonly notifications: readonly GitHubNotificationSummary[];
}) {
    return (
        <section className="space-y-2">
            <SectionTitle
                subtitle="Unread notifications for this repository"
                title="Inbox"
            />
            {notifications.length === 0 ? (
                <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[11px] text-text-secondary">
                    No current notifications for this repository.
                </div>
            ) : (
                <div className="overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary">
                    {notifications.slice(0, 8).map((notification) => (
                        <button
                            className="flex w-full items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] border-l-[3px] border-l-transparent pl-2.5 pr-3 py-2 text-left text-[11px] transition last:border-b-0 hover:border-l-[color-mix(in_srgb,var(--color-accent)_60%,transparent)] hover:bg-bg-secondary"
                            key={notification.id}
                            onClick={() =>
                                openGitHubWebUrl(
                                    notification.subject.latestCommentUrl ??
                                        notification.subject.url ??
                                        notification.url,
                                )
                            }
                            type="button"
                        >
                            <div className="min-w-0">
                                <div className="truncate text-text-primary">
                                    {notification.subject.title}
                                </div>
                                <div className="mt-0.5 text-[10px] text-text-secondary">
                                    {notification.reason} ·{" "}
                                    {notification.subject.type}
                                </div>
                            </div>
                            <span className="shrink-0 text-[10px] text-text-secondary">
                                {formatGitHubRelativeTime(
                                    notification.updatedAt,
                                )}
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </section>
    );
}

function ReleasesSection({
    canWrite,
    createDraftRelease,
    generateNotes,
    generatedNotes,
    isCreating,
    previousTagName,
    publishRelease,
    releaseBody,
    releaseName,
    releases,
    setPreviousTagName,
    setReleaseBody,
    setReleaseName,
    setTagName,
    setTargetCommitish,
    tagName,
    targetCommitish,
}: {
    readonly canWrite: boolean;
    readonly createDraftRelease: () => void;
    readonly generateNotes: () => void;
    readonly generatedNotes: { readonly body: string; readonly name: string } | null | undefined;
    readonly isCreating: boolean;
    readonly previousTagName: string;
    readonly publishRelease: (release: GitHubReleaseSummary) => void;
    readonly releaseBody: string;
    readonly releaseName: string;
    readonly releases: readonly GitHubReleaseSummary[];
    readonly setPreviousTagName: (value: string) => void;
    readonly setReleaseBody: (value: string) => void;
    readonly setReleaseName: (value: string) => void;
    readonly setTagName: (value: string) => void;
    readonly setTargetCommitish: (value: string) => void;
    readonly tagName: string;
    readonly targetCommitish: string;
}) {
    return (
        <section className="space-y-3">
            <SectionTitle
                subtitle="Draft releases stay unpublished until confirmed"
                title="Releases"
            />
            <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary p-3">
                <div className="grid gap-2 md:grid-cols-2">
                    <input
                        className="h-[22px] rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary px-2 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                        onChange={(event) => setTagName(event.currentTarget.value)}
                        placeholder="Tag name, e.g. v1.2.3"
                        value={tagName}
                    />
                    <input
                        className="h-[22px] rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary px-2 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                        onChange={(event) =>
                            setTargetCommitish(event.currentTarget.value)
                        }
                        placeholder="Target commitish (optional)"
                        value={targetCommitish}
                    />
                    <input
                        className="h-[22px] rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary px-2 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                        onChange={(event) =>
                            setPreviousTagName(event.currentTarget.value)
                        }
                        placeholder="Previous tag (optional)"
                        value={previousTagName}
                    />
                    <input
                        className="h-[22px] rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary px-2 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                        onChange={(event) =>
                            setReleaseName(event.currentTarget.value)
                        }
                        placeholder="Release name"
                        value={releaseName}
                    />
                </div>
                <textarea
                    className="mt-2 min-h-28 w-full resize-y rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary px-3 py-2 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                    onChange={(event) => setReleaseBody(event.currentTarget.value)}
                    placeholder="Release notes..."
                    value={releaseBody}
                />
                <div className="mt-3">
                    <GitHubDraftPreview
                        body={releaseBody || generatedNotes?.body || ""}
                        meta={tagName.trim() || "No tag selected"}
                        title={releaseName || generatedNotes?.name || ""}
                    />
                </div>
                <div className="mt-3 flex justify-end gap-2">
                    <IdeActionButton
                        disabled={tagName.trim().length === 0}
                        onClick={generateNotes}
                    >
                        Generate Notes
                    </IdeActionButton>
                    <IdeActionButton
                        disabled={
                            !canWrite ||
                            isCreating ||
                            tagName.trim().length === 0
                        }
                        onClick={createDraftRelease}
                    >
                        {isCreating ? "Creating..." : "Create Draft Release"}
                    </IdeActionButton>
                </div>
            </div>
            <div className="overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary">
                {releases.slice(0, 6).map((release) => (
                    <div
                        className="flex items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] border-l-[3px] border-l-transparent pl-2.5 pr-3 py-2 text-[11px] transition last:border-b-0 hover:border-l-[color-mix(in_srgb,var(--color-accent)_60%,transparent)] hover:bg-bg-secondary"
                        key={release.id}
                    >
                        <button
                            className="min-w-0 text-left"
                            onClick={() => openGitHubWebUrl(release.url)}
                            type="button"
                        >
                            <div className="truncate text-text-primary">
                                {release.name ?? release.tagName}
                            </div>
                            <div className="mt-0.5 text-[10px] text-text-secondary">
                                {release.draft ? "draft" : "published"} ·{" "}
                                {formatGitHubDateTime(
                                    release.publishedAt ?? release.updatedAt,
                                )}
                            </div>
                        </button>
                        {release.draft ? (
                            <IdeActionButton
                                disabled={!canWrite}
                                onClick={() => publishRelease(release)}
                            >
                                Publish
                            </IdeActionButton>
                        ) : null}
                    </div>
                ))}
                {releases.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-text-secondary">
                        No releases found yet.
                    </div>
                ) : null}
            </div>
        </section>
    );
}

function MilestonesSection({
    milestones,
}: {
    readonly milestones: readonly {
        readonly dueOn: string | null;
        readonly number: number;
        readonly state: string;
        readonly title: string;
    }[];
}) {
    return (
        <section className="space-y-2">
            <SectionTitle
                subtitle="Read-only planning state; item moves stay out of this phase"
                title="Milestones"
            />
            <div className="grid gap-2 md:grid-cols-2">
                {milestones.slice(0, 8).map((milestone) => (
                    <div
                        className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[11px]"
                        key={milestone.number}
                    >
                        <div className="truncate text-text-primary">
                            {milestone.title}
                        </div>
                        <div className="mt-1 text-[10px] text-text-secondary">
                            {milestone.state} · due{" "}
                            {milestone.dueOn
                                ? formatGitHubDateTime(milestone.dueOn)
                                : "not set"}
                        </div>
                    </div>
                ))}
            </div>
            {milestones.length === 0 ? (
                <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[11px] text-text-secondary">
                    No milestones found.
                </div>
            ) : null}
        </section>
    );
}

function SectionTitle({
    subtitle,
    title,
}: {
    readonly subtitle: string;
    readonly title: string;
}) {
    return (
        <div>
            <GitHubSectionLabel>{title}</GitHubSectionLabel>
            <div className="mt-0.5 text-[10px] text-text-secondary">
                {subtitle}
            </div>
        </div>
    );
}
