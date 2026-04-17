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
            toolActivity: [],
            trackedFiles: [],
            updatedAt: "2026-04-15T10:00:00.000Z",
            worktreeId: null,
        };

        persistence.saveSessionSnapshot(snapshot);

        const storedTranscript = connection
            .prepare<[string], { transcript_json: string } | undefined>(
                `
                SELECT transcript_json
                FROM chat_transcripts
                WHERE session_id = ?
                `,
            )
            .get(snapshot.sessionId);

        expect(storedTranscript).toBeDefined();
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

    it("lists session history scoped by project and worktree with previews", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

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

    it("keeps a renamed session visible in scoped history listings", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
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

function seedChatSession(
    connection: ReturnType<typeof createTestConnection>,
    input: {
        readonly projectId?: string | null;
        readonly runtimeId: "claude" | "codex" | "gemini" | "kilo";
        readonly sessionId: string;
        readonly transcript: Record<string, unknown>;
        readonly updatedAt: string;
        readonly worktreeId?: string | null;
    },
): void {
    connection
        .prepare(
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
            VALUES (?, ?, ?, ?, ?, 'idle', '', ?, ?, ?)
            `,
        )
        .run(
            input.sessionId,
            input.projectId ?? null,
            input.worktreeId ?? null,
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
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            `,
        )
        .run(
            `transcript:${input.sessionId}`,
            input.sessionId,
            JSON.stringify(input.transcript),
            Array.isArray(input.transcript.messages)
                ? input.transcript.messages.length
                : 0,
            input.updatedAt,
            input.updatedAt,
        );
}
