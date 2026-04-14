import { GitActionButton, GitBadge } from "./GitUi";
import { GitChangesView } from "./GitChangesView";
import { GitDiffsView } from "./GitDiffsView";
import { GitFilesView } from "./GitFilesView";
import type { GitPanelProps, GitPanelTabId } from "./types";

export function GitPanel({
    activeTab,
    changes,
    className,
    diffs,
    files,
    onTabChange,
    tabCounts,
    title = "Git",
    toolbar,
}: GitPanelProps) {
    return (
        <section
            className={["flex h-full min-h-0 flex-col bg-bg-panel", className]
                .filter(Boolean)
                .join(" ")}
        >
            <div className="border-b border-border bg-bg-panel px-3 py-2.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-secondary">
                            {title}
                        </p>
                        {toolbar?.summary?.repositoryName ? (
                            <p className="truncate text-[11px] text-text-secondary">
                                {toolbar.summary.repositoryName}
                            </p>
                        ) : null}
                    </div>
                    {toolbar?.summary ? (
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                            <GitBadge tone="neutral">
                                {toolbar.summary.worktreeName ??
                                    toolbar.summary.worktreePath ??
                                    "worktree"}
                            </GitBadge>
                            <GitBadge
                                tone={
                                    toolbar.summary.detached
                                        ? "warning"
                                        : "neutral"
                                }
                            >
                                {toolbar.summary.detached
                                    ? "detached"
                                    : (toolbar.summary.branchName ?? "branch")}
                            </GitBadge>
                            {toolbar.summary.upstreamName ? (
                                <GitBadge tone="accent">
                                    {toolbar.summary.upstreamName}
                                </GitBadge>
                            ) : null}
                            {toolbar.summary.aheadBy !== null &&
                            toolbar.summary.aheadBy !== undefined ? (
                                <GitBadge tone="success">
                                    +{toolbar.summary.aheadBy}
                                </GitBadge>
                            ) : null}
                            {toolbar.summary.behindBy !== null &&
                            toolbar.summary.behindBy !== undefined ? (
                                <GitBadge tone="danger">
                                    -{toolbar.summary.behindBy}
                                </GitBadge>
                            ) : null}
                            {toolbar.summary.stateLabel ? (
                                <GitBadge tone="warning">
                                    {toolbar.summary.stateLabel}
                                </GitBadge>
                            ) : null}
                        </div>
                    ) : null}
                </div>

                <GitPanelTabs
                    activeTab={activeTab}
                    counts={tabCounts}
                    onTabChange={onTabChange}
                />
            </div>

            {activeTab === "changes" && toolbar ? (
                <div className="border-b border-border bg-bg-panel px-3 py-2">
                    <GitPanelActions
                        primaryActions={toolbar.primaryActions}
                        secondaryActions={toolbar.secondaryActions}
                        syncActions={toolbar.syncActions}
                    />
                </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto">
                {activeTab === "files" ? (
                    <GitFilesView {...files} />
                ) : activeTab === "changes" ? (
                    <GitChangesView {...changes} />
                ) : (
                    <GitDiffsView {...diffs} />
                )}
            </div>

            {activeTab === "changes" && toolbar?.commit ? (
                <GitCommitFooter
                    commit={toolbar.commit}
                    summary={toolbar.summary}
                />
            ) : null}
        </section>
    );
}

export function GitPanelTabs({
    activeTab,
    counts,
    onTabChange,
}: {
    readonly activeTab: GitPanelTabId;
    readonly counts?: Partial<Record<GitPanelTabId, number>>;
    readonly onTabChange: (tab: GitPanelTabId) => void;
}) {
    const tabs: readonly {
        readonly id: GitPanelTabId;
        readonly label: string;
    }[] = [
        { id: "files", label: "Files" },
        { id: "changes", label: "Changes" },
        { id: "diffs", label: "Diffs" },
    ];

    return (
        <div
            aria-label="Git panel tabs"
            className="flex items-center gap-1 rounded-lg border border-border bg-bg-secondary p-1"
            role="tablist"
        >
            {tabs.map((tab) => {
                const isActive = activeTab === tab.id;
                const count = counts?.[tab.id];

                return (
                    <button
                        aria-selected={isActive}
                        className={[
                            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors",
                            isActive
                                ? "bg-bg-elevated text-text-primary shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                                : "text-text-secondary hover:text-text-primary",
                        ].join(" ")}
                        key={tab.id}
                        onClick={() => onTabChange(tab.id)}
                        role="tab"
                        type="button"
                    >
                        <span>{tab.label}</span>
                        {typeof count === "number" ? (
                            <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary">
                                {count}
                            </span>
                        ) : null}
                    </button>
                );
            })}
        </div>
    );
}

function GitPanelActions({
    primaryActions,
    secondaryActions,
    syncActions,
}: Pick<
    NonNullable<GitPanelProps["toolbar"]>,
    "primaryActions" | "secondaryActions" | "syncActions"
>) {
    const hasActions =
        (primaryActions && primaryActions.length > 0) ||
        syncActions?.fetch ||
        syncActions?.pull ||
        syncActions?.push ||
        (secondaryActions && secondaryActions.length > 0);

    if (!hasActions) return null;

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {primaryActions?.map((action) => (
                <GitActionButton action={action} key={action.id} />
            ))}
            {syncActions?.fetch ? (
                <GitActionButton action={syncActions.fetch} key="fetch" />
            ) : null}
            {syncActions?.pull ? (
                <GitActionButton action={syncActions.pull} key="pull" />
            ) : null}
            {syncActions?.push ? (
                <GitActionButton action={syncActions.push} key="push" />
            ) : null}
            {secondaryActions?.map((action) => (
                <GitActionButton action={action} key={action.id} />
            ))}
        </div>
    );
}

function GitCommitFooter({
    commit,
    summary,
}: {
    readonly commit: NonNullable<
        NonNullable<GitPanelProps["toolbar"]>["commit"]
    >;
    readonly summary: NonNullable<GitPanelProps["toolbar"]>["summary"];
}) {
    return (
        <div className="border-t border-border bg-bg-panel px-3 py-3 space-y-2">
            {summary?.branchName ? (
                <div className="flex items-center justify-between text-[11px] text-text-secondary">
                    <span className="truncate font-medium">
                        {summary.repositoryName ?? "repo"} /{" "}
                        {summary.branchName}
                    </span>
                </div>
            ) : null}

            <textarea
                className="ide-input min-h-[60px] resize-y font-mono text-[12px] leading-5"
                disabled={commit.disabled}
                onChange={(event) => commit.onChange(event.target.value)}
                placeholder={commit.placeholder ?? "Enter commit message"}
                rows={commit.lines ?? 3}
                value={commit.message}
            />

            <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 text-[11px] text-text-secondary">
                    {commit.error ? (
                        <span className="text-red-600 dark:text-red-300">
                            {commit.error}
                        </span>
                    ) : commit.hint ? (
                        <span>{commit.hint}</span>
                    ) : null}
                </div>

                <button
                    className={[
                        "inline-flex items-center justify-center rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-[11px] font-medium text-text-primary transition-colors hover:border-[color-mix(in_srgb,var(--color-accent)_26%,var(--color-border))] hover:bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg-elevated))]",
                        commit.disabled ? "cursor-default opacity-60" : "",
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    disabled={commit.disabled}
                    onClick={commit.onCommit}
                    type="button"
                >
                    {commit.commitLabel ?? "Commit"}
                </button>
            </div>
        </div>
    );
}
