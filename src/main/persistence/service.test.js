import { describe, expect, it } from "vitest";
import { PersistenceService } from "./service";
describe("PersistenceService", () => {
    it("restaura ventana y proyecto activo desde la ultima sesion", () => {
        const connection = createFakePersistenceConnection();
        const service = new PersistenceService(connection);
        service.saveWindowState({
            height: 900,
            id: "main",
            isFullScreen: false,
            isMaximized: true,
            width: 1440,
            x: 24,
            y: 32,
        });
        service.saveActiveProjectId("project-1");
        expect(service.loadSnapshot()).toEqual({
            activeProjectId: "project-1",
            windowState: {
                height: 900,
                id: "main",
                isFullScreen: false,
                isMaximized: true,
                width: 1440,
                x: 24,
                y: 32,
            },
        });
    });
});
function createFakePersistenceConnection() {
    const windows = new Map();
    const sessions = new Map();
    return {
        prepare(sql) {
            if (sql.includes("INSERT INTO app_windows")) {
                return {
                    run(id, _kind, _title, x, y, width, height, isMaximized, isFullScreen) {
                        windows.set(id, {
                            height,
                            id,
                            is_full_screen: isFullScreen,
                            is_maximized: isMaximized,
                            width,
                            x,
                            y,
                        });
                    },
                };
            }
            if (sql.includes("SELECT active_project_id")) {
                return {
                    get(id) {
                        return sessions.get(id);
                    },
                };
            }
            if (sql.includes("SELECT\n                    id,")) {
                return {
                    get(id) {
                        return windows.get(id);
                    },
                };
            }
            if (sql.includes("INSERT INTO workspace_sessions")) {
                return {
                    run(id, windowId, workspaceId, activeProjectIdOrCreatedAt) {
                        const existing = sessions.get(id);
                        const activeProjectId = activeProjectIdOrCreatedAt &&
                            activeProjectIdOrCreatedAt.includes("T")
                            ? (existing?.active_project_id ?? null)
                            : activeProjectIdOrCreatedAt;
                        sessions.set(id, {
                            active_project_id: activeProjectId ?? null,
                            window_id: windowId,
                            workspace_id: workspaceId,
                        });
                    },
                };
            }
            throw new Error(`Unsupported SQL in fake persistence test:\n${sql}`);
        },
    };
}
