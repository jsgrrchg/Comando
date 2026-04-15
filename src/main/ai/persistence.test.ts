import { describe, expect, it } from "vitest";

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

        expect(persistence.loadLatestRuntimeCatalog("codex")).toEqual(
            expect.objectContaining({
                configOptions: expect.arrayContaining([
                    expect.objectContaining({
                        id: "sandbox_mode",
                        value: "full",
                    }),
                    expect.objectContaining({
                        id: "model",
                        value: "gpt-5.4-mini",
                    }),
                    expect.objectContaining({
                        category: "reasoning",
                        id: "thought_level",
                        value: "medium",
                    }),
                ]),
                modelId: "gpt-5.4-mini",
            }),
        );
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

function seedChatSession(
    connection: ReturnType<typeof createTestConnection>,
    input: {
        readonly runtimeId: "claude" | "codex" | "gemini" | "kilo";
        readonly sessionId: string;
        readonly transcript: Record<string, unknown>;
        readonly updatedAt: string;
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
            VALUES (?, NULL, NULL, ?, ?, 'idle', '', ?, ?, ?)
            `,
        )
        .run(
            input.sessionId,
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
            VALUES (?, ?, ?, 0, ?, ?)
            `,
        )
        .run(
            `transcript:${input.sessionId}`,
            input.sessionId,
            JSON.stringify(input.transcript),
            input.updatedAt,
            input.updatedAt,
        );
}
