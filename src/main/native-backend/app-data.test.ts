import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiSessionSnapshot } from "@shared/ipc";

import type { NativeBackendRequester } from "./persistence";

vi.mock("electron", () => ({
    safeStorage: {
        decryptString: (value: Buffer) => value.toString("utf8"),
    },
}));

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { force: true, recursive: true });
    }
});

describe("createNativeAppDataClient", () => {
    it("migrates legacy SQLite app data into native app-data and keyring", async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-app-data-"));
        tempDirs.push(tempDir);
        const databaseFile = path.join(tempDir, "comando.sqlite");
        createLegacyDatabase(databaseFile);
        const native = createFakeNativeRequester();
        const { createNativeAppDataClient } = await import("./app-data");

        const client = await createNativeAppDataClient({
            client: native.requester,
            databaseFile,
        });

        expect(client.settings.loadAppAppearanceSettings().themeMode).toBe("dark");
        expect(client.settings.loadAppEditorSettings().fontFamily).toBe(
            "jetbrains",
        );
        expect(client.settings.loadCodexRuntimeSettings().hasOpenAiApiKey).toBe(
            true,
        );
        expect(client.secretStore.loadSecret("ai.codex", "openai_api_key")).toBe(
            "legacy-openai",
        );
        expect(native.secrets.get("ai.codex.openai_api_key")).toBe(
            "legacy-openai",
        );
        expect(client.aiPersistence.loadRuntimeSelectionPreferences("codex")).toEqual(
            {
                configOptions: { approvalPolicy: "never" },
                modeId: "agent",
                modelId: "gpt-5",
            },
        );
        expect(client.aiPersistence.loadLatestRuntimeCatalog("codex")).toMatchObject(
            {
                configOptions: [
                    {
                        id: "model",
                        value: "gpt-5",
                    },
                ],
                modeId: "full-access",
                modelId: "gpt-5",
                models: [
                    {
                        id: "gpt-5",
                    },
                ],
                modes: [
                    {
                        id: "full-access",
                    },
                ],
            },
        );

        const windows = client.persistence.listRestorableMainWindowSnapshots();
        expect(windows).toHaveLength(1);
        expect(windows[0]?.activeProjectId).toBe("project-1");
        expect(windows[0]?.windowContext?.workspaceId).toBe("workspace-1");

        const workspace = await client.workspace.loadSnapshot("workspace-1");
        expect("version" in workspace).toBe(false);
        if ("version" in workspace) {
            throw new Error("Expected the migrated legacy workspace layout.");
        }
        expect(workspace.activePaneId).toBe("pane-1");
        expect(workspace.tabs).toHaveLength(1);
        expect(workspace.tabs[0]?.title).toBe("README.md");
        expect(workspace.tabs[0]?.worktreeId).toBe("worktree-1");

        const projectSettings =
            client.settings.loadProjectSettings("project-1");
        expect(projectSettings?.editor?.fontSize).toBe(15);
        expect(projectSettings?.appearance?.themeMode).toBe("light");

        client.settings.saveAppAppearanceSettings({
            ...client.settings.loadAppAppearanceSettings(),
            themeMode: "light",
        });
        await client.close();

        const snapshot = native.appData.get("settings.snapshot") as {
            readonly appearance?: { readonly themeMode?: string };
        };
        expect(snapshot.appearance?.themeMode).toBe("light");
        expect(native.appData.get("legacy.secretsMigrated.v1")).toBe(true);
    });

    it("fills partial native runtime catalogs from legacy ACP catalogs", async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-app-data-"));
        tempDirs.push(tempDir);
        const databaseFile = path.join(tempDir, "comando.sqlite");
        createLegacyDatabase(databaseFile);
        const native = createFakeNativeRequester();
        native.appData.set("ai.runtimeCatalogs", {
            codex: {
                availableCommands: [
                    {
                        description: "New command",
                        id: "new-command",
                        insertText: "/new-command ",
                        label: "/new-command",
                    },
                ],
                configOptions: [],
                modeId: null,
                modes: [],
                modelId: "gpt-5.4-mini",
                models: [],
            },
        });
        const { createNativeAppDataClient } = await import("./app-data");

        const client = await createNativeAppDataClient({
            client: native.requester,
            databaseFile,
        });
        const catalog = client.aiPersistence.loadLatestRuntimeCatalog("codex");

        expect(catalog).toMatchObject({
            availableCommands: [
                {
                    id: "new-command",
                },
            ],
            configOptions: [
                {
                    id: "model",
                    value: "gpt-5",
                },
            ],
            modelId: "gpt-5.4-mini",
            models: [
                {
                    id: "gpt-5",
                },
            ],
        });
        await client.close();
    });

    it("persists runtime catalogs for status rehydration", async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-app-data-"));
        tempDirs.push(tempDir);
        const databaseFile = path.join(tempDir, "comando.sqlite");
        new DatabaseSync(databaseFile).close();
        const native = createFakeNativeRequester();
        const { createNativeAppDataClient } = await import("./app-data");

        const firstClient = await createNativeAppDataClient({
            client: native.requester,
            databaseFile,
        });
        firstClient.aiPersistence.saveSessionSnapshot(
            createCatalogSnapshot({
                availableCommands: [
                    {
                        description: "Review changes",
                        id: "review",
                        insertText: "/review ",
                        label: "/review",
                    },
                ],
                configOptions: [
                    {
                        category: "model",
                        description: null,
                        id: "model",
                        label: "Model",
                        options: [
                            {
                                description: null,
                                groupLabel: null,
                                label: "GPT-5",
                                value: "gpt-5",
                            },
                        ],
                        type: "select",
                        value: "gpt-5",
                    },
                ],
                modelId: "gpt-5",
            }),
        );
        await firstClient.close();

        const secondClient = await createNativeAppDataClient({
            client: native.requester,
            databaseFile,
        });

        expect(
            secondClient.aiPersistence.loadLatestRuntimeCatalog("codex"),
        ).toMatchObject({
            availableCommands: [
                {
                    id: "review",
                    insertText: "/review ",
                    label: "/review",
                },
            ],
            configOptions: [
                {
                    id: "model",
                    value: "gpt-5",
                },
            ],
            modelId: "gpt-5",
        });
        await secondClient.close();
    });

    it("applies explicit runtime catalog patches without inferring from snapshots", async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-app-data-"));
        tempDirs.push(tempDir);
        const databaseFile = path.join(tempDir, "comando.sqlite");
        new DatabaseSync(databaseFile).close();
        const native = createFakeNativeRequester();
        const { createNativeAppDataClient } = await import("./app-data");

        const client = await createNativeAppDataClient({
            client: native.requester,
            databaseFile,
        });
        client.aiPersistence.saveSessionSnapshot(
            createCatalogSnapshot({
                availableCommands: [
                    {
                        description: "Review changes",
                        id: "review",
                        insertText: "/review ",
                        label: "/review",
                    },
                ],
                configOptions: [
                    {
                        category: "model",
                        description: null,
                        id: "model",
                        label: "Model",
                        options: [
                            {
                                description: null,
                                groupLabel: null,
                                label: "GPT-5",
                                value: "gpt-5",
                            },
                        ],
                        type: "select",
                        value: "gpt-5",
                    },
                ],
                modelId: "gpt-5",
                models: [
                    {
                        description: "Frontier model",
                        id: "gpt-5",
                        name: "GPT-5",
                    },
                ],
            }),
        );
        client.aiPersistence.saveRuntimeCatalogPatch?.("codex", {
            configOptions: [],
            modelId: null,
            models: [],
        });

        expect(client.aiPersistence.loadLatestRuntimeCatalog("codex")).toMatchObject(
            {
                availableCommands: [
                    {
                        id: "review",
                    },
                ],
                configOptions: [],
                modelId: null,
                models: [],
            },
        );
        await client.close();
    });
});

function createFakeNativeRequester(): {
    readonly appData: Map<string, unknown>;
    readonly requester: NativeBackendRequester;
    readonly secrets: Map<string, string | null>;
} {
    const appData = new Map<string, unknown>();
    const secrets = new Map<string, string | null>();
    const request: NativeBackendRequester["request"] = <T = unknown>(
        command: string,
        args: Record<string, unknown> = {},
    ): Promise<T> => {
        let output: unknown;
        switch (command) {
            case "app_data_get_json": {
                const key = String(args.key);
                output = {
                    value: appData.has(key) ? appData.get(key) : null,
                };
                break;
            }
            case "app_data_set_json": {
                appData.set(String(args.key), args.value);
                output = {};
                break;
            }
            case "app_secret_get": {
                output = {
                    value:
                        secrets.get(secretMapKey(args.namespace, args.secretId)) ??
                        null,
                };
                break;
            }
            case "app_secret_set": {
                secrets.set(
                    secretMapKey(args.namespace, args.secretId),
                    typeof args.value === "string" ? args.value : null,
                );
                output = {};
                break;
            }
            case "app_secret_delete": {
                secrets.delete(secretMapKey(args.namespace, args.secretId));
                output = {};
                break;
            }
            default:
                throw new Error(`Unexpected native command: ${command}`);
        }
        return Promise.resolve(output as T);
    };
    return {
        appData,
        requester: { request },
        secrets,
    };
}

function secretMapKey(namespace: unknown, secretId: unknown): string {
    return `${String(namespace)}.${String(secretId)}`;
}

function createCatalogSnapshot(
    overrides: Partial<AiSessionSnapshot>,
): AiSessionSnapshot {
    return {
        activeTurnStartedAt: null,
        availableCommands: [],
        closedAt: null,
        configOptions: [],
        lastError: null,
        messages: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: "project-1",
        runtimeId: "codex",
        runtimeSessionId: "runtime-session-1",
        sessionId: "session-1",
        status: "idle",
        title: "Session 1",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-06-20T12:00:00.000Z",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

function createLegacyDatabase(databaseFile: string): void {
    const database = new DatabaseSync(databaseFile);
    try {
        database.exec(`
            CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE app_windows (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                x INTEGER,
                y INTEGER,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                is_maximized INTEGER NOT NULL,
                is_full_screen INTEGER NOT NULL
            );

            CREATE TABLE workspace_sessions (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                window_id TEXT NOT NULL,
                active_project_id TEXT,
                active_worktree_id TEXT,
                shell_state_json TEXT,
                is_open INTEGER,
                last_opened_at TEXT
            );

            CREATE TABLE workspace_layouts (
                id TEXT PRIMARY KEY,
                active_pane_id TEXT NOT NULL,
                root_node_json TEXT NOT NULL
            );

            CREATE TABLE workspace_tabs (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                worktree_id TEXT,
                position INTEGER NOT NULL
            );

            CREATE TABLE project_settings (
                project_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (project_id, key)
            );
        `);

        const setting = database.prepare(
            "INSERT INTO app_settings (key, value) VALUES (?, ?)",
        );
        setting.run("appearance.theme_mode", "dark");
        setting.run("editor.font_family", "jetbrains-mono");
        setting.run("ai.codex.has_openai_api_key", "true");
        setting.run(
            "ai.runtime_preferences.codex",
            JSON.stringify({
                configOptions: { approvalPolicy: "never" },
                modeId: "agent",
                modelId: "gpt-5",
            }),
        );
        setting.run(
            "ai.runtime_catalog.codex",
            JSON.stringify({
                availableCommands: [
                    {
                        description: "Review changes",
                        id: "review",
                        insertText: "/review ",
                        label: "/review",
                    },
                ],
                configOptions: [
                    {
                        category: "model",
                        description: null,
                        id: "model",
                        label: "Model",
                        options: [
                            {
                                description: null,
                                groupLabel: null,
                                label: "GPT-5",
                                value: "gpt-5",
                            },
                        ],
                        type: "select",
                        value: "gpt-5",
                    },
                ],
                modeId: "full-access",
                modes: [
                    {
                        description: "No prompts",
                        id: "full-access",
                        name: "Full Access",
                    },
                ],
                modelId: "gpt-5",
                models: [
                    {
                        description: "Frontier model",
                        id: "gpt-5",
                        name: "GPT-5",
                    },
                ],
            }),
        );
        setting.run(
            "secret.ai.codex.openai_api_key",
            JSON.stringify({
                scheme: "plain-text-v1",
                value: " legacy-openai ",
            }),
        );

        database
            .prepare(
                `
                INSERT INTO app_windows (
                    id,
                    kind,
                    x,
                    y,
                    width,
                    height,
                    is_maximized,
                    is_full_screen
                )
                VALUES ('window-1', 'main', 12, 24, 1440, 900, 1, 0)
                `,
            )
            .run();
        database
            .prepare(
                `
                INSERT INTO workspace_sessions (
                    id,
                    workspace_id,
                    window_id,
                    active_project_id,
                    active_worktree_id,
                    shell_state_json,
                    is_open,
                    last_opened_at
                )
                VALUES (
                    'workspace-session-1',
                    'workspace-1',
                    'window-1',
                    'project-1',
                    'worktree-1',
                    NULL,
                    1,
                    '2026-06-20T12:00:00.000Z'
                )
                `,
            )
            .run();
        database
            .prepare(
                `
                INSERT INTO workspace_layouts (
                    id,
                    active_pane_id,
                    root_node_json
                )
                VALUES ('workspace-1', 'pane-1', ?)
                `,
            )
            .run(
                JSON.stringify({
                    activeTabId: "tab-1",
                    id: "pane-1",
                    tabIds: ["tab-1"],
                    type: "pane",
                }),
            );
        database
            .prepare(
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
                VALUES (
                    'tab-1',
                    'workspace-1',
                    'editor',
                    'README.md',
                    ?,
                    '2026-06-20T12:00:00.000Z',
                    'worktree-1',
                    0
                )
                `,
            )
            .run(JSON.stringify({ path: "README.md" }));

        const projectSetting = database.prepare(
            `
            INSERT INTO project_settings (project_id, key, value, updated_at)
            VALUES ('project-1', ?, ?, '2026-06-20T12:00:00.000Z')
            `,
        );
        projectSetting.run("editor.font_size", "15");
        projectSetting.run("appearance.theme_mode", "light");
    } finally {
        database.close();
    }
}
