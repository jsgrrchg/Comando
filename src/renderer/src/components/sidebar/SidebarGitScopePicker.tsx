import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";

import type {
    GitBranchSummary,
    GitRepositorySnapshot,
    GitWorktreeSummary,
} from "@shared/ipc";

import { useGitStore } from "@renderer/app/store/git-store";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import { getViewportSafeMenuPosition } from "@renderer/app/utils/menu-position";

import { SidebarNodeRow, type SidebarBadge } from "./SidebarNodeRow";

type GitScopeTabId = "branches" | "worktrees";

interface MenuPosition {
    readonly minWidth: number;
    readonly x: number;
    readonly y: number;
}

interface SidebarGitScopePickerProps {
    readonly projectId: string | null;
    readonly worktreeId: string | null;
}

const EMPTY_BRANCHES: readonly GitBranchSummary[] = [];
const EMPTY_WORKTREES: readonly GitWorktreeSummary[] = [];

export function SidebarGitScopePicker({
    projectId,
    worktreeId,
}: SidebarGitScopePickerProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<GitScopeTabId>("branches");
    const [actionError, setActionError] = useState<string | null>(null);
    const [isBusy, setIsBusy] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
    const [query, setQuery] = useState("");
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);

    const project = useProjectsStore((state) =>
        projectId
            ? state.projects.find((entry) => entry.id === projectId)
            : null,
    );
    const refreshProjectTree = useProjectsStore(
        (state) => state.refreshProjectTree,
    );

    const snapshot = useGitStore((state) =>
        projectId
            ? getProjectSnapshot(state.snapshots, projectId, worktreeId)
            : null,
    );
    const branches = useGitStore((state) =>
        projectId
            ? (state.branchesByProject[projectId] ?? EMPTY_BRANCHES)
            : EMPTY_BRANCHES,
    );
    const checkoutBranch = useGitStore((state) => state.checkoutBranch);
    const refreshGitHistory = useGitStore((state) => state.refreshHistory);
    const refreshGitProject = useGitStore((state) => state.refreshProject);
    const setActiveWorktree = useGitStore((state) => state.setActiveWorktree);

    const activeWorktree =
        snapshot?.worktrees.find((entry) => entry.id === worktreeId) ??
        snapshot?.worktrees.find((entry) => entry.isCurrent) ??
        snapshot?.worktrees.find((entry) => entry.isPrimary) ??
        null;
    const activeBranchName =
        activeWorktree?.branchName ?? snapshot?.branch?.name ?? "Detached HEAD";
    const activeRootPath =
        activeWorktree?.rootPath ?? snapshot?.rootPath ?? null;
    const activeWorktreeLabel = activeWorktree
        ? getWorktreeBadgeLabel(activeWorktree)
        : "No worktree";
    const availableBranches = branches.length;
    const availableWorktrees = snapshot?.worktrees.length ?? 0;

    const filteredBranches = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) {
            return branches;
        }

        return branches.filter((branch) => {
            const linkedWorktree = snapshot?.worktrees.find(
                (entry) => entry.branchName === branch.name,
            );
            const haystack = [
                branch.name,
                branch.upstreamName ?? "",
                linkedWorktree?.rootPath ?? "",
                linkedWorktree?.branchName ?? "",
                branch.isRemote ? "remote" : "local",
            ]
                .join(" ")
                .toLowerCase();

            return haystack.includes(normalizedQuery);
        });
    }, [branches, query, snapshot?.worktrees]);

    const filteredWorktrees = useMemo(() => {
        const worktrees = snapshot?.worktrees ?? EMPTY_WORKTREES;
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) {
            return worktrees;
        }

        return worktrees.filter((entry) =>
            [
                entry.branchName ?? "",
                entry.rootPath,
                entry.commitSha ?? "",
                getWorktreeBadgeLabel(entry),
            ]
                .join(" ")
                .toLowerCase()
                .includes(normalizedQuery),
        );
    }, [query, snapshot?.worktrees]);

    const updateMenuPosition = useCallback(() => {
        const button = buttonRef.current;
        if (!button) {
            return;
        }

        const buttonRect = button.getBoundingClientRect();
        const measuredMenuRect = menuRef.current?.getBoundingClientRect();
        const minWidth = Math.max(280, Math.ceil(buttonRect.width));
        const width = Math.min(
            380,
            Math.max(minWidth, Math.ceil(measuredMenuRect?.width ?? minWidth)),
        );
        const estimatedRows =
            activeTab === "branches"
                ? Math.max(filteredBranches.length, 1)
                : Math.max(filteredWorktrees.length, 1);
        const estimatedHeight = Math.min(
            420,
            estimatedRows * 56 + 144 + (actionError ? 40 : 0),
        );
        const height = Math.ceil(measuredMenuRect?.height ?? estimatedHeight);
        const spaceAbove = buttonRect.top - 8;
        const spaceBelow = window.innerHeight - buttonRect.bottom - 8;
        const openAbove = spaceAbove >= height || spaceAbove > spaceBelow;
        const preferredY = openAbove
            ? buttonRect.top - height - 6
            : buttonRect.bottom + 6;
        const safePosition = getViewportSafeMenuPosition(
            buttonRect.left,
            preferredY,
            width,
            height,
        );

        setMenuPosition({
            minWidth,
            x: safePosition.x,
            y: safePosition.y,
        });
    }, [
        actionError,
        activeTab,
        filteredBranches.length,
        filteredWorktrees.length,
    ]);

    useEffect(() => {
        setActionError(null);
        setQuery("");
        setIsOpen(false);
        setActiveTab("branches");
        setIsBusy(false);
    }, [projectId]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (containerRef.current?.contains(target)) return;
            if (menuRef.current?.contains(target)) return;
            setIsOpen(false);
            setQuery("");
            setActionError(null);
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setIsOpen(false);
                setQuery("");
                setActionError(null);
            }
        };

        document.addEventListener("mousedown", handlePointerDown);
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("mousedown", handlePointerDown);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        const handleViewportChange = () => {
            updateMenuPosition();
        };

        handleViewportChange();
        window.addEventListener("resize", handleViewportChange);
        window.addEventListener("scroll", handleViewportChange, true);
        return () => {
            window.removeEventListener("resize", handleViewportChange);
            window.removeEventListener("scroll", handleViewportChange, true);
        };
    }, [isOpen, updateMenuPosition]);

    useLayoutEffect(() => {
        if (!isOpen) {
            return;
        }

        updateMenuPosition();
    }, [isOpen, updateMenuPosition]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        searchRef.current?.focus();
        searchRef.current?.select();
    }, [activeTab, isOpen]);

    const handleSelectWorktree = useCallback(
        async (nextWorktreeId: string | null) => {
            if (!projectId || isBusy) {
                return;
            }

            if ((worktreeId ?? null) === (nextWorktreeId ?? null)) {
                setIsOpen(false);
                setQuery("");
                setActionError(null);
                return;
            }

            setActionError(null);
            setIsBusy(true);

            try {
                await setActiveWorktree(projectId, nextWorktreeId);
                await Promise.all([
                    refreshGitProject(projectId, nextWorktreeId),
                    refreshGitHistory(projectId, nextWorktreeId),
                    refreshProjectTree(projectId, nextWorktreeId),
                ]);
                setIsOpen(false);
                setQuery("");
            } catch (error) {
                setActionError(
                    error instanceof Error
                        ? error.message
                        : "Could not switch worktrees.",
                );
            } finally {
                setIsBusy(false);
            }
        },
        [
            isBusy,
            projectId,
            refreshGitHistory,
            refreshGitProject,
            refreshProjectTree,
            setActiveWorktree,
            worktreeId,
        ],
    );

    const handleSelectBranch = useCallback(
        async (branch: GitBranchSummary) => {
            if (!projectId || isBusy) {
                return;
            }

            const linkedWorktree =
                snapshot?.worktrees.find(
                    (entry) =>
                        entry.branchName === branch.name &&
                        entry.id !== (worktreeId ?? null),
                ) ?? null;

            if (linkedWorktree) {
                await handleSelectWorktree(linkedWorktree.id);
                return;
            }

            if (branch.isRemote) {
                setActionError(
                    "Remote branches are read-only here for now. Switch from a local branch or create a worktree first.",
                );
                return;
            }

            if (branch.name === snapshot?.branch?.name) {
                setIsOpen(false);
                setQuery("");
                setActionError(null);
                return;
            }

            setActionError(null);
            setIsBusy(true);

            try {
                const result = await checkoutBranch(
                    projectId,
                    branch.name,
                    worktreeId ?? snapshot?.currentWorktreeId ?? null,
                );
                const nextWorktreeId =
                    result.currentWorktreeId ??
                    worktreeId ??
                    snapshot?.currentWorktreeId ??
                    null;
                await refreshProjectTree(projectId, nextWorktreeId);
                setIsOpen(false);
                setQuery("");
            } catch (error) {
                setActionError(
                    error instanceof Error
                        ? error.message
                        : "Could not switch branches.",
                );
            } finally {
                setIsBusy(false);
            }
        },
        [
            checkoutBranch,
            handleSelectWorktree,
            isBusy,
            projectId,
            refreshProjectTree,
            snapshot,
            worktreeId,
        ],
    );

    const branchTabLabel = `Branches (${availableBranches})`;
    const worktreeTabLabel = `Worktrees (${availableWorktrees})`;
    const searchPlaceholder =
        activeTab === "branches" ? "Search branches..." : "Search worktrees...";
    const emptyLabel =
        activeTab === "branches"
            ? "No branches match your search."
            : "No worktrees match your search.";

    return (
        <div className="relative app-no-drag" ref={containerRef}>
            <button
                className={[
                    "sidebar-git-scope-trigger",
                    isOpen ? "sidebar-git-scope-trigger--open" : "",
                ]
                    .filter(Boolean)
                    .join(" ")}
                disabled={!projectId}
                onClick={() => {
                    if (!projectId) {
                        return;
                    }

                    setIsOpen((current) => !current);
                    setActionError(null);
                    setQuery("");
                }}
                ref={buttonRef}
                title={
                    projectId
                        ? activeRootPath
                            ? `${activeBranchName} · ${activeRootPath}`
                            : activeBranchName
                        : "Open a project to select a branch or worktree."
                }
                type="button"
            >
                <div className="sidebar-git-scope-trigger__icon">
                    <BranchGlyph />
                </div>

                <div className="min-w-0 flex-1">
                    <div className="sidebar-git-scope-trigger__title">
                        <span className="truncate">
                            {projectId ? activeBranchName : "Git scope"}
                        </span>
                        <span className="sidebar-git-scope-trigger__badge">
                            {projectId ? activeWorktreeLabel : "Inactive"}
                        </span>
                    </div>
                    <div
                        className="sidebar-git-scope-trigger__subtitle"
                        title={
                            projectId
                                ? (activeRootPath ?? project?.rootPath)
                                : undefined
                        }
                    >
                        {projectId
                            ? (activeRootPath ??
                              project?.rootPath ??
                              "No path available")
                            : "Open a project to select a branch or worktree."}
                    </div>
                </div>

                <ChevronIcon open={isOpen} />
            </button>

            {isOpen
                ? createPortal(
                      <div
                          className="sidebar-git-scope-menu"
                          ref={menuRef}
                          style={{
                              left: menuPosition?.x ?? 8,
                              minWidth: menuPosition?.minWidth ?? 280,
                              top: menuPosition?.y ?? 8,
                          }}
                      >
                          <div className="sidebar-git-scope-menu__header">
                              <div className="sidebar-git-scope-menu__title">
                                  <span className="truncate">
                                      {project?.name ?? "Project"}
                                  </span>
                                  <span className="sidebar-git-scope-menu__path">
                                      {activeRootPath ??
                                          project?.rootPath ??
                                          ""}
                                  </span>
                              </div>
                              <div className="sidebar-git-scope-menu__tabs">
                                  <TabButton
                                      active={activeTab === "branches"}
                                      label={branchTabLabel}
                                      onClick={() => setActiveTab("branches")}
                                  />
                                  <TabButton
                                      active={activeTab === "worktrees"}
                                      label={worktreeTabLabel}
                                      onClick={() => setActiveTab("worktrees")}
                                  />
                              </div>
                              <div className="sidebar-git-scope-menu__search">
                                  <input
                                      autoCapitalize="off"
                                      autoCorrect="off"
                                      className="ide-input app-no-drag w-full text-xs"
                                      onChange={(event) =>
                                          setQuery(event.target.value)
                                      }
                                      onKeyDown={(event) =>
                                          event.stopPropagation()
                                      }
                                      placeholder={searchPlaceholder}
                                      ref={searchRef}
                                      spellCheck={false}
                                      value={query}
                                  />
                              </div>
                          </div>

                          <div className="shell-scrollbar sidebar-git-scope-menu__list">
                              {activeTab === "branches" ? (
                                  filteredBranches.length > 0 ? (
                                      filteredBranches.map((branch) => {
                                          const branchWorktree =
                                              snapshot?.worktrees.find(
                                                  (entry) =>
                                                      entry.branchName ===
                                                      branch.name,
                                              ) ?? null;
                                          const badges = getBranchBadges(
                                              branch,
                                              branchWorktree,
                                              worktreeId,
                                          );

                                          return (
                                              <SidebarNodeRow
                                                  badges={badges}
                                                  className={
                                                      branch.isRemote
                                                          ? "opacity-80"
                                                          : undefined
                                                  }
                                                  description={getBranchDescription(
                                                      branch,
                                                      branchWorktree,
                                                  )}
                                                  isActive={
                                                      !branch.isRemote &&
                                                      branch.name ===
                                                          snapshot?.branch?.name
                                                  }
                                                  key={branch.name}
                                                  leading={<BranchGlyph />}
                                                  onClick={
                                                      isBusy || branch.isRemote
                                                          ? undefined
                                                          : () =>
                                                                void handleSelectBranch(
                                                                    branch,
                                                                )
                                                  }
                                                  title={branch.name}
                                              />
                                          );
                                      })
                                  ) : (
                                      <EmptyState label={emptyLabel} />
                                  )
                              ) : filteredWorktrees.length > 0 ? (
                                  filteredWorktrees.map((entry) => (
                                      <SidebarNodeRow
                                          badges={getWorktreeBadges(entry)}
                                          description={entry.rootPath}
                                          isActive={
                                              entry.id === (worktreeId ?? null)
                                          }
                                          key={entry.id}
                                          leading={<WorktreeGlyph />}
                                          onClick={
                                              isBusy
                                                  ? undefined
                                                  : () =>
                                                        void handleSelectWorktree(
                                                            entry.id,
                                                        )
                                          }
                                          title={
                                              entry.branchName ??
                                              getDetachedWorktreeLabel(entry)
                                          }
                                      />
                                  ))
                              ) : (
                                  <EmptyState label={emptyLabel} />
                              )}
                          </div>

                          {actionError ? (
                              <div className="sidebar-git-scope-menu__status sidebar-git-scope-menu__status--error">
                                  {actionError}
                              </div>
                          ) : null}

                          {isBusy ? (
                              <div className="sidebar-git-scope-menu__status">
                                  Updating git scope…
                              </div>
                          ) : activeTab === "branches" &&
                            branches.some((branch) => branch.isRemote) ? (
                              <div className="sidebar-git-scope-menu__status">
                                  Remote branches are visible, but checkout
                                  stays local in this first pass.
                              </div>
                          ) : null}
                      </div>,
                      document.body,
                  )
                : null}
        </div>
    );
}

function TabButton({
    active,
    label,
    onClick,
}: {
    readonly active: boolean;
    readonly label: string;
    readonly onClick: () => void;
}) {
    return (
        <button
            className={[
                "sidebar-git-scope-menu__tab",
                active ? "sidebar-git-scope-menu__tab--active" : "",
            ]
                .filter(Boolean)
                .join(" ")}
            onClick={onClick}
            type="button"
        >
            {label}
        </button>
    );
}

function EmptyState({ label }: { readonly label: string }) {
    return <div className="sidebar-git-scope-menu__empty">{label}</div>;
}

function getBranchBadges(
    branch: GitBranchSummary,
    branchWorktree: GitWorktreeSummary | null,
    activeWorktreeId: string | null,
): readonly SidebarBadge[] {
    const badges: SidebarBadge[] = [];

    if (branch.isCurrent) {
        badges.push({ label: "Current", tone: "accent" });
    }

    if (branchWorktree && branchWorktree.id !== activeWorktreeId) {
        badges.push({ label: "Worktree", tone: "success" });
    }

    if (branch.isRemote) {
        badges.push({ label: "Remote", tone: "neutral" });
    }

    return badges;
}

function getWorktreeBadges(
    worktree: GitWorktreeSummary,
): readonly SidebarBadge[] {
    const badges: SidebarBadge[] = [];

    if (worktree.isCurrent) {
        badges.push({ label: "Current", tone: "accent" });
    }

    if (worktree.isPrimary) {
        badges.push({ label: "Primary", tone: "neutral" });
    }

    if (worktree.isLocked) {
        badges.push({ label: "Locked", tone: "warning" });
    }

    return badges;
}

function getBranchDescription(
    branch: GitBranchSummary,
    branchWorktree: GitWorktreeSummary | null,
): string {
    if (branchWorktree) {
        return branchWorktree.rootPath;
    }

    const syncBits = [];
    if (branch.upstreamName) {
        syncBits.push(branch.upstreamName);
    }
    if (branch.aheadBy > 0) {
        syncBits.push(`Ahead ${branch.aheadBy}`);
    }
    if (branch.behindBy > 0) {
        syncBits.push(`Behind ${branch.behindBy}`);
    }

    if (syncBits.length > 0) {
        return syncBits.join(" · ");
    }

    return branch.isRemote
        ? "Remote branch"
        : branch.commitSha
          ? `Commit ${branch.commitSha.slice(0, 8)}`
          : "Local branch";
}

function getWorktreeBadgeLabel(worktree: GitWorktreeSummary): string {
    if (worktree.isPrimary) {
        return "Primary";
    }

    return worktree.branchName ?? getDetachedWorktreeLabel(worktree);
}

function getDetachedWorktreeLabel(worktree: GitWorktreeSummary): string {
    return getBaseName(worktree.rootPath) || "Detached";
}

function getBaseName(path: string): string {
    return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

function ChevronIcon({ open }: { readonly open: boolean }) {
    return (
        <svg
            aria-hidden="true"
            className={[
                "h-3 w-3 shrink-0 transition-transform duration-150",
                open ? "rotate-180" : "",
            ].join(" ")}
            fill="none"
            viewBox="0 0 16 16"
        >
            <path
                d="M4.5 6.5 8 10l3.5-3.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.4"
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

function WorktreeGlyph() {
    return (
        <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 16 16"
        >
            <rect
                x="2.5"
                y="2.5"
                width="11"
                height="11"
                rx="1.8"
                stroke="currentColor"
                strokeWidth="1.2"
            />
            <path
                d="M5.2 5.5H10.8"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.2"
            />
            <path
                d="M5.2 8H10.8"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.2"
            />
            <path
                d="M5.2 10.5H8.7"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.2"
            />
        </svg>
    );
}

function getContextKey(projectId: string, worktreeId: string | null): string {
    return `${projectId}::${worktreeId ?? "primary"}`;
}

function getProjectSnapshot(
    snapshots: Record<string, GitRepositorySnapshot | null>,
    projectId: string,
    worktreeId: string | null,
) {
    const directMatch = snapshots[getContextKey(projectId, worktreeId)] ?? null;
    if (directMatch) {
        return directMatch;
    }

    return (
        Object.values(snapshots).find(
            (snapshot) =>
                snapshot?.projectId === projectId &&
                (worktreeId == null ||
                    snapshot.worktrees.some(
                        (entry) => entry.id === worktreeId,
                    )),
        ) ?? null
    );
}
