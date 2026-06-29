import {
    useDeferredValue,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type FormEvent,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

import type {
    GitBranchSummary,
    GitRepositorySnapshot,
    GitWorktreeSummary,
} from "@shared/ipc";

import {
    areGitWorktreeIdsEquivalent,
    getGitContextKey,
    isGitWorktreeActive,
} from "@renderer/app/git/context-key";
import { useGitStore } from "@renderer/app/store/git-store";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import { getViewportSafeMenuPosition } from "@renderer/app/utils/menu-position";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "@renderer/components/context-menu/ContextMenu";
import {
    MeasuredVirtualList,
    type MeasuredVirtualListHandle,
} from "@renderer/components/virtual/MeasuredVirtualList";

import { SidebarNodeRow, type SidebarBadge } from "./SidebarNodeRow";
import {
    buildBranchCreationBaseOptions,
    createBranchCreationDraft,
    getBranchCreationQueryOffer,
    getDefaultBranchCreationBase,
    validateNewBranchName,
    type BranchCreationBaseOption,
    type BranchCreationDraft,
} from "./sidebarGitBranchCreation";

type GitScopeTabId = "branches" | "worktrees";

interface MenuPosition {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
}

interface GitScopeMenuSize {
    readonly height: number;
    readonly width: number;
}

interface SidebarGitScopePickerProps {
    readonly projectId: string | null;
    readonly worktreeId: string | null;
}

const EMPTY_BRANCHES: readonly GitBranchSummary[] = [];
const EMPTY_WORKTREES: readonly GitWorktreeSummary[] = [];
const GIT_SCOPE_VIRTUALIZATION_THRESHOLD = 120;
const GIT_SCOPE_VIRTUALIZATION_OVERSCAN = 6;
const GIT_SCOPE_ROW_ESTIMATE = 52;
const GIT_SCOPE_SECTION_ESTIMATE = 30;
const GIT_SCOPE_MENU_SIZE_STORAGE_KEY = "comando.git.scope.menu.size";
const GIT_SCOPE_MENU_SIZE_VERSION = 1;
const GIT_SCOPE_MENU_MIN_WIDTH = 280;
const GIT_SCOPE_MENU_MAX_WIDTH = 720;
const GIT_SCOPE_MENU_MIN_HEIGHT = 260;
const GIT_SCOPE_MENU_DEFAULT_MAX_HEIGHT = 420;
const GIT_SCOPE_MENU_MAX_HEIGHT = 720;

function getStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function getMenuMaxWidth(x = 8): number {
    return Math.max(
        GIT_SCOPE_MENU_MIN_WIDTH,
        Math.min(GIT_SCOPE_MENU_MAX_WIDTH, window.innerWidth - x - 8),
    );
}

function getMenuMaxHeight(y = 8): number {
    return Math.max(
        GIT_SCOPE_MENU_MIN_HEIGHT,
        Math.min(GIT_SCOPE_MENU_MAX_HEIGHT, window.innerHeight - y - 8),
    );
}

function clampGitScopeMenuSize(
    size: GitScopeMenuSize,
    origin?: { readonly x: number; readonly y: number },
): GitScopeMenuSize {
    const maxWidth = getMenuMaxWidth(origin?.x);
    const maxHeight = getMenuMaxHeight(origin?.y);

    return {
        height: Math.round(
            Math.min(Math.max(size.height, GIT_SCOPE_MENU_MIN_HEIGHT), maxHeight),
        ),
        width: Math.round(
            Math.min(Math.max(size.width, GIT_SCOPE_MENU_MIN_WIDTH), maxWidth),
        ),
    };
}

function readPersistedGitScopeMenuSize(): GitScopeMenuSize | null {
    const storage = getStorage();
    if (!storage) {
        return null;
    }

    const raw = storage.getItem(GIT_SCOPE_MENU_SIZE_STORAGE_KEY);
    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as {
            readonly height?: unknown;
            readonly version?: unknown;
            readonly width?: unknown;
        };
        if (
            parsed.version !== GIT_SCOPE_MENU_SIZE_VERSION ||
            typeof parsed.width !== "number" ||
            typeof parsed.height !== "number" ||
            !Number.isFinite(parsed.width) ||
            !Number.isFinite(parsed.height)
        ) {
            return null;
        }

        return clampGitScopeMenuSize({
            height: parsed.height,
            width: parsed.width,
        });
    } catch {
        return null;
    }
}

function persistGitScopeMenuSize(size: GitScopeMenuSize): void {
    const storage = getStorage();
    if (!storage) {
        return;
    }

    storage.setItem(
        GIT_SCOPE_MENU_SIZE_STORAGE_KEY,
        JSON.stringify({
            ...size,
            updatedAt: Date.now(),
            version: GIT_SCOPE_MENU_SIZE_VERSION,
        }),
    );
}

interface RemoteBranchResolution {
    readonly hasSuggestedNameConflict: boolean;
    readonly linkedWorktree: GitWorktreeSummary | null;
    readonly localBranch: GitBranchSummary | null;
    readonly suggestedLocalBranchName: string;
}

interface BranchListRow {
    readonly badges: readonly SidebarBadge[];
    readonly branch: GitBranchSummary;
    readonly branchWorktree: GitWorktreeSummary | null;
    readonly description: string;
    readonly isActive: boolean;
    readonly remoteResolution: RemoteBranchResolution | null;
    readonly searchText: string;
}

interface WorktreeListRow {
    readonly badges: readonly SidebarBadge[];
    readonly description: string;
    readonly isActive: boolean;
    readonly searchText: string;
    readonly title: string;
    readonly worktree: GitWorktreeSummary;
}

type GitScopeContextMenuPayload =
    | {
          readonly branchName: string;
          readonly kind: "branch";
      }
    | {
          readonly kind: "worktree";
          readonly worktreeId: string;
      };

type RenderListItem =
    | {
          readonly collapsed: boolean;
          readonly count: number;
          readonly key: string;
          readonly kind: "section";
          readonly label: string;
          readonly section: "local" | "remote";
      }
    | {
          readonly key: string;
          readonly kind: "branch";
          readonly row: BranchListRow;
          readonly selectableIndex: number;
      }
    | {
          readonly key: string;
          readonly kind: "worktree";
          readonly row: WorktreeListRow;
          readonly selectableIndex: number;
      };

type SelectableListItem =
    | {
          readonly branchName: string;
          readonly kind: "create-branch";
      }
    | {
          readonly branch: GitBranchSummary;
          readonly kind: "branch";
      }
    | {
          readonly kind: "worktree";
          readonly worktree: GitWorktreeSummary;
      };

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
    const [branchCreationDraft, setBranchCreationDraft] =
        useState<BranchCreationDraft | null>(null);
    const [branchCreationName, setBranchCreationName] = useState("");
    const [branchCreationBaseName, setBranchCreationBaseName] = useState("");
    const [branchCreationCheckout, setBranchCreationCheckout] = useState(true);
    const [branchCreationSubmitted, setBranchCreationSubmitted] = useState(false);
    const [itemContextMenu, setItemContextMenu] = useState<
        ContextMenuState<GitScopeContextMenuPayload> | null
    >(null);
    const [collapsedSections, setCollapsedSections] = useState<
        Record<string, boolean>
    >({});
    const [userMenuSize, setUserMenuSize] = useState<GitScopeMenuSize | null>(
        () => readPersistedGitScopeMenuSize(),
    );
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const virtualListRef = useRef<MeasuredVirtualListHandle | null>(null);
    const menuResizeStateRef = useRef<{
        readonly startHeight: number;
        readonly startWidth: number;
        readonly startX: number;
        readonly startY: number;
        readonly x: number;
        readonly y: number;
    } | null>(null);
    const pendingMenuSizeRef = useRef<GitScopeMenuSize | null>(null);
    const menuResizeEndRef = useRef<(() => void) | null>(null);

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
    const createBranch = useGitStore((state) => state.createBranch);
    const createWorktree = useGitStore((state) => state.createWorktree);
    const deleteLocalBranch = useGitStore((state) => state.deleteLocalBranch);
    const deleteRemoteBranch = useGitStore((state) => state.deleteRemoteBranch);
    const initRepository = useGitStore((state) => state.initRepository);
    const refreshGitHistory = useGitStore((state) => state.refreshHistory);
    const refreshGitProject = useGitStore((state) => state.refreshProject);
    const removeWorktree = useGitStore((state) => state.removeWorktree);
    const setActiveWorktree = useGitStore((state) => state.setActiveWorktree);

    const activeWorktree =
        snapshot?.worktrees.find(
            (entry) =>
                projectId
                    ? isGitScopeWorktreeActive(projectId, worktreeId, entry)
                    : entry.id === worktreeId,
        ) ??
        snapshot?.worktrees.find((entry) => entry.isCurrent) ??
        snapshot?.worktrees.find((entry) => entry.isPrimary) ??
        null;
    const canInitializeGit = snapshot?.repositoryState === "not_repo";
    const activeBranchName =
        activeWorktree?.branchName ??
        snapshot?.branch?.name ??
        (canInitializeGit ? "No Git Repository" : "Detached HEAD");
    const activeRootPath =
        activeWorktree?.rootPath ?? snapshot?.rootPath ?? null;
    const availableBranches = branches.length;
    const worktrees = snapshot?.worktrees ?? EMPTY_WORKTREES;
    const availableWorktrees = worktrees.length;
    const deferredQuery = useDeferredValue(query);
    const branchCreationBaseOptions = useMemo(
        () => buildBranchCreationBaseOptions(branches),
        [branches],
    );
    const defaultBranchCreationBase = useMemo(
        () =>
            getDefaultBranchCreationBase({
                branches,
                currentBranchName:
                    activeWorktree?.branchName ??
                    (snapshot?.branch?.isDetached
                        ? null
                        : (snapshot?.branch?.name ?? null)),
            }),
        [
            activeWorktree?.branchName,
            branches,
            snapshot?.branch?.isDetached,
            snapshot?.branch?.name,
        ],
    );
    const branchCreationValidation = useMemo(
        () =>
            branchCreationDraft
                ? validateNewBranchName(branchCreationName, branches)
                : null,
        [branchCreationDraft, branchCreationName, branches],
    );

    const branchRows = useMemo(() => {
        const localBranchByUpstream = new Map<string, GitBranchSummary>();
        const localBranchNames = new Set<string>();
        const worktreeByBranchName = new Map<string, GitWorktreeSummary>();

        for (const branch of branches) {
            if (branch.isRemote) {
                continue;
            }

            localBranchNames.add(branch.name);
            if (branch.upstreamName) {
                localBranchByUpstream.set(branch.upstreamName, branch);
            }
        }

        for (const worktree of worktrees) {
            if (!worktree.branchName) {
                continue;
            }

            worktreeByBranchName.set(worktree.branchName, worktree);
        }

        return branches.map((branch) => {
            const remoteResolution = branch.isRemote
                ? resolveRemoteBranchResolutionWithIndexes(
                      branch,
                      localBranchByUpstream,
                      localBranchNames,
                      worktreeByBranchName,
                  )
                : null;
            const branchWorktree = branch.isRemote
                ? remoteResolution?.linkedWorktree ?? null
                : (worktreeByBranchName.get(branch.name) ?? null);
            const badges = branch.isRemote
                ? getRemoteBranchBadges(
                      remoteResolution ?? {
                          hasSuggestedNameConflict: false,
                          linkedWorktree: branchWorktree,
                          localBranch: null,
                          suggestedLocalBranchName: stripRemotePrefix(
                              branch.name,
                          ),
                      },
                      branchWorktree,
                      projectId,
                      worktreeId,
                  )
                : getBranchBadges(
                      branch,
                      branchWorktree,
                      projectId,
                      worktreeId,
                  );
            const description = getBranchDescription(
                branch,
                branchWorktree,
                remoteResolution?.localBranch ?? null,
            );
            const searchText = [
                branch.name,
                branch.upstreamName ?? "",
                remoteResolution?.localBranch?.name ?? "",
                branchWorktree?.rootPath ?? "",
                branchWorktree?.branchName ?? "",
                branch.isRemote ? "remote" : "local",
            ]
                .join(" ")
                .toLowerCase();

            return {
                badges,
                branch,
                branchWorktree,
                description,
                isActive: branch.isRemote
                    ? snapshot?.branch?.upstreamName === branch.name
                    : snapshot?.branch?.name === branch.name,
                remoteResolution,
                searchText,
            } satisfies BranchListRow;
        });
    }, [
        branches,
        projectId,
        snapshot?.branch?.name,
        snapshot?.branch?.upstreamName,
        worktreeId,
        worktrees,
    ]);

    const worktreeRows = useMemo(
        () =>
            worktrees.map((worktree) => ({
                badges: getWorktreeBadges(worktree),
                description: worktree.rootPath,
                isActive: projectId
                    ? isGitScopeWorktreeActive(projectId, worktreeId, worktree)
                    : worktree.id === (worktreeId ?? null),
                searchText: [
                    worktree.branchName ?? "",
                    worktree.rootPath,
                    worktree.commitSha ?? "",
                    getWorktreeBadgeLabel(worktree),
                ]
                    .join(" ")
                    .toLowerCase(),
                title:
                    worktree.branchName ?? getDetachedWorktreeLabel(worktree),
                worktree,
            })) satisfies readonly WorktreeListRow[],
        [projectId, worktreeId, worktrees],
    );
    const branchRowByName = useMemo(
        () => new Map(branchRows.map((row) => [row.branch.name, row])),
        [branchRows],
    );
    const worktreeRowById = useMemo(
        () => new Map(worktreeRows.map((row) => [row.worktree.id, row])),
        [worktreeRows],
    );

    const normalizedQuery = deferredQuery.trim().toLowerCase();
    const branchCreationQueryOffer = useMemo(
        () =>
            activeTab === "branches" &&
            !canInitializeGit &&
            !branchCreationDraft &&
            defaultBranchCreationBase
                ? getBranchCreationQueryOffer(deferredQuery, branches)
                : null,
        [
            activeTab,
            branchCreationDraft,
            branches,
            canInitializeGit,
            defaultBranchCreationBase,
            deferredQuery,
        ],
    );
    const filteredBranchRows = useMemo(() => {
        if (!normalizedQuery) {
            return branchRows;
        }

        return branchRows.filter((row) => row.searchText.includes(normalizedQuery));
    }, [branchRows, normalizedQuery]);

    const localBranchRows = useMemo(
        () => filteredBranchRows.filter((row) => !row.branch.isRemote),
        [filteredBranchRows],
    );
    const remoteBranchRows = useMemo(
        () => filteredBranchRows.filter((row) => row.branch.isRemote),
        [filteredBranchRows],
    );

    const filteredWorktreeRows = useMemo(() => {
        if (!normalizedQuery) {
            return worktreeRows;
        }

        return worktreeRows.filter((row) => row.searchText.includes(normalizedQuery));
    }, [normalizedQuery, worktreeRows]);

    const listItems = useMemo(() => {
        let selectableIndex = branchCreationQueryOffer ? 1 : 0;
        const items: RenderListItem[] = [];

        if (activeTab === "worktrees") {
            for (const row of filteredWorktreeRows) {
                items.push({
                    key: row.worktree.id,
                    kind: "worktree",
                    row,
                    selectableIndex,
                });
                selectableIndex += 1;
            }

            return items;
        }

        if (localBranchRows.length > 0) {
            items.push({
                collapsed: !!collapsedSections.local,
                count: localBranchRows.length,
                key: "section-local",
                kind: "section",
                label: "Local",
                section: "local",
            });

            if (!collapsedSections.local) {
                for (const row of localBranchRows) {
                    items.push({
                        key: row.branch.name,
                        kind: "branch",
                        row,
                        selectableIndex,
                    });
                    selectableIndex += 1;
                }
            }
        }

        if (remoteBranchRows.length > 0) {
            items.push({
                collapsed: !!collapsedSections.remote,
                count: remoteBranchRows.length,
                key: "section-remote",
                kind: "section",
                label: "Remote",
                section: "remote",
            });

            if (!collapsedSections.remote) {
                for (const row of remoteBranchRows) {
                    items.push({
                        key: row.branch.name,
                        kind: "branch",
                        row,
                        selectableIndex,
                    });
                    selectableIndex += 1;
                }
            }
        }

        return items;
    }, [
        activeTab,
        branchCreationQueryOffer,
        collapsedSections.local,
        collapsedSections.remote,
        filteredWorktreeRows,
        localBranchRows,
        remoteBranchRows,
    ]);

    const flatItems = useMemo<readonly SelectableListItem[]>(() => {
        const items: SelectableListItem[] = [];
        if (branchCreationQueryOffer) {
            items.push({
                branchName: branchCreationQueryOffer.branchName,
                kind: "create-branch",
            });
        }

        for (const item of listItems) {
            if (item.kind === "section") {
                continue;
            }

            if (item.kind === "branch") {
                items.push({ branch: item.row.branch, kind: "branch" });
                continue;
            }

            items.push({ kind: "worktree", worktree: item.row.worktree });
        }

        return items;
    }, [branchCreationQueryOffer, listItems]);
    const selectableRenderIndexByFocusIndex = useMemo(
        () =>
            new Map(
                listItems.flatMap((item, renderIndex) =>
                    item.kind === "section"
                        ? []
                        : [[item.selectableIndex, renderIndex] as const],
                ),
            ),
        [listItems],
    );
    const shouldVirtualizeList = listItems.length >= GIT_SCOPE_VIRTUALIZATION_THRESHOLD;

    const updateMenuPosition = useCallback(() => {
        const button = buttonRef.current;
        if (!button) {
            return;
        }

        const buttonRect = button.getBoundingClientRect();
        const measuredMenuRect = menuRef.current?.getBoundingClientRect();
        const defaultWidth = Math.min(
            window.innerWidth - 16,
            Math.max(GIT_SCOPE_MENU_MIN_WIDTH, Math.ceil(buttonRect.width)),
        );
        const estimatedRows = Math.max(listItems.length, 1);
        const defaultHeight = Math.min(
            GIT_SCOPE_MENU_DEFAULT_MAX_HEIGHT,
            estimatedRows * GIT_SCOPE_ROW_ESTIMATE + 144 + (actionError ? 40 : 0),
        );
        const size = clampGitScopeMenuSize(
            userMenuSize ?? {
                height: Math.ceil(measuredMenuRect?.height ?? defaultHeight),
                width: defaultWidth,
            },
            {
                x: buttonRect.left,
                y: buttonRect.bottom + 6,
            },
        );
        const spaceAbove = buttonRect.top - 8;
        const spaceBelow = window.innerHeight - buttonRect.bottom - 8;
        const openAbove = spaceAbove >= size.height || spaceAbove > spaceBelow;
        const preferredY = openAbove
            ? buttonRect.top - size.height - 6
            : buttonRect.bottom + 6;
        const safePosition = getViewportSafeMenuPosition(
            buttonRect.left,
            preferredY,
            size.width,
            size.height,
        );

        setMenuPosition({
            height: size.height,
            width: size.width,
            x: safePosition.x,
            y: safePosition.y,
        });
    }, [
        actionError,
        listItems.length,
        userMenuSize,
    ]);

    useEffect(() => {
        setActionError(null);
        setQuery("");
        setIsOpen(false);
        setItemContextMenu(null);
        setActiveTab("branches");
        setIsBusy(false);
        setFocusIndex(-1);
        setBranchCreationDraft(null);
        setBranchCreationName("");
        setBranchCreationBaseName("");
        setBranchCreationCheckout(true);
        setBranchCreationSubmitted(false);
        setCollapsedSections({});
    }, [projectId]);

    useEffect(() => {
        if (!isOpen) {
            setItemContextMenu(null);
            setBranchCreationDraft(null);
        }
    }, [isOpen]);

    useEffect(() => {
        if (activeTab !== "branches") {
            setBranchCreationDraft(null);
        }
    }, [activeTab]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (containerRef.current?.contains(target)) return;
            if (menuRef.current?.contains(target)) return;
            if (
                target instanceof Element &&
                target.closest('[data-context-menu-root="true"]')
            ) {
                return;
            }
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

        let resizeObserver: ResizeObserver | null = null;
        if (typeof ResizeObserver !== "undefined" && buttonRef.current) {
            resizeObserver = new ResizeObserver(() => {
                handleViewportChange();
            });
            resizeObserver.observe(buttonRef.current);
        }

        return () => {
            window.removeEventListener("resize", handleViewportChange);
            window.removeEventListener("scroll", handleViewportChange, true);
            resizeObserver?.disconnect();
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

            if (
                areGitScopeWorktreeIdsEqual(
                    projectId,
                    worktreeId,
                    nextWorktreeId,
                )
            ) {
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
                !areGitScopeWorktreeIdsEqual(
                    projectId,
                    linkedWorktree.id,
                    worktreeId ?? snapshot?.currentWorktreeId ?? null,
                )
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
            if (!projectId || isBusy || !project) {
                return;
            }

            const suggestedBranchName = branch.isRemote
                ? buildUniqueLocalBranchName(
                      stripRemotePrefix(branch.name),
                      branches,
                  )
                : branch.name;
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
                    startPoint: branch.isRemote ? branch.name : null,
                    worktreeId: worktreeId ?? snapshot?.currentWorktreeId ?? null,
                });

                await getComandoApi().openProjectWindow({
                    forceNewWindow: true,
                    projectId,
                    worktreeId: createdWorktree.id,
                });

                setIsOpen(false);
                setQuery("");
            } catch (error) {
                setActionError(
                    error instanceof Error
                        ? error.message
                        : "Could not create or open a worktree from this branch.",
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
            snapshot?.currentWorktreeId,
            snapshot?.worktrees,
            worktreeId,
        ],
    );

    const openBranchCreationForm = useCallback(
        (
            baseBranchName: string | null,
            source: BranchCreationDraft["source"],
            initialName = "",
        ) => {
            const draft = createBranchCreationDraft({
                baseBranchName,
                initialName,
                source,
            });
            if (!draft) {
                setActionError("Choose a base branch before creating a branch.");
                return;
            }

            setActiveTab("branches");
            setActionError(null);
            setItemContextMenu(null);
            setBranchCreationDraft(draft);
            setBranchCreationName(draft.initialName);
            setBranchCreationBaseName(draft.baseBranchName);
            setBranchCreationCheckout(draft.checkoutAfterCreate);
            setBranchCreationSubmitted(false);
        },
        [],
    );

    const closeBranchCreationForm = useCallback(() => {
        setBranchCreationDraft(null);
        setBranchCreationName("");
        setBranchCreationBaseName("");
        setBranchCreationCheckout(true);
        setBranchCreationSubmitted(false);
        setActionError(null);
    }, []);

    const handleCreateBranchSubmit = useCallback(
        async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();

            if (!projectId || isBusy || !branchCreationDraft) {
                return;
            }

            setBranchCreationSubmitted(true);
            const validation = validateNewBranchName(branchCreationName, branches);
            if (!validation.isValid) {
                return;
            }

            const baseBranchName = branchCreationBaseName.trim();
            if (!baseBranchName) {
                setActionError("Choose a base branch before creating a branch.");
                return;
            }

            const activeWorktreeId =
                worktreeId ?? snapshot?.currentWorktreeId ?? null;

            setActionError(null);
            setIsBusy(true);

            try {
                const result = branchCreationCheckout
                    ? await checkoutBranch(
                          projectId,
                          baseBranchName,
                          activeWorktreeId,
                          {
                              newBranchName: validation.value,
                              startPoint: baseBranchName,
                          },
                      )
                    : await createBranch({
                          branchName: validation.value,
                          projectId,
                          startPoint: baseBranchName,
                          worktreeId: activeWorktreeId,
                      });

                await refreshProjectTree(
                    projectId,
                    result.currentWorktreeId ?? activeWorktreeId,
                );
                setIsOpen(false);
                setQuery("");
                setBranchCreationDraft(null);
                setBranchCreationName("");
                setBranchCreationBaseName("");
                setBranchCreationCheckout(true);
                setBranchCreationSubmitted(false);
            } catch (error) {
                setActionError(
                    error instanceof Error
                        ? error.message
                        : "Could not create this branch.",
                );
            } finally {
                setIsBusy(false);
            }
        },
        [
            branchCreationBaseName,
            branchCreationCheckout,
            branchCreationDraft,
            branchCreationName,
            branches,
            checkoutBranch,
            createBranch,
            isBusy,
            projectId,
            refreshProjectTree,
            snapshot?.currentWorktreeId,
            worktreeId,
        ],
    );

    const handleDeleteLocalBranch = useCallback(
        async (branch: GitBranchSummary) => {
            if (
                !projectId ||
                isBusy ||
                branch.isRemote ||
                branch.isCurrent ||
                findBranchWorktree(
                    branch.name,
                    snapshot?.worktrees ?? EMPTY_WORKTREES,
                )
            ) {
                return;
            }

            const confirmed = window.confirm(
                `Delete the local branch "${branch.name}"?\n\nThis only removes the local branch reference. Any remote branch will remain untouched.`,
            );
            if (!confirmed) {
                return;
            }

            setActionError(null);
            setIsBusy(true);

            try {
                await deleteLocalBranch(
                    projectId,
                    branch.name,
                    worktreeId ?? snapshot?.currentWorktreeId ?? null,
                );
                setItemContextMenu(null);
            } catch (error) {
                setActionError(
                    error instanceof Error
                        ? error.message
                        : "Could not delete this local branch.",
                );
            } finally {
                setIsBusy(false);
            }
        },
        [
            deleteLocalBranch,
            isBusy,
            projectId,
            snapshot?.currentWorktreeId,
            snapshot?.worktrees,
            worktreeId,
        ],
    );

    const handleDeleteRemoteBranch = useCallback(
        async (branch: GitBranchSummary) => {
            if (!projectId || isBusy) {
                return;
            }

            const remoteReference = branch.isRemote
                ? branch.name
                : branch.upstreamName;
            const parsedReference = parseRemoteBranchReference(remoteReference);
            if (!parsedReference) {
                setActionError("Could not resolve the remote branch reference.");
                return;
            }

            const confirmed = window.confirm(
                `Delete the remote branch "${parsedReference.remoteName}/${parsedReference.remoteRef}"?\n\nThis will remove it from the remote for everyone with access. Local branches and worktrees on your machine will remain.\n\nThis cannot be undone.`,
            );
            if (!confirmed) {
                return;
            }

            setActionError(null);
            setIsBusy(true);

            try {
                await deleteRemoteBranch(
                    projectId,
                    parsedReference.remoteName,
                    parsedReference.remoteRef,
                    worktreeId ?? snapshot?.currentWorktreeId ?? null,
                );
                setItemContextMenu(null);
            } catch (error) {
                setActionError(
                    error instanceof Error
                        ? error.message
                        : "Could not delete this remote branch.",
                );
            } finally {
                setIsBusy(false);
            }
        },
        [
            deleteRemoteBranch,
            isBusy,
            projectId,
            snapshot?.currentWorktreeId,
            worktreeId,
        ],
    );

    const handleOpenWorktreeInNewWindow = useCallback(
        async (targetWorktree: GitWorktreeSummary) => {
            if (!projectId || isBusy) {
                return;
            }

            setActionError(null);
            setIsBusy(true);

            try {
                await getComandoApi().openProjectWindow({
                    forceNewWindow: true,
                    projectId,
                    worktreeId: targetWorktree.id,
                });
                setIsOpen(false);
                setQuery("");
            } catch (error) {
                setActionError(
                    error instanceof Error
                        ? error.message
                        : "Could not open this worktree in a new window.",
                );
            } finally {
                setIsBusy(false);
            }
        },
        [isBusy, projectId],
    );

    const handleRevealWorktreeInFinder = useCallback(
        async (targetWorktree: GitWorktreeSummary) => {
            if (!projectId) {
                return;
            }

            try {
                await getComandoApi().revealProjectEntry({
                    projectId,
                    relativePath: null,
                    worktreeId: targetWorktree.id,
                });
            } catch (error) {
                setActionError(
                    error instanceof Error
                        ? error.message
                        : "Could not reveal this worktree in Finder.",
                );
            }
        },
        [projectId],
    );

    const handleRemoveWorktree = useCallback(
        async (targetWorktree: GitWorktreeSummary) => {
            if (
                !projectId ||
                isBusy ||
                targetWorktree.isCurrent ||
                targetWorktree.isLocked ||
                targetWorktree.isPrimary
            ) {
                return;
            }

            const label =
                targetWorktree.branchName ??
                getDetachedWorktreeLabel(targetWorktree);
            const confirmed = window.confirm(
                `Remove the worktree "${label}"?\n\nThis removes the worktree checkout at:\n${targetWorktree.rootPath}`,
            );
            if (!confirmed) {
                return;
            }

            setActionError(null);
            setIsBusy(true);

            try {
                const nextSnapshot = await removeWorktree(
                    projectId,
                    targetWorktree.rootPath,
                    worktreeId ?? snapshot?.currentWorktreeId ?? null,
                );
                await Promise.all([
                    refreshGitProject(
                        projectId,
                        nextSnapshot.currentWorktreeId ?? null,
                    ),
                    refreshGitHistory(
                        projectId,
                        nextSnapshot.currentWorktreeId ?? null,
                    ),
                    refreshProjectTree(
                        projectId,
                        nextSnapshot.currentWorktreeId ?? null,
                    ),
                ]);
                setIsOpen(false);
                setQuery("");
            } catch (error) {
                setActionError(
                    error instanceof Error
                        ? error.message
                        : "Could not remove this worktree.",
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
            removeWorktree,
            snapshot?.currentWorktreeId,
            worktreeId,
        ],
    );

    const handleInitRepository = useCallback(async () => {
        if (!projectId || isBusy || !canInitializeGit) {
            return;
        }

        setActionError(null);
        setIsBusy(true);

        try {
            const nextSnapshot = await initRepository(projectId, worktreeId);
            await refreshProjectTree(
                projectId,
                nextSnapshot.currentWorktreeId ?? worktreeId ?? null,
            );
            setIsOpen(false);
            setQuery("");
        } catch (error) {
            setActionError(
                error instanceof Error
                    ? error.message
                    : "Could not initialize this git repository.",
            );
        } finally {
            setIsBusy(false);
        }
    }, [
        canInitializeGit,
        initRepository,
        isBusy,
        projectId,
        refreshProjectTree,
        worktreeId,
    ]);

    const openItemContextMenu = useCallback(
        (
            payload: GitScopeContextMenuPayload,
            position: { readonly x: number; readonly y: number },
        ) => {
            setItemContextMenu({
                payload,
                x: position.x,
                y: position.y,
            });
        },
        [],
    );

    const handleBranchContextMenu = useCallback(
        (event: ReactMouseEvent, branchName: string) => {
            event.preventDefault();
            event.stopPropagation();
            openItemContextMenu(
                { branchName, kind: "branch" },
                { x: event.clientX, y: event.clientY },
            );
        },
        [openItemContextMenu],
    );

    const handleWorktreeContextMenu = useCallback(
        (event: ReactMouseEvent, targetWorktreeId: string) => {
            event.preventDefault();
            event.stopPropagation();
            openItemContextMenu(
                { kind: "worktree", worktreeId: targetWorktreeId },
                { x: event.clientX, y: event.clientY },
            );
        },
        [openItemContextMenu],
    );

    const handleMenuTriggerClick = useCallback(
        (
            event: ReactMouseEvent<HTMLButtonElement>,
            payload: GitScopeContextMenuPayload,
        ) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openItemContextMenu(payload, {
                x: rect.right - 8,
                y: rect.bottom + 6,
            });
        },
        [openItemContextMenu],
    );

    const contextMenuEntries = useMemo(() => {
        if (!itemContextMenu) {
            return [] satisfies ContextMenuEntry[];
        }

        if (itemContextMenu.payload.kind === "branch") {
            const row =
                branchRowByName.get(itemContextMenu.payload.branchName) ?? null;
            if (!row) {
                return [] satisfies ContextMenuEntry[];
            }

            const entries: ContextMenuEntry[] = [];
            const linkedWorktree = row.branchWorktree;
            const canSwitchToLinkedWorktree =
                linkedWorktree !== null &&
                !areGitScopeWorktreeIdsEqual(
                    projectId ?? linkedWorktree.projectId,
                    linkedWorktree.id,
                    worktreeId ?? snapshot?.currentWorktreeId ?? null,
                );
            const checkoutLabel = canSwitchToLinkedWorktree
                ? "Switch to Worktree"
                : "Checkout";
            const canCreateWorktree = linkedWorktree === null;
            const canDeleteLocalBranch =
                !row.branch.isRemote &&
                !row.branch.isCurrent &&
                linkedWorktree === null;
            const canDeleteRemoteBranch =
                parseRemoteBranchReference(
                    row.branch.isRemote
                        ? row.branch.name
                        : row.branch.upstreamName,
                ) !== null;

            entries.push({
                action: () => void handleSelectBranch(row.branch),
                disabled: isBusy || row.isActive,
                label: checkoutLabel,
            });
            entries.push({
                action: () =>
                    openBranchCreationForm(row.branch.name, "context-menu"),
                disabled: isBusy || !projectId,
                label: "New Branch from...",
            });

            if (linkedWorktree) {
                entries.push({
                    action: () =>
                        void handleOpenWorktreeInNewWindow(linkedWorktree),
                    disabled: isBusy,
                    label: "Open Worktree in New Window",
                });
            }

            if (canCreateWorktree) {
                entries.push({
                    action: () => void handleCreateWorktreeFromBranch(row.branch),
                    disabled: isBusy || !projectId,
                    label: "Create Worktree",
                });
            }

            if (canDeleteLocalBranch) {
                entries.push({ type: "separator" });
                entries.push({
                    action: () => void handleDeleteLocalBranch(row.branch),
                    danger: true,
                    disabled: isBusy,
                    label: "Remove Local Branch",
                });
            }

            if (canDeleteRemoteBranch) {
                if (!canDeleteLocalBranch) {
                    entries.push({ type: "separator" });
                }
                entries.push({
                    action: () => void handleDeleteRemoteBranch(row.branch),
                    danger: true,
                    disabled: isBusy,
                    label: "Delete Remote Branch",
                });
            }

            return entries;
        }

        const row =
            worktreeRowById.get(itemContextMenu.payload.worktreeId) ?? null;
        if (!row) {
            return [] satisfies ContextMenuEntry[];
        }

        return [
            {
                action: () => void handleSelectWorktree(row.worktree.id),
                disabled: isBusy || row.isActive,
                label: "Switch Here",
            },
            {
                action: () =>
                    void handleOpenWorktreeInNewWindow(row.worktree),
                disabled: isBusy,
                label: "Open in New Window",
            },
            {
                action: () => void handleRevealWorktreeInFinder(row.worktree),
                disabled: !projectId,
                label: "Reveal in Finder",
            },
            { type: "separator" },
            {
                action: () => void handleRemoveWorktree(row.worktree),
                danger: true,
                disabled:
                    isBusy ||
                    row.worktree.isCurrent ||
                    row.worktree.isLocked ||
                    row.worktree.isPrimary,
                label: "Remove Worktree",
            },
        ] satisfies ContextMenuEntry[];
    }, [
        branchRowByName,
        handleCreateWorktreeFromBranch,
        handleDeleteLocalBranch,
        handleDeleteRemoteBranch,
        handleOpenWorktreeInNewWindow,
        handleRemoveWorktree,
        handleRevealWorktreeInFinder,
        handleSelectBranch,
        handleSelectWorktree,
        isBusy,
        itemContextMenu,
        openBranchCreationForm,
        projectId,
        snapshot?.currentWorktreeId,
        worktreeId,
        worktreeRowById,
    ]);

    const handleSelectFocused = useCallback(() => {
        const item = flatItems[focusIndex];
        if (!item) return;

        if (item.kind === "create-branch") {
            openBranchCreationForm(
                defaultBranchCreationBase,
                "search",
                item.branchName,
            );
        } else if (item.kind === "branch") {
            void handleSelectBranch(item.branch);
        } else {
            void handleSelectWorktree(item.worktree.id);
        }
    }, [
        defaultBranchCreationBase,
        flatItems,
        focusIndex,
        handleSelectBranch,
        handleSelectWorktree,
        openBranchCreationForm,
    ]);

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

    const handleVirtualListReady = useCallback(
        (handle: MeasuredVirtualListHandle | null) => {
            virtualListRef.current = handle;
        },
        [],
    );

    const handleMenuResizeMove = useCallback((event: PointerEvent) => {
        const resizeState = menuResizeStateRef.current;
        if (!resizeState) {
            return;
        }

        event.preventDefault();
        const nextSize = clampGitScopeMenuSize(
            {
                height:
                    resizeState.startHeight + event.clientY - resizeState.startY,
                width: resizeState.startWidth + event.clientX - resizeState.startX,
            },
            {
                x: resizeState.x,
                y: resizeState.y,
            },
        );
        pendingMenuSizeRef.current = nextSize;
        setMenuPosition((current) =>
            current
                ? {
                      ...current,
                      height: nextSize.height,
                      width: nextSize.width,
                  }
                : current,
        );
    }, []);

    const handleMenuResizeEndEvent = useCallback(() => {
        menuResizeEndRef.current?.();
    }, []);

    const handleMenuResizeEnd = useCallback(() => {
        const nextSize = pendingMenuSizeRef.current;
        menuResizeStateRef.current = null;
        pendingMenuSizeRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handleMenuResizeMove);
        window.removeEventListener("pointerup", handleMenuResizeEndEvent);
        window.removeEventListener("pointercancel", handleMenuResizeEndEvent);

        if (!nextSize) {
            return;
        }

        setUserMenuSize(nextSize);
        persistGitScopeMenuSize(nextSize);
    }, [handleMenuResizeEndEvent, handleMenuResizeMove]);

    useEffect(() => {
        menuResizeEndRef.current = handleMenuResizeEnd;
        return () => {
            if (menuResizeEndRef.current === handleMenuResizeEnd) {
                menuResizeEndRef.current = null;
            }
        };
    }, [handleMenuResizeEnd]);

    const handleMenuResizeStart = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const rect = menuRef.current?.getBoundingClientRect();
            if (!rect) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const startSize = clampGitScopeMenuSize(
                {
                    height: rect.height,
                    width: rect.width,
                },
                {
                    x: rect.left,
                    y: rect.top,
                },
            );
            menuResizeStateRef.current = {
                startHeight: startSize.height,
                startWidth: startSize.width,
                startX: event.clientX,
                startY: event.clientY,
                x: rect.left,
                y: rect.top,
            };
            pendingMenuSizeRef.current = startSize;
            document.body.style.cursor = "nwse-resize";
            document.body.style.userSelect = "none";
            window.addEventListener("pointermove", handleMenuResizeMove);
            window.addEventListener("pointerup", handleMenuResizeEndEvent);
            window.addEventListener("pointercancel", handleMenuResizeEndEvent);
        },
        [handleMenuResizeEndEvent, handleMenuResizeMove],
    );

    useEffect(() => {
        return () => {
            window.removeEventListener("pointermove", handleMenuResizeMove);
            window.removeEventListener("pointerup", handleMenuResizeEndEvent);
            window.removeEventListener("pointercancel", handleMenuResizeEndEvent);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
    }, [handleMenuResizeEndEvent, handleMenuResizeMove]);

    useEffect(() => {
        if (focusIndex < 0 || !listRef.current) return;

        const renderIndex = selectableRenderIndexByFocusIndex.get(focusIndex);
        if (renderIndex == null) {
            return;
        }

        if (shouldVirtualizeList) {
            virtualListRef.current?.scrollToIndex(renderIndex, {
                align: "center",
            });
            return;
        }

        const rows = listRef.current.querySelectorAll("[data-row-index]");
        const row = rows[focusIndex] as HTMLElement | undefined;
        row?.scrollIntoView({ block: "nearest" });
    }, [focusIndex, selectableRenderIndexByFocusIndex, shouldVirtualizeList]);

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
    const canOpenBranchCreation =
        activeTab === "branches" &&
        !canInitializeGit &&
        branchCreationBaseOptions.length > 0;
    const renderListItem = useCallback(
        (item: RenderListItem) => {
            if (item.kind === "section") {
                return (
                    <SectionHeader
                        collapsed={item.collapsed}
                        count={item.count}
                        label={item.label}
                        onToggle={() => toggleSection(item.section)}
                    />
                );
            }

            if (item.kind === "branch") {
                const { row, selectableIndex } = item;

                return (
                    <div data-row-index={selectableIndex}>
                        <SidebarNodeRow
                            badges={row.badges}
                            description={row.description}
                            isActive={row.isActive}
                            isSelected={selectableIndex === focusIndex}
                            leading={<BranchGlyph />}
                            onContextMenu={(event) =>
                                handleBranchContextMenu(
                                    event,
                                    row.branch.name,
                                )
                            }
                            onClick={
                                isBusy
                                    ? undefined
                                    : () => void handleSelectBranch(row.branch)
                            }
                            title={row.branch.name}
                            trailing={
                                <RowMenuTrigger
                                    disabled={isBusy}
                                    label={`Open branch menu for ${row.branch.name}`}
                                    onClick={(event) =>
                                        handleMenuTriggerClick(event, {
                                            branchName: row.branch.name,
                                            kind: "branch",
                                        })
                                    }
                                />
                            }
                        />
                    </div>
                );
            }

            const { row, selectableIndex } = item;

            return (
                <div data-row-index={selectableIndex}>
                    <SidebarNodeRow
                        badges={row.badges}
                        description={row.description}
                        isActive={row.isActive}
                        isSelected={selectableIndex === focusIndex}
                        leading={<WorktreeGlyph />}
                        onContextMenu={(event) =>
                            handleWorktreeContextMenu(
                                event,
                                row.worktree.id,
                            )
                        }
                        onClick={
                            isBusy
                                ? undefined
                                : () =>
                                      void handleSelectWorktree(
                                          row.worktree.id,
                                      )
                        }
                        title={row.title}
                        trailing={
                            <RowMenuTrigger
                                disabled={isBusy}
                                label={`Open worktree menu for ${row.title}`}
                                onClick={(event) =>
                                    handleMenuTriggerClick(event, {
                                        kind: "worktree",
                                        worktreeId: row.worktree.id,
                                    })
                                }
                            />
                        }
                    />
                </div>
            );
        },
        [
            focusIndex,
            handleBranchContextMenu,
            handleMenuTriggerClick,
            handleSelectBranch,
            handleSelectWorktree,
            handleWorktreeContextMenu,
            isBusy,
            toggleSection,
        ],
    );

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
                              height: menuPosition?.height,
                              left: menuPosition?.x ?? 8,
                              top: menuPosition?.y ?? 8,
                              width: menuPosition?.width ?? 280,
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
                              {activeTab === "branches" && !canInitializeGit ? (
                                  <div className="sidebar-git-scope-menu__actions">
                                      <button
                                          className="sidebar-git-scope-menu__new-branch-button"
                                          disabled={
                                              isBusy || !canOpenBranchCreation
                                          }
                                          onClick={() =>
                                              openBranchCreationForm(
                                                  defaultBranchCreationBase,
                                                  "current",
                                              )
                                          }
                                          type="button"
                                      >
                                          <PlusIcon />
                                          <span>New Branch</span>
                                      </button>
                                  </div>
                              ) : null}
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

                          {branchCreationDraft ? (
                              <BranchCreationForm
                                  baseName={branchCreationBaseName}
                                  baseOptions={branchCreationBaseOptions}
                                  checkoutAfterCreate={branchCreationCheckout}
                                  disabled={isBusy}
                                  name={branchCreationName}
                                  onBaseNameChange={setBranchCreationBaseName}
                                  onCancel={closeBranchCreationForm}
                                  onCheckoutAfterCreateChange={
                                      setBranchCreationCheckout
                                  }
                                  onNameChange={(nextName) => {
                                      setBranchCreationName(nextName);
                                      setBranchCreationSubmitted(false);
                                  }}
                                  onSubmit={(event) => {
                                      void handleCreateBranchSubmit(event);
                                  }}
                                  validationError={
                                      branchCreationSubmitted
                                          ? (branchCreationValidation?.error ??
                                            null)
                                          : null
                                  }
                              />
                          ) : null}

                          <div
                              className="shell-scrollbar sidebar-git-scope-menu__list"
                              ref={listRef}
                          >
                              {branchCreationQueryOffer ? (
                                  <BranchCreationQueryOfferRow
                                      branchName={
                                          branchCreationQueryOffer.branchName
                                      }
                                      disabled={isBusy}
                                      isSelected={focusIndex === 0}
                                      onClick={() =>
                                          openBranchCreationForm(
                                              defaultBranchCreationBase,
                                              "search",
                                              branchCreationQueryOffer.branchName,
                                          )
                                      }
                                  />
                              ) : null}
                              {canInitializeGit ? (
                                  <GitInitState
                                      disabled={isBusy}
                                      onInit={handleInitRepository}
                                  />
                              ) : listItems.length === 0 &&
                                !branchCreationQueryOffer ? (
                                  <EmptyState label={emptyLabel} />
                              ) : shouldVirtualizeList ? (
                                  <MeasuredVirtualList
                                      defaultViewportHeight={420}
                                      enabled={shouldVirtualizeList}
                                      estimateSize={(item) =>
                                          item.kind === "section"
                                              ? GIT_SCOPE_SECTION_ESTIMATE
                                              : GIT_SCOPE_ROW_ESTIMATE
                                      }
                                      getItemKey={(item) => item.key}
                                      items={listItems}
                                      onReady={handleVirtualListReady}
                                      overscan={GIT_SCOPE_VIRTUALIZATION_OVERSCAN}
                                      renderItem={({ item }) =>
                                          renderListItem(item)
                                      }
                                      scrollContainerRef={listRef}
                                  />
                              ) : (
                                  listItems.map((item) => (
                                      <div key={item.key}>
                                          {renderListItem(item)}
                                      </div>
                                  ))
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

                          <div
                              aria-hidden="true"
                              className="sidebar-git-scope-menu__resize-handle"
                              onPointerDown={handleMenuResizeStart}
                              title="Resize"
                          />
                      </div>,
                      document.body,
                  )
                : null}

            {itemContextMenu ? (
                <ContextMenu
                    entries={contextMenuEntries}
                    menu={itemContextMenu}
                    minWidth={188}
                    onClose={() => setItemContextMenu(null)}
                    zIndex={10010}
                />
            ) : null}
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

function BranchCreationQueryOfferRow({
    branchName,
    disabled,
    isSelected,
    onClick,
}: {
    readonly branchName: string;
    readonly disabled: boolean;
    readonly isSelected: boolean;
    readonly onClick: () => void;
}) {
    return (
        <button
            className={[
                "sidebar-git-scope-menu__create-query",
                isSelected ? "sidebar-git-scope-menu__create-query--selected" : "",
            ]
                .filter(Boolean)
                .join(" ")}
            disabled={disabled}
            onClick={onClick}
            type="button"
        >
            <span className="sidebar-git-scope-menu__create-query-icon">
                <PlusIcon />
            </span>
            <span className="sidebar-git-scope-menu__create-query-copy">
                Create <span>{branchName}</span>
            </span>
        </button>
    );
}

function GitInitState({
    disabled,
    onInit,
}: {
    readonly disabled: boolean;
    readonly onInit: () => Promise<void>;
}) {
    return (
        <div className="sidebar-git-scope-menu__init">
            <div className="sidebar-git-scope-menu__init-copy">
                This project is not a Git repository yet.
            </div>
            <button
                className="sidebar-git-scope-menu__init-button"
                disabled={disabled}
                onClick={() => void onInit()}
                type="button"
            >
                <BranchGlyph />
                <span>Initialize Git</span>
            </button>
        </div>
    );
}

function BranchCreationForm({
    baseName,
    baseOptions,
    checkoutAfterCreate,
    disabled,
    name,
    onBaseNameChange,
    onCancel,
    onCheckoutAfterCreateChange,
    onNameChange,
    onSubmit,
    validationError,
}: {
    readonly baseName: string;
    readonly baseOptions: readonly BranchCreationBaseOption[];
    readonly checkoutAfterCreate: boolean;
    readonly disabled: boolean;
    readonly name: string;
    readonly onBaseNameChange: (value: string) => void;
    readonly onCancel: () => void;
    readonly onCheckoutAfterCreateChange: (value: boolean) => void;
    readonly onNameChange: (value: string) => void;
    readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    readonly validationError: string | null;
}) {
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    return (
        <form
            className="sidebar-git-scope-menu__branch-form"
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    onCancel();
                }
                event.stopPropagation();
            }}
            onSubmit={onSubmit}
        >
            <div className="sidebar-git-scope-menu__branch-form-header">
                <span>New Branch</span>
            </div>

            <label className="sidebar-git-scope-menu__branch-form-field">
                <span>Name</span>
                <input
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="ide-input app-no-drag w-full text-xs"
                    disabled={disabled}
                    onChange={(event) => onNameChange(event.target.value)}
                    placeholder="feature/my-branch"
                    ref={inputRef}
                    spellCheck={false}
                    value={name}
                />
            </label>
            {validationError ? (
                <div className="sidebar-git-scope-menu__branch-form-error">
                    {validationError}
                </div>
            ) : null}

            <label className="sidebar-git-scope-menu__branch-form-field">
                <span>Base</span>
                <select
                    className="ide-input app-no-drag w-full text-xs"
                    disabled={disabled || baseOptions.length === 0}
                    onChange={(event) => onBaseNameChange(event.target.value)}
                    value={baseName}
                >
                    {baseOptions.map((option) => (
                        <option key={option.name} value={option.name}>
                            {option.name}
                            {option.isCurrent ? " · current" : ""}
                            {option.isRemote ? " · remote" : ""}
                        </option>
                    ))}
                </select>
            </label>

            <label className="sidebar-git-scope-menu__branch-form-checkbox">
                <input
                    checked={checkoutAfterCreate}
                    disabled={disabled}
                    onChange={(event) =>
                        onCheckoutAfterCreateChange(event.target.checked)
                    }
                    type="checkbox"
                />
                <span>Checkout branch</span>
            </label>

            <div className="sidebar-git-scope-menu__branch-form-actions">
                <button
                    className="sidebar-git-scope-menu__branch-form-secondary"
                    disabled={disabled}
                    onClick={onCancel}
                    type="button"
                >
                    Cancel
                </button>
                <button
                    className="sidebar-git-scope-menu__branch-form-primary"
                    disabled={disabled || baseOptions.length === 0}
                    type="submit"
                >
                    Create Branch
                </button>
            </div>
        </form>
    );
}

function RowMenuTrigger({
    disabled = false,
    label,
    onClick,
}: {
    readonly disabled?: boolean;
    readonly label: string;
    readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
    return (
        <button
            aria-label={label}
            className={[
                "flex h-6 w-6 items-center justify-center rounded-md text-text-secondary transition",
                disabled
                    ? "cursor-not-allowed text-text-secondary/40"
                    : "hover:bg-bg-tertiary hover:text-text-primary",
            ].join(" ")}
            disabled={disabled}
            onClick={onClick}
            title={label}
            type="button"
        >
            <HorizontalDotsIcon />
        </button>
    );
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

function PlusIcon() {
    return (
        <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
            <path
                d="M8 3.5v9M3.5 8h9"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.4"
            />
        </svg>
    );
}

function getBranchBadges(
    branch: GitBranchSummary,
    branchWorktree: GitWorktreeSummary | null,
    projectId: string | null,
    activeWorktreeId: string | null,
): readonly SidebarBadge[] {
    const badges: SidebarBadge[] = [];

    if (branch.isCurrent) {
        badges.push({ label: "Current", tone: "accent" });
    }

    if (
        branchWorktree &&
        !isGitScopeWorktreeActive(
            projectId ?? branchWorktree.projectId,
            activeWorktreeId,
            branchWorktree,
        )
    ) {
        badges.push({ label: "Worktree", tone: "success" });
    }

    return badges;
}

function getRemoteBranchBadges(
    resolution: RemoteBranchResolution,
    branchWorktree: GitWorktreeSummary | null,
    projectId: string | null,
    activeWorktreeId: string | null,
): readonly SidebarBadge[] {
    const badges: SidebarBadge[] = [];

    if (resolution.localBranch) {
        badges.push({ label: "Local", tone: "neutral" });
    }

    if (
        branchWorktree &&
        !isGitScopeWorktreeActive(
            projectId ?? branchWorktree.projectId,
            activeWorktreeId,
            branchWorktree,
        )
    ) {
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

function resolveRemoteBranchResolutionWithIndexes(
    remoteBranch: GitBranchSummary,
    localBranchByUpstream: ReadonlyMap<string, GitBranchSummary>,
    localBranchNames: ReadonlySet<string>,
    worktreeByBranchName: ReadonlyMap<string, GitWorktreeSummary>,
): RemoteBranchResolution {
    const localBranch = localBranchByUpstream.get(remoteBranch.name) ?? null;
    const suggestedLocalBranchName = stripRemotePrefix(remoteBranch.name);
    const linkedWorktree =
        worktreeByBranchName.get(
            localBranch?.name ?? suggestedLocalBranchName,
        ) ?? null;
    const hasSuggestedNameConflict =
        !localBranch && localBranchNames.has(suggestedLocalBranchName);

    return {
        hasSuggestedNameConflict,
        linkedWorktree,
        localBranch,
        suggestedLocalBranchName,
    };
}

export function resolveRemoteBranchResolution(
    remoteBranch: GitBranchSummary,
    branches: readonly GitBranchSummary[],
    worktrees: readonly GitWorktreeSummary[],
): RemoteBranchResolution {
    const localBranchByUpstream = new Map<string, GitBranchSummary>();
    const localBranchNames = new Set<string>();
    const worktreeByBranchName = new Map<string, GitWorktreeSummary>();

    for (const branch of branches) {
        if (branch.isRemote) {
            continue;
        }

        localBranchNames.add(branch.name);
        if (branch.upstreamName) {
            localBranchByUpstream.set(branch.upstreamName, branch);
        }
    }

    for (const worktree of worktrees) {
        if (!worktree.branchName) {
            continue;
        }

        worktreeByBranchName.set(worktree.branchName, worktree);
    }

    return resolveRemoteBranchResolutionWithIndexes(
        remoteBranch,
        localBranchByUpstream,
        localBranchNames,
        worktreeByBranchName,
    );
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

export function parseRemoteBranchReference(referenceName: string | null): {
    readonly remoteName: string;
    readonly remoteRef: string;
} | null {
    if (!referenceName) {
        return null;
    }

    const segments = referenceName.split("/").filter(Boolean);
    if (segments.length < 2) {
        return null;
    }

    if (segments[0] === "refs" && segments[1] === "remotes") {
        if (segments.length < 4) {
            return null;
        }

        return {
            remoteName: segments[2] ?? "",
            remoteRef: segments.slice(3).join("/"),
        };
    }

    if (segments[0] === "remotes") {
        if (segments.length < 3) {
            return null;
        }

        return {
            remoteName: segments[1] ?? "",
            remoteRef: segments.slice(2).join("/"),
        };
    }

    return {
        remoteName: segments[0] ?? "",
        remoteRef: segments.slice(1).join("/"),
    };
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

function getComandoApi() {
    if (!window.comando) {
        throw new Error(
            "The desktop bridge is not available yet. Restart the Electron app and try again.",
        );
    }

    return window.comando;
}

export function isGitScopeWorktreeActive(
    projectId: string,
    activeWorktreeId: string | null,
    worktree: GitWorktreeSummary,
): boolean {
    return isGitWorktreeActive(projectId, activeWorktreeId, worktree);
}

function areGitScopeWorktreeIdsEqual(
    projectId: string,
    leftWorktreeId: string | null,
    rightWorktreeId: string | null,
): boolean {
    return areGitWorktreeIdsEquivalent(
        projectId,
        leftWorktreeId,
        rightWorktreeId,
    );
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

function HorizontalDotsIcon() {
    return (
        <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="currentColor"
            viewBox="0 0 16 16"
        >
            <circle cx="3" cy="8" r="1.2" />
            <circle cx="8" cy="8" r="1.2" />
            <circle cx="13" cy="8" r="1.2" />
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
    return getGitContextKey(projectId, worktreeId);
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
