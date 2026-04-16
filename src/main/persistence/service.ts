import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type {
    PersistenceSnapshot,
    PersistedShellState,
    PersistedWindowState,
    WindowContextSnapshot,
} from "@shared/ipc";

import { appIdentity } from "../app-runtime";
import type { Awaitable } from "../db/awaitable";

const DEFAULT_MAIN_WINDOW_HEIGHT = 960;
const DEFAULT_MAIN_WINDOW_WIDTH = 1480;

interface LegacySettingRow {
    readonly value: string;
}

interface MainWindowSnapshotRow {
    readonly active_project_id: string | null;
    readonly active_worktree_id: string | null;
    readonly height: number;
    readonly is_full_screen: number;
    readonly is_maximized: number;
    readonly shell_state_json: string | null;
    readonly window_id: string;
    readonly window_kind: string;
    readonly workspace_id: string;
    readonly workspace_session_id: string;
    readonly width: number;
    readonly x: number | null;
    readonly y: number | null;
}

interface WindowRow {
    readonly height: number;
    readonly id: string;
    readonly is_full_screen: number;
    readonly is_maximized: number;
    readonly width: number;
    readonly x: number | null;
    readonly y: number | null;
}

export interface CreateMainWindowSessionInput {
    readonly projectId?: string | null;
    readonly worktreeId?: string | null;
    readonly shellState?: PersistedShellState | null;
}

export interface PersistenceGateway {
    createMainWindowSession(
        input?: CreateMainWindowSessionInput,
    ): Awaitable<PersistenceSnapshot>;
    listRestorableMainWindowSnapshots(): readonly PersistenceSnapshot[];
    loadSnapshot(windowId: string): PersistenceSnapshot;
    loadWindowState(windowId: string): PersistedWindowState | null;
    saveActiveProjectId(
        windowId: string,
        projectId: string | null,
        worktreeId?: string | null,
    ): void;
    saveShellState(
        windowId: string,
        shellState: PersistedShellState | null,
    ): void;
    saveWindowState(state: PersistedWindowState): void;
    markWindowClosed(windowId: string): void;
    markWindowOpen(windowId: string): void;
}

export class PersistenceService {
    readonly #connection: Database.Database;

    constructor(connection: Database.Database) {
        this.#connection = connection;
    }

    createMainWindowSession(
        input: CreateMainWindowSessionInput = {},
    ): PersistenceSnapshot {
        const now = new Date().toISOString();
        const windowId = randomUUID();
        const workspaceId = randomUUID();
        const workspaceSessionId = randomUUID();
        const shellState =
            input.shellState === undefined
                ? this.#loadLegacyShellState()
                : input.shellState;

        this.#upsertWindow({
            height: DEFAULT_MAIN_WINDOW_HEIGHT,
            id: windowId,
            isFullScreen: false,
            isMaximized: false,
            kind: "main",
            title: appIdentity.windowTitle,
            width: DEFAULT_MAIN_WINDOW_WIDTH,
            x: null,
            y: null,
        });
        this.#connection
            .prepare<
                [
                    string,
                    string,
                    string,
                    string | null,
                    string | null,
                    string | null,
                    string,
                    string,
                    string,
                    number,
                ],
                void
            >(
                `
                INSERT INTO workspace_sessions (
                    id,
                    window_id,
                    workspace_id,
                    active_project_id,
                    active_worktree_id,
                    shell_state_json,
                    created_at,
                    updated_at,
                    last_opened_at,
                    is_open
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    window_id = excluded.window_id,
                    workspace_id = excluded.workspace_id,
                    active_project_id = excluded.active_project_id,
                    active_worktree_id = excluded.active_worktree_id,
                    shell_state_json = excluded.shell_state_json,
                    updated_at = excluded.updated_at,
                    last_opened_at = excluded.last_opened_at,
                    is_open = excluded.is_open
                `,
            )
            .run(
                workspaceSessionId,
                windowId,
                workspaceId,
                input.projectId ?? null,
                input.worktreeId ?? null,
                shellState ? JSON.stringify(shellState) : null,
                now,
                now,
                now,
                1,
            );

        return this.loadSnapshot(windowId);
    }

    listRestorableMainWindowSnapshots(): readonly PersistenceSnapshot[] {
        const rows = this.#connection
            .prepare<[], MainWindowSnapshotRow>(
                `
                SELECT
                    app_windows.id AS window_id,
                    app_windows.kind AS window_kind,
                    app_windows.x,
                    app_windows.y,
                    app_windows.width,
                    app_windows.height,
                    app_windows.is_maximized,
                    app_windows.is_full_screen,
                    workspace_sessions.id AS workspace_session_id,
                    workspace_sessions.workspace_id,
                    workspace_sessions.active_project_id,
                    workspace_sessions.active_worktree_id,
                    workspace_sessions.shell_state_json
                FROM workspace_sessions
                INNER JOIN app_windows
                    ON app_windows.id = workspace_sessions.window_id
                WHERE app_windows.kind = 'main'
                    AND workspace_sessions.is_open = 1
                ORDER BY workspace_sessions.last_opened_at ASC
                `,
            )
            .all();

        return rows.map((row) => this.#toPersistenceSnapshot(row));
    }

    loadSnapshot(windowId: string): PersistenceSnapshot {
        const row = this.#connection
            .prepare<[string], MainWindowSnapshotRow | undefined>(
                `
                SELECT
                    app_windows.id AS window_id,
                    app_windows.kind AS window_kind,
                    app_windows.x,
                    app_windows.y,
                    app_windows.width,
                    app_windows.height,
                    app_windows.is_maximized,
                    app_windows.is_full_screen,
                    workspace_sessions.id AS workspace_session_id,
                    workspace_sessions.workspace_id,
                    workspace_sessions.active_project_id,
                    workspace_sessions.active_worktree_id,
                    workspace_sessions.shell_state_json
                FROM app_windows
                LEFT JOIN workspace_sessions
                    ON workspace_sessions.window_id = app_windows.id
                WHERE app_windows.id = ?
                LIMIT 1
                `,
            )
            .get(windowId);

        if (!row) {
            return {
                activeProjectId: null,
                activeWorktreeId: null,
                shellState: null,
                windowContext: null,
                windowState: null,
            };
        }

        return this.#toPersistenceSnapshot(row);
    }

    loadWindowState(windowId: string): PersistedWindowState | null {
        const row = this.#connection
            .prepare<[string], WindowRow | undefined>(
                `
                SELECT
                    id,
                    x,
                    y,
                    width,
                    height,
                    is_maximized,
                    is_full_screen
                FROM app_windows
                WHERE id = ?
                `,
            )
            .get(windowId);

        if (!row) {
            return null;
        }

        return {
            height: row.height,
            id: row.id,
            isFullScreen: row.is_full_screen === 1,
            isMaximized: row.is_maximized === 1,
            width: row.width,
            x: row.x,
            y: row.y,
        };
    }

    saveActiveProjectId(
        windowId: string,
        projectId: string | null,
        worktreeId: string | null = null,
    ): void {
        const now = new Date().toISOString();

        this.#connection
            .prepare<
                [string | null, string | null, string, string, string],
                void
            >(
                `
                UPDATE workspace_sessions
                SET
                    active_project_id = ?,
                    active_worktree_id = ?,
                    updated_at = ?,
                    last_opened_at = ?,
                    is_open = 1
                WHERE window_id = ?
                `,
            )
            .run(projectId, worktreeId, now, now, windowId);
    }

    saveShellState(
        windowId: string,
        shellState: PersistedShellState | null,
    ): void {
        const now = new Date().toISOString();

        this.#connection
            .prepare<[string | null, string, string, string], void>(
                `
                UPDATE workspace_sessions
                SET
                    shell_state_json = ?,
                    updated_at = ?,
                    last_opened_at = ?,
                    is_open = 1
                WHERE window_id = ?
                `,
            )
            .run(
                shellState ? JSON.stringify(shellState) : null,
                now,
                now,
                windowId,
            );
    }

    saveWindowState(state: PersistedWindowState): void {
        this.#upsertWindow({
            ...state,
            kind: "main",
            title: appIdentity.windowTitle,
        });

        const now = new Date().toISOString();
        this.#connection
            .prepare<[string, string, number, string], void>(
                `
                UPDATE workspace_sessions
                SET
                    updated_at = ?,
                    last_opened_at = ?,
                    is_open = ?
                WHERE window_id = ?
                `,
            )
            .run(now, now, 1, state.id);
    }

    markWindowClosed(windowId: string): void {
        this.#connection
            .prepare<[string, string], void>(
                `
                UPDATE workspace_sessions
                SET
                    is_open = 0,
                    updated_at = ?
                WHERE window_id = ?
                `,
            )
            .run(new Date().toISOString(), windowId);
    }

    markWindowOpen(windowId: string): void {
        const now = new Date().toISOString();

        this.#connection
            .prepare<[string, string, string], void>(
                `
                UPDATE workspace_sessions
                SET
                    is_open = 1,
                    updated_at = ?,
                    last_opened_at = ?
                WHERE window_id = ?
                `,
            )
            .run(now, now, windowId);
    }

    #loadLegacyShellState(): PersistedShellState | null {
        const row = this.#connection
            .prepare<
                [string],
                LegacySettingRow | undefined
            >("SELECT value FROM app_settings WHERE key = ?")
            .get("shell.state");

        if (!row) {
            return null;
        }

        try {
            const parsed = JSON.parse(row.value) as PersistedShellState;
            return parsed;
        } catch {
            return null;
        }
    }

    #toPersistenceSnapshot(row: MainWindowSnapshotRow): PersistenceSnapshot {
        const shellState =
            row.shell_state_json !== null
                ? this.#parseShellState(row.shell_state_json)
                : this.#loadLegacyShellState();

        return {
            activeProjectId: row.active_project_id ?? null,
            activeWorktreeId: row.active_worktree_id ?? null,
            shellState,
            windowContext: row.workspace_session_id
                ? {
                      projectId: row.active_project_id ?? null,
                      worktreeId: row.active_worktree_id ?? null,
                      windowId: row.window_id,
                      windowKind: (row.window_kind === "settings"
                          ? "settings"
                          : "main") satisfies WindowContextSnapshot["windowKind"],
                      workspaceId: row.workspace_id,
                      workspaceSessionId: row.workspace_session_id,
                  }
                : null,
            windowState: {
                height: row.height,
                id: row.window_id,
                isFullScreen: row.is_full_screen === 1,
                isMaximized: row.is_maximized === 1,
                width: row.width,
                x: row.x,
                y: row.y,
            },
        };
    }

    #parseShellState(json: string): PersistedShellState | null {
        try {
            return JSON.parse(json) as PersistedShellState;
        } catch {
            return null;
        }
    }

    #upsertWindow(input: {
        readonly height: number;
        readonly id: string;
        readonly isFullScreen: boolean;
        readonly isMaximized: boolean;
        readonly kind: string;
        readonly title: string;
        readonly width: number;
        readonly x: number | null;
        readonly y: number | null;
    }): void {
        const now = new Date().toISOString();

        this.#connection
            .prepare<
                [
                    string,
                    string,
                    string,
                    number | null,
                    number | null,
                    number,
                    number,
                    number,
                    number,
                    string,
                    string,
                    string,
                ],
                void
            >(
                `
                INSERT INTO app_windows (
                    id,
                    kind,
                    title,
                    x,
                    y,
                    width,
                    height,
                    is_maximized,
                    is_full_screen,
                    created_at,
                    updated_at,
                    last_seen_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    kind = excluded.kind,
                    title = excluded.title,
                    x = excluded.x,
                    y = excluded.y,
                    width = excluded.width,
                    height = excluded.height,
                    is_maximized = excluded.is_maximized,
                    is_full_screen = excluded.is_full_screen,
                    updated_at = excluded.updated_at,
                    last_seen_at = excluded.last_seen_at
                `,
            )
            .run(
                input.id,
                input.kind,
                input.title,
                input.x,
                input.y,
                input.width,
                input.height,
                input.isMaximized ? 1 : 0,
                input.isFullScreen ? 1 : 0,
                now,
                now,
                now,
            );
    }
}
