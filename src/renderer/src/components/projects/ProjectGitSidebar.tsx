import type { ReactNode } from "react";

import {
    SidebarNodeRow,
    type SidebarBadge,
    type SidebarNodeRowAction,
} from "../sidebar/SidebarNodeRow";
import { SidebarSection } from "../sidebar/SidebarSection";

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
    onToggleWorktrees,
    projects,
}: ProjectGitSidebarProps) {
    return (
        <div className={["space-y-3", className].filter(Boolean).join(" ")}>
            {projects.map((project) => (
                <section
                    className="overflow-hidden rounded-lg border border-border bg-bg-panel"
                    key={project.id}
                >
                    <div
                        className={[
                            "group flex items-stretch gap-2 border-b border-border px-2 py-2 transition-colors",
                            project.isActive
                                ? "bg-accent/8"
                                : "hover:bg-bg-secondary/60",
                        ].join(" ")}
                    >
                        <button
                            className="app-no-drag min-w-0 flex-1 text-left"
                            onClick={() => onSelectProject(project.id)}
                            type="button"
                        >
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="truncate text-[13px] font-semibold text-text-primary">
                                    {project.name}
                                </span>
                                {project.isActive ? (
                                    <span className="rounded-full border border-accent/25 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-strong">
                                        Active
                                    </span>
                                ) : null}
                            </div>
                            <div className="truncate text-[11px] text-text-secondary">
                                {project.rootPath}
                            </div>
                        </button>

                        <div className="app-no-drag flex items-start gap-1 pt-0.5">
                            <span className="rounded-full border border-border bg-bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                                {project.worktrees.length} WT
                            </span>
                            <span className="rounded-full border border-border bg-bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                                {project.branches.length} BR
                            </span>
                            <button
                                aria-expanded={project.isExpanded}
                                aria-label={`${project.isExpanded ? "Collapse" : "Expand"} ${project.name}`}
                                className="sidebar-tool-button h-5 w-5 shrink-0"
                                onClick={() => onToggleProject(project.id)}
                                type="button"
                            >
                                <ChevronIcon isExpanded={project.isExpanded} />
                            </button>
                        </div>
                    </div>

                    {project.isExpanded ? (
                        <div className="space-y-3 px-2 py-2.5">
                            <SidebarSection
                                count={project.worktrees.length}
                                emptyState="No worktrees yet."
                                isExpanded={project.worktreesExpanded}
                                onToggleExpanded={() =>
                                    onToggleWorktrees(project.id)
                                }
                                title="Worktrees"
                            >
                                {project.worktrees.map((worktree) => {
                                    const badges = buildWorktreeBadges(worktree);

                                    return (
                                        <SidebarNodeRow
                                            actions={worktree.trailingActions}
                                            badges={badges}
                                            description={
                                                worktree.description ??
                                                worktree.branchName ??
                                                null
                                            }
                                            isActive={worktree.isActive}
                                            key={worktree.id}
                                            leading={<WorktreeGlyph />}
                                            onClick={() =>
                                                onSelectWorktree(
                                                    project.id,
                                                    worktree.id,
                                                )
                                            }
                                            title={worktree.label}
                                        />
                                    );
                                })}
                            </SidebarSection>

                            <SidebarSection
                                count={project.branches.length}
                                emptyState="No branches available."
                                isExpanded={project.branchesExpanded}
                                onToggleExpanded={() =>
                                    onToggleBranches(project.id)
                                }
                                title="Branches"
                            >
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
                                        ...(branch.trailingActions ?? []),
                                    ];

                                    return (
                                        <SidebarNodeRow
                                            actions={actions}
                                            badges={buildBranchBadges(branch)}
                                            description={branch.description}
                                            isActive={branch.isActive}
                                            key={branch.id}
                                            leading={<BranchGlyph />}
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
                            </SidebarSection>
                        </div>
                    ) : null}
                </section>
            ))}
        </div>
    );
}

function buildWorktreeBadges(worktree: ProjectGitSidebarWorktree): SidebarBadge[] {
    const badges: SidebarBadge[] = [];

    if (worktree.status) {
        badges.push({
            label: formatStatusLabel(worktree.status),
            tone: getStatusTone(worktree.status),
        });
    }

    if (typeof worktree.aheadCount === "number" && worktree.aheadCount > 0) {
        badges.push({ label: `+${worktree.aheadCount}`, tone: "success" });
    }

    if (typeof worktree.behindCount === "number" && worktree.behindCount > 0) {
        badges.push({ label: `-${worktree.behindCount}`, tone: "warning" });
    }

    return [...badges, ...(worktree.badges ?? [])];
}

function buildBranchBadges(branch: ProjectGitSidebarBranch): SidebarBadge[] {
    const badges: SidebarBadge[] = [];

    if (branch.isRemote) {
        badges.push({ label: "Remote", tone: "neutral" });
    }

    if (typeof branch.worktreeCount === "number") {
        badges.push({
            label: `${branch.worktreeCount} WT`,
            tone: branch.worktreeCount > 0 ? "accent" : "neutral",
        });
    }

    if (typeof branch.aheadCount === "number" && branch.aheadCount > 0) {
        badges.push({ label: `+${branch.aheadCount}`, tone: "success" });
    }

    if (typeof branch.behindCount === "number" && branch.behindCount > 0) {
        badges.push({ label: `-${branch.behindCount}`, tone: "warning" });
    }

    return [...badges, ...(branch.badges ?? [])];
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

function getStatusTone(
    status: NonNullable<ProjectGitSidebarWorktree["status"]>,
): SidebarBadge["tone"] {
    switch (status) {
        case "clean":
            return "success";
        case "conflicted":
            return "danger";
        case "dirty":
            return "warning";
        case "missing":
            return "neutral";
    }
}

function ChevronIcon({ isExpanded }: { readonly isExpanded: boolean }) {
    return (
        <svg
            aria-hidden="true"
            className={[
                "h-3 w-3 transition-transform duration-150",
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

function WorktreeGlyph() {
    return (
        <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 16 16"
        >
            <path
                d="M4 3.5H8.5C9.60457 3.5 10.5 4.39543 10.5 5.5V6.5C10.5 7.60457 9.60457 8.5 8.5 8.5H6.5C5.39543 8.5 4.5 9.39543 4.5 10.5V12.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.2"
            />
            <circle cx="4" cy="3.5" r="1" stroke="currentColor" strokeWidth="1.2" />
            <circle
                cx="4.5"
                cy="12.5"
                r="1"
                stroke="currentColor"
                strokeWidth="1.2"
            />
            <circle
                cx="12"
                cy="6.5"
                r="1"
                stroke="currentColor"
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
            <circle cx="5" cy="3.5" r="1" stroke="currentColor" strokeWidth="1.2" />
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
