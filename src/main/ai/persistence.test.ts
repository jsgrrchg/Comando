import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot } from "@shared/ipc";

import { databaseMigrations } from "@main/db/migrations";
import {
    applyMigrations,
    createSqliteCompatConnection,
} from "@main/testing/sqlite-compat";

import { AiPersistence } from "./persistence";

describe("AiPersistence", () => {
    it("overlays explicit runtime preferences onto the latest runtime catalog", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        seedChatSession(connection, {
            runtimeId: "codex",
            sessionId: "session-latest",
            transcript: createCatalogTranscript({
                access: "read-only",
                modelId: "gpt-5",
                reasoning: "high",
            }),
            updatedAt: "2026-04-15T10:00:00.000Z",
        });

        persistence.saveRuntimeModelPreference("codex", "gpt-5.4-mini");
        persistence.saveRuntimeSelectionPreferenceOption(
            "codex",
            "sandbox_mode",
            "full",
        );
        persistence.saveRuntimeSelectionPreferenceOption(
            "codex",
            "thought_level",
            "medium",
        );

        const catalog = persistence.loadLatestRuntimeCatalog("codex");

        expect(catalog?.modelId).toBe("gpt-5.4-mini");
        expect(
            catalog?.configOptions.some(
                (option) =>
                    option.id === "sandbox_mode" && option.value === "full",
            ),
        ).toBe(true);
        expect(
            catalog?.configOptions.some(
                (option) =>
                    option.id === "model" && option.value === "gpt-5.4-mini",
            ),
        ).toBe(true);
        expect(
            catalog?.configOptions.some(
                (option) =>
                    option.id === "thought_level" &&
                    option.category === "reasoning" &&
                    option.value === "medium",
            ),
        ).toBe(true);
    });

    it("loads saved runtime selection preferences independently from session history", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        persistence.saveRuntimeModePreference("codex", "plan");
        persistence.saveRuntimeModelPreference("codex", "gpt-5.4-mini");
        persistence.saveRuntimeSelectionPreferenceOption(
            "codex",
            "thought_level",
            "high",
        );

        expect(persistence.loadRuntimeSelectionPreferences("codex")).toEqual({
            configOptions: {
                thought_level: "high",
            },
            modeId: "plan",
            modelId: "gpt-5.4-mini",
        });
    });

    it("applies legacy Claude effort preferences to upstream effort catalogs", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const transcript = createCatalogTranscript({
            access: "read-only",
            modelId: "gpt-5",
            reasoning: "high",
        });

        seedChatSession(connection, {
            runtimeId: "claude",
            sessionId: "session-claude-effort",
            transcript: {
                ...transcript,
                configOptions: transcript.configOptions.map((option) =>
                    option.id === "thought_level"
                        ? {
                              ...option,
                              id: "effort",
                              label: "Effort",
                          }
                        : option,
                ),
            },
            updatedAt: "2026-04-15T10:00:00.000Z",
        });
        persistence.saveRuntimeSelectionPreferenceOption(
            "claude",
            "effort_level",
            "medium",
        );

        const catalog = persistence.loadLatestRuntimeCatalog("claude");

        expect(
            catalog?.configOptions.some(
                (option) =>
                    option.id === "effort" &&
                    option.category === "reasoning" &&
                    option.value === "medium",
            ),
        ).toBe(true);
    });

    it("persists a compact transcript snapshot and restores the runtime catalog separately", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const snapshot: AiSessionSnapshot = {
            availableCommands: [
                {
                    description: "Create plan",
                    id: "plan",
                    insertText: "/plan ",
                    label: "/plan",
                },
            ],
            configOptions: createCatalogTranscript({
                access: "read-only",
                modelId: "gpt-5",
                reasoning: "high",
            }).configOptions as AiSessionSnapshot["configOptions"],
            lastError: null,
            messages: [
                {
                    attachments: [],
                    content: "hello",
                    createdAt: "2026-04-15T10:00:00.000Z",
                    id: "msg-1",
                    kind: "user",
                    status: "completed",
                },
            ],
            modeId: null,
            modes: [],
            modelId: "gpt-5",
            models: createCatalogTranscript({
                access: "read-only",
                modelId: "gpt-5",
                reasoning: "high",
            }).models as AiSessionSnapshot["models"],
            pendingPermission: null,
            pendingUserInput: null,
            plan: null,
            projectId: null,
            runtimeId: "codex",
            runtimeSessionId: "runtime-session-1",
            sessionId: "session-compact",
            status: "idle",
            title: "Compact session",
            tokenUsage: null,
            toolActivity: [],
            trackedFiles: [],
            updatedAt: "2026-04-15T10:00:00.000Z",
            worktreeId: null,
        };

        persistence.saveSessionSnapshot(snapshot);

        const storedTranscript = connection
            .prepare<
                [string],
                { preview: string | null; transcript_json: string } | undefined
            >(
                `
                SELECT preview, transcript_json
                FROM chat_transcripts
                WHERE session_id = ?
                `,
            )
            .get(snapshot.sessionId);

        expect(storedTranscript).toBeDefined();
        expect(storedTranscript?.preview).toBe("hello");
        expect(storedTranscript?.transcript_json).toBeTruthy();
        expect(
            JSON.parse(storedTranscript?.transcript_json ?? "{}"),
        ).not.toHaveProperty("configOptions");
        expect(
            JSON.parse(storedTranscript?.transcript_json ?? "{}"),
        ).not.toHaveProperty("availableCommands");

        const catalog = persistence.loadLatestRuntimeCatalog("codex");

        expect(catalog?.modelId).toBe("gpt-5");
        expect(
            catalog?.configOptions.some(
                (option) =>
                    option.id === "sandbox_mode" &&
                    option.value === "read-only",
            ),
        ).toBe(true);
        expect(persistence.loadSessionSnapshot(snapshot.sessionId)).toEqual(
            expect.objectContaining({
                availableCommands: snapshot.availableCommands,
                configOptions: snapshot.configOptions,
                messages: snapshot.messages,
                sessionId: snapshot.sessionId,
                title: snapshot.title,
            }),
        );
    });

    it("persists AI session parent links as structured data", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const parentSnapshot = createSnapshot({
            messages: ["Parent prompt"],
            sessionId: "session-parent",
            title: "Parent",
            updatedAt: "2026-04-16T12:00:00.000Z",
        });
        const childSnapshot = createSnapshot({
            messages: ["Child response"],
            parentSessionId: "session-parent",
            sessionId: "session-child",
            title: "Galileo",
            toolActivity: [
                {
                    action: {
                        kind: "open_session",
                        sessionId: "session-child",
                    },
                    createdAt: "2026-04-16T12:01:00.000Z",
                    diffs: [],
                    exitCode: null,
                    id: "tool-open-child",
                    kind: "subagent",
                    locations: [],
                    rawInputJson: null,
                    rawOutputJson: null,
                    sessionId: "session-parent",
                    status: "completed",
                    summary: null,
                    terminalOutput: null,
                    title: "Open Galileo",
                    updatedAt: "2026-04-16T12:01:00.000Z",
                },
            ],
            updatedAt: "2026-04-16T12:01:00.000Z",
        });

        persistence.saveSessionSnapshot(parentSnapshot);
        persistence.saveSessionSnapshot(childSnapshot);

        const childRow = connection
            .prepare<
                [string],
                { parent_session_id: string | null } | undefined
            >(
                `
                SELECT parent_session_id
                FROM chat_sessions
                WHERE id = ?
                `,
            )
            .get(childSnapshot.sessionId);
        expect(childRow?.parent_session_id).toBe("session-parent");

        const storedTranscript = connection
            .prepare<
                [string],
                { transcript_json: string } | undefined
            >(
                `
                SELECT transcript_json
                FROM chat_transcripts
                WHERE session_id = ?
                `,
            )
            .get(childSnapshot.sessionId);
        const storedSnapshot = JSON.parse(
            storedTranscript?.transcript_json ?? "{}",
        );
        expect(storedSnapshot.parentSessionId).toBe("session-parent");
        expect(storedSnapshot.toolActivity?.[0]?.action).toEqual({
            kind: "open_session",
            sessionId: "session-child",
        });

        expect(persistence.loadSessionSnapshot(childSnapshot.sessionId)).toEqual(
            expect.objectContaining({
                parentSessionId: "session-parent",
                toolActivity: expect.arrayContaining([
                    expect.objectContaining({
                        action: {
                            kind: "open_session",
                            sessionId: "session-child",
                        },
                    }),
                ]),
            }),
        );

        persistence.deleteSession(parentSnapshot.sessionId);

        const remainingChildRow = connection
            .prepare<
                [string],
                { id: string; parent_session_id: string | null } | undefined
            >(
                `
                SELECT id, parent_session_id
                FROM chat_sessions
                WHERE id = ?
                `,
            )
            .get(childSnapshot.sessionId);
        expect(remainingChildRow).toEqual({
            id: "session-child",
            parent_session_id: null,
        });
        expect(persistence.loadSessionSnapshot(childSnapshot.sessionId)).toEqual(
            expect.objectContaining({
                parentSessionId: null,
            }),
        );

        persistence.saveSessionSnapshot(childSnapshot);
        expect(persistence.loadSessionSnapshot(childSnapshot.sessionId)).toEqual(
            expect.objectContaining({
                parentSessionId: null,
            }),
        );
    });

    it("persists generated image messages and derives a history preview", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const snapshot: AiSessionSnapshot = {
            availableCommands: [],
            configOptions: [],
            lastError: null,
            messages: [
                {
                    attachments: [],
                    content: "",
                    createdAt: "2026-04-15T10:00:00.000Z",
                    generatedImage: {
                        error: null,
                        mimeType: "image/png",
                        path: "/Users/example/.codex/generated_images/image.png",
                        result: "created image",
                        revisedPrompt: "A tiny brass robot",
                        status: "completed",
                        title: "Generated image",
                    },
                    id: "image:codex-acp:image:image-1",
                    kind: "image",
                    status: "completed",
                },
            ],
            modeId: null,
            modes: [],
            modelId: null,
            models: [],
            pendingPermission: null,
            pendingUserInput: null,
            plan: null,
            projectId: null,
            runtimeId: "codex",
            runtimeSessionId: null,
            sessionId: "session-image",
            status: "idle",
            title: "Image session",
            tokenUsage: null,
            toolActivity: [],
            trackedFiles: [],
            updatedAt: "2026-04-15T10:00:00.000Z",
            worktreeId: null,
        };

        persistence.saveSessionSnapshot(snapshot);

        expect(persistence.loadSessionSnapshot(snapshot.sessionId)?.messages).toEqual(
            snapshot.messages,
        );
        expect(loadStoredPreview(connection, snapshot.sessionId)).toBe(
            "Generated image",
        );
    });

    it("lists session history scoped by project and worktree with previews", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        seedChatSession(connection, {
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-empty",
            transcript: createTranscriptWithMessages([]),
            updatedAt: "2026-04-16T12:30:00.000Z",
            worktreeId: "worktree-a",
        });
        seedChatSession(connection, {
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-main",
            transcript: createTranscriptWithMessages([
                "User asks for a summary",
                "Assistant returns the final summary for the branch.",
            ]),
            updatedAt: "2026-04-16T12:00:00.000Z",
            worktreeId: "worktree-a",
        });
        seedChatSession(connection, {
            projectId: "project-1",
            runtimeId: "claude",
            sessionId: "session-other-worktree",
            transcript: createTranscriptWithMessages([
                "This should stay out of scope.",
            ]),
            updatedAt: "2026-04-16T11:00:00.000Z",
            worktreeId: "worktree-b",
        });
        seedChatSession(connection, {
            projectId: "project-2",
            runtimeId: "gemini",
            sessionId: "session-other-project",
            transcript: createTranscriptWithMessages([
                "This belongs to another project.",
            ]),
            updatedAt: "2026-04-16T10:00:00.000Z",
            worktreeId: "worktree-a",
        });

        const history = persistence.listSessionHistory({
            limit: 20,
            projectId: "project-1",
            worktreeId: "worktree-a",
        });

        expect(history).toEqual([
            expect.objectContaining({
                messageCount: 2,
                preview: "Assistant returns the final summary for the branch.",
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-main",
                worktreeId: "worktree-a",
            }),
        ]);
        expect(loadStoredPreview(connection, "session-main")).toBe(
            "Assistant returns the final summary for the branch.",
        );
    });

    it("uses persisted history previews without parsing transcripts", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        seedChatSession(connection, {
            preview: "Persisted summary wins",
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-main",
            transcript: createTranscriptWithMessages([
                "This transcript should not be parsed.",
            ]),
            updatedAt: "2026-04-16T12:00:00.000Z",
            worktreeId: "worktree-a",
        });
        connection
            .prepare(
                `
                UPDATE chat_transcripts
                SET transcript_json = 'not json'
                WHERE session_id = ?
                `,
            )
            .run("session-main");

        const history = persistence.listSessionHistory({
            limit: 20,
            projectId: "project-1",
            worktreeId: "worktree-a",
        });

        expect(history).toEqual([
            expect.objectContaining({
                messageCount: 1,
                preview: "Persisted summary wins",
                sessionId: "session-main",
            }),
        ]);
    });

    it("omits empty sessions from history listings", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        seedChatSession(connection, {
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-empty",
            transcript: createTranscriptWithMessages([]),
            updatedAt: "2026-04-16T12:00:00.000Z",
            worktreeId: "worktree-a",
        });

        const history = persistence.listSessionHistory({
            limit: 20,
            projectId: "project-1",
            worktreeId: "worktree-a",
        });

        expect(history).toEqual([]);
    });

    it("keeps empty subagent sessions visible in history", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        seedChatSession(connection, {
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-parent",
            transcript: createTranscriptWithMessages(["Parent message"]),
            updatedAt: "2026-04-16T11:59:00.000Z",
            worktreeId: "worktree-a",
        });
        seedChatSession(connection, {
            parentSessionId: "session-parent",
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-child",
            transcript: {
                ...createTranscriptWithMessages([]),
                parentSessionId: "session-parent",
                sessionId: "session-child",
                title: "Galileo",
            },
            updatedAt: "2026-04-16T12:00:00.000Z",
            worktreeId: "worktree-a",
        });

        const history = persistence.listSessionHistory({
            limit: 20,
            projectId: "project-1",
            worktreeId: "worktree-a",
        });

        expect(history).toEqual([
            expect.objectContaining({
                messageCount: 0,
                parentSessionId: "session-parent",
                preview: null,
                sessionId: "session-child",
            }),
            expect.objectContaining({
                messageCount: 1,
                parentSessionId: null,
                sessionId: "session-parent",
            }),
        ]);
    });

    it("lists unscoped history using null project and worktree filters", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        seedChatSession(connection, {
            projectId: null,
            runtimeId: "codex",
            sessionId: "session-global-new",
            transcript: createTranscriptWithMessages([
                "Newest global session",
            ]),
            updatedAt: "2026-04-16T13:00:00.000Z",
            worktreeId: null,
        });
        seedChatSession(connection, {
            projectId: null,
            runtimeId: "codex",
            sessionId: "session-global-old",
            transcript: createTranscriptWithMessages([
                "Older global session",
            ]),
            updatedAt: "2026-04-16T12:00:00.000Z",
            worktreeId: null,
        });
        seedChatSession(connection, {
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-scoped",
            transcript: createTranscriptWithMessages([
                "Scoped session should stay out",
            ]),
            updatedAt: "2026-04-16T14:00:00.000Z",
            worktreeId: "worktree-a",
        });

        const history = persistence.listSessionHistory({
            limit: 20,
            projectId: null,
            worktreeId: null,
        });

        expect(history.map((session) => session.sessionId)).toEqual([
            "session-global-new",
            "session-global-old",
        ]);
    });

    it("returns the full scoped history when the limit is null", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        for (let index = 0; index < 105; index += 1) {
            seedChatSession(connection, {
                projectId: "project-unbounded",
                runtimeId: "codex",
                sessionId: `session-${index}`,
                transcript: createTranscriptWithMessages([
                    `Message ${index}`,
                ]),
                updatedAt: `2026-04-16T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
                worktreeId: "worktree-unbounded",
            });
        }

        const history = persistence.listSessionHistory({
            limit: null,
            projectId: "project-unbounded",
            worktreeId: "worktree-unbounded",
        });

        expect(history).toHaveLength(105);
    });

    it("loads a transcript page from persisted snapshot messages", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        seedChatSession(connection, {
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-page",
            transcript: createTranscriptWithMessages([
                "Message 1",
                "Message 2",
                "Message 3",
                "Message 4",
            ]),
            updatedAt: "2026-04-16T12:00:00.000Z",
            worktreeId: "worktree-a",
        });

        const page = persistence.loadSessionTranscriptPage({
            limit: 2,
            offset: 1,
            sessionId: "session-page",
        });

        expect(page).toEqual({
            messages: [
                expect.objectContaining({
                    content: "Message 2",
                    kind: "assistant",
                }),
                expect.objectContaining({
                    content: "Message 3",
                    kind: "assistant",
                }),
            ],
            offset: 1,
            sessionId: "session-page",
            totalMessages: 4,
        });
    });

    it("deletes a persisted session and cascades transcript rows", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        seedChatSession(connection, {
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-delete",
            transcript: createTranscriptWithMessages(["Delete me"]),
            updatedAt: "2026-04-16T12:00:00.000Z",
            worktreeId: "worktree-a",
        });

        persistence.deleteSession("session-delete");

        const sessionRow = connection
            .prepare<[string], { id: string } | undefined>(
                `
                SELECT id
                FROM chat_sessions
                WHERE id = ?
                `,
            )
            .get("session-delete");
        const transcriptRow = connection
            .prepare<[string], { session_id: string } | undefined>(
                `
                SELECT session_id
                FROM chat_transcripts
                WHERE session_id = ?
                `,
            )
            .get("session-delete");

        expect(sessionRow).toBeUndefined();
        expect(transcriptRow).toBeUndefined();
    });

    it("persists pinned sessions without affecting the history scope", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        seedChatSession(connection, {
            pinnedAt: null,
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-pin",
            transcript: createTranscriptWithMessages(["Pin me"]),
            updatedAt: "2026-04-16T12:00:00.000Z",
            worktreeId: "worktree-a",
        });

        persistence.setSessionPinned("session-pin", true);

        let history = persistence.listSessionHistory({
            limit: 20,
            projectId: "project-1",
            worktreeId: "worktree-a",
        });

        expect(history).toEqual([
            expect.objectContaining({
                sessionId: "session-pin",
            }),
        ]);
        expect(typeof history[0]?.pinnedAt).toBe("string");

        persistence.setSessionPinned("session-pin", false);

        history = persistence.listSessionHistory({
            limit: 20,
            projectId: "project-1",
            worktreeId: "worktree-a",
        });

        expect(history).toEqual([
            expect.objectContaining({
                pinnedAt: null,
                sessionId: "session-pin",
            }),
        ]);
    });

    it("keeps a renamed session visible in scoped history listings", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        seedProject(
            connection,
            "project-rename",
            "2026-04-16T12:00:00.000Z",
        );
        seedProjectWorktree(
            connection,
            "project-rename",
            "worktree-rename",
            "2026-04-16T12:00:00.000Z",
        );
        const baseSnapshot: AiSessionSnapshot = {
            availableCommands: [],
            configOptions: [],
            lastError: null,
            messages: [
                {
                    attachments: [],
                    content: "Persisted message",
                    createdAt: "2026-04-16T12:00:00.000Z",
                    id: "msg-rename-1",
                    kind: "assistant",
                    status: "completed",
                },
            ],
            modeId: null,
            modes: [],
            modelId: null,
            models: [],
            pendingPermission: null,
            pendingUserInput: null,
            plan: null,
            projectId: "project-rename",
            runtimeId: "codex",
            runtimeSessionId: null,
            sessionId: "session-rename",
            status: "idle",
            title: "Original title",
            tokenUsage: null,
            toolActivity: [],
            trackedFiles: [],
            updatedAt: "2026-04-16T12:00:00.000Z",
            worktreeId: "worktree-rename",
        };

        persistence.saveSessionSnapshot(baseSnapshot);
        persistence.saveSessionSnapshot({
            ...baseSnapshot,
            title: "Renamed title",
            updatedAt: "2026-04-16T12:05:00.000Z",
        });

        const history = persistence.listSessionHistory({
            limit: 20,
            projectId: "project-rename",
            worktreeId: "worktree-rename",
        });

        expect(history).toEqual([
            expect.objectContaining({
                sessionId: "session-rename",
                title: "Renamed title",
            }),
        ]);
    });
});

function createTestConnection() {
    const connection = createSqliteCompatConnection();
    applyMigrations(connection, databaseMigrations);
    return connection;
}

function createCatalogTranscript(input: {
    readonly access: string;
    readonly modelId: string;
    readonly reasoning: string;
}) {
    return {
        availableCommands: [],
        configOptions: [
            {
                category: "other",
                description: null,
                id: "sandbox_mode",
                label: "Access",
                options: [
                    {
                        description: null,
                        groupLabel: null,
                        label: "Read Only",
                        value: "read-only",
                    },
                    {
                        description: null,
                        groupLabel: null,
                        label: "Full Access",
                        value: "full",
                    },
                ],
                type: "select",
                value: input.access,
            },
            {
                category: "model",
                description: null,
                id: "model",
                label: "Model",
                options: [
                    {
                        description: null,
                        groupLabel: null,
                        label: "GPT 5",
                        value: "gpt-5",
                    },
                    {
                        description: null,
                        groupLabel: null,
                        label: "GPT 5.4 Mini",
                        value: "gpt-5.4-mini",
                    },
                ],
                type: "select",
                value: input.modelId,
            },
            {
                category: "reasoning",
                description: null,
                id: "thought_level",
                label: "Reasoning",
                options: [
                    {
                        description: null,
                        groupLabel: null,
                        label: "Low",
                        value: "low",
                    },
                    {
                        description: null,
                        groupLabel: null,
                        label: "Medium",
                        value: "medium",
                    },
                    {
                        description: null,
                        groupLabel: null,
                        label: "High",
                        value: "high",
                    },
                ],
                type: "select",
                value: input.reasoning,
            },
        ],
        messages: [],
        modeId: null,
        modes: [],
        modelId: input.modelId,
        models: [
            {
                description: null,
                id: "gpt-5",
                name: "GPT 5",
            },
            {
                description: null,
                id: "gpt-5.4-mini",
                name: "GPT 5.4 Mini",
            },
        ],
        sessionId: "session-catalog",
        version: 1,
    };
}

function createTranscriptWithMessages(
    contents: readonly string[],
): Record<string, unknown> {
    return {
        lastError: null,
        messages: contents.map((content, index) => ({
            attachments: [],
            content,
            createdAt: `2026-04-16T12:00:0${index}.000Z`,
            id: `message-${index + 1}`,
            kind: "assistant",
            status: "completed",
        })),
        modeId: null,
        modelId: null,
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: null,
        runtimeId: "codex",
        runtimeSessionId: null,
        sessionId: "session",
        status: "idle",
        title: "Transcript",
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-16T12:00:00.000Z",
        worktreeId: null,
    };
}

function createSnapshot(input: {
    readonly messages?: readonly string[];
    readonly parentSessionId?: string | null;
    readonly sessionId: string;
    readonly title: string;
    readonly toolActivity?: AiSessionSnapshot["toolActivity"];
    readonly updatedAt: string;
}): AiSessionSnapshot {
    return {
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: (input.messages ?? []).map((content, index) => ({
            attachments: [],
            content,
            createdAt: `2026-04-16T12:00:0${index}.000Z`,
            id: `${input.sessionId}:message-${index + 1}`,
            kind: "assistant",
            status: "completed",
        })),
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        parentSessionId: input.parentSessionId ?? null,
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: null,
        runtimeId: "codex",
        runtimeSessionId: null,
        sessionId: input.sessionId,
        status: "idle",
        title: input.title,
        tokenUsage: null,
        toolActivity: input.toolActivity ?? [],
        trackedFiles: [],
        updatedAt: input.updatedAt,
        worktreeId: null,
    };
}

function seedChatSession(
    connection: ReturnType<typeof createTestConnection>,
    input: {
        readonly parentSessionId?: string | null;
        readonly pinnedAt?: string | null;
        readonly preview?: string | null;
        readonly projectId?: string | null;
        readonly runtimeId: "claude" | "codex" | "gemini" | "kilo";
        readonly sessionId: string;
        readonly transcript: Record<string, unknown>;
        readonly updatedAt: string;
        readonly worktreeId?: string | null;
    },
): void {
    if (input.projectId) {
        seedProject(connection, input.projectId, input.updatedAt);
    }

    if (input.projectId && input.worktreeId) {
        seedProjectWorktree(
            connection,
            input.projectId,
            input.worktreeId,
            input.updatedAt,
        );
    }

    connection
        .prepare(
            `
            INSERT INTO chat_sessions (
                id,
                project_id,
                worktree_id,
                parent_session_id,
                pinned_at,
                title,
                runtime,
                status,
                draft,
                created_at,
                updated_at,
                last_opened_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', '', ?, ?, ?)
            `,
        )
        .run(
            input.sessionId,
            input.projectId ?? null,
            input.worktreeId ?? null,
            input.parentSessionId ?? null,
            input.pinnedAt ?? null,
            input.sessionId,
            input.runtimeId,
            input.updatedAt,
            input.updatedAt,
            input.updatedAt,
        );

    connection
        .prepare(
            `
            INSERT INTO chat_transcripts (
                id,
                session_id,
                transcript_json,
                message_count,
                preview,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
        )
        .run(
            `transcript:${input.sessionId}`,
            input.sessionId,
            JSON.stringify(input.transcript),
            Array.isArray(input.transcript.messages)
                ? input.transcript.messages.length
                : 0,
            input.preview ?? null,
            input.updatedAt,
            input.updatedAt,
        );
}

function loadStoredPreview(
    connection: ReturnType<typeof createSqliteCompatConnection>,
    sessionId: string,
): string | null {
    return (
        connection
            .prepare<[string], { preview: string | null } | undefined>(
                `
                SELECT preview
                FROM chat_transcripts
                WHERE session_id = ?
                `,
            )
            .get(sessionId)?.preview ?? null
    );
}

function seedProject(
    connection: ReturnType<typeof createTestConnection>,
    projectId: string,
    timestamp: string,
): void {
    connection
        .prepare(
            `
            INSERT OR IGNORE INTO projects (
                id,
                name,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?)
            `,
        )
        .run(projectId, projectId, timestamp, timestamp);
}

function seedProjectWorktree(
    connection: ReturnType<typeof createTestConnection>,
    projectId: string,
    worktreeId: string,
    timestamp: string,
): void {
    connection
        .prepare(
            `
            INSERT OR IGNORE INTO project_worktrees (
                id,
                project_id,
                root_path,
                branch_name,
                head_sha,
                is_primary,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, NULL, NULL, 0, ?, ?)
            `,
        )
        .run(
            worktreeId,
            projectId,
            `/tmp/${projectId}/${worktreeId}`,
            timestamp,
            timestamp,
        );
}
