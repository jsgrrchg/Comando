import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type {
    GitHubAuthStatus,
    GitHubIssueState,
    GitHubIssueSummary,
    GitHubLabelSummary,
    GitHubPullRequestSummary,
    GitHubRepositoryRef,
    GitRepositorySnapshot,
} from "@shared/ipc";

import {
    countCurrentBranchPullRequests,
    isPullRequestForCurrentBranch,
    sortPullRequestsNewestFirst,
} from "@renderer/app/github/current-branch-pr";
import {
    appendWorkspaceTabComposerItem,
    createEmptyComposerParts,
    type AIComposerPart,
} from "@renderer/components/workspace/chat/composerParts";
import {
    createGitHubIssueComposerDragItem,
    createGitHubPullRequestComposerDragItem,
    type WorkspaceTabComposerDragItem,
} from "@renderer/app/drag-and-drop";
import { getGitContextKey } from "@renderer/app/git/context-key";
import { resolveGitHubRepositoryRef } from "@renderer/app/git/remote-link";
import { useGitStore } from "@renderer/app/store/git-store";
import {
    EMPTY_GITHUB_LIST,
    getGitHubRepoKey,
    useGitHubStore,
} from "@renderer/app/store/github-store";
import { getViewportSafeMenuPosition } from "@renderer/app/utils/menu-position";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "@renderer/components/context-menu/ContextMenu";
import {
    formatGitHubRelativeTime,
    GitHubEmptyState,
    GitHubErrorState,
    GitHubLabelPill,
    GitHubUsers,
    hasGitHubWritePermission,
    openGitHubWebUrl,
} from "@renderer/components/workspace/GitHubWorkspacePrimitives";

import {
    emitSidebarGitHubDrag,
    type SidebarGitHubDragItem,
    type SidebarGitHubDragItemKind,
} from "./sidebarGitHubDragEvents";
import {
    shouldCancelSidebarDragOnMove,
    shouldEmitSidebarDragCancel,
} from "./sidebarDragGuards";
import {
    selectGitTreeRange,
    toggleGitTreePathSelection,
} from "../git/treeSelection";

type SidebarGitHubPanelKind = "issues" | "pull_requests";
type SidebarIssueFilter = GitHubIssueState | "all" | "assigned";
type SidebarPullRequestFilter = "all" | "branch" | "closed" | "draft" | "open";

/* Circular-arrows glyph for the refresh action */
function RefreshIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.4"
            viewBox="0 0 16 16"
            width="14"
        >
            <path d="M13 8a5 5 0 1 1-1.46-3.54" />
            <path d="M13 2.5V5H10.5" />
        </svg>
    );
}

/* Open-in-view glyph (arrow leaving a panel) for the open-list action */
function OpenListIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.4"
            viewBox="0 0 16 16"
            width="14"
        >
            <path d="M8.5 3H4a1.5 1.5 0 0 0-1.5 1.5V12A1.5 1.5 0 0 0 4 13.5h7.5A1.5 1.5 0 0 0 13 12V7.5" />
            <path d="M9.5 2.5H13.5V6.5" />
            <path d="M13.5 2.5 8 8" />
        </svg>
    );
}

type SidebarGitHubDragPreview = {
    readonly kindLabel: string;
    readonly meta: string;
    readonly title: string;
    readonly x: number;
    readonly y: number;
};

type SidebarGitHubDragSnapshot = {
    readonly itemKind: SidebarGitHubDragItemKind;
    readonly items: readonly SidebarGitHubDragItem[];
    readonly number: number;
    readonly previewKindLabel: string;
    readonly previewMeta: string;
    readonly previewTitle: string;
    readonly projectId: string | null;
    readonly ref: GitHubRepositoryRef;
    readonly title: string;
    readonly worktreeId: string | null;
};

type SidebarGitHubPointerPoint = {
    readonly clientX: number;
    readonly clientY: number;
};

type SidebarGitHubContextMenuPayload = {
    readonly itemNumbers: readonly number[];
};

type SidebarIssueLabelPickerState = {
    readonly issueNumber: number;
    readonly x: number;
    readonly y: number;
};

export type SidebarGitHubAddToChatRequest =
    | {
          readonly forceNewChat: boolean;
          readonly items: readonly GitHubIssueSummary[];
          readonly kind: "issues";
          readonly parts: readonly AIComposerPart[];
          readonly projectId: string | null;
          readonly worktreeId: string | null;
      }
    | {
          readonly forceNewChat: boolean;
          readonly items: readonly GitHubPullRequestSummary[];
          readonly kind: "pull_requests";
          readonly parts: readonly AIComposerPart[];
          readonly projectId: string | null;
          readonly worktreeId: string | null;
      };

interface SidebarGitHubSelectionState {
    readonly anchorNumber: number | null;
    readonly selectedNumbers: readonly number[];
}

interface ResolveSidebarGitHubItemClickSelectionInput {
    readonly anchorNumber: number | null;
    readonly isRangeSelection: boolean;
    readonly isToggleSelection: boolean;
    readonly itemNumber: number;
    readonly selectedNumbers: readonly number[];
    readonly visibleNumbers: readonly number[];
}

interface ReconcileSidebarGitHubSelectionInput {
    readonly anchorNumber: number | null;
    readonly selectedNumbers: readonly number[];
    readonly visibleNumbers: readonly number[];
}

const SIDEBAR_GITHUB_DRAG_THRESHOLD_PX = 6;

export function SidebarGitHubPanel({
    filter,
    kind,
    onAddToChat,
    onOpenSettings,
    projectId,
    selectionResetSignal = 0,
    worktreeId,
}: {
    readonly filter?: string;
    readonly kind: SidebarGitHubPanelKind;
    readonly onAddToChat?: (request: SidebarGitHubAddToChatRequest) => void;
    readonly onOpenSettings: () => void;
    readonly projectId: string | null;
    readonly selectionResetSignal?: number;
    readonly worktreeId: string | null;
}) {
    const snapshot = useGitStore((state) =>
        projectId
            ? getProjectSnapshot(state.snapshots, projectId, worktreeId)
            : null,
    );
    const githubSnapshot = useGitStore((state) =>
        projectId
            ? getGitHubRepositorySnapshot(
                  state.snapshots,
                  projectId,
                  worktreeId,
              )
            : null,
    );
    const repoRef = useMemo(
        () => resolveGitHubRepositoryRef(githubSnapshot?.remotes ?? []),
        [githubSnapshot?.remotes],
    );
    const repoKey = repoRef ? getGitHubRepoKey(repoRef) : null;
    const authStatus = useGitHubStore((state) =>
        repoRef ? (state.authStatusByHost[repoRef.host] ?? null) : null,
    );
    const [issueFilter, setIssueFilter] =
        useState<SidebarIssueFilter>("open");
    const [pullRequestFilter, setPullRequestFilter] =
        useState<SidebarPullRequestFilter>("open");
    const currentBranch = snapshot?.branch?.isDetached
        ? null
        : (snapshot?.branch?.name ?? null);
    const requiredIssueListState = getIssueListState(issueFilter);
    const requiredPullRequestListState =
        getPullRequestListState(pullRequestFilter);
    const issues = useGitHubStore((state): readonly GitHubIssueSummary[] =>
        repoKey
            ? (state.issuesByRepoAndState[repoKey]?.[
                  requiredIssueListState
              ] ??
              (state.issueListStateByRepo[repoKey] === requiredIssueListState
                  ? (state.issuesByRepo[repoKey] ?? EMPTY_GITHUB_LIST)
                  : EMPTY_GITHUB_LIST))
            : EMPTY_GITHUB_LIST,
    );
    const hasIssueCache = useGitHubStore((state) =>
        repoKey
            ? state.issuesByRepoAndState[repoKey]?.[
                  requiredIssueListState
              ] !== undefined
            : false,
    );
    const pullRequests = useGitHubStore(
        (state): readonly GitHubPullRequestSummary[] =>
            repoKey
                ? (state.pullRequestsByRepoAndState[repoKey]?.[
                      requiredPullRequestListState
                  ] ??
                  (state.pullRequestListStateByRepo[repoKey] ===
                  requiredPullRequestListState
                      ? (state.pullRequestsByRepo[repoKey] ??
                        EMPTY_GITHUB_LIST)
                      : EMPTY_GITHUB_LIST))
                : EMPTY_GITHUB_LIST,
    );
    const hasPullRequestCache = useGitHubStore((state) =>
        repoKey
            ? state.pullRequestsByRepoAndState[repoKey]?.[
                  requiredPullRequestListState
              ] !== undefined
            : false,
    );
    const labels = useGitHubStore((state): readonly GitHubLabelSummary[] =>
        repoKey ? (state.labelsByRepo[repoKey] ?? EMPTY_GITHUB_LIST) : EMPTY_GITHUB_LIST,
    );
    const isCheckingAuth = useGitHubStore((state) =>
        repoRef ? (state.loadingKeys[`auth:${repoRef.host}`] ?? false) : false,
    );
    const isLoadingIssues = useGitHubStore((state) =>
        repoKey ? (state.loadingKeys[`${repoKey}:issues`] ?? false) : false,
    );
    const isLoadingPullRequests = useGitHubStore((state) =>
        repoKey ? (state.loadingKeys[`${repoKey}:prs`] ?? false) : false,
    );
    const isLoadingLabels = useGitHubStore((state) =>
        repoKey ? (state.loadingKeys[`${repoKey}:labels`] ?? false) : false,
    );
    const issueError = useGitHubStore((state) =>
        repoKey ? (state.errors[`${repoKey}:issues`] ?? null) : null,
    );
    const labelsError = useGitHubStore((state) =>
        repoKey ? (state.errors[`${repoKey}:labels`] ?? null) : null,
    );
    const pullRequestError = useGitHubStore((state) =>
        repoKey ? (state.errors[`${repoKey}:prs`] ?? null) : null,
    );
    const authError = useGitHubStore((state) =>
        repoRef ? (state.errors[`auth:${repoRef.host}`] ?? null) : null,
    );
    const refreshAuthStatus = useGitHubStore(
        (state) => state.refreshAuthStatus,
    );
    const refreshIssues = useGitHubStore((state) => state.refreshIssues);
    const refreshLabels = useGitHubStore((state) => state.refreshLabels);
    const refreshPullRequests = useGitHubStore(
        (state) => state.refreshPullRequests,
    );
    const updateIssue = useGitHubStore((state) => state.updateIssue);
    const mutatingKeys = useGitHubStore((state) => state.mutatingKeys);
    const openGitHubIssuesTab = useWorkspaceStore(
        (state) => state.openGitHubIssuesTab,
    );
    const openGitHubIssueTab = useWorkspaceStore(
        (state) => state.openGitHubIssueTab,
    );
    const openGitHubPullRequestsTab = useWorkspaceStore(
        (state) => state.openGitHubPullRequestsTab,
    );
    const openGitHubPullRequestTab = useWorkspaceStore(
        (state) => state.openGitHubPullRequestTab,
    );
    const [githubContextMenu, setGitHubContextMenu] =
        useState<ContextMenuState<SidebarGitHubContextMenuPayload> | null>(null);
    const [labelPicker, setLabelPicker] =
        useState<SidebarIssueLabelPickerState | null>(null);
    const [selectionAnchorNumber, setSelectionAnchorNumber] = useState<
        number | null
    >(null);
    const [selectedItemNumbers, setSelectedItemNumbers] = useState<
        readonly number[]
    >([]);
    const selectionScopeRef = useRef<string | null>(null);
    const normalizedSearch = (filter ?? "").trim().toLowerCase();
    const disabledReason = getDisabledReason({
        authError,
        authStatus,
        isCheckingAuth,
        projectId,
        repoRef,
        snapshot: githubSnapshot,
    });

    useEffect(() => {
        if (!repoRef || authStatus) {
            return;
        }

        void refreshAuthStatus(repoRef).catch(() => undefined);
    }, [authStatus, refreshAuthStatus, repoRef]);

    useEffect(() => {
        if (kind !== "issues" || !repoRef || !repoKey) {
            return;
        }
        if (hasIssueCache) {
            return;
        }

        const activeRepoKey = repoKey;
        const activeRepoRef = repoRef;
        const activeListState = requiredIssueListState;
        let cancelled = false;

        async function loadIssues() {
            if (
                useGitHubStore.getState().issuesByRepoAndState[
                    activeRepoKey
                ]?.[activeListState] !== undefined
            ) {
                return;
            }

            const status =
                useGitHubStore.getState().authStatusByHost[
                    activeRepoRef.host
                ] ?? (await refreshAuthStatus(activeRepoRef));
            if (!cancelled && status.state === "authenticated") {
                await refreshIssues(activeRepoRef, {
                    state: activeListState,
                });
            }
        }

        void loadIssues().catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [
        hasIssueCache,
        kind,
        refreshAuthStatus,
        refreshIssues,
        repoKey,
        repoRef,
        requiredIssueListState,
    ]);

    useEffect(() => {
        if (kind !== "pull_requests" || !repoRef || !repoKey) {
            return;
        }
        if (hasPullRequestCache) {
            return;
        }

        const activeRepoKey = repoKey;
        const activeRepoRef = repoRef;
        const activeListState = requiredPullRequestListState;
        let cancelled = false;

        async function loadPullRequests() {
            if (
                useGitHubStore.getState().pullRequestsByRepoAndState[
                    activeRepoKey
                ]?.[activeListState] !== undefined
            ) {
                return;
            }

            const status =
                useGitHubStore.getState().authStatusByHost[
                    activeRepoRef.host
                ] ?? (await refreshAuthStatus(activeRepoRef));
            if (!cancelled && status.state === "authenticated") {
                await refreshPullRequests(activeRepoRef, {
                    state: activeListState,
                });
            }
        }

        void loadPullRequests().catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [
        hasPullRequestCache,
        kind,
        refreshAuthStatus,
        refreshPullRequests,
        repoKey,
        repoRef,
        requiredPullRequestListState,
    ]);

    const visibleIssues = useMemo(() => {
        const login = authStatus?.user?.login ?? null;

        return issues.filter((issue) => {
            if (
                issueFilter === "assigned" &&
                (!login ||
                    !issue.assignees.some(
                        (assignee) => assignee.login === login,
                    ))
            ) {
                return false;
            }

            if (
                issueFilter !== "all" &&
                issueFilter !== "assigned" &&
                issue.state !== issueFilter
            ) {
                return false;
            }

            if (!normalizedSearch) {
                return true;
            }

            return issueMatchesSearch(issue, normalizedSearch);
        });
    }, [authStatus?.user?.login, issueFilter, issues, normalizedSearch]);

    const visiblePullRequests = useMemo(() => {
        const filteredPullRequests = pullRequests.filter((pullRequest) => {
            if (pullRequestFilter === "draft" && !pullRequest.draft) {
                return false;
            }

            if (
                pullRequestFilter === "branch" &&
                (!repoRef ||
                    !isPullRequestForCurrentBranch(
                        pullRequest,
                        currentBranch,
                        repoRef,
                    ))
            ) {
                return false;
            }

            if (
                pullRequestFilter === "closed" &&
                pullRequest.state !== "closed" &&
                pullRequest.state !== "merged"
            ) {
                return false;
            }

            if (
                pullRequestFilter !== "all" &&
                pullRequestFilter !== "branch" &&
                pullRequestFilter !== "closed" &&
                pullRequestFilter !== "draft" &&
                pullRequest.state !== pullRequestFilter
            ) {
                return false;
            }

            if (!normalizedSearch) {
                return true;
            }

            return pullRequestMatchesSearch(pullRequest, normalizedSearch);
        });

        return sortPullRequestsNewestFirst(filteredPullRequests);
    }, [
        currentBranch,
        normalizedSearch,
        pullRequestFilter,
        pullRequests,
        repoRef,
    ]);

    const currentBranchPullRequestCount = useMemo(
        () =>
            repoRef
                ? countCurrentBranchPullRequests(
                      pullRequests,
                      currentBranch,
                      repoRef,
                  )
                : 0,
        [currentBranch, pullRequests, repoRef],
    );
    const canWriteIssues = hasGitHubWritePermission(authStatus, "issues");
    const visibleItemNumbers = useMemo(
        () =>
            kind === "issues"
                ? visibleIssues.map((issue) => issue.number)
                : visiblePullRequests.map((pullRequest) => pullRequest.number),
        [kind, visibleIssues, visiblePullRequests],
    );
    const visibleItemNumbersKey = visibleItemNumbers.join("\u0000");
    const selectionScopeKey = `${repoKey ?? "none"}:${kind}`;

    useEffect(() => {
        if (selectionScopeRef.current === selectionScopeKey) {
            return;
        }

        selectionScopeRef.current = selectionScopeKey;
        setSelectionAnchorNumber(null);
        setSelectedItemNumbers([]);
    }, [selectionScopeKey]);

    useEffect(() => {
        setSelectionAnchorNumber(null);
        setSelectedItemNumbers([]);
        setGitHubContextMenu(null);
    }, [selectionResetSignal]);

    useEffect(() => {
        const reconciled = reconcileSidebarGitHubSelection({
            anchorNumber: selectionAnchorNumber,
            selectedNumbers: selectedItemNumbers,
            visibleNumbers: visibleItemNumbers,
        });

        if (
            reconciled.anchorNumber !== selectionAnchorNumber ||
            !areNumberArraysEqual(
                reconciled.selectedNumbers,
                selectedItemNumbers,
            )
        ) {
            setSelectionAnchorNumber(reconciled.anchorNumber);
            setSelectedItemNumbers(reconciled.selectedNumbers);
        }
    }, [
        selectedItemNumbers,
        selectionAnchorNumber,
        visibleItemNumbers,
        visibleItemNumbersKey,
    ]);

    const selectedItemNumberSet = useMemo(
        () => new Set(selectedItemNumbers),
        [selectedItemNumbers],
    );
    const contextMenuPosition = githubContextMenu
        ? { x: githubContextMenu.x, y: githubContextMenu.y }
        : null;
    const contextIssues = useMemo(
        () =>
            githubContextMenu && kind === "issues"
                ? getSidebarGitHubItemsByNumber(
                      visibleIssues,
                      githubContextMenu.payload.itemNumbers,
                  )
                : [],
        [githubContextMenu, kind, visibleIssues],
    );
    const contextPullRequests = useMemo(
        () =>
            githubContextMenu && kind === "pull_requests"
                ? getSidebarGitHubItemsByNumber(
                      visiblePullRequests,
                      githubContextMenu.payload.itemNumbers,
                  )
                : [],
        [githubContextMenu, kind, visiblePullRequests],
    );
    const contextItemCount =
        kind === "issues" ? contextIssues.length : contextPullRequests.length;
    const activeLabelPickerIssue = labelPicker
        ? (visibleIssues.find(
              (issue) => issue.number === labelPicker.issueNumber,
          ) ??
          issues.find((issue) => issue.number === labelPicker.issueNumber) ??
          null)
        : null;
    const isUpdatingLabelPickerIssue =
        repoKey && activeLabelPickerIssue
            ? (mutatingKeys[
                  `${repoKey}:issue:${activeLabelPickerIssue.number}:update`
              ] ?? false)
            : false;
    const openIssueTab = useCallback(
        (issueNumber: number) => {
            if (!repoRef) {
                return;
            }

            void openGitHubIssueTab({
                issueNumber,
                projectId,
                ref: repoRef,
                worktreeId,
            });
        },
        [openGitHubIssueTab, projectId, repoRef, worktreeId],
    );
    const openIssueLabelPicker = useCallback(
        (issue: GitHubIssueSummary, position: { x: number; y: number }) => {
            if (!repoRef) {
                return;
            }

            setLabelPicker({
                issueNumber: issue.number,
                x: position.x,
                y: position.y,
            });
            void refreshLabels(repoRef).catch(() => undefined);
        },
        [refreshLabels, repoRef],
    );
    const addGitHubItemsToChat = useCallback(
        (options: { readonly forceNewChat: boolean }) => {
            if (!repoRef || !onAddToChat || contextItemCount === 0) {
                return;
            }

            if (kind === "issues") {
                onAddToChat({
                    forceNewChat: options.forceNewChat,
                    items: contextIssues,
                    kind: "issues",
                    parts: buildSidebarGitHubComposerParts(
                        repoRef,
                        contextIssues,
                        "issues",
                    ),
                    projectId,
                    worktreeId,
                });
                return;
            }

            onAddToChat({
                forceNewChat: options.forceNewChat,
                items: contextPullRequests,
                kind: "pull_requests",
                parts: buildSidebarGitHubComposerParts(
                    repoRef,
                    contextPullRequests,
                    "pull_requests",
                ),
                projectId,
                worktreeId,
            });
        },
        [
            contextIssues,
            contextItemCount,
            contextPullRequests,
            kind,
            onAddToChat,
            projectId,
            repoRef,
            worktreeId,
        ],
    );
    const contextMenuEntries: ContextMenuEntry[] =
        repoRef && githubContextMenu && contextMenuPosition && contextItemCount > 0
            ? buildSidebarGitHubContextMenuEntries({
                  canWriteIssues,
                  count: contextItemCount,
                  kind,
                  onAddToChat: () =>
                      addGitHubItemsToChat({ forceNewChat: false }),
                  onAddToNewChat: () =>
                      addGitHubItemsToChat({ forceNewChat: true }),
                  onEditLabels:
                      kind === "issues" && contextIssues.length === 1
                          ? () =>
                                openIssueLabelPicker(
                                    contextIssues[0],
                                    contextMenuPosition,
                                )
                          : null,
                  onOpen:
                      kind === "issues"
                          ? () => openIssueTab(contextIssues[0].number)
                          : () =>
                                void openGitHubPullRequestTab({
                                    projectId,
                                    pullRequestNumber:
                                        contextPullRequests[0].number,
                                    ref: repoRef,
                                    worktreeId,
                                }),
                  onOpenInGitHub: () =>
                      openGitHubWebUrl(
                          kind === "issues"
                              ? contextIssues[0].url
                              : contextPullRequests[0].url,
                      ),
              })
            : [];
    const handleItemClickSelection = useCallback(
        (
            event: ReactMouseEvent<HTMLElement>,
            itemNumber: number,
            onOpen: () => void,
        ) => {
            const nextSelection = resolveSidebarGitHubItemClickSelection({
                anchorNumber: selectionAnchorNumber,
                isRangeSelection: event.shiftKey,
                isToggleSelection: event.metaKey || event.ctrlKey,
                itemNumber,
                selectedNumbers: selectedItemNumbers,
                visibleNumbers: visibleItemNumbers,
            });
            setSelectionAnchorNumber(nextSelection.anchorNumber);
            setSelectedItemNumbers(nextSelection.selectedNumbers);

            if (
                shouldOpenSidebarGitHubItemClick({
                    ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey,
                    shiftKey: event.shiftKey,
                })
            ) {
                onOpen();
            }
        },
        [selectedItemNumbers, selectionAnchorNumber, visibleItemNumbers],
    );
    const handleItemContextMenu = useCallback(
        (event: ReactMouseEvent<HTMLElement>, itemNumber: number) => {
            event.preventDefault();
            event.stopPropagation();
            setLabelPicker(null);
            const itemNumbers = getSidebarGitHubContextNumbers({
                itemNumber,
                selectedNumbers: selectedItemNumbers,
                visibleNumbers: visibleItemNumbers,
            });
            setSelectionAnchorNumber(itemNumber);
            setSelectedItemNumbers(itemNumbers);
            setGitHubContextMenu({
                payload: { itemNumbers },
                x: event.clientX,
                y: event.clientY,
            });
        },
        [selectedItemNumbers, visibleItemNumbers],
    );
    const handleItemPointerDown = useCallback(() => {
        setGitHubContextMenu(null);
        setLabelPicker(null);
    }, []);
    const getIssueDragItems = useCallback(
        (issue: GitHubIssueSummary): readonly SidebarGitHubDragItem[] =>
            getSidebarGitHubDragItems({
                item: issue,
                selectedNumbers: selectedItemNumbers,
                visibleItems: visibleIssues,
                visibleNumbers: visibleItemNumbers,
            }),
        [selectedItemNumbers, visibleIssues, visibleItemNumbers],
    );
    const getPullRequestDragItems = useCallback(
        (
            pullRequest: GitHubPullRequestSummary,
        ): readonly SidebarGitHubDragItem[] =>
            getSidebarGitHubDragItems({
                item: pullRequest,
                selectedNumbers: selectedItemNumbers,
                visibleItems: visiblePullRequests,
                visibleNumbers: visibleItemNumbers,
            }),
        [selectedItemNumbers, visiblePullRequests, visibleItemNumbers],
    );
    const handleSaveIssueLabels = useCallback(
        async (labelNames: readonly string[]) => {
            if (!repoRef || !activeLabelPickerIssue || !canWriteIssues) {
                return;
            }

            await updateIssue(repoRef, activeLabelPickerIssue.number, {
                labels: labelNames,
            });
            setLabelPicker(null);
        },
        [activeLabelPickerIssue, canWriteIssues, repoRef, updateIssue],
    );

    const handleRefresh = useCallback(async () => {
        if (!repoRef) {
            return;
        }

        try {
            const status = await refreshAuthStatus(repoRef);
            if (status.state !== "authenticated") {
                return;
            }

            if (kind === "issues") {
                await refreshIssues(repoRef, {
                    state: requiredIssueListState,
                });
                return;
            }

            await refreshPullRequests(repoRef, {
                state: requiredPullRequestListState,
            });
        } catch {
            // The store records the displayable error for this request.
        }
    }, [
        kind,
        refreshAuthStatus,
        refreshIssues,
        refreshPullRequests,
        repoRef,
        requiredIssueListState,
        requiredPullRequestListState,
    ]);

    const handleOpenList = useCallback(() => {
        if (!projectId || !repoRef) {
            return;
        }

        const input = {
            projectId,
            ref: repoRef,
            worktreeId,
        };

        if (kind === "issues") {
            void openGitHubIssuesTab(input);
            return;
        }

        void openGitHubPullRequestsTab(input);
    }, [
        kind,
        openGitHubIssuesTab,
        openGitHubPullRequestsTab,
        projectId,
        repoRef,
        worktreeId,
    ]);

    const panelTitle = kind === "issues" ? "Issues" : "Pull Requests";
    const isLoading =
        isCheckingAuth ||
        (kind === "issues" ? isLoadingIssues : isLoadingPullRequests);
    const error =
        authError ?? (kind === "issues" ? issueError : pullRequestError);
    const visibleCount =
        kind === "issues" ? visibleIssues.length : visiblePullRequests.length;
    const totalCount = kind === "issues" ? issues.length : pullRequests.length;

    if (disabledReason) {
        return (
            <SidebarGitHubStatus
                action={
                    repoRef &&
                    !isCheckingAuth &&
                    authStatus?.state !== "authenticated" ? (
                        <button
                            className="review-action-btn"
                            onClick={onOpenSettings}
                            type="button"
                        >
                            Connect
                        </button>
                    ) : null
                }
                title={panelTitle}
            >
                {disabledReason}
            </SidebarGitHubStatus>
        );
    }

    if (!repoRef) {
        return null;
    }

    const activeRepoRef = repoRef;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-border/50 px-2 py-2">
                <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="min-w-0">
                        <div className="text-[12px] font-semibold text-text-primary">
                            {panelTitle}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <button
                            aria-label="Refresh"
                            className="review-icon-btn"
                            disabled={isLoading}
                            onClick={() => void handleRefresh()}
                            title="Refresh"
                            type="button"
                        >
                            <RefreshIcon />
                        </button>
                        <button
                            aria-label={
                                kind === "issues"
                                    ? "Open issues in a tab"
                                    : "Open pull requests in a tab"
                            }
                            className="review-icon-btn"
                            onClick={handleOpenList}
                            title={
                                kind === "issues"
                                    ? "Open issues in a tab"
                                    : "Open pull requests in a tab"
                            }
                            type="button"
                        >
                            <OpenListIcon />
                        </button>
                    </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                    {kind === "issues" ? (
                        <>
                            <SidebarGitHubFilterButton
                                active={issueFilter === "open"}
                                onClick={() => setIssueFilter("open")}
                            >
                                Open
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={issueFilter === "closed"}
                                onClick={() => setIssueFilter("closed")}
                            >
                                Closed
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={issueFilter === "assigned"}
                                onClick={() => setIssueFilter("assigned")}
                            >
                                Assigned
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={issueFilter === "all"}
                                onClick={() => setIssueFilter("all")}
                            >
                                All
                            </SidebarGitHubFilterButton>
                        </>
                    ) : (
                        <>
                            <SidebarGitHubFilterButton
                                active={pullRequestFilter === "open"}
                                onClick={() => setPullRequestFilter("open")}
                            >
                                Open
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={pullRequestFilter === "branch"}
                                onClick={() => setPullRequestFilter("branch")}
                            >
                                {currentBranchPullRequestCount > 0
                                    ? `Branch ${currentBranchPullRequestCount}`
                                    : "Branch"}
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={pullRequestFilter === "draft"}
                                onClick={() => setPullRequestFilter("draft")}
                            >
                                Draft
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={pullRequestFilter === "closed"}
                                onClick={() => setPullRequestFilter("closed")}
                            >
                                Closed
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={pullRequestFilter === "all"}
                                onClick={() => setPullRequestFilter("all")}
                            >
                                All
                            </SidebarGitHubFilterButton>
                        </>
                    )}
                </div>
                <div className="mt-2 text-[10px] text-text-secondary">
                    {normalizedSearch
                        ? `${visibleCount} of ${totalCount}`
                        : `${visibleCount} ${visibleCount === 1 ? "item" : "items"}`}
                </div>
            </div>

            <div className="shell-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-2">
                {error ? (
                    <div className="px-1 pb-2">
                        <GitHubErrorState>{error}</GitHubErrorState>
                    </div>
                ) : null}
                {isLoading ? (
                    <div className="px-3 py-3 text-[12px] text-text-secondary">
                        Loading {kind === "issues" ? "issues" : "pull requests"}
                        ...
                    </div>
                ) : null}
                {!isLoading && visibleCount === 0 ? (
                    <GitHubEmptyState>
                        No {kind === "issues" ? "issues" : "pull requests"} match
                        this view.
                    </GitHubEmptyState>
                ) : null}
                {kind === "issues" && visibleIssues.length > 0 ? (
                    <ul className="space-y-1">
                        {visibleIssues.map((issue) => (
                            <li key={issue.id}>
                                <SidebarGitHubIssueRow
                                    dragItems={getIssueDragItems(issue)}
                                    issue={issue}
                                    onContextMenu={(event) =>
                                        handleItemContextMenu(
                                            event,
                                            issue.number,
                                        )
                                    }
                                    onOpen={() => openIssueTab(issue.number)}
                                    onPointerDown={handleItemPointerDown}
                                    onRowClick={(event) =>
                                        handleItemClickSelection(
                                            event,
                                            issue.number,
                                            () => openIssueTab(issue.number),
                                        )
                                    }
                                    projectId={projectId}
                                    repoRef={activeRepoRef}
                                    selected={selectedItemNumberSet.has(
                                        issue.number,
                                    )}
                                    worktreeId={worktreeId}
                                />
                            </li>
                        ))}
                    </ul>
                ) : null}
                {kind === "pull_requests" && visiblePullRequests.length > 0 ? (
                    <ul className="space-y-1">
                        {visiblePullRequests.map((pullRequest) => (
                            <li key={pullRequest.id}>
                                <SidebarGitHubPullRequestRow
                                    currentBranch={currentBranch}
                                    dragItems={getPullRequestDragItems(
                                        pullRequest,
                                    )}
                                    onContextMenu={(event) =>
                                        handleItemContextMenu(
                                            event,
                                            pullRequest.number,
                                        )
                                    }
                                    onOpen={() =>
                                        void openGitHubPullRequestTab({
                                            projectId,
                                            pullRequestNumber:
                                                pullRequest.number,
                                            ref: activeRepoRef,
                                            worktreeId,
                                        })
                                    }
                                    onPointerDown={handleItemPointerDown}
                                    onRowClick={(event) =>
                                        handleItemClickSelection(
                                            event,
                                            pullRequest.number,
                                            () =>
                                                void openGitHubPullRequestTab({
                                                    projectId,
                                                    pullRequestNumber:
                                                        pullRequest.number,
                                                    ref: activeRepoRef,
                                                    worktreeId,
                                                }),
                                        )
                                    }
                                    pullRequest={pullRequest}
                                    projectId={projectId}
                                    repoRef={activeRepoRef}
                                    selected={selectedItemNumberSet.has(
                                        pullRequest.number,
                                    )}
                                    worktreeId={worktreeId}
                                />
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
            {githubContextMenu && contextMenuEntries.length > 0 ? (
                <ContextMenu
                    entries={contextMenuEntries}
                    menu={githubContextMenu}
                    minWidth={230}
                    onClose={() => setGitHubContextMenu(null)}
                />
            ) : null}
            {activeLabelPickerIssue && labelPicker ? (
                <SidebarGitHubLabelPicker
                    anchor={{ x: labelPicker.x, y: labelPicker.y }}
                    error={labelsError}
                    issue={activeLabelPickerIssue}
                    isLoading={isLoadingLabels}
                    isSaving={isUpdatingLabelPickerIssue}
                    labels={labels}
                    onClose={() => setLabelPicker(null)}
                    onSave={(labelNames) => void handleSaveIssueLabels(labelNames)}
                />
            ) : null}
        </div>
    );
}

function SidebarGitHubIssueRow({
    dragItems,
    issue,
    onContextMenu,
    onOpen,
    onPointerDown,
    onRowClick,
    projectId,
    repoRef,
    selected,
    worktreeId,
}: {
    readonly dragItems: readonly SidebarGitHubDragItem[];
    readonly issue: GitHubIssueSummary;
    readonly onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
    readonly onOpen: () => void;
    readonly onPointerDown: () => void;
    readonly onRowClick: (event: ReactMouseEvent<HTMLElement>) => void;
    readonly projectId: string | null;
    readonly repoRef: GitHubRepositoryRef;
    readonly selected: boolean;
    readonly worktreeId: string | null;
}) {
    const hasAssignees = issue.assignees.length > 0;
    const issueHeaderClassName = [
        "grid w-full min-w-0 items-start gap-x-2",
        hasAssignees
            ? "grid-cols-[minmax(0,1fr)_auto_auto]"
            : "grid-cols-[minmax(0,1fr)_auto]",
    ].join(" ");

    return (
        <SidebarGitHubDraggableRow
            dragItems={dragItems}
            itemKind="issue"
            meta={`#${issue.number} - ${issue.commentCount} comments`}
            number={issue.number}
            onContextMenu={onContextMenu}
            onOpen={onOpen}
            onPointerDown={onPointerDown}
            onRowClick={onRowClick}
            projectId={projectId}
            repoRef={repoRef}
            selected={selected}
            title={issue.title}
            worktreeId={worktreeId}
        >
            <div className={issueHeaderClassName}>
                <div className="min-w-0">
                    <span className="sidebar-github-title block min-w-0 truncate font-medium text-text-primary">
                        {issue.title}
                    </span>
                    {issue.labels.length > 0 ? (
                        <div className="mt-1 flex min-w-0 flex-wrap gap-1">
                            {issue.labels.slice(0, 3).map((label) => (
                                <GitHubLabelPill
                                    className="sidebar-github-label-pill"
                                    key={label.id}
                                    label={label}
                                />
                            ))}
                        </div>
                    ) : null}
                    <div className="sidebar-github-meta mt-1 flex min-w-0 items-center gap-1.5 text-text-secondary">
                        <span className="shrink-0">
                            updated {formatGitHubRelativeTime(issue.updatedAt)}
                        </span>
                        <span aria-hidden="true" className="shrink-0">
                            -
                        </span>
                        <span className="shrink-0">
                            {issue.commentCount} comments
                        </span>
                        {!hasAssignees ? (
                            <>
                                <span aria-hidden="true" className="shrink-0">
                                    -
                                </span>
                                <span className="shrink-0">Unassigned</span>
                            </>
                        ) : null}
                    </div>
                </div>
                {hasAssignees ? (
                    <div className="sidebar-github-assignees shrink-0">
                        <GitHubUsers users={issue.assignees} />
                    </div>
                ) : null}
                <span className="sidebar-github-number shrink-0 font-mono text-text-secondary">
                    #{issue.number}
                </span>
            </div>
        </SidebarGitHubDraggableRow>
    );
}

function SidebarGitHubPullRequestRow({
    currentBranch,
    dragItems,
    onContextMenu,
    onOpen,
    onPointerDown,
    onRowClick,
    projectId,
    pullRequest,
    repoRef,
    selected,
    worktreeId,
}: {
    readonly currentBranch: string | null;
    readonly dragItems: readonly SidebarGitHubDragItem[];
    readonly onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
    readonly onOpen: () => void;
    readonly onPointerDown: () => void;
    readonly onRowClick: (event: ReactMouseEvent<HTMLElement>) => void;
    readonly projectId: string | null;
    readonly pullRequest: GitHubPullRequestSummary;
    readonly repoRef: GitHubRepositoryRef;
    readonly selected: boolean;
    readonly worktreeId: string | null;
}) {
    const isCurrentBranchPullRequest = isPullRequestForCurrentBranch(
        pullRequest,
        currentBranch,
        repoRef,
    );
    return (
        <SidebarGitHubDraggableRow
            dragItems={dragItems}
            itemKind="pull_request"
            meta={`PR #${pullRequest.number} - ${pullRequest.head.ref}`}
            number={pullRequest.number}
            onContextMenu={onContextMenu}
            onOpen={onOpen}
            onPointerDown={onPointerDown}
            onRowClick={onRowClick}
            projectId={projectId}
            repoRef={repoRef}
            selected={selected}
            title={pullRequest.title}
            worktreeId={worktreeId}
        >
            <div className="flex w-full min-w-0 items-center gap-2">
                <span className="sidebar-github-title min-w-0 flex-1 truncate font-medium text-text-primary">
                    {pullRequest.title}
                </span>
                <span className="sidebar-github-number shrink-0 font-mono text-text-secondary">
                    #{pullRequest.number}
                </span>
            </div>
            <div className="sidebar-github-branch mt-1 flex w-full min-w-0 items-center gap-1.5 font-mono text-text-secondary">
                <span className="min-w-0 truncate">{pullRequest.head.label}</span>
                <span aria-hidden="true" className="shrink-0">
                    -&gt;
                </span>
                <span className="min-w-0 truncate">{pullRequest.base.label}</span>
            </div>
            <div className="sidebar-github-meta mt-1 flex w-full min-w-0 items-center gap-1.5 text-text-secondary">
                <span className="shrink-0">
                    updated {formatGitHubRelativeTime(pullRequest.updatedAt)}
                </span>
                <span aria-hidden="true" className="shrink-0">
                    -
                </span>
                <span className="shrink-0">
                    {pullRequest.author?.login ?? "ghost"}
                </span>
                {isCurrentBranchPullRequest ? (
                    <>
                        <span aria-hidden="true" className="shrink-0">
                            -
                        </span>
                        <span className="sidebar-github-branch-badge shrink-0 rounded-[3px] border border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-border))] text-text-primary">
                            Branch
                        </span>
                    </>
                ) : null}
            </div>
        </SidebarGitHubDraggableRow>
    );
}

function SidebarGitHubLabelPicker({
    anchor,
    error,
    issue,
    isLoading,
    isSaving,
    labels,
    onClose,
    onSave,
}: {
    readonly anchor: { readonly x: number; readonly y: number };
    readonly error: string | null;
    readonly issue: GitHubIssueSummary;
    readonly isLoading: boolean;
    readonly isSaving: boolean;
    readonly labels: readonly GitHubLabelSummary[];
    readonly onClose: () => void;
    readonly onSave: (labelNames: readonly string[]) => void;
}) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [query, setQuery] = useState("");
    const [position, setPosition] = useState(anchor);
    const [selectedNames, setSelectedNames] = useState<ReadonlySet<string>>(
        () => new Set(issue.labels.map((label) => label.name)),
    );

    useEffect(() => {
        const handleMouseDown = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                onClose();
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };

        document.addEventListener("mousedown", handleMouseDown);
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            document.removeEventListener("mousedown", handleMouseDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [onClose]);

    useEffect(() => {
        setQuery("");
        setSelectedNames(new Set(issue.labels.map((label) => label.name)));
    }, [issue.number, issue.labels]);

    const normalizedQuery = query.trim().toLowerCase();
    const visibleLabels = labels.filter(
        (label) =>
            !normalizedQuery ||
            label.name.toLowerCase().includes(normalizedQuery) ||
            (label.description?.toLowerCase().includes(normalizedQuery) ??
                false),
    );
    const labelNames = labels.map((label) => label.name);
    const selectedLabels = labelNames.filter((name) => selectedNames.has(name));

    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) {
            return;
        }

        const rect = element.getBoundingClientRect();
        setPosition(
            getViewportSafeMenuPosition(
                anchor.x,
                anchor.y,
                rect.width,
                rect.height,
            ),
        );
    }, [
        anchor.x,
        anchor.y,
        error,
        isLoading,
        labels.length,
        visibleLabels.length,
    ]);

    const toggleLabel = (labelName: string) => {
        setSelectedNames((current) => {
            const next = new Set(current);
            if (next.has(labelName)) {
                next.delete(labelName);
            } else {
                next.add(labelName);
            }
            return next;
        });
    };

    return createPortal(
        <div
            className="fixed w-[min(320px,calc(100vw-16px))] rounded-lg border border-border bg-bg-panel p-2 shadow-[0_18px_42px_rgba(0,0,0,0.34)]"
            data-context-menu-root="true"
            ref={ref}
            style={{ left: position.x, top: position.y, zIndex: 10020 }}
        >
            <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-text-primary">
                        Edit Labels
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-text-secondary">
                        #{issue.number} {issue.title}
                    </div>
                </div>
                <button
                    className="review-action-btn"
                    onClick={onClose}
                    type="button"
                >
                    Close
                </button>
            </div>
            <input
                className="mt-3 h-[24px] w-full rounded-md border border-border/70 bg-bg-primary px-2 font-mono text-[11px] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search labels..."
                value={query}
            />
            {error ? (
                <div className="mt-2 rounded-md border border-[color-mix(in_srgb,var(--diff-remove)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-remove)_8%,transparent)] px-2 py-1.5 text-[11px] text-text-primary">
                    {error}
                </div>
            ) : null}
            <div className="shell-scrollbar mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
                {isLoading ? (
                    <div className="px-1 py-2 text-[11px] text-text-secondary">
                        Loading labels...
                    </div>
                ) : null}
                {!isLoading && visibleLabels.length === 0 ? (
                    <div className="px-1 py-2 text-[11px] text-text-secondary">
                        No labels match this search.
                    </div>
                ) : null}
                {visibleLabels.map((label) => (
                    <label
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-text-primary hover:bg-bg-tertiary"
                        key={label.id || label.name}
                    >
                        <input
                            checked={selectedNames.has(label.name)}
                            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                            onChange={() => toggleLabel(label.name)}
                            type="checkbox"
                        />
                        <span
                            aria-hidden="true"
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: `#${label.color}` }}
                        />
                        <span className="min-w-0 flex-1 truncate">
                            {label.name}
                        </span>
                    </label>
                ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
                <button
                    className="review-action-btn"
                    disabled={isSaving || selectedNames.size === 0}
                    onClick={() => setSelectedNames(new Set())}
                    type="button"
                >
                    Clear
                </button>
                <div className="flex items-center gap-2">
                    <button
                        className="review-action-btn"
                        disabled={isSaving}
                        onClick={onClose}
                        type="button"
                    >
                        Cancel
                    </button>
                    <button
                        className="review-action-btn"
                        disabled={isSaving || isLoading}
                        onClick={() => onSave(selectedLabels)}
                        type="button"
                    >
                        {isSaving ? "Saving..." : "Save"}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

export function SidebarGitHubDraggableRow({
    children,
    dragItems,
    itemKind,
    meta,
    number,
    onContextMenu,
    onOpen,
    onPointerDown,
    onRowClick,
    projectId,
    repoRef,
    selected,
    title,
    worktreeId,
}: {
    readonly children: ReactNode;
    readonly dragItems: readonly SidebarGitHubDragItem[];
    readonly itemKind: SidebarGitHubDragItemKind;
    readonly meta: string;
    readonly number: number;
    readonly onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
    readonly onOpen: () => void;
    readonly onPointerDown?: () => void;
    readonly onRowClick?: (event: ReactMouseEvent<HTMLElement>) => void;
    readonly projectId: string | null;
    readonly repoRef: GitHubRepositoryRef;
    readonly selected: boolean;
    readonly title: string;
    readonly worktreeId: string | null;
}) {
    const dragStateRef = useRef<{
        readonly captureElement: HTMLElement | null;
        readonly pointerId: number;
        readonly snapshot: SidebarGitHubDragSnapshot;
        readonly startX: number;
        readonly startY: number;
        active: boolean;
    } | null>(null);
    const suppressClickRef = useRef(false);
    const [dragPreview, setDragPreview] =
        useState<SidebarGitHubDragPreview | null>(null);
    const [isPointerTracking, setIsPointerTracking] = useState(false);
    const kindLabel = itemKind === "issue" ? "Issue" : "Pull Request";
    const previewKindLabel =
        dragItems.length > 1 ? getSidebarGitHubPluralLabel(itemKind) : kindLabel;
    const previewTitle =
        dragItems.length > 1 ? `${dragItems.length} ${previewKindLabel}` : title;
    const previewMeta =
        dragItems.length > 1 ? `${dragItems.length} selected` : meta;

    const emitDrag = useCallback(
        (
            snapshot: SidebarGitHubDragSnapshot,
            phase: "cancel" | "end" | "move" | "start",
            event?: SidebarGitHubPointerPoint,
        ) => {
            emitSidebarGitHubDrag({
                itemKind: snapshot.itemKind,
                items: snapshot.items,
                number: snapshot.number,
                phase,
                projectId: snapshot.projectId,
                ref: snapshot.ref,
                title: snapshot.title,
                worktreeId: snapshot.worktreeId,
                x: event?.clientX ?? 0,
                y: event?.clientY ?? 0,
            });
        },
        [],
    );

    const updateDragPreview = useCallback(
        (
            snapshot: SidebarGitHubDragSnapshot,
            event: SidebarGitHubPointerPoint,
        ) => {
            setDragPreview({
                kindLabel: snapshot.previewKindLabel,
                meta: snapshot.previewMeta,
                title: snapshot.previewTitle,
                x: event.clientX,
                y: event.clientY,
            });
        },
        [],
    );

    const clearDragState = useCallback(
        ({
            emitCancel,
            event,
            pointerId,
            releaseTarget,
        }: {
            readonly emitCancel: boolean;
            readonly event?: SidebarGitHubPointerPoint;
            readonly pointerId?: number;
            readonly releaseTarget?: EventTarget | null;
        }) => {
            const dragState = dragStateRef.current;
            if (!dragState) {
                return;
            }

            dragStateRef.current = null;
            setIsPointerTracking(false);
            setDragPreview(null);

            const captureElement =
                releaseTarget instanceof HTMLElement
                    ? releaseTarget
                    : dragState.captureElement;
            if (captureElement && pointerId !== undefined) {
                captureElement.releasePointerCapture?.(pointerId);
            }

            if (emitCancel && shouldEmitSidebarDragCancel(dragState.active)) {
                emitDrag(dragState.snapshot, "cancel", event);
            }
        },
        [emitDrag],
    );

    useEffect(() => {
        if (!isPointerTracking) {
            return;
        }

        const handleWindowBlur = () => {
            clearDragState({ emitCancel: true });
        };
        const handlePointerCancel = (event: PointerEvent) => {
            const dragState = dragStateRef.current;
            if (!dragState || dragState.pointerId !== event.pointerId) {
                return;
            }

            clearDragState({
                emitCancel: true,
                event,
                pointerId: event.pointerId,
            });
        };
        const handlePointerUp = (event: PointerEvent) => {
            const dragState = dragStateRef.current;
            if (!dragState || dragState.pointerId !== event.pointerId) {
                return;
            }

            dragStateRef.current = null;
            setIsPointerTracking(false);
            dragState.captureElement?.releasePointerCapture?.(event.pointerId);
            if (!dragState.active) {
                setDragPreview(null);
                return;
            }

            setDragPreview(null);
            suppressClickRef.current = true;
            window.requestAnimationFrame(() => {
                suppressClickRef.current = false;
            });
            emitDrag(dragState.snapshot, "end", event);
        };
        const handleVisibilityChange = () => {
            if (document.visibilityState !== "hidden") {
                return;
            }

            clearDragState({ emitCancel: true });
        };

        window.addEventListener("blur", handleWindowBlur);
        window.addEventListener("pointercancel", handlePointerCancel);
        window.addEventListener("pointerup", handlePointerUp);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.removeEventListener("blur", handleWindowBlur);
            window.removeEventListener("pointercancel", handlePointerCancel);
            window.removeEventListener("pointerup", handlePointerUp);
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
            clearDragState({ emitCancel: true });
        };
    }, [clearDragState, emitDrag, isPointerTracking]);

    return (
        <>
            <div
                className="sidebar-agents-row app-no-drag w-full"
                aria-selected={selected ? true : undefined}
                data-active={selected ? "true" : "false"}
                data-selected={selected ? "true" : "false"}
                onClick={(event) => {
                    if (suppressClickRef.current) return;
                    onRowClick?.(event);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpen();
                    }
                }}
                onContextMenu={(event) => {
                    clearDragState({
                        emitCancel: true,
                        event,
                    });
                    onContextMenu?.(event);
                }}
                onPointerCancel={(event) => {
                    const dragState = dragStateRef.current;
                    if (!dragState || dragState.pointerId !== event.pointerId) {
                        return;
                    }

                    clearDragState({
                        emitCancel: true,
                        event,
                        pointerId: event.pointerId,
                        releaseTarget: event.currentTarget,
                    });
                }}
                onLostPointerCapture={(event) => {
                    const dragState = dragStateRef.current;
                    if (!dragState || dragState.pointerId !== event.pointerId) {
                        return;
                    }

                    clearDragState({
                        emitCancel: true,
                        event,
                    });
                }}
                onPointerDown={(event) => {
                    if (
                        event.button !== 0 ||
                        isInteractiveSidebarGitHubDragTarget(
                            event.target,
                            event.currentTarget,
                        )
                    ) {
                        return;
                    }

                    onPointerDown?.();
                    dragStateRef.current = {
                        active: false,
                        captureElement: event.currentTarget,
                        pointerId: event.pointerId,
                        snapshot: {
                            itemKind,
                            items: dragItems,
                            number,
                            previewKindLabel,
                            previewMeta,
                            previewTitle,
                            projectId,
                            ref: repoRef,
                            title,
                            worktreeId,
                        },
                        startX: event.clientX,
                        startY: event.clientY,
                    };
                    setIsPointerTracking(true);
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                }}
                onPointerMove={(event) => {
                    const dragState = dragStateRef.current;
                    if (!dragState || dragState.pointerId !== event.pointerId) {
                        return;
                    }
                    if (shouldCancelSidebarDragOnMove(event.buttons)) {
                        clearDragState({
                            emitCancel: true,
                            event,
                            pointerId: event.pointerId,
                            releaseTarget: event.currentTarget,
                        });
                        return;
                    }

                    if (!dragState.active) {
                        const deltaX = event.clientX - dragState.startX;
                        const deltaY = event.clientY - dragState.startY;
                        if (
                            Math.hypot(deltaX, deltaY) <
                            SIDEBAR_GITHUB_DRAG_THRESHOLD_PX
                        ) {
                            return;
                        }

                        dragState.active = true;
                        updateDragPreview(dragState.snapshot, event);
                        emitDrag(dragState.snapshot, "start", event);
                    } else {
                        updateDragPreview(dragState.snapshot, event);
                        emitDrag(dragState.snapshot, "move", event);
                    }

                    event.preventDefault();
                }}
                onPointerUp={(event) => {
                    const dragState = dragStateRef.current;
                    if (!dragState || dragState.pointerId !== event.pointerId) {
                        return;
                    }

                    dragStateRef.current = null;
                    setIsPointerTracking(false);
                    event.currentTarget.releasePointerCapture?.(event.pointerId);
                    if (!dragState.active) {
                        setDragPreview(null);
                        return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    setDragPreview(null);
                    suppressClickRef.current = true;
                    window.requestAnimationFrame(() => {
                        suppressClickRef.current = false;
                    });
                    emitDrag(dragState.snapshot, "end", event);
                }}
                role="button"
                tabIndex={0}
                title={title}
            >
                {children}
            </div>
            {dragPreview && typeof document !== "undefined"
                ? createPortal(
                      <SidebarGitHubDragGhost preview={dragPreview} />,
                      document.body,
                  )
                : null}
        </>
    );
}

function SidebarGitHubDragGhost({
    preview,
}: {
    readonly preview: SidebarGitHubDragPreview;
}) {
    return (
        <div
            aria-hidden="true"
            className="pointer-events-none fixed min-w-44 max-w-72 rounded-lg border border-accent/30 bg-bg-panel/96 px-2.5 py-2 text-text-primary shadow-[0_14px_34px_rgba(15,23,42,0.28)] backdrop-blur-sm"
            style={{
                left: preview.x + 14,
                top: preview.y + 14,
                transform: "translate3d(0, 0, 0) scale(1.02)",
                zIndex: 10050,
            }}
        >
            <div className="flex min-w-0 items-center gap-2">
                <span
                    aria-hidden="true"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/10 text-[10px] font-semibold text-accent"
                >
                    GH
                </span>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[11.5px] font-medium leading-tight">
                        {preview.title}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] leading-tight text-text-secondary">
                        Drag to pane or composer - {preview.kindLabel} -{" "}
                        {preview.meta}
                    </div>
                </div>
            </div>
        </div>
    );
}

function SidebarGitHubFilterButton({
    active,
    children,
    onClick,
}: {
    readonly active?: boolean;
    readonly children: ReactNode;
    readonly onClick: () => void;
}) {
    return (
        <button
            className={[
                "rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                active
                    ? "border-[color-mix(in_srgb,var(--color-accent)_45%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-text-primary"
                    : "border-border/70 text-text-secondary hover:bg-bg-elevated hover:text-text-primary",
            ].join(" ")}
            onClick={onClick}
            type="button"
        >
            {children}
        </button>
    );
}

function SidebarGitHubStatus({
    action,
    children,
    title,
}: {
    readonly action?: ReactNode;
    readonly children: ReactNode;
    readonly title: string;
}) {
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-border/50 px-2 py-2">
                <div className="text-[12px] font-semibold text-text-primary">
                    {title}
                </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 text-center text-[12px] leading-5 text-text-secondary">
                <p>{children}</p>
                {action}
            </div>
        </div>
    );
}

export function resolveSidebarGitHubItemClickSelection({
    anchorNumber,
    isRangeSelection,
    isToggleSelection,
    itemNumber,
    selectedNumbers,
    visibleNumbers,
}: ResolveSidebarGitHubItemClickSelectionInput): SidebarGitHubSelectionState {
    if (isRangeSelection) {
        const effectiveAnchorNumber = anchorNumber ?? itemNumber;
        return {
            anchorNumber: effectiveAnchorNumber,
            selectedNumbers: selectGitTreeRange(
                stringifyNumbers(visibleNumbers),
                String(effectiveAnchorNumber),
                String(itemNumber),
            ).map(Number),
        };
    }

    if (isToggleSelection) {
        return {
            anchorNumber: itemNumber,
            selectedNumbers: toggleGitTreePathSelection(
                stringifyNumbers(selectedNumbers),
                String(itemNumber),
            ).map(Number),
        };
    }

    return {
        anchorNumber: itemNumber,
        selectedNumbers: [],
    };
}

export function reconcileSidebarGitHubSelection({
    anchorNumber,
    selectedNumbers,
    visibleNumbers,
}: ReconcileSidebarGitHubSelectionInput): SidebarGitHubSelectionState {
    const visibleNumberSet = new Set(visibleNumbers);
    return {
        anchorNumber:
            anchorNumber !== null && visibleNumberSet.has(anchorNumber)
                ? anchorNumber
                : null,
        selectedNumbers: visibleNumbers.filter((number) =>
            selectedNumbers.includes(number),
        ),
    };
}

export function getSidebarGitHubContextNumbers({
    itemNumber,
    selectedNumbers,
    visibleNumbers,
}: {
    readonly itemNumber: number;
    readonly selectedNumbers: readonly number[];
    readonly visibleNumbers: readonly number[];
}): number[] {
    if (!selectedNumbers.includes(itemNumber)) {
        return [itemNumber];
    }

    const selectedNumberSet = new Set(selectedNumbers);
    const orderedNumbers = visibleNumbers.filter((number) =>
        selectedNumberSet.has(number),
    );
    return orderedNumbers.length > 0 ? orderedNumbers : [itemNumber];
}

export function shouldOpenSidebarGitHubItemClick({
    ctrlKey,
    metaKey,
    shiftKey,
}: {
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
}): boolean {
    return !shiftKey && !metaKey && !ctrlKey;
}

export function getSidebarGitHubDragItems<
    Item extends { readonly number: number; readonly title: string },
>({
    item,
    selectedNumbers,
    visibleItems,
    visibleNumbers,
}: {
    readonly item: Item;
    readonly selectedNumbers: readonly number[];
    readonly visibleItems: readonly Item[];
    readonly visibleNumbers: readonly number[];
}): readonly SidebarGitHubDragItem[] {
    const numbers = getSidebarGitHubContextNumbers({
        itemNumber: item.number,
        selectedNumbers,
        visibleNumbers,
    });
    const items = getSidebarGitHubItemsByNumber(visibleItems, numbers);

    return items.length > 0
        ? items.map(toSidebarGitHubDragItem)
        : [toSidebarGitHubDragItem(item)];
}

export function getSidebarGitHubAddToChatLabel({
    count,
    forceNewChat,
    kind,
}: {
    readonly count: number;
    readonly forceNewChat: boolean;
    readonly kind: SidebarGitHubPanelKind;
}): string {
    const target = forceNewChat ? "New Chat" : "Chat";
    if (count <= 1) {
        const itemLabel = kind === "issues" ? "Issue" : "Pull Request";
        return `Add ${itemLabel} to ${target}`;
    }

    const itemLabel = kind === "issues" ? "Issues" : "Pull Requests";
    return `Add ${count} ${itemLabel} to ${target}`;
}

function buildSidebarGitHubContextMenuEntries({
    canWriteIssues,
    count,
    kind,
    onAddToChat,
    onAddToNewChat,
    onEditLabels,
    onOpen,
    onOpenInGitHub,
}: {
    readonly canWriteIssues: boolean;
    readonly count: number;
    readonly kind: SidebarGitHubPanelKind;
    readonly onAddToChat: () => void;
    readonly onAddToNewChat: () => void;
    readonly onEditLabels: (() => void) | null;
    readonly onOpen: () => void;
    readonly onOpenInGitHub: () => void;
}): ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = [
        {
            label: getSidebarGitHubAddToChatLabel({
                count,
                forceNewChat: false,
                kind,
            }),
            action: onAddToChat,
        },
        {
            label: getSidebarGitHubAddToChatLabel({
                count,
                forceNewChat: true,
                kind,
            }),
            action: onAddToNewChat,
        },
        { type: "separator" },
        {
            label: kind === "issues" ? "Open Issue" : "Open Pull Request",
            action: onOpen,
            disabled: count !== 1,
        },
        {
            label: "Open in GitHub",
            action: onOpenInGitHub,
            disabled: count !== 1,
        },
    ];

    if (kind === "issues" && count === 1 && onEditLabels) {
        entries.push(
            { type: "separator" },
            {
                label: "Edit Labels...",
                action: onEditLabels,
                disabled: !canWriteIssues,
            },
        );
    }

    return entries;
}

export function buildSidebarGitHubComposerParts(
    repoRef: GitHubRepositoryRef,
    items:
        | readonly GitHubIssueSummary[]
        | readonly GitHubPullRequestSummary[],
    kind: SidebarGitHubPanelKind,
): AIComposerPart[] {
    const dragItems: WorkspaceTabComposerDragItem[] =
        kind === "issues"
            ? (items as readonly GitHubIssueSummary[]).map((issue) =>
                  createGitHubIssueComposerDragItem(repoRef, issue),
              )
            : (items as readonly GitHubPullRequestSummary[]).map(
                  (pullRequest) =>
                      createGitHubPullRequestComposerDragItem(
                          repoRef,
                          pullRequest,
                      ),
              );

    return dragItems.reduce<AIComposerPart[]>(
        (parts, item) => appendWorkspaceTabComposerItem(parts, item),
        createEmptyComposerParts(),
    );
}

function getSidebarGitHubItemsByNumber<
    Item extends { readonly number: number },
>(items: readonly Item[], numbers: readonly number[]): Item[] {
    const itemByNumber = new Map(items.map((item) => [item.number, item]));
    return numbers
        .map((number) => itemByNumber.get(number) ?? null)
        .filter((item): item is Item => item !== null);
}

function toSidebarGitHubDragItem(item: {
    readonly number: number;
    readonly title: string;
}): SidebarGitHubDragItem {
    return {
        number: item.number,
        title: item.title,
    };
}

function getSidebarGitHubPluralLabel(
    itemKind: SidebarGitHubDragItemKind,
): string {
    return itemKind === "issue" ? "Issues" : "Pull Requests";
}

function stringifyNumbers(numbers: readonly number[]): string[] {
    return numbers.map(String);
}

function areNumberArraysEqual(
    left: readonly number[],
    right: readonly number[],
): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

function getDisabledReason({
    authError,
    authStatus,
    isCheckingAuth,
    projectId,
    repoRef,
    snapshot,
}: {
    readonly authError: string | null;
    readonly authStatus: GitHubAuthStatus | null;
    readonly isCheckingAuth: boolean;
    readonly projectId: string | null;
    readonly repoRef: GitHubRepositoryRef | null;
    readonly snapshot: GitRepositorySnapshot | null;
}): string | null {
    if (!projectId) {
        return "Open a project first.";
    }

    if (!snapshot || snapshot.repositoryState !== "ready") {
        return "Open a Git repository to browse GitHub data.";
    }

    if (!repoRef) {
        return "No GitHub remote detected for this repository.";
    }

    if (!authStatus && isCheckingAuth) {
        return "Checking GitHub authentication...";
    }

    if (authError) {
        return `GitHub authentication failed: ${authError}`;
    }

    if (authStatus?.state !== "authenticated") {
        return "Connect GitHub in Settings to browse repository data.";
    }

    return null;
}

function issueMatchesSearch(
    issue: GitHubIssueSummary,
    normalizedSearch: string,
): boolean {
    return (
        issue.title.toLowerCase().includes(normalizedSearch) ||
        String(issue.number).includes(normalizedSearch) ||
        issue.labels.some((label) =>
            label.name.toLowerCase().includes(normalizedSearch),
        ) ||
        issue.assignees.some((assignee) =>
            assignee.login.toLowerCase().includes(normalizedSearch),
        ) ||
        (issue.author?.login.toLowerCase().includes(normalizedSearch) ?? false)
    );
}

function pullRequestMatchesSearch(
    pullRequest: GitHubPullRequestSummary,
    normalizedSearch: string,
): boolean {
    return (
        pullRequest.title.toLowerCase().includes(normalizedSearch) ||
        String(pullRequest.number).includes(normalizedSearch) ||
        pullRequest.head.label.toLowerCase().includes(normalizedSearch) ||
        pullRequest.head.ref.toLowerCase().includes(normalizedSearch) ||
        pullRequest.base.label.toLowerCase().includes(normalizedSearch) ||
        pullRequest.base.ref.toLowerCase().includes(normalizedSearch) ||
        (pullRequest.author?.login.toLowerCase().includes(normalizedSearch) ??
            false)
    );
}

function getIssueListState(filter: SidebarIssueFilter): GitHubIssueState | "all" {
    return filter === "assigned" ? "all" : filter;
}

function getPullRequestListState(
    filter: SidebarPullRequestFilter,
): "all" | "closed" | "open" {
    return filter === "draft" || filter === "branch" ? "all" : filter;
}

function getContextKey(projectId: string, worktreeId: string | null): string {
    return getGitContextKey(projectId, worktreeId);
}

export function getProjectSnapshot(
    snapshots: Record<string, GitRepositorySnapshot | null>,
    projectId: string,
    worktreeId: string | null,
): GitRepositorySnapshot | null {
    const directMatch = snapshots[getContextKey(projectId, worktreeId)] ?? null;
    if (directMatch) {
        return directMatch;
    }

    if (worktreeId !== null) {
        return null;
    }

    return (
        Object.values(snapshots).find(
            (snapshot) =>
                snapshot?.projectId === projectId &&
                snapshot.currentWorktreeId === null,
        ) ?? null
    );
}

export function getGitHubRepositorySnapshot(
    snapshots: Record<string, GitRepositorySnapshot | null>,
    projectId: string,
    worktreeId: string | null,
): GitRepositorySnapshot | null {
    const directMatch = getProjectSnapshot(snapshots, projectId, worktreeId);
    if (directMatch) {
        return directMatch;
    }

    return (
        Object.values(snapshots).find(
            (snapshot) =>
                snapshot?.projectId === projectId &&
                (worktreeId === null ||
                    snapshot.worktrees.some(
                        (entry) => entry.id === worktreeId,
                    ) ||
                    snapshot.currentWorktreeId === null),
        ) ?? null
    );
}

function isInteractiveSidebarGitHubDragTarget(
    target: EventTarget | null,
    currentTarget: HTMLElement,
): boolean {
    if (!(target instanceof Element)) {
        return false;
    }

    const interactive = target.closest(
        "button,input,textarea,select,a,[role='button']",
    );
    return Boolean(interactive && interactive !== currentTarget);
}
