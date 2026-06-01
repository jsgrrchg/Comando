import { describe, expect, it } from "vitest";

import type { AiRuntimeId, AiSessionSnapshot } from "@shared/ipc";

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
        const transcript = createCatalogTranscript({
            access: "read-only",
            modelId: "gpt-5",
            reasoning: "high",
        });

        persistence.saveSessionSnapshot({
            ...createSnapshot({
                sessionId: "session-latest",
                title: "Latest catalog",
                updatedAt: "2026-04-15T10:00:00.000Z",
            }),
            availableCommands: transcript.availableCommands,
            configOptions:
                transcript.configOptions as AiSessionSnapshot["configOptions"],
            modelId: transcript.modelId,
            models: transcript.models,
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

    it("applies Claude effort preference aliases to upstream effort catalogs", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const transcript = createCatalogTranscript({
            access: "read-only",
            modelId: "gpt-5",
            reasoning: "high",
        });

        persistence.saveSessionSnapshot({
            ...createSnapshot({
                sessionId: "session-claude-effort",
                title: "Claude effort",
                updatedAt: "2026-04-15T10:00:00.000Z",
            }),
            availableCommands: transcript.availableCommands,
            configOptions:
                transcript.configOptions.map((option) =>
                    option.id === "thought_level"
                        ? {
                              ...option,
                              id: "effort",
                              label: "Effort",
                          }
                        : option,
                ) as AiSessionSnapshot["configOptions"],
            modelId: transcript.modelId,
            models: transcript.models,
            runtimeId: "claude",
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

    it("stores transcript metadata without duplicating the full snapshot blob", () => {
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
            }).models,
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
        expect(storedTranscript?.transcript_json).toBe("{}");

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

    it("rolls back snapshot writes when shadow transcript persistence fails", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const snapshot = createSnapshot({
            messages: ["hello before failure"],
            sessionId: "session-rollback",
            title: "Rollback session",
            updatedAt: "2026-04-16T12:00:00.000Z",
        });

        connection.exec(`
            CREATE TRIGGER fail_shadow_message_insert
            BEFORE INSERT ON chat_transcript_messages
            BEGIN
                SELECT RAISE(ABORT, 'shadow transcript insert failed');
            END;
        `);

        expect(() => persistence.saveSessionSnapshot(snapshot)).toThrow(
            /shadow transcript insert failed/,
        );

        for (const tableName of [
            "chat_sessions",
            "chat_transcripts",
            "chat_transcript_messages",
            "chat_session_runtime_state",
            "chat_session_review_state",
        ]) {
            const row = connection
                .prepare<[string], { readonly count: number }>(
                    `
                    SELECT COUNT(*) AS count
                    FROM ${tableName}
                    WHERE ${tableName === "chat_sessions" ? "id" : "session_id"} = ?
                    `,
                )
                .get(snapshot.sessionId);

            expect(row?.count ?? 0).toBe(0);
        }
    });

    it("writes normalized transcript shadow rows without duplicating message ids", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const snapshot = createSnapshot({
            messages: ["First", "Second"],
            sessionId: "session-shadow-upsert",
            title: "Shadow rows",
            updatedAt: "2026-04-16T12:00:00.000Z",
        });

        persistence.saveSessionSnapshot(snapshot);
        persistence.saveSessionSnapshot({
            ...snapshot,
            messages: [
                snapshot.messages[0],
                {
                    ...snapshot.messages[1],
                    content: "Second updated",
                },
            ],
            updatedAt: "2026-04-16T12:01:00.000Z",
        });

        const rows = connection
            .prepare<
                [string],
                {
                    content: string;
                    content_hash: string;
                    message_id: string;
                    message_index: number;
                    role: string;
                }
            >(
                `
                SELECT
                    message_id,
                    message_index,
                    role,
                    content_hash,
                    json_extract(payload_json, '$.content') AS content
                FROM chat_transcript_messages
                WHERE session_id = ?
                ORDER BY message_index ASC
                `,
            )
            .all(snapshot.sessionId);

        expect(rows).toEqual([
            expect.objectContaining({
                content: "First",
                message_id: "session-shadow-upsert:message-1",
                message_index: 0,
                role: "assistant",
            }),
            expect.objectContaining({
                content: "Second updated",
                message_id: "session-shadow-upsert:message-2",
                message_index: 1,
                role: "assistant",
            }),
        ]);
        expect(rows.map((row) => row.content_hash)).toEqual([
            expect.stringMatching(/^[a-f0-9]{64}$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
        ]);
        expect(loadStoredMessageCount(connection, snapshot.sessionId)).toBe(2);
    });

    it("loads transcript pages from message rows when transcript_json is unavailable", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const snapshot = createSnapshot({
            messages: ["Message 1", "Message 2", "Message 3"],
            sessionId: "session-shadow-page",
            title: "Shadow page",
            updatedAt: "2026-04-16T12:00:00.000Z",
        });

        persistence.saveSessionSnapshot(snapshot);
        connection
            .prepare(
                `
                UPDATE chat_transcripts
                SET transcript_json = 'not json',
                    message_count = 999
                WHERE session_id = ?
                `,
            )
            .run(snapshot.sessionId);

        const page = persistence.loadSessionTranscriptPage({
            limit: 1,
            offset: 1,
            sessionId: snapshot.sessionId,
        });
        const loaded = persistence.loadSessionSnapshot(snapshot.sessionId);

        expect(page).toEqual({
            messages: [
                expect.objectContaining({
                    content: "Message 2",
                    id: "session-shadow-page:message-2",
                }),
            ],
            offset: 1,
            sessionId: snapshot.sessionId,
            totalMessages: 3,
        });
        expect(loaded?.messages.map((message) => message.content)).toEqual([
            "Message 1",
            "Message 2",
            "Message 3",
        ]);
        expect(loaded?.title).toBe("Shadow page");
    });

    it("loads snapshot transcript and state from normalized rows before compact json", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const snapshot: AiSessionSnapshot = {
            ...createSnapshot({
                messages: ["Fresh shadow message"],
                sessionId: "session-shadow-primary",
                title: "Shadow primary",
                toolActivity: [
                    createInflatedToolActivity(
                        "tool-shadow-primary",
                        "session-shadow-primary",
                    ),
                ],
                updatedAt: "2026-04-16T12:00:00.000Z",
            }),
            trackedFiles: [
                {
                    hunks: [],
                    identityKey: "src/fresh.ts",
                    isText: true,
                    kind: "update",
                    newText: "fresh",
                    oldText: "old",
                    path: "src/fresh.ts",
                    previousPath: null,
                    reviewState: "pending",
                    reversible: true,
                    sessionId: "session-shadow-primary",
                    toolCallId: "tool-shadow-primary",
                    updatedAt: "2026-04-16T12:00:00.000Z",
                },
            ],
        };

        persistence.saveSessionSnapshot(snapshot);

        const staleTranscriptPayload = {
            ...loadStoredRuntimeState(connection, snapshot.sessionId),
            messages: [
                {
                    attachments: [],
                    content: "Stale compact message",
                    createdAt: "2026-04-16T11:59:00.000Z",
                    id: "stale-message",
                    kind: "assistant",
                    status: "completed",
                },
            ],
            status: "waiting_permission",
            toolActivity: [
                {
                    ...createInflatedToolActivity(
                        "tool-stale-compact",
                        snapshot.sessionId,
                    ),
                    summary: "Stale compact tool",
                },
            ],
            trackedFiles: [
                {
                    hunks: [],
                    identityKey: "src/stale.ts",
                    isText: true,
                    kind: "update",
                    newText: "stale",
                    oldText: "old",
                    path: "src/stale.ts",
                    previousPath: null,
                    reviewState: "pending",
                    reversible: true,
                    sessionId: snapshot.sessionId,
                    toolCallId: "tool-stale-compact",
                    updatedAt: "2026-04-16T11:59:00.000Z",
                },
            ],
            updatedAt: "2026-04-16T11:59:00.000Z",
        };
        connection
            .prepare(
                `
                UPDATE chat_transcripts
                SET transcript_json = ?
                WHERE session_id = ?
                `,
            )
            .run(JSON.stringify(staleTranscriptPayload), snapshot.sessionId);

        const loaded = persistence.loadSessionSnapshot(snapshot.sessionId);

        expect(loaded?.messages.map((message) => message.content)).toEqual([
            "Fresh shadow message",
        ]);
        expect(loaded?.status).toBe("idle");
        expect(loaded?.toolActivity[0]?.id).toBe("tool-shadow-primary");
        expect(loaded?.trackedFiles[0]?.path).toBe("src/fresh.ts");
    });

    it("does not revive persisted live state when restoring a session", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const baseSnapshot = createSnapshot({
            messages: ["Partial assistant response"],
            sessionId: "session-live-state",
            title: "Live state",
            updatedAt: "2026-04-16T12:00:00.000Z",
        });
        const snapshot: AiSessionSnapshot = {
            ...baseSnapshot,
            activeTurnStartedAt: "2026-04-16T12:00:00.000Z",
            messages: [
                {
                    ...baseSnapshot.messages[0],
                    status: "streaming",
                },
            ],
            pendingPermission: {
                description: null,
                options: [],
                requestId: "permission-1",
                sessionId: baseSnapshot.sessionId,
                title: "Approve command",
                toolCallId: "tool-1",
                updatedAt: "2026-04-16T12:00:01.000Z",
            },
            pendingUserInput: {
                questions: [],
                requestId: "input-1",
                sessionId: baseSnapshot.sessionId,
                title: "Need input",
                toolCallId: "tool-1",
                turnId: null,
                updatedAt: "2026-04-16T12:00:02.000Z",
            },
            status: "streaming",
        };

        persistence.saveSessionSnapshot(snapshot);

        const storedRuntimeState = loadStoredRuntimeState(
            connection,
            snapshot.sessionId,
        );
        const storedSessionStatus = connection
            .prepare<[string], { status: string } | undefined>(
                "SELECT status FROM chat_sessions WHERE id = ?",
            )
            .get(snapshot.sessionId)?.status;
        const loaded = persistence.loadSessionSnapshot(snapshot.sessionId);

        expect(storedSessionStatus).toBe("idle");
        expect(storedRuntimeState.status).toBe("idle");
        expect(storedRuntimeState.activeTurnStartedAt).toBeNull();
        expect(storedRuntimeState.pendingPermission).toBeNull();
        expect(storedRuntimeState.pendingUserInput).toBeNull();
        expect(loaded).toEqual(
            expect.objectContaining({
                activeTurnStartedAt: null,
                pendingPermission: null,
                pendingUserInput: null,
                status: "idle",
            }),
        );
        expect(loaded?.messages[0]?.status).toBe("completed");
    });

    it("stores sanitized runtime tool activity when raw output and diffs contain huge strings", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const snapshot = createSnapshot({
            messages: ["Summarize the edit"],
            sessionId: "session-save-sanitized-tool-activity",
            title: "Sanitized save",
            toolActivity: [
                createInflatedToolActivity(
                    "tool-save-sanitized",
                    "session-save-sanitized-tool-activity",
                ),
            ],
            updatedAt: "2026-04-16T12:00:00.000Z",
        });

        persistence.saveSessionSnapshot(snapshot);

        const storedRuntimeState = loadStoredRuntimeState(
            connection,
            snapshot.sessionId,
        );
        const toolActivity = storedRuntimeState.toolActivity?.[0];
        const diff = toolActivity?.diffs?.[0];

        expect(toolActivity).toEqual(
            expect.objectContaining({
                id: "tool-save-sanitized",
                kind: "edit",
                rawInputJson: null,
                rawOutputJson: null,
                sessionId: snapshot.sessionId,
                status: "completed",
                summary: "Edited a large file",
                title: "Edit large file",
            }),
        );
        expect(toolActivity?.terminalOutput?.length).toBeLessThan(
            "terminal\n".repeat(5_000).length,
        );
        expect(diff).toEqual(
            expect.objectContaining({
                hunks: [],
                newText: null,
                oldText: null,
                path: "/tmp/large-file.ts",
                previousPath: null,
                reversible: true,
            }),
        );
        expect(loadStoredMessageCount(connection, snapshot.sessionId)).toBe(1);
    });

    it("keeps transcript metadata idempotent when loading snapshots and pages", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const snapshot = createSnapshot({
            messages: ["Stable message"],
            sessionId: "session-compact-idempotent",
            title: "Stable session",
            toolActivity: [
                createInflatedToolActivity(
                    "tool-idempotent",
                    "session-compact-idempotent",
                ),
            ],
            updatedAt: "2026-04-16T12:00:00.000Z",
        });

        persistence.saveSessionSnapshot(snapshot);
        const storedBefore = loadStoredTranscriptJson(
            connection,
            snapshot.sessionId,
        );

        const loaded = persistence.loadSessionSnapshot(snapshot.sessionId);
        const page = persistence.loadSessionTranscriptPage({
            limit: 10,
            offset: 0,
            sessionId: snapshot.sessionId,
        });
        const storedAfter = loadStoredTranscriptJson(
            connection,
            snapshot.sessionId,
        );

        expect(storedAfter).toBe(storedBefore);
        expect(loaded?.messages).toEqual(snapshot.messages);
        expect(loaded?.toolActivity[0]).toEqual(
            expect.objectContaining({
                id: "tool-idempotent",
                rawInputJson: null,
                rawOutputJson: null,
                title: "Edit large file",
            }),
        );
        expect(page?.messages).toEqual(snapshot.messages);
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

        const loadedChildSnapshot = persistence.loadSessionSnapshot(
            childSnapshot.sessionId,
        );
        expect(loadedChildSnapshot?.parentSessionId).toBe("session-parent");
        expect(loadedChildSnapshot?.toolActivity[0]?.action).toEqual({
            kind: "open_session",
            sessionId: "session-child",
        });

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
                parentSessionId: "session-parent",
            }),
        );

        persistence.saveSessionSnapshot(childSnapshot);
        expect(persistence.loadSessionSnapshot(childSnapshot.sessionId)).toEqual(
            expect.objectContaining({
                parentSessionId: "session-parent",
            }),
        );
    });

    it("preserves and backfills child parent links when the child is saved first", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const childSnapshot = createSnapshot({
            messages: [],
            parentSessionId: "session-parent",
            runtimeSessionId: "runtime-child",
            sessionId: "session-child",
            title: "Galileo",
            updatedAt: "2026-04-16T12:01:00.000Z",
        });
        const parentSnapshot = createSnapshot({
            messages: ["Parent prompt"],
            runtimeSessionId: "runtime-parent",
            sessionId: "session-parent",
            title: "Parent",
            updatedAt: "2026-04-16T12:00:00.000Z",
        });

        persistence.saveSessionSnapshot(childSnapshot);

        expect(
            connection
                .prepare<
                    [string],
                    { parent_session_id: string | null } | undefined
                >(
                    "SELECT parent_session_id FROM chat_sessions WHERE id = ?",
                )
                .get("session-child")?.parent_session_id,
        ).toBeNull();
        expect(persistence.loadSessionSnapshot("session-child")).toEqual(
            expect.objectContaining({
                parentSessionId: "session-parent",
            }),
        );

        persistence.saveSessionSnapshot(parentSnapshot);

        expect(
            connection
                .prepare<
                    [string],
                    { parent_session_id: string | null } | undefined
                >(
                    "SELECT parent_session_id FROM chat_sessions WHERE id = ?",
                )
                .get("session-child")?.parent_session_id,
        ).toBe("session-parent");
        expect(persistence.listSessionRuntimeMappingsForParent("session-parent")).toEqual([
            expect.objectContaining({
                appSessionId: "session-child",
                parentAppSessionId: "session-parent",
                runtimeSessionId: "runtime-child",
            }),
        ]);
    });

    it("resolves raw runtime parent links through persisted runtime mappings", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);
        const childSnapshot = createSnapshot({
            parentSessionId: "runtime-parent",
            runtimeSessionId: "runtime-child",
            sessionId: "session-child",
            title: "Galileo",
            updatedAt: "2026-04-16T12:01:00.000Z",
        });
        const parentSnapshot = createSnapshot({
            messages: ["Parent prompt"],
            runtimeSessionId: "runtime-parent",
            sessionId: "session-parent",
            title: "Parent",
            updatedAt: "2026-04-16T12:00:00.000Z",
        });

        persistence.saveSessionSnapshot(childSnapshot);
        persistence.saveSessionSnapshot(parentSnapshot);

        expect(persistence.loadSessionSnapshot("session-child")).toEqual(
            expect.objectContaining({
                parentSessionId: "session-parent",
                runtimeSessionId: "runtime-child",
            }),
        );
        const history = persistence.listSessionHistory({
            limit: 20,
            projectId: null,
            worktreeId: null,
        });
        expect(history).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    parentSessionId: "session-parent",
                    runtimeSessionId: "runtime-child",
                    sessionId: "session-child",
                }),
                expect.objectContaining({
                    parentSessionId: null,
                    runtimeSessionId: "runtime-parent",
                    sessionId: "session-parent",
                }),
            ]),
        );
        expect(history).toHaveLength(2);
        expect(
            persistence.resolveAppSessionIdByRuntimeSessionId("runtime-child"),
        ).toBe("session-child");
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
            preview: "Assistant returns the final summary for the branch.",
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

    it("returns null for missing history previews without backfilling transcripts", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        seedChatSession(connection, {
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "session-no-preview",
            transcript: createTranscriptWithMessages([
                "Compact transcript should not be parsed for history.",
            ]),
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
                messageCount: 1,
                preview: null,
                sessionId: "session-no-preview",
            }),
        ]);
        expect(loadStoredPreview(connection, "session-no-preview")).toBeNull();
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

    it("loads a transcript page from normalized transcript messages", () => {
        const connection = createTestConnection();
        const persistence = new AiPersistence(connection);

        persistence.saveSessionSnapshot(createSnapshot({
            sessionId: "session-page",
            title: "Paged session",
            messages: [
                "Message 1",
                "Message 2",
                "Message 3",
                "Message 4",
            ],
            updatedAt: "2026-04-16T12:00:00.000Z",
        }));

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
    readonly runtimeSessionId?: string | null;
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
        runtimeSessionId: input.runtimeSessionId ?? null,
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
        readonly runtimeId: AiRuntimeId;
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

function createInflatedToolActivity(
    id: string,
    sessionId: string,
): AiSessionSnapshot["toolActivity"][number] {
    const hugeText = "large change\n".repeat(4_000);

    return {
        action: {
            kind: "open_session",
            sessionId: `${sessionId}-child`,
        },
        createdAt: "2026-04-16T12:00:00.000Z",
        diffs: [
            {
                hunks: [
                    {
                        id: "hunk-1",
                        lines: [
                            {
                                id: "line-1",
                                text: hugeText,
                                type: "context",
                            },
                        ],
                        newCount: 1,
                        newStart: 1,
                        oldCount: 1,
                        oldStart: 1,
                    },
                ],
                isText: true,
                kind: "update",
                newText: hugeText,
                oldText: hugeText,
                path: "/tmp/large-file.ts",
                previousPath: null,
                reversible: true,
            },
        ],
        exitCode: 0,
        id,
        kind: "edit",
        locations: [
            {
                endLine: 12,
                line: 4,
                path: "/tmp/large-file.ts",
            },
        ],
        rawInputJson: JSON.stringify({ prompt: hugeText }),
        rawOutputJson: JSON.stringify({ output: hugeText }),
        sessionId,
        status: "completed",
        summary: "Edited a large file",
        terminalOutput: "terminal\n".repeat(5_000),
        title: "Edit large file",
        updatedAt: "2026-04-16T12:00:01.000Z",
    };
}

function loadStoredRuntimeState(
    connection: ReturnType<typeof createSqliteCompatConnection>,
    sessionId: string,
): {
    readonly activeTurnStartedAt?: string | null;
    readonly messages?: unknown[];
    readonly pendingPermission?: unknown;
    readonly pendingUserInput?: unknown;
    readonly status?: string;
    readonly toolActivity?: readonly {
        readonly diffs?: readonly {
            readonly hunks?: unknown[];
            readonly newText?: string | null;
            readonly oldText?: string | null;
            readonly path?: string;
            readonly previousPath?: string | null;
            readonly reversible?: boolean;
        }[];
        readonly id?: string;
        readonly kind?: string;
        readonly rawInputJson?: string | null;
        readonly rawOutputJson?: string | null;
        readonly sessionId?: string;
        readonly status?: string;
        readonly summary?: string | null;
        readonly terminalOutput?: string | null;
        readonly title?: string;
    }[];
} {
    const row = connection
        .prepare<[string], { state_json: string } | undefined>(
            `
            SELECT state_json
            FROM chat_session_runtime_state
            WHERE session_id = ?
            `,
        )
        .get(sessionId);

    expect(row).toBeDefined();
    return JSON.parse(row?.state_json ?? "{}") as {
        readonly activeTurnStartedAt?: string | null;
        readonly messages?: unknown[];
        readonly pendingPermission?: unknown;
        readonly pendingUserInput?: unknown;
        readonly status?: string;
        readonly toolActivity?: readonly {
            readonly diffs?: readonly {
                readonly hunks?: unknown[];
                readonly newText?: string | null;
                readonly oldText?: string | null;
                readonly path?: string;
                readonly previousPath?: string | null;
                readonly reversible?: boolean;
            }[];
            readonly id?: string;
            readonly kind?: string;
            readonly rawInputJson?: string | null;
            readonly rawOutputJson?: string | null;
            readonly sessionId?: string;
            readonly status?: string;
            readonly summary?: string | null;
            readonly terminalOutput?: string | null;
            readonly title?: string;
        }[];
    };
}

function loadStoredTranscriptJson(
    connection: ReturnType<typeof createSqliteCompatConnection>,
    sessionId: string,
): string {
    const row = connection
        .prepare<[string], { transcript_json: string } | undefined>(
            `
            SELECT transcript_json
            FROM chat_transcripts
            WHERE session_id = ?
            `,
        )
        .get(sessionId);

    expect(row).toBeDefined();
    return row?.transcript_json ?? "";
}

function loadStoredMessageCount(
    connection: ReturnType<typeof createSqliteCompatConnection>,
    sessionId: string,
): number | null {
    return (
        connection
            .prepare<[string], { message_count: number | null } | undefined>(
                `
                SELECT message_count
                FROM chat_transcripts
                WHERE session_id = ?
                `,
            )
            .get(sessionId)?.message_count ?? null
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
