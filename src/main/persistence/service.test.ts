import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { PersistenceService } from "./service";

describe("PersistenceService", () => {
    it("restaura shell, ventana y proyecto activo desde la ultima sesion", () => {
        const connection = createFakePersistenceConnection();
        const service = new PersistenceService(
            connection as unknown as Database.Database,
        );

        service.saveWindowState({
            height: 900,
            id: "main",
            isFullScreen: false,
            isMaximized: true,
            width: 1440,
            x: 24,
            y: 32,
        });
        service.saveShellState({
            activeSurface: "workspace",
            leftWidth: 260,
            rightWidth: 336,
        });
        service.saveActiveProjectId("project-1");

        expect(service.loadSnapshot()).toEqual({
            activeProjectId: "project-1",
            shellState: {
                activeSurface: "workspace",
                leftWidth: 260,
                rightWidth: 336,
            },
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
    const settings = new Map<string, string>();
    const windows = new Map<
        string,
        {
            height: number;
            id: string;
            is_full_screen: number;
            is_maximized: number;
            width: number;
            x: number | null;
            y: number | null;
        }
    >();
    const sessions = new Map<
        string,
        {
            active_project_id: string | null;
            window_id: string;
            workspace_id: string;
        }
    >();

    return {
        prepare(sql: string) {
            if (sql.includes("INSERT INTO app_settings")) {
                return {
                    run(key: string, value: string) {
                        settings.set(key, value);
                    },
                };
            }

            if (
                sql.includes("SELECT value FROM app_settings WHERE key = ?")
            ) {
                return {
                    get(key: string) {
                        const value = settings.get(key);
                        return value ? { value } : undefined;
                    },
                };
            }

            if (sql.includes("INSERT INTO app_windows")) {
                return {
                    run(
                        id: string,
                        _kind: string,
                        _title: string,
                        x: number | null,
                        y: number | null,
                        width: number,
                        height: number,
                        isMaximized: number,
                        isFullScreen: number,
                    ) {
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
                    get(id: string) {
                        return sessions.get(id);
                    },
                };
            }

            if (sql.includes("SELECT\n                    id,")) {
                return {
                    get(id: string) {
                        return windows.get(id);
                    },
                };
            }

            if (sql.includes("INSERT INTO workspace_sessions")) {
                return {
                    run(
                        id: string,
                        windowId: string,
                        workspaceId: string,
                        activeProjectIdOrCreatedAt: string | null,
                    ) {
                        const existing = sessions.get(id);
                        const activeProjectId =
                            activeProjectIdOrCreatedAt &&
                            activeProjectIdOrCreatedAt.includes("T")
                                ? existing?.active_project_id ?? null
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
