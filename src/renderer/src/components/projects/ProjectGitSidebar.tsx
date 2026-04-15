import type { ReactNode } from "react";

import {
    SidebarNodeRow,
    type SidebarBadge,
    type SidebarNodeRowAction,
} from "../sidebar/SidebarNodeRow";

export interface ProjectGitSidebarProject {
    readonly branches: readonly ProjectGitSidebarBranch[];
    readonly branchesExpanded: boolean;
    readonly id: string;
    readonly isActive: boolean;
    readonly isExpanded: boolean;
    readonly name: string;
    readonly rootPath: string;
    readonly worktrees: readonly ProjectGitSidebarWorktree[];
    readonly worktreesExpanded: boolean;
}

export interface ProjectGitSidebarWorktree {
    readonly aheadCount?: number | null;
    readonly badges?: readonly SidebarBadge[];
    readonly behindCount?: number | null;
    readonly branchName?: string | null;
    readonly description?: ReactNode;
    readonly id: string;
    readonly isActive: boolean;
    readonly label: string;
    readonly status?: "clean" | "conflicted" | "dirty" | "missing";
    readonly trailingActions?: readonly SidebarNodeRowAction[];
}

export interface ProjectGitSidebarBranch {
    readonly aheadCount?: number | null;
    readonly badges?: readonly SidebarBadge[];
    readonly behindCount?: number | null;
    readonly description?: ReactNode;
    readonly id: string;
    readonly isActive: boolean;
    readonly isRemote?: boolean;
    readonly label: string;
    readonly trailingActions?: readonly SidebarNodeRowAction[];
    readonly worktreeCount?: number | null;
}

interface ProjectGitSidebarProps {
    readonly className?: string;
    readonly onCheckoutBranch?: (projectId: string, branchId: string) => void;
    readonly onCreateWorktreeFromBranch?: (
        projectId: string,
        branchId: string,
    ) => void;
    readonly onSelectBranch: (projectId: string, branchId: string) => void;
    readonly onSelectProject: (projectId: string) => void;
    readonly onSelectWorktree: (projectId: string, worktreeId: string) => void;
    readonly onToggleBranches: (projectId: string) => void;
    readonly onToggleProject: (projectId: string) => void;
    readonly onToggleWorktrees: (projectId: string) => void;
    readonly projects: readonly ProjectGitSidebarProject[];
}

export function ProjectGitSidebar({
    className,
    onCheckoutBranch,
    onCreateWorktreeFromBranch,
    onSelectBranch,
    onSelectProject,
    onSelectWorktree,
    onToggleBranches,
    onToggleProject,
    projects,
}: ProjectGitSidebarProps) {
    return (
        <div className={["space-y-4", className].filter(Boolean).join(" ")}>
            {projects.map((project) => (
                <div key={project.id}>
                    <button
                        className={[
                            "app-no-drag group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors",
                            project.isActive
                                ? "text-accent-strong"
                                : "text-text-secondary hover:text-text-primary",
                        ].join(" ")}
                        onClick={() => {
                            if (project.isActive) {
                                onToggleProject(project.id);
                                return;
                            }

                            onSelectProject(project.id);
                        }}
                        type="button"
                    >
                        <ChevronIcon isExpanded={project.isExpanded} />
                        <FolderIcon />
                        <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em]">
                            {project.name}
                        </span>
                    </button>

                    {project.isExpanded ? (
                        <div className="mt-0.5 space-y-px">
                            {project.worktrees.map((worktree) => (
                                <button
                                    className={[
                                        "app-no-drag flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
                                        worktree.isActive
                                            ? "bg-accent/10 font-medium text-accent-strong"
                                            : "text-text-primary hover:bg-bg-secondary/80",
                                    ].join(" ")}
                                    key={worktree.id}
                                    onClick={() =>
                                        onSelectWorktree(
                                            project.id,
                                            worktree.id,
                                        )
                                    }
                                    style={{ paddingLeft: 28 }}
                                    type="button"
                                >
                                    <span className="min-w-0 flex-1 truncate">
                                        {worktree.label}
                                    </span>
                                    <StatusDot status={worktree.status} />
                                </button>
                            ))}

                            {project.worktrees.length === 0 ? (
                                <div className="px-7 py-1 text-[11px] text-text-secondary">
                                    No worktrees
                                </div>
                            ) : null}

                            {project.branches.length > 0 ? (
                                <div className="mt-1">
                                    <button
                                        className="app-no-drag flex w-full items-center gap-1.5 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-text-secondary hover:text-text-primary"
                                        onClick={() =>
                                            onToggleBranches(project.id)
                                        }
                                        style={{ paddingLeft: 28 }}
                                        type="button"
                                    >
                                        <ChevronIcon
                                            isExpanded={
                                                project.branchesExpanded
                                            }
                                        />
                                        <span>Branches</span>
                                        <span className="text-text-secondary/60">
                                            {project.branches.length}
                                        </span>
                                    </button>

                                    {project.branchesExpanded ? (
                                        <div className="space-y-px">
                                            {project.branches.map((branch) => {
                                                const actions = [
                                                    ...(onCheckoutBranch
                                                        ? [
                                                              {
                                                                  label: "Checkout",
                                                                  onClick: () =>
                                                                      onCheckoutBranch(
                                                                          project.id,
                                                                          branch.id,
                                                                      ),
                                                              },
                                                          ]
                                                        : []),
                                                    ...(onCreateWorktreeFromBranch
                                                        ? [
                                                              {
                                                                  label: "Worktree",
                                                                  onClick: () =>
                                                                      onCreateWorktreeFromBranch(
                                                                          project.id,
                                                                          branch.id,
                                                                      ),
                                                              },
                                                          ]
                                                        : []),
                                                    ...(branch.trailingActions ??
                                                        []),
                                                ];

                                                return (
                                                    <SidebarNodeRow
                                                        actions={actions}
                                                        depth={2}
                                                        description={
                                                            branch.description
                                                        }
                                                        isActive={
                                                            branch.isActive
                                                        }
                                                        key={branch.id}
                                                        leading={
                                                            <BranchGlyph />
                                                        }
                                                        onClick={() =>
                                                            onSelectBranch(
                                                                project.id,
                                                                branch.id,
                                                            )
                                                        }
                                                        title={branch.label}
                                                    />
                                                );
                                            })}
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ))}
        </div>
    );
}

function StatusDot({
    status,
}: {
    readonly status?: ProjectGitSidebarWorktree["status"];
}) {
    if (!status) return null;

    const colorStyles: Record<NonNullable<typeof status>, string> = {
        clean: "var(--diff-add)",
        conflicted: "var(--diff-remove)",
        dirty: "var(--diff-warn)",
        missing: "var(--color-text-secondary)",
    };

    return (
        <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: colorStyles[status] }}
            title={formatStatusLabel(status)}
        />
    );
}

function formatStatusLabel(
    status: NonNullable<ProjectGitSidebarWorktree["status"]>,
): string {
    switch (status) {
        case "clean":
            return "Clean";
        case "conflicted":
            return "Conflict";
        case "dirty":
            return "Dirty";
        case "missing":
            return "Missing";
    }
}

function ChevronIcon({ isExpanded }: { readonly isExpanded: boolean }) {
    return (
        <svg
            aria-hidden="true"
            className={[
                "h-3 w-3 shrink-0 transition-transform duration-150",
                isExpanded ? "rotate-90" : "",
            ].join(" ")}
            fill="none"
            viewBox="0 0 16 16"
        >
            <path
                d="M6 4L10 8L6 12"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.4"
            />
        </svg>
    );
}

function FolderIcon() {
    return (
        <svg
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0"
            fill="none"
            viewBox="0 0 16 16"
        >
            <path
                d="M2 4.5C2 3.67 2.67 3 3.5 3H6.29a1 1 0 0 1 .7.29L8 4.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5V4.5Z"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth="1.2"
            />
        </svg>
    );
}

function BranchGlyph() {
    return (
        <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 16 16"
        >
            <path
                d="M5 3.5V9.2C5 10.2 5.8 11 6.8 11H10.2C11.2 11 12 11.8 12 12.8V12.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.2"
            />
            <circle
                cx="5"
                cy="3.5"
                r="1"
                stroke="currentColor"
                strokeWidth="1.2"
            />
            <circle
                cx="5"
                cy="12.5"
                r="1"
                stroke="currentColor"
                strokeWidth="1.2"
            />
            <circle
                cx="12"
                cy="12.5"
                r="1"
                stroke="currentColor"
                strokeWidth="1.2"
            />
        </svg>
    );
}
