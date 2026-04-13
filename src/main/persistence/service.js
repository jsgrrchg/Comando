const PRIMARY_WINDOW_ID = "main";
const PRIMARY_WORKSPACE_ID = "primary";
const PRIMARY_WORKSPACE_SESSION_ID = "last-session";
export class PersistenceService {
    #connection;
    constructor(connection) {
        this.#connection = connection;
    }
    loadSnapshot() {
        return {
            activeProjectId: this.#loadActiveProjectId(),
            windowState: this.loadWindowState(PRIMARY_WINDOW_ID),
        };
    }
    loadWindowState(windowId = PRIMARY_WINDOW_ID) {
        const row = this.#connection
            .prepare(`
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
                `)
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
    saveActiveProjectId(projectId) {
        const now = new Date().toISOString();
        this.#connection
            .prepare(`
                INSERT INTO workspace_sessions (
                    id,
                    window_id,
                    workspace_id,
                    active_project_id,
                    created_at,
                    updated_at,
                    last_opened_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    active_project_id = excluded.active_project_id,
                    updated_at = excluded.updated_at,
                    last_opened_at = excluded.last_opened_at
                `)
            .run(PRIMARY_WORKSPACE_SESSION_ID, PRIMARY_WINDOW_ID, PRIMARY_WORKSPACE_ID, projectId, now, now, now);
    }
    saveWindowState(state) {
        const now = new Date().toISOString();
        this.#connection
            .prepare(`
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
                    x = excluded.x,
                    y = excluded.y,
                    width = excluded.width,
                    height = excluded.height,
                    is_maximized = excluded.is_maximized,
                    is_full_screen = excluded.is_full_screen,
                    updated_at = excluded.updated_at,
                    last_seen_at = excluded.last_seen_at
                `)
            .run(state.id, "main", "Comando", state.x, state.y, state.width, state.height, state.isMaximized ? 1 : 0, state.isFullScreen ? 1 : 0, now, now, now);
        this.#connection
            .prepare(`
                INSERT INTO workspace_sessions (
                    id,
                    window_id,
                    workspace_id,
                    active_project_id,
                    created_at,
                    updated_at,
                    last_opened_at
                )
                VALUES (?, ?, ?, NULL, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    window_id = excluded.window_id,
                    updated_at = excluded.updated_at,
                    last_opened_at = excluded.last_opened_at
                `)
            .run(PRIMARY_WORKSPACE_SESSION_ID, state.id, PRIMARY_WORKSPACE_ID, now, now, now);
    }
    #loadActiveProjectId() {
        const row = this.#connection
            .prepare(`
                SELECT active_project_id
                FROM workspace_sessions
                WHERE id = ?
                `)
            .get(PRIMARY_WORKSPACE_SESSION_ID);
        return row?.active_project_id ?? null;
    }
}
