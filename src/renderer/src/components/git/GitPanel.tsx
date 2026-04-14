import { GitActionButton } from "./GitUi";
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
    toolbar,
}: GitPanelProps) {
    return (
        <section
            className={["flex h-full min-h-0 flex-col bg-bg-panel", className]
                .filter(Boolean)
                .join(" ")}
        >
            <div className="flex h-7.75 items-center border-b border-border bg-bg-panel px-3">
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
            className="inline-flex h-[25px] items-center gap-0.5 rounded-md border border-border/70 bg-bg-secondary/70 p-0.5"
            role="tablist"
        >
            {tabs.map((tab) => {
                const isActive = activeTab === tab.id;
                const count = counts?.[tab.id];

                return (
                    <button
                        aria-selected={isActive}
                        className={[
                            "inline-flex h-[21px] items-center gap-1 rounded-[7px] px-2.5 text-[11px] font-medium leading-4 transition-colors",
                            isActive
                                ? "bg-bg-elevated text-text-primary"
                                : "text-text-secondary hover:bg-bg-elevated/45 hover:text-text-primary",
                        ].join(" ")}
                        key={tab.id}
                        onClick={() => onTabChange(tab.id)}
                        role="tab"
                        type="button"
                    >
                        <span>{tab.label}</span>
                        {typeof count === "number" ? (
                            <span
                                className={[
                                    "min-w-4 rounded-full px-1.5 py-0 text-center text-[10px] leading-4",
                                    isActive
                                        ? "bg-bg-tertiary text-text-secondary"
                                        : "bg-bg-tertiary/70 text-text-secondary/80",
                                ].join(" ")}
                            >
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
