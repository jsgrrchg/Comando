import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type {
    AiRuntimeId,
    PersistedChatSessionState,
    GitHubRepositoryRef,
    WorkspaceChatHistoryTab,
    WorkspaceChatTab,
    WorkspaceFileTab,
    WorkspaceGitCommitTab,
    WorkspaceGitWorktreeDiffTab,
    WorkspaceGitHubIssueTab,
    WorkspaceGitHubIssuesTab,
    WorkspaceGitHubPullRequestTab,
    WorkspaceGitHubPullRequestsTab,
    WorkspaceGitTab,
    WorkspaceNode,
    WorkspaceReviewTab,
    WorkspaceSnapshot,
    WorkspaceTab,
    WorkspaceTerminalTab,
} from "@shared/ipc";
import { isKnownAiRuntimeId } from "@shared/ai-runtimes";

import type { Awaitable } from "../db/awaitable";
import { debugBenignError } from "../observability/logging";
import { mainProcessPerformance } from "../observability/performance";

interface WorkspaceLayoutRow {
    readonly active_pane_id: string;
    readonly root_node_json: string;
}

interface WorkspaceTabRow {
    readonly created_at: string;
    readonly id: string;
    readonly kind: string;
    readonly payload_json: string;
    readonly position?: number;
    readonly title: string;
    readonly worktree_id: string | null;
}

interface ChatSessionEventRow {
    readonly created_at: string;
    readonly event_type: string;
    readonly id: string;
    readonly payload_json: string;
    readonly sequence: number;
    readonly session_id: string;
}

interface ReviewArtifactRow {
    readonly artifact_type: string;
    readonly created_at: string;
    readonly id: string;
    readonly path: string | null;
    readonly payload_json: string;
    readonly session_id: string | null;
    readonly title: string;
    readonly updated_at: string;
}

type WorkspaceFilePayload = Omit<
    WorkspaceFileTab,
    "createdAt" | "id" | "title"
>;
type WorkspaceChatPayload = Omit<
    WorkspaceChatTab,
    "createdAt" | "id" | "title"
>;
type WorkspaceChatHistoryPayload = Omit<
    WorkspaceChatHistoryTab,
    "createdAt" | "id" | "title"
>;
type WorkspaceGitCommitPayload = Omit<
    WorkspaceGitCommitTab,
    "createdAt" | "id" | "title"
>;
type WorkspaceGitHubIssuesPayload = Omit<
    WorkspaceGitHubIssuesTab,
    "createdAt" | "id" | "title"
>;
type WorkspaceGitHubIssuePayload = Omit<
    WorkspaceGitHubIssueTab,
    "createdAt" | "id" | "title"
>;
type WorkspaceGitHubPullRequestsPayload = Omit<
    WorkspaceGitHubPullRequestsTab,
    "createdAt" | "id" | "title"
>;
type WorkspaceGitHubPullRequestPayload = Omit<
    WorkspaceGitHubPullRequestTab,
    "createdAt" | "id" | "title"
>;
type WorkspaceGitPayload = Omit<WorkspaceGitTab, "createdAt" | "id" | "title">;
type WorkspaceGitWorktreeDiffPayload = Omit<
    WorkspaceGitWorktreeDiffTab,
    "createdAt" | "id" | "title"
>;
type WorkspaceReviewPayload = Omit<
    WorkspaceReviewTab,
    "createdAt" | "id" | "title"
>;
type WorkspaceTerminalPayload = Omit<
    WorkspaceTerminalTab,
    "createdAt" | "id" | "title"
>;

const GIT_WORKTREE_DIFF_TAB_TITLE = "Uncommitted Changes";

export interface WorkspaceGateway {
    loadSnapshot(workspaceId: string): Awaitable<WorkspaceSnapshot>;
    saveSnapshot(
        workspaceId: string,
        snapshot: WorkspaceSnapshot,
    ): Awaitable<void>;
    loadChatSessionState(
        sessionId: string,
    ): Awaitable<PersistedChatSessionState | null>;
}

export class WorkspaceService {
    readonly #connection: Database.Database;

    constructor(connection: Database.Database) {
        this.#connection = connection;
    }

    loadSnapshot(workspaceId: string): WorkspaceSnapshot {
        return mainProcessPerformance.measureSync(
            "db.workspace.loadSnapshot",
            () => {
                const layoutRow = this.#connection
                    .prepare<[string], WorkspaceLayoutRow | undefined>(
                        `
                        SELECT active_pane_id, root_node_json
                        FROM workspace_layouts
                        WHERE id = ?
                        `,
                    )
                    .get(workspaceId);

                if (!layoutRow) {
                    return createDefaultWorkspaceSnapshot();
                }

                const tabRows = this.#connection
                    .prepare<[string], WorkspaceTabRow>(
                        `
                        SELECT id, kind, title, payload_json, created_at, worktree_id
                        FROM workspace_tabs
                        WHERE workspace_id = ?
                        ORDER BY position ASC
                        `,
                    )
                    .all(workspaceId);

                return {
                    activePaneId: layoutRow.active_pane_id,
                    rootNode: parseJsonWithFallback<WorkspaceNode>(
                        layoutRow.root_node_json,
                        createDefaultWorkspaceSnapshot().rootNode,
                    ),
                    tabs: tabRows
                        .map((row) => deserializeTabRow(row))
                        .filter((tab): tab is WorkspaceTab => tab !== null),
                };
            },
        );
    }

    saveSnapshot(workspaceId: string, snapshot: WorkspaceSnapshot): void {
        mainProcessPerformance.measureSync("db.workspace.saveSnapshot", () => {
            const now = new Date().toISOString();
            const upsertLayout = this.#connection.prepare<
                [string, string, string, string, string],
                void
            >(
                `
                INSERT INTO workspace_layouts (
                    id,
                    root_node_json,
                    active_pane_id,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    root_node_json = excluded.root_node_json,
                    active_pane_id = excluded.active_pane_id,
                    updated_at = excluded.updated_at
                `,
            );
            const loadExistingTabs = this.#connection.prepare<
                [string],
                WorkspaceTabRow
            >(
                `
                SELECT
                    id,
                    kind,
                    title,
                    payload_json,
                    created_at,
                    worktree_id,
                    position
                FROM workspace_tabs
                WHERE workspace_id = ?
                `,
            );
            const deleteTab = this.#connection.prepare<[string, string], void>(
                "DELETE FROM workspace_tabs WHERE workspace_id = ? AND id = ?",
            );
            const upsertTab = this.#connection.prepare<
                [
                    string,
                    string,
                    string,
                    string,
                    string,
                    string,
                    string | null,
                    number,
                ],
                void
            >(
                `
                INSERT INTO workspace_tabs (
                    id,
                    workspace_id,
                    kind,
                    title,
                    payload_json,
                    created_at,
                    worktree_id,
                    position
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    kind = excluded.kind,
                    title = excluded.title,
                    payload_json = excluded.payload_json,
                    created_at = excluded.created_at,
                    worktree_id = excluded.worktree_id,
                    position = excluded.position
                `,
            );

            const transaction = this.#connection.transaction(
                (nextSnapshot: WorkspaceSnapshot) => {
                    upsertLayout.run(
                        workspaceId,
                        JSON.stringify(nextSnapshot.rootNode),
                        nextSnapshot.activePaneId,
                        now,
                        now,
                    );
                    const existingTabsById = new Map(
                        loadExistingTabs
                            .all(workspaceId)
                            .map((row) => [row.id, row] as const),
                    );
                    const nextTabIds = new Set<string>();

                    nextSnapshot.tabs.forEach((tab, index) => {
                        const serializedPayload = JSON.stringify(
                            serializeTab(tab),
                        );
                        const nextWorktreeId = tab.worktreeId ?? null;
                        const existingTab = existingTabsById.get(tab.id);
                        nextTabIds.add(tab.id);

                        if (
                            existingTab &&
                            existingTab.kind === tab.kind &&
                            existingTab.title === tab.title &&
                            existingTab.payload_json === serializedPayload &&
                            existingTab.created_at === tab.createdAt &&
                            existingTab.worktree_id === nextWorktreeId &&
                            existingTab.position === index
                        ) {
                            return;
                        }

                        upsertTab.run(
                            tab.id,
                            workspaceId,
                            tab.kind,
                            tab.title,
                            serializedPayload,
                            tab.createdAt,
                            nextWorktreeId,
                            index,
                        );
                    });

                    existingTabsById.forEach((_row, tabId) => {
                        if (!nextTabIds.has(tabId)) {
                            deleteTab.run(workspaceId, tabId);
                        }
                    });

                    syncChatPersistence(this.#connection, nextSnapshot.tabs);
                },
            );

            transaction(snapshot);
        });
    }

    loadChatSessionState(sessionId: string): PersistedChatSessionState | null {
        const row = this.#connection
            .prepare<
                [string],
                | {
                      draft: string;
                      message_count: number;
                      project_id: string | null;
                      title: string;
                      updated_at: string;
                      worktree_id: string | null;
                  }
                | undefined
            >(
                `
                SELECT
                    chat_sessions.project_id,
                    chat_sessions.worktree_id,
                    chat_sessions.title,
                    chat_sessions.draft,
                    chat_sessions.updated_at,
                    chat_transcripts.message_count
                FROM chat_sessions
                LEFT JOIN chat_transcripts
                    ON chat_transcripts.session_id = chat_sessions.id
                WHERE chat_sessions.id = ?
                `,
            )
            .get(sessionId);

        if (!row) {
            return null;
        }

        const events = this.#connection
            .prepare<[string], ChatSessionEventRow>(
                `
                SELECT
                    id,
                    session_id,
                    sequence,
                    event_type,
                    payload_json,
                    created_at
                FROM chat_session_events
                WHERE session_id = ?
                ORDER BY sequence ASC
                `,
            )
            .all(sessionId);
        const reviewArtifacts = this.#connection
            .prepare<[string], ReviewArtifactRow>(
                `
                SELECT
                    id,
                    session_id,
                    artifact_type,
                    title,
                    path,
                    payload_json,
                    created_at,
                    updated_at
                FROM review_artifacts
                WHERE session_id = ?
                ORDER BY updated_at DESC, created_at DESC
                `,
            )
            .all(sessionId);

        return {
            draft: row.draft,
            events: events.map((event) => ({
                createdAt: event.created_at,
                eventType: event.event_type,
                id: event.id,
                payloadJson: event.payload_json,
                sequence: event.sequence,
                sessionId: event.session_id,
            })),
            messageCount: row.message_count,
            projectId: row.project_id,
            reviewArtifacts: reviewArtifacts.map((artifact) => ({
                artifactType: artifact.artifact_type,
                createdAt: artifact.created_at,
                id: artifact.id,
                path: artifact.path,
                payloadJson: artifact.payload_json,
                sessionId: artifact.session_id,
                title: artifact.title,
                updatedAt: artifact.updated_at,
            })),
            sessionId,
            title: row.title,
            updatedAt: row.updated_at,
            worktreeId: row.worktree_id ?? null,
        };
    }
}

function deserializeTabRow(row: WorkspaceTabRow): WorkspaceTab | null {
    const payload = parseJsonWithFallback<
        | WorkspaceFilePayload
        | WorkspaceChatPayload
        | WorkspaceChatHistoryPayload
        | WorkspaceGitCommitPayload
        | WorkspaceGitWorktreeDiffPayload
        | WorkspaceGitHubIssuePayload
        | WorkspaceGitHubIssuesPayload
        | WorkspaceGitHubPullRequestPayload
        | WorkspaceGitHubPullRequestsPayload
        | WorkspaceGitPayload
        | WorkspaceReviewPayload
        | WorkspaceTerminalPayload
        | null
    >(row.payload_json, null);

    if (!payload) {
        return null;
    }

    if (row.kind === "chat") {
        const chatPayload = payload as Partial<WorkspaceChatPayload>;

        return {
            createdAt: row.created_at,
            draft:
                typeof chatPayload.draft === "string" ? chatPayload.draft : "",
            id: row.id,
            kind: "chat",
            projectId:
                typeof chatPayload.projectId === "string" ||
                chatPayload.projectId === null
                    ? chatPayload.projectId
                    : null,
            runtimeId: parseAiRuntimeId(chatPayload.runtimeId),
            sessionId:
                typeof chatPayload.sessionId === "string"
                    ? chatPayload.sessionId
                    : row.id,
            title: row.title,
            worktreeId:
                typeof chatPayload.worktreeId === "string" ||
                chatPayload.worktreeId === null
                    ? chatPayload.worktreeId
                    : row.worktree_id,
        };
    }

    if (row.kind === "chat_history") {
        const historyPayload = payload as Partial<WorkspaceChatHistoryPayload>;

        return {
            createdAt: row.created_at,
            id: row.id,
            kind: "chat_history",
            projectId:
                typeof historyPayload.projectId === "string" ||
                historyPayload.projectId === null
                    ? historyPayload.projectId
                    : null,
            title: row.title,
            worktreeId:
                typeof historyPayload.worktreeId === "string" ||
                historyPayload.worktreeId === null
                    ? historyPayload.worktreeId
                    : row.worktree_id,
        };
    }

    if (row.kind === "review") {
        const reviewPayload = payload as Partial<WorkspaceReviewPayload>;

        return {
            createdAt: row.created_at,
            id: row.id,
            kind: "review",
            projectId:
                typeof reviewPayload.projectId === "string" ||
                reviewPayload.projectId === null
                    ? reviewPayload.projectId
                    : null,
            runtimeId: parseAiRuntimeId(reviewPayload.runtimeId),
            sessionId:
                typeof reviewPayload.sessionId === "string"
                    ? reviewPayload.sessionId
                    : row.id,
            title: row.title,
            worktreeId:
                typeof reviewPayload.worktreeId === "string" ||
                reviewPayload.worktreeId === null
                    ? reviewPayload.worktreeId
                    : row.worktree_id,
        };
    }

    if (row.kind === "git") {
        const gitPayload = payload as Partial<WorkspaceGitPayload>;

        return {
            createdAt: row.created_at,
            id: row.id,
            kind: "git",
            projectId:
                typeof gitPayload.projectId === "string" ||
                gitPayload.projectId === null
                    ? gitPayload.projectId
                    : null,
            title: row.title,
            worktreeId:
                typeof gitPayload.worktreeId === "string" ||
                gitPayload.worktreeId === null
                    ? gitPayload.worktreeId
                    : row.worktree_id,
        };
    }

    if (row.kind === "git_worktree_diff") {
        const gitWorktreeDiffPayload =
            payload as Partial<WorkspaceGitWorktreeDiffPayload>;
        const projectId =
            typeof gitWorktreeDiffPayload.projectId === "string"
                ? gitWorktreeDiffPayload.projectId
                : null;

        if (!projectId) {
            return null;
        }

        return {
            createdAt: row.created_at,
            id: row.id,
            kind: "git_worktree_diff",
            projectId,
            title: GIT_WORKTREE_DIFF_TAB_TITLE,
            worktreeId:
                typeof gitWorktreeDiffPayload.worktreeId === "string" ||
                gitWorktreeDiffPayload.worktreeId === null
                    ? gitWorktreeDiffPayload.worktreeId
                    : row.worktree_id,
        };
    }

    if (row.kind === "git_commit") {
        const gitCommitPayload = payload as Partial<WorkspaceGitCommitPayload>;

        return {
            commitSha:
                typeof gitCommitPayload.commitSha === "string"
                    ? gitCommitPayload.commitSha
                    : "",
            createdAt: row.created_at,
            id: row.id,
            kind: "git_commit",
            projectId:
                typeof gitCommitPayload.projectId === "string" ||
                gitCommitPayload.projectId === null
                    ? gitCommitPayload.projectId
                    : null,
            title: row.title,
            worktreeId:
                typeof gitCommitPayload.worktreeId === "string" ||
                gitCommitPayload.worktreeId === null
                    ? gitCommitPayload.worktreeId
                    : row.worktree_id,
        };
    }

    if (row.kind === "github_commit_tree") {
        return null;
    }

    if (row.kind === "github_issues") {
        const githubPayload = payload as Partial<WorkspaceGitHubIssuesPayload>;
        const ref = parseGitHubRepositoryRef(githubPayload.ref);
        if (!ref) {
            return null;
        }

        return {
            createdAt: row.created_at,
            id: row.id,
            kind: "github_issues",
            projectId: parseNullableString(githubPayload.projectId),
            ref,
            title: row.title,
            worktreeId: parseNullableString(
                githubPayload.worktreeId,
                row.worktree_id,
            ),
        };
    }

    if (row.kind === "github_issue") {
        const githubPayload = payload as Partial<WorkspaceGitHubIssuePayload>;
        const ref = parseGitHubRepositoryRef(githubPayload.ref);
        if (!ref || typeof githubPayload.issueNumber !== "number") {
            return null;
        }

        return {
            createdAt: row.created_at,
            id: row.id,
            issueNumber: githubPayload.issueNumber,
            kind: "github_issue",
            projectId: parseNullableString(githubPayload.projectId),
            ref,
            title: row.title,
            worktreeId: parseNullableString(
                githubPayload.worktreeId,
                row.worktree_id,
            ),
        };
    }

    if (row.kind === "github_pull_requests") {
        const githubPayload =
            payload as Partial<WorkspaceGitHubPullRequestsPayload>;
        const ref = parseGitHubRepositoryRef(githubPayload.ref);
        if (!ref) {
            return null;
        }

        return {
            createdAt: row.created_at,
            id: row.id,
            kind: "github_pull_requests",
            projectId: parseNullableString(githubPayload.projectId),
            ref,
            title: row.title,
            worktreeId: parseNullableString(
                githubPayload.worktreeId,
                row.worktree_id,
            ),
        };
    }

    if (row.kind === "github_pull_request") {
        const githubPayload =
            payload as Partial<WorkspaceGitHubPullRequestPayload>;
        const ref = parseGitHubRepositoryRef(githubPayload.ref);
        if (!ref || typeof githubPayload.pullRequestNumber !== "number") {
            return null;
        }

        return {
            createdAt: row.created_at,
            id: row.id,
            kind: "github_pull_request",
            projectId: parseNullableString(githubPayload.projectId),
            pullRequestNumber: githubPayload.pullRequestNumber,
            ref,
            title: row.title,
            worktreeId: parseNullableString(
                githubPayload.worktreeId,
                row.worktree_id,
            ),
        };
    }

    if (row.kind === "terminal") {
        const terminalPayload = payload as Partial<WorkspaceTerminalPayload>;
        const sessionId =
            typeof terminalPayload.sessionId === "string"
                ? terminalPayload.sessionId
                : row.id;
        const terminalId =
            typeof terminalPayload.terminalId === "string"
                ? terminalPayload.terminalId
                : sessionId;

        return {
            createdAt: row.created_at,
            id: row.id,
            kind: "terminal",
            projectId: parseNullableString(terminalPayload.projectId),
            sessionId,
            terminalId,
            title: row.title,
            worktreeId: parseNullableString(
                terminalPayload.worktreeId,
                row.worktree_id,
            ),
        };
    }

    return {
        ...payload,
        createdAt: row.created_at,
        id: row.id,
        title: row.title,
        worktreeId:
            typeof payload.worktreeId === "string" ||
            payload.worktreeId === null
                ? payload.worktreeId
                : row.worktree_id,
    };
}

function serializeTab(
    tab: WorkspaceTab,
):
    | WorkspaceFilePayload
    | WorkspaceChatPayload
    | WorkspaceChatHistoryPayload
    | WorkspaceGitCommitPayload
    | WorkspaceGitWorktreeDiffPayload
    | WorkspaceGitHubIssuePayload
    | WorkspaceGitHubIssuesPayload
    | WorkspaceGitHubPullRequestPayload
    | WorkspaceGitHubPullRequestsPayload
    | WorkspaceGitPayload
    | WorkspaceReviewPayload
    | WorkspaceTerminalPayload {
    if (tab.kind === "file") {
        return {
            kind: tab.kind,
            projectId: tab.projectId,
            relativePath: tab.relativePath,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    if (tab.kind === "chat") {
        return {
            draft: tab.draft,
            kind: tab.kind,
            projectId: tab.projectId,
            runtimeId: tab.runtimeId,
            sessionId: tab.sessionId,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    if (tab.kind === "chat_history") {
        return {
            kind: tab.kind,
            projectId: tab.projectId,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    if (tab.kind === "review") {
        return {
            kind: tab.kind,
            projectId: tab.projectId,
            runtimeId: tab.runtimeId,
            sessionId: tab.sessionId,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    if (tab.kind === "git") {
        return {
            kind: tab.kind,
            projectId: tab.projectId,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    if (tab.kind === "git_commit") {
        return {
            commitSha: tab.commitSha,
            kind: tab.kind,
            projectId: tab.projectId,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    if (tab.kind === "git_worktree_diff") {
        return {
            kind: tab.kind,
            projectId: tab.projectId,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    if (tab.kind === "github_issues") {
        return {
            kind: tab.kind,
            projectId: tab.projectId,
            ref: tab.ref,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    if (tab.kind === "github_issue") {
        return {
            issueNumber: tab.issueNumber,
            kind: tab.kind,
            projectId: tab.projectId,
            ref: tab.ref,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    if (tab.kind === "github_pull_requests") {
        return {
            kind: tab.kind,
            projectId: tab.projectId,
            ref: tab.ref,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    if (tab.kind === "github_pull_request") {
        return {
            kind: tab.kind,
            projectId: tab.projectId,
            pullRequestNumber: tab.pullRequestNumber,
            ref: tab.ref,
            worktreeId: tab.worktreeId ?? null,
        };
    }

    return {
        kind: tab.kind,
        projectId: tab.projectId,
        sessionId: tab.sessionId,
        terminalId: tab.terminalId,
        worktreeId: tab.worktreeId ?? null,
    };
}

function parseNullableString(
    value: unknown,
    fallback: string | null = null,
): string | null {
    if (typeof value === "string" || value === null) {
        return value;
    }

    return fallback;
}

function parseAiRuntimeId(value: unknown): AiRuntimeId {
    return isKnownAiRuntimeId(value) ? value : "codex";
}

function parseGitHubRepositoryRef(
    value: unknown,
): GitHubRepositoryRef | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }

    const candidate = value as {
        readonly host?: unknown;
        readonly owner?: unknown;
        readonly repo?: unknown;
    };
    if (
        typeof candidate.host !== "string" ||
        typeof candidate.owner !== "string" ||
        typeof candidate.repo !== "string"
    ) {
        return null;
    }

    return {
        host: candidate.host,
        owner: candidate.owner,
        repo: candidate.repo,
    };
}

function createDefaultWorkspaceSnapshot(): WorkspaceSnapshot {
    return {
        activePaneId: "pane-root",
        rootNode: {
            activeTabId: null,
            id: "pane-root",
            tabIds: [],
            type: "pane",
        },
        tabs: [],
    };
}

function syncChatPersistence(
    connection: Database.Database,
    tabs: readonly WorkspaceTab[],
): void {
    const chatTabs = tabs.filter(
        (tab): tab is WorkspaceChatTab => tab.kind === "chat",
    );
    const findSession = connection.prepare<
        [string],
        { id: string } | undefined
    >("SELECT id FROM chat_sessions WHERE id = ?");
    const upsertChatSession = connection.prepare<
        [
            string,
            string | null,
            string | null,
            string,
            string,
            string,
            string,
            string,
            string,
        ],
        void
    >(
        `
        INSERT INTO chat_sessions (
            id,
            project_id,
            worktree_id,
            title,
            runtime,
            status,
            draft,
            created_at,
            updated_at,
            last_opened_at
        )
        VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            worktree_id = excluded.worktree_id,
            title = excluded.title,
            runtime = excluded.runtime,
            draft = excluded.draft,
            updated_at = excluded.updated_at,
            last_opened_at = excluded.last_opened_at
        `,
    );
    const upsertTranscript = connection.prepare<
        [string, string, string, number, string, string],
        void
    >(
        `
        INSERT INTO chat_transcripts (
            id,
            session_id,
            transcript_json,
            message_count,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            transcript_json = excluded.transcript_json,
            message_count = excluded.message_count,
            updated_at = excluded.updated_at
        `,
    );
    const nextSessionSequence = connection.prepare<
        [string],
        { next_sequence: number }
    >(
        `
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
        FROM chat_session_events
        WHERE session_id = ?
        `,
    );
    const insertSessionEvent = connection.prepare<
        [string, string, number, string, string, string],
        void
    >(
        `
        INSERT INTO chat_session_events (
            id,
            session_id,
            sequence,
            event_type,
            payload_json,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        `,
    );
    const upsertReviewArtifact = connection.prepare<
        [string, string, string, string, string | null, string, string, string],
        void
    >(
        `
        INSERT INTO review_artifacts (
            id,
            session_id,
            artifact_type,
            title,
            path,
            payload_json,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            artifact_type = excluded.artifact_type,
            title = excluded.title,
            path = excluded.path,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        `,
    );

    for (const tab of chatTabs) {
        const now = new Date().toISOString();
        const wasPersisted = Boolean(findSession.get(tab.sessionId));

        upsertChatSession.run(
            tab.sessionId,
            tab.projectId,
            tab.worktreeId ?? null,
            tab.title,
            tab.runtimeId,
            tab.draft,
            tab.createdAt,
            now,
            now,
        );

        if (!wasPersisted) {
            upsertTranscript.run(
                `transcript:${tab.sessionId}`,
                tab.sessionId,
                "{}",
                0,
                tab.createdAt,
                now,
            );
            const sequence =
                nextSessionSequence.get(tab.sessionId)?.next_sequence ?? 1;
            insertSessionEvent.run(
                randomUUID(),
                tab.sessionId,
                sequence,
                "session.created",
                JSON.stringify({
                    projectId: tab.projectId,
                    runtimeId: tab.runtimeId,
                    source: "workspace-sync",
                    tabId: tab.id,
                    title: tab.title,
                    worktreeId: tab.worktreeId ?? null,
                }),
                now,
            );
        }

        upsertReviewArtifact.run(
            `artifact:${tab.sessionId}:transcript-skeleton`,
            tab.sessionId,
            "transcript-skeleton",
            "Transcript skeleton",
            null,
            JSON.stringify({
                messageCount: 0,
                runtimeId: tab.runtimeId,
                sessionId: tab.sessionId,
                tabId: tab.id,
                version: 1,
            }),
            tab.createdAt,
            now,
        );
    }
}

function parseJsonWithFallback<T>(
    value: string | null | undefined,
    fallback: T,
): T {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value) as T;
    } catch (error) {
        debugBenignError("workspace.parseJson", error);
        return fallback;
    }
}
