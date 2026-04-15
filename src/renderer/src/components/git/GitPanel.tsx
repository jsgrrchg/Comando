import { useState } from "react";

import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "@renderer/components/context-menu/ContextMenu";

import { GitActionButton } from "./GitUi";
import { GitChangesView } from "./GitChangesView";
import { GitDiffsView } from "./GitDiffsView";
import type { GitPanelProps, GitPanelTabId } from "./types";

export function GitPanel({
    activeTab,
    changes,
    className,
    diffs,
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
                {activeTab === "changes" ? (
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

export function GitCommitFooter({
    commit,
    onOpenHistory,
    summary,
    syncActions,
    syncStatus,
}: {
    readonly commit: NonNullable<
        NonNullable<GitPanelProps["toolbar"]>["commit"]
    >;
    readonly onOpenHistory?: () => void;
    readonly summary: NonNullable<GitPanelProps["toolbar"]>["summary"];
    readonly syncActions?: {
        readonly onFetch?: () => void;
        readonly onPull?: () => void;
        readonly onPush?: () => void;
    } | null;
    readonly syncStatus?: {
        readonly message: string;
        readonly tone: "success" | "error";
    } | null;
}) {
    const canCommit = !commit.disabled && commit.message.trim().length > 0;
    const [syncMenu, setSyncMenu] = useState<ContextMenuState | null>(null);

    const syncMenuEntries: readonly ContextMenuEntry[] = syncActions
        ? [
              ...(syncActions.onFetch
                  ? [
                        {
                            label: "Fetch",
                            action: syncActions.onFetch,
                        } satisfies ContextMenuEntry,
                    ]
                  : []),
              ...(syncActions.onPull
                  ? [
                        {
                            label: "Pull",
                            action: syncActions.onPull,
                        } satisfies ContextMenuEntry,
                    ]
                  : []),
              ...(syncActions.onFetch || syncActions.onPull
                  ? [{ type: "separator" as const } satisfies ContextMenuEntry]
                  : []),
              ...(syncActions.onPush
                  ? [
                        {
                            label: "Push",
                            action: syncActions.onPush,
                        } satisfies ContextMenuEntry,
                    ]
                  : []),
          ]
        : [];

    return (
        <div className="border-t border-border px-3 py-3 space-y-1.5">
            {summary?.branchName ? (
                <div className="flex items-center justify-between text-[11px] text-text-secondary">
                    <span className="flex min-w-0 items-center gap-2 font-medium">
                        <span className="truncate">
                            {summary.repositoryName ?? "repo"} /{" "}
                            {summary.branchName}
                        </span>
                        {syncStatus ? (
                            <span
                                style={{
                                    fontSize: 10,
                                    fontWeight: 500,
                                    flexShrink: 0,
                                    color:
                                        syncStatus.tone === "success"
                                            ? "var(--color-status-added, #22c55e)"
                                            : "var(--color-status-deleted, #ef4444)",
                                }}
                            >
                                {syncStatus.message}
                            </span>
                        ) : null}
                    </span>
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 2,
                            flexShrink: 0,
                        }}
                    >
                        {syncActions && syncMenuEntries.length > 0 ? (
                            <button
                                onClick={(e) => {
                                    const rect =
                                        e.currentTarget.getBoundingClientRect();
                                    setSyncMenu({
                                        x: rect.right,
                                        y: rect.top,
                                        payload: undefined,
                                    });
                                }}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: 22,
                                    height: 22,
                                    borderRadius: 5,
                                    border: "none",
                                    background: "transparent",
                                    color: "var(--color-text-secondary)",
                                    cursor: "pointer",
                                    flexShrink: 0,
                                    padding: 0,
                                    transition: "all 120ms ease",
                                }}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.background =
                                        "var(--color-bg-tertiary)";
                                    e.currentTarget.style.color =
                                        "var(--color-text-primary)";
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.background =
                                        "transparent";
                                    e.currentTarget.style.color =
                                        "var(--color-text-secondary)";
                                }}
                                title="Sync actions"
                                type="button"
                            >
                                <svg
                                    fill="none"
                                    height="13"
                                    viewBox="0 0 16 16"
                                    width="13"
                                >
                                    <path
                                        d="M4.5 2v4.5M4.5 2L2 4.5M4.5 2L7 4.5"
                                        stroke="currentColor"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="1.3"
                                    />
                                    <path
                                        d="M11.5 14v-4.5M11.5 14L9 11.5M11.5 14L14 11.5"
                                        stroke="currentColor"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="1.3"
                                    />
                                    <path
                                        d="M4.5 6.5v3c0 1.1.9 2 2 2h5"
                                        stroke="currentColor"
                                        strokeLinecap="round"
                                        strokeWidth="1.3"
                                    />
                                    <path
                                        d="M11.5 9.5v-3c0-1.1-.9-2-2-2h-5"
                                        stroke="currentColor"
                                        strokeLinecap="round"
                                        strokeWidth="1.3"
                                    />
                                </svg>
                            </button>
                        ) : null}

                        {onOpenHistory ? (
                            <button
                                onClick={onOpenHistory}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: 22,
                                    height: 22,
                                    borderRadius: 5,
                                    border: "none",
                                    background: "transparent",
                                    color: "var(--color-text-secondary)",
                                    cursor: "pointer",
                                    flexShrink: 0,
                                    padding: 0,
                                    transition: "all 120ms ease",
                                }}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.background =
                                        "var(--color-bg-tertiary)";
                                    e.currentTarget.style.color =
                                        "var(--color-text-primary)";
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.background =
                                        "transparent";
                                    e.currentTarget.style.color =
                                        "var(--color-text-secondary)";
                                }}
                                title="View commit history"
                                type="button"
                            >
                                <svg
                                    fill="none"
                                    height="13"
                                    viewBox="0 0 16 16"
                                    width="13"
                                >
                                    <circle
                                        cx="4"
                                        cy="4"
                                        r="1.8"
                                        stroke="currentColor"
                                        strokeWidth="1.3"
                                    />
                                    <circle
                                        cx="12"
                                        cy="4"
                                        r="1.8"
                                        stroke="currentColor"
                                        strokeWidth="1.3"
                                    />
                                    <circle
                                        cx="8"
                                        cy="13"
                                        r="1.8"
                                        stroke="currentColor"
                                        strokeWidth="1.3"
                                    />
                                    <path
                                        d="M4 5.8V8.5C4 9.6 4.9 10.5 6 10.5H8M12 5.8V8.5C12 9.6 11.1 10.5 10 10.5H8"
                                        stroke="currentColor"
                                        strokeLinecap="round"
                                        strokeWidth="1.3"
                                    />
                                </svg>
                            </button>
                        ) : null}
                    </div>
                </div>
            ) : null}

            <div
                className="commit-composer"
                style={{
                    display: "flex",
                    flexDirection: "column",
                    border: "1px solid var(--color-border)",
                    borderRadius: 10,
                    background: "var(--color-bg-elevated)",
                    transition:
                        "border-color 120ms ease, background-color 120ms ease",
                    overflow: "hidden",
                }}
            >
                <textarea
                    autoCapitalize="off"
                    autoCorrect="off"
                    disabled={commit.disabled}
                    onChange={(event) => commit.onChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (
                            event.key === "Enter" &&
                            (event.metaKey || event.ctrlKey) &&
                            canCommit
                        ) {
                            event.preventDefault();
                            commit.onCommit();
                        }
                    }}
                    placeholder={commit.placeholder ?? "Enter commit message"}
                    rows={commit.lines ?? 2}
                    spellCheck={false}
                    value={commit.message}
                    style={{
                        width: "100%",
                        minHeight: 48,
                        resize: "none",
                        border: "none",
                        outline: "none",
                        background: "transparent",
                        padding: "10px 12px 4px",
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: 12,
                        lineHeight: 1.5,
                        color: "var(--color-text-primary)",
                    }}
                />

                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "2px 6px 6px",
                    }}
                >
                    <div className="min-w-0 px-1 text-[10px] text-text-secondary">
                        {commit.error ? (
                            <span className="text-red-600 dark:text-red-300">
                                {commit.error}
                            </span>
                        ) : commit.hint ? (
                            <span>{commit.hint}</span>
                        ) : null}
                    </div>

                    <button
                        disabled={!canCommit}
                        onClick={commit.onCommit}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 26,
                            height: 26,
                            borderRadius: "50%",
                            border: "none",
                            backgroundColor: canCommit
                                ? "var(--color-accent)"
                                : "transparent",
                            color: canCommit
                                ? "#fff"
                                : "var(--color-text-secondary)",
                            cursor: canCommit ? "pointer" : "default",
                            opacity: canCommit ? 1 : 0.4,
                            flexShrink: 0,
                            transition: "all 0.15s ease",
                            padding: 0,
                        }}
                        title={
                            canCommit
                                ? `${commit.commitLabel ?? "Commit"} (⌘↵)`
                                : "Enter a commit message"
                        }
                        type="button"
                    >
                        <svg
                            fill="none"
                            height="14"
                            viewBox="0 0 16 16"
                            width="14"
                        >
                            <path
                                d="M8 12.5V3.5M8 3.5L4 7.5M8 3.5L12 7.5"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="1.8"
                            />
                        </svg>
                    </button>
                </div>
            </div>

            {syncMenu ? (
                <ContextMenu
                    entries={syncMenuEntries}
                    onClose={() => setSyncMenu(null)}
                    menu={syncMenu}
                />
            ) : null}
        </div>
    );
}
