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

interface RemoteBranchResolution {
    readonly hasSuggestedNameConflict: boolean;
    readonly linkedWorktree: GitWorktreeSummary | null;
    readonly localBranch: GitBranchSummary | null;
    readonly suggestedLocalBranchName: string;
}

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
    const [focusIndex, setFocusIndex] = useState(-1);
    const [collapsedSections, setCollapsedSections] = useState<
        Record<string, boolean>
    >({});
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

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
    const createWorktree = useGitStore((state) => state.createWorktree);
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
    const availableBranches = branches.length;
    const availableWorktrees = snapshot?.worktrees.length ?? 0;

    const filteredBranches = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) {
            return branches;
        }

        return branches.filter((branch) => {
            const linkedWorktree = branch.isRemote
                ? resolveRemoteBranchResolution(
                      branch,
                      branches,
                      snapshot?.worktrees ?? EMPTY_WORKTREES,
                  ).linkedWorktree
                : findBranchWorktree(
                      branch.name,
                      snapshot?.worktrees ?? EMPTY_WORKTREES,
                  );
            const trackingLocalBranch = branch.isRemote
                ? resolveRemoteBranchResolution(
                      branch,
                      branches,
                      snapshot?.worktrees ?? EMPTY_WORKTREES,
                  ).localBranch
                : null;
            const haystack = [
                branch.name,
                branch.upstreamName ?? "",
                trackingLocalBranch?.name ?? "",
                linkedWorktree?.rootPath ?? "",
                linkedWorktree?.branchName ?? "",
                branch.isRemote ? "remote" : "local",
            ]
                .join(" ")
                .toLowerCase();

            return haystack.includes(normalizedQuery);
        });
    }, [branches, query, snapshot?.worktrees]);

    const localBranches = useMemo(
        () => filteredBranches.filter((b) => !b.isRemote),
        [filteredBranches],
    );
    const remoteBranches = useMemo(
        () => filteredBranches.filter((b) => b.isRemote),
        [filteredBranches],
    );

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

    const flatItems = useMemo(() => {
        if (activeTab === "worktrees") {
            return filteredWorktrees.map((entry) => ({
                kind: "worktree" as const,
                worktree: entry,
            }));
        }

        const items: Array<
            | { kind: "branch"; branch: GitBranchSummary }
            | { kind: "worktree"; worktree: GitWorktreeSummary }
        > = [];

        if (!collapsedSections.local) {
            for (const branch of localBranches) {
                items.push({ kind: "branch", branch });
            }
        }

        if (!collapsedSections.remote) {
            for (const branch of remoteBranches) {
                items.push({ kind: "branch", branch });
            }
        }

        return items;
    }, [
        activeTab,
        collapsedSections,
        filteredWorktrees,
        localBranches,
        remoteBranches,
    ]);

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
        setFocusIndex(-1);
        setCollapsedSections({});
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
                setFocusIndex(-1);
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
        setFocusIndex(-1);
    }, [activeTab, isOpen]);

    useEffect(() => {
        setFocusIndex(-1);
    }, [query]);

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

            const remoteResolution = branch.isRemote
                ? resolveRemoteBranchResolution(
                      branch,
                      branches,
                      snapshot?.worktrees ?? EMPTY_WORKTREES,
                  )
                : null;
            const targetBranch = remoteResolution?.localBranch ?? branch;
            const linkedWorktree = branch.isRemote
                ? remoteResolution?.linkedWorktree ??
                  findBranchWorktree(
                      targetBranch.name,
                      snapshot?.worktrees ?? EMPTY_WORKTREES,
                  )
                : findBranchWorktree(
                      targetBranch.name,
                      snapshot?.worktrees ?? EMPTY_WORKTREES,
                  );

            if (
                linkedWorktree &&
                linkedWorktree.id !== (worktreeId ?? snapshot?.currentWorktreeId ?? null)
            ) {
                await handleSelectWorktree(linkedWorktree.id);
                return;
            }

            if (branch.isRemote) {
                if (remoteResolution?.hasSuggestedNameConflict) {
                    setActionError(
                        `Could not create a local branch for ${branch.name}. ${remoteResolution.suggestedLocalBranchName} already exists with a different upstream. Use the Worktree action or rename that local branch first.`,
                    );
                    return;
                }
            }

            if (targetBranch.name === snapshot?.branch?.name) {
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
                    targetBranch.name,
                    worktreeId ?? snapshot?.currentWorktreeId ?? null,
                    branch.isRemote && !remoteResolution?.localBranch
                        ? {
                              newBranchName:
                                  remoteResolution?.suggestedLocalBranchName ??
                                  stripRemotePrefix(branch.name),
                              startPoint: branch.name,
                          }
                        : undefined,
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
            branches,
            checkoutBranch,
            handleSelectWorktree,
            isBusy,
            projectId,
            refreshProjectTree,
            snapshot,
            worktreeId,
        ],
    );

    const handleCreateWorktreeFromBranch = useCallback(
        async (branch: GitBranchSummary) => {
            if (!projectId || isBusy || !project || !branch.isRemote) {
                return;
            }

            const suggestedBranchName = buildUniqueLocalBranchName(
                stripRemotePrefix(branch.name),
                branches,
            );
            const suggestedPath = buildSuggestedWorktreePath(
                project.rootPath,
                suggestedBranchName,
                snapshot?.worktrees ?? EMPTY_WORKTREES,
            );

            setActionError(null);
            setIsBusy(true);

            try {
                const createdWorktree = await createWorktree({
                    branchName: suggestedBranchName,
                    path: suggestedPath,
                    projectId,
                    startPoint: branch.name,
                    worktreeId: worktreeId ?? snapshot?.currentWorktreeId ?? null,
                });

                await setActiveWorktree(projectId, createdWorktree.id);
                await Promise.all([
                    refreshGitProject(projectId, createdWorktree.id),
                    refreshGitHistory(projectId, createdWorktree.id),
                    refreshProjectTree(projectId, createdWorktree.id),
                ]);

                setIsOpen(false);
                setQuery("");
            } catch (error) {
                setActionError(
                    error instanceof Error
                        ? error.message
                        : "Could not create a worktree from this branch.",
                );
            } finally {
                setIsBusy(false);
            }
        },
        [
            branches,
            createWorktree,
            isBusy,
            project,
            projectId,
            refreshGitHistory,
            refreshGitProject,
            refreshProjectTree,
            setActiveWorktree,
            snapshot?.currentWorktreeId,
            snapshot?.worktrees,
            worktreeId,
        ],
    );

    const handleSelectFocused = useCallback(() => {
        const item = flatItems[focusIndex];
        if (!item) return;

        if (item.kind === "branch") {
            void handleSelectBranch(item.branch);
        } else {
            void handleSelectWorktree(item.worktree.id);
        }
    }, [flatItems, focusIndex, handleSelectBranch, handleSelectWorktree]);

    const handleListKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
            const total = flatItems.length;
            if (total === 0) return;

            if (event.key === "ArrowDown") {
                event.preventDefault();
                setFocusIndex((prev) => (prev + 1) % total);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setFocusIndex((prev) => (prev <= 0 ? total - 1 : prev - 1));
            } else if (event.key === "Enter" && focusIndex >= 0) {
                event.preventDefault();
                handleSelectFocused();
            }
        },
        [flatItems.length, focusIndex, handleSelectFocused],
    );

    useEffect(() => {
        if (focusIndex < 0 || !listRef.current) return;

        const rows = listRef.current.querySelectorAll("[data-row-index]");
        const row = rows[focusIndex] as HTMLElement | undefined;
        row?.scrollIntoView({ block: "nearest" });
    }, [focusIndex]);

    const toggleSection = useCallback((section: string) => {
        setCollapsedSections((prev) => ({
            ...prev,
            [section]: !prev[section],
        }));
    }, []);

    const branchTabLabel = `Branches (${availableBranches})`;
    const worktreeTabLabel = `Worktrees (${availableWorktrees})`;
    const searchPlaceholder =
        activeTab === "branches" ? "Search branches..." : "Search worktrees...";
    const emptyLabel =
        activeTab === "branches"
            ? "No branches match your search."
            : "No worktrees match your search.";

    let rowIndex = 0;

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

                <span className="min-w-0 flex-1 truncate sidebar-git-scope-trigger__title">
                    {projectId ? activeBranchName : "Git scope"}
                </span>

                <ChevronIcon open={isOpen} />
            </button>

            {isOpen
                ? createPortal(
                      <div
                          className="sidebar-git-scope-menu"
                          onKeyDown={handleListKeyDown}
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
                                  <SearchIcon />
                                  <input
                                      autoCapitalize="off"
                                      autoCorrect="off"
                                      className="ide-input app-no-drag w-full text-xs"
                                      onChange={(event) =>
                                          setQuery(event.target.value)
                                      }
                                      onKeyDown={(event) => {
                                          if (
                                              event.key === "ArrowDown" ||
                                              event.key === "ArrowUp" ||
                                              event.key === "Enter"
                                          ) {
                                              return;
                                          }
                                          event.stopPropagation();
                                      }}
                                      placeholder={searchPlaceholder}
                                      ref={searchRef}
                                      spellCheck={false}
                                      value={query}
                                  />
                              </div>
                          </div>

                          <div
                              className="shell-scrollbar sidebar-git-scope-menu__list"
                              ref={listRef}
                          >
                              {activeTab === "branches" ? (
                                  filteredBranches.length > 0 ? (
                                      <>
                                          {localBranches.length > 0 ? (
                                              <>
                                                  <SectionHeader
                                                      collapsed={
                                                          !!collapsedSections.local
                                                      }
                                                      count={
                                                          localBranches.length
                                                      }
                                                      label="Local"
                                                      onToggle={() =>
                                                          toggleSection("local")
                                                      }
                                                  />
                                                  {!collapsedSections.local
                                                      ? localBranches.map(
                                                            (branch) => {
                                                                const idx =
                                                                    rowIndex++;
                                                                const branchWorktree =
                                                                    findBranchWorktree(
                                                                        branch.name,
                                                                        snapshot?.worktrees ??
                                                                            EMPTY_WORKTREES,
                                                                    );
                                                                const badges =
                                                                    getBranchBadges(
                                                                        branch,
                                                                        branchWorktree,
                                                                        worktreeId,
                                                                    );

                                                                return (
                                                                    <div
                                                                        data-row-index={
                                                                            idx
                                                                        }
                                                                        key={
                                                                            branch.name
                                                                        }
                                                                    >
                                                                        <SidebarNodeRow
                                                                            badges={
                                                                                badges
                                                                            }
                                                                            description={getBranchDescription(
                                                                                branch,
                                                                                branchWorktree,
                                                                                null,
                                                                            )}
                                                                            isActive={
                                                                                branch.name ===
                                                                                snapshot
                                                                                    ?.branch
                                                                                    ?.name
                                                                            }
                                                                            isSelected={
                                                                                idx ===
                                                                                focusIndex
                                                                            }
                                                                            leading={
                                                                                <BranchGlyph />
                                                                            }
                                                                            onClick={
                                                                                isBusy
                                                                                    ? undefined
                                                                                    : () =>
                                                                                          void handleSelectBranch(
                                                                                              branch,
                                                                                          )
                                                                            }
                                                                            title={
                                                                                branch.name
                                                                            }
                                                                        />
                                                                    </div>
                                                                );
                                                            },
                                                        )
                                                      : null}
                                              </>
                                          ) : null}

                                          {remoteBranches.length > 0 ? (
                                              <>
                                                  <SectionHeader
                                                      collapsed={
                                                          !!collapsedSections.remote
                                                      }
                                                      count={
                                                          remoteBranches.length
                                                      }
                                                      label="Remote"
                                                      onToggle={() =>
                                                          toggleSection(
                                                              "remote",
                                                          )
                                                      }
                                                  />
                                                  {!collapsedSections.remote
                                                      ? remoteBranches.map(
                                                            (branch) => {
                                                                const idx =
                                                                    rowIndex++;
                                                                const remoteResolution =
                                                                    resolveRemoteBranchResolution(
                                                                        branch,
                                                                        branches,
                                                                        snapshot?.worktrees ??
                                                                            EMPTY_WORKTREES,
                                                                    );
                                                                const branchWorktree =
                                                                    remoteResolution.linkedWorktree;
                                                                const badges =
                                                                    getRemoteBranchBadges(
                                                                        remoteResolution,
                                                                        branchWorktree,
                                                                        worktreeId,
                                                                    );
                                                                const remoteActions =
                                                                    remoteResolution.localBranch
                                                                        ? []
                                                                        : [
                                                                              {
                                                                                  disabled:
                                                                                      remoteResolution.hasSuggestedNameConflict,
                                                                                  label: "Checkout",
                                                                                  onClick: () =>
                                                                                      void handleSelectBranch(
                                                                                          branch,
                                                                                      ),
                                                                                  title:
                                                                                      remoteResolution.hasSuggestedNameConflict
                                                                                          ? `Cannot create ${remoteResolution.suggestedLocalBranchName} because a different local branch already uses that name.`
                                                                                          : `Create ${remoteResolution.suggestedLocalBranchName} from ${branch.name}`,
                                                                              },
                                                                              {
                                                                                  label: "Worktree",
                                                                                  onClick: () =>
                                                                                      void handleCreateWorktreeFromBranch(
                                                                                          branch,
                                                                                      ),
                                                                                  title: `Create a new worktree from ${branch.name}`,
                                                                              },
                                                                          ];

                                                                return (
                                                                    <div
                                                                        data-row-index={
                                                                            idx
                                                                        }
                                                                        key={
                                                                            branch.name
                                                                        }
                                                                    >
                                                                        <SidebarNodeRow
                                                                            actions={
                                                                                remoteActions
                                                                            }
                                                                            badges={
                                                                                badges
                                                                            }
                                                                            description={getBranchDescription(
                                                                                branch,
                                                                                branchWorktree,
                                                                                remoteResolution.localBranch,
                                                                            )}
                                                                            isActive={Boolean(
                                                                                snapshot
                                                                                    ?.branch
                                                                                    ?.upstreamName ===
                                                                                    branch.name,
                                                                            )}
                                                                            isSelected={
                                                                                idx ===
                                                                                focusIndex
                                                                            }
                                                                            leading={
                                                                                <BranchGlyph />
                                                                            }
                                                                            onClick={
                                                                                isBusy
                                                                                    ? undefined
                                                                                    : () =>
                                                                                          void handleSelectBranch(
                                                                                              branch,
                                                                                          )
                                                                            }
                                                                            title={
                                                                                branch.name
                                                                            }
                                                                        />
                                                                    </div>
                                                                );
                                                            },
                                                        )
                                                      : null}
                                              </>
                                          ) : null}
                                      </>
                                  ) : (
                                      <EmptyState label={emptyLabel} />
                                  )
                              ) : filteredWorktrees.length > 0 ? (
                                  filteredWorktrees.map((entry) => {
                                      const idx = rowIndex++;
                                      return (
                                          <div
                                              data-row-index={idx}
                                              key={entry.id}
                                          >
                                              <SidebarNodeRow
                                                  badges={getWorktreeBadges(
                                                      entry,
                                                  )}
                                                  description={entry.rootPath}
                                                  isActive={
                                                      entry.id ===
                                                      (worktreeId ?? null)
                                                  }
                                                  isSelected={
                                                      idx === focusIndex
                                                  }
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
                                                      getDetachedWorktreeLabel(
                                                          entry,
                                                      )
                                                  }
                                              />
                                          </div>
                                      );
                                  })
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

function SectionHeader({
    collapsed,
    count,
    label,
    onToggle,
}: {
    readonly collapsed: boolean;
    readonly count: number;
    readonly label: string;
    readonly onToggle: () => void;
}) {
    return (
        <div
            className="sidebar-git-scope-menu__section-header"
            onClick={onToggle}
        >
            <svg
                aria-hidden="true"
                className={[
                    "sidebar-git-scope-menu__section-chevron",
                    collapsed
                        ? "sidebar-git-scope-menu__section-chevron--collapsed"
                        : "",
                ]
                    .filter(Boolean)
                    .join(" ")}
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
            <span className="sidebar-git-scope-menu__section-label">
                {label}
            </span>
            <span className="sidebar-git-scope-menu__section-count">
                {count}
            </span>
        </div>
    );
}

function EmptyState({ label }: { readonly label: string }) {
    return <div className="sidebar-git-scope-menu__empty">{label}</div>;
}

function SearchIcon() {
    return (
        <svg
            aria-hidden="true"
            className="sidebar-git-scope-menu__search-icon"
            fill="none"
            viewBox="0 0 16 16"
        >
            <path
                d="M11.25 11.25 14 14M6.5 11a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.3"
            />
        </svg>
    );
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

    return badges;
}

function getRemoteBranchBadges(
    resolution: RemoteBranchResolution,
    branchWorktree: GitWorktreeSummary | null,
    activeWorktreeId: string | null,
): readonly SidebarBadge[] {
    const badges: SidebarBadge[] = [];

    if (resolution.localBranch) {
        badges.push({ label: "Local", tone: "neutral" });
    }

    if (branchWorktree && branchWorktree.id !== activeWorktreeId) {
        badges.push({ label: "Worktree", tone: "success" });
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
    trackingLocalBranch: GitBranchSummary | null,
): string {
    if (branchWorktree) {
        return branchWorktree.rootPath;
    }

    const syncBits = [];
    if (branch.isRemote && trackingLocalBranch) {
        syncBits.push(`Local ${trackingLocalBranch.name}`);
    }
    if (branch.upstreamName) {
        const upstreamLabel =
            branch.isRemote && branch.upstreamName === branch.name
                ? null
                : branch.upstreamName;
        if (upstreamLabel) {
            syncBits.push(upstreamLabel);
        }
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

function findBranchWorktree(
    branchName: string,
    worktrees: readonly GitWorktreeSummary[],
): GitWorktreeSummary | null {
    return (
        worktrees.find((entry) => entry.branchName === branchName) ?? null
    );
}

function findTrackingLocalBranch(
    remoteBranch: GitBranchSummary,
    branches: readonly GitBranchSummary[],
): GitBranchSummary | null {
    return (
        branches.find(
            (branch) =>
                !branch.isRemote && branch.upstreamName === remoteBranch.name,
        ) ?? null
    );
}

export function resolveRemoteBranchResolution(
    remoteBranch: GitBranchSummary,
    branches: readonly GitBranchSummary[],
    worktrees: readonly GitWorktreeSummary[],
): RemoteBranchResolution {
    const localBranch = findTrackingLocalBranch(remoteBranch, branches);
    const suggestedLocalBranchName = stripRemotePrefix(remoteBranch.name);
    const linkedWorktree =
        findBranchWorktree(localBranch?.name ?? suggestedLocalBranchName, worktrees);
    const hasSuggestedNameConflict =
        !localBranch &&
        branches.some(
            (branch) =>
                !branch.isRemote && branch.name === suggestedLocalBranchName,
        );

    return {
        hasSuggestedNameConflict,
        linkedWorktree,
        localBranch,
        suggestedLocalBranchName,
    };
}

export function buildUniqueLocalBranchName(
    baseBranchName: string,
    branches: readonly GitBranchSummary[],
): string {
    const sanitizedBaseName = sanitizeBranchName(baseBranchName);
    let candidate = sanitizedBaseName;
    let suffix = 2;

    while (
        branches.some(
            (branch) => !branch.isRemote && branch.name === candidate,
        )
    ) {
        candidate = `${sanitizedBaseName}-${suffix}`;
        suffix += 1;
    }

    return candidate;
}

export function buildSuggestedWorktreePath(
    rootPath: string,
    branchName: string,
    worktrees: readonly GitWorktreeSummary[],
): string {
    const normalizedRoot = rootPath.replace(/[\\/]+$/, "");
    const suffix = sanitizePathSegment(branchName);
    const existingPaths = new Set(
        worktrees.map((worktree) => worktree.rootPath.replace(/[\\/]+$/, "")),
    );
    let candidate = `${normalizedRoot}-${suffix}`;
    let index = 2;

    while (existingPaths.has(candidate)) {
        candidate = `${normalizedRoot}-${suffix}-${index}`;
        index += 1;
    }

    return candidate;
}

export function stripRemotePrefix(referenceName: string): string {
    const segments = referenceName.split("/");
    return segments.length > 1 ? segments.slice(1).join("/") : referenceName;
}

function sanitizeBranchName(branchName: string): string {
    return branchName.trim().replace(/\s+/g, "-") || "branch";
}

function sanitizePathSegment(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._/-]+/g, "-")
        .replace(/[\\/]+/g, "-")
        .replace(/^-+|-+$/g, "") || "worktree";
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
