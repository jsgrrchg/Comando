import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type {
    AiAvailableCommand,
    AiHistorySessionSummary,
    AiDiffHunk,
    AiGeneratedImage,
    AiImageAttachment,
    AiMessage,
    AiPermissionRequest,
    AiPlan,
    AiSessionConfigOption,
    AiSessionMode,
    AiSessionModel,
    AiSessionSnapshot,
    AiSessionTranscriptPage,
    AiTokenUsage,
    AiToolActivity,
    AiTrackedFile,
    AiUserInputRequest,
    GetAiSessionTranscriptPageInput,
    ListAiSessionHistoryInput,
} from "@shared/ipc";
import { syncTrackedFile } from "@shared/ai-tracked-file";
import { isKnownAiRuntimeId } from "@shared/ai-runtimes";

import type { Awaitable } from "../db/awaitable";
import { debugBenignError } from "../observability/logging";
import { mainProcessPerformance } from "../observability/performance";
import {
    mergeMissingModelOptions,
    syncSelectedModelOption,
} from "./session-core";

interface PersistedAiSessionRow {
    readonly draft: string;
    readonly parent_session_id: string | null;
    readonly project_id: string | null;
    readonly runtime: string;
    readonly runtime_session_id: string | null;
    readonly status: string;
    readonly title: string;
    readonly review_json: string | null;
    readonly state_json: string | null;
    readonly updated_at: string;
    readonly worktree_id: string | null;
}

interface PersistedAiHistorySessionRow {
    readonly created_at: string;
    readonly message_count: number | null;
    readonly parent_session_id: string | null;
    readonly pinned_at: string | null;
    readonly preview: string | null;
    readonly project_id: string | null;
    readonly runtime: string;
    readonly runtime_session_id: string | null;
    readonly session_id: string;
    readonly title: string;
    readonly updated_at: string;
    readonly worktree_id: string | null;
}

interface PersistedAiTranscriptRow {
    readonly session_id: string;
}

interface PersistedTranscriptMessageRow {
    readonly message_id: string;
    readonly payload_json: string;
}

interface PersistedTranscriptMessageOrderRow {
    readonly message_id: string;
}

interface ExistingDraftRow {
    readonly draft: string;
}

interface PersistedRuntimeCatalogRow {
    readonly value: string | null;
}

interface PersistedRuntimePreferencesRow {
    readonly value: string;
}

interface PersistedSessionRuntimeLinkRow {
    readonly app_session_id: string;
    readonly parent_app_session_id: string | null;
    readonly parent_runtime_session_id: string | null;
    readonly runtime_session_id: string;
}

export interface PersistedAiSessionRuntimeMapping {
    readonly appSessionId: string;
    readonly parentAppSessionId: string | null;
    readonly parentRuntimeSessionId: string | null;
    readonly runtimeSessionId: string;
}

type PersistedSessionSnapshot = Omit<
    AiSessionSnapshot,
    "availableCommands" | "configOptions" | "modes" | "models"
> & {
    readonly persistenceVersion: number;
};

const CURRENT_PERSISTED_SESSION_VERSION = 3;
const MAX_PERSISTED_RAW_INPUT_JSON_CHARS = 8_000;
const MAX_PERSISTED_RAW_OUTPUT_JSON_CHARS = 16_000;
const MAX_PERSISTED_TERMINAL_OUTPUT_CHARS = 24_000;
const MAX_PERSISTED_DIFF_TEXT_CHARS = 12_000;
const MAX_PERSISTED_DIFF_TEXT_TOTAL_CHARS = 32_000;
const MAX_PERSISTED_DIFF_HUNKS_JSON_CHARS = 24_000;
const MAX_PERSISTED_DIFF_HUNK_LINES = 500;
const MAX_PERSISTED_DIFFS_PER_ACTIVITY = 100;

const LATEST_RUNTIME_CATALOG_QUERY = `
    SELECT
        value
    FROM app_settings
    WHERE key = ?
    LIMIT 1
`;

export interface PersistedRuntimeSelectionPreferences {
    readonly configOptions: Record<string, boolean | string>;
    readonly modeId: string | null;
    readonly modelId: string | null;
}

export type PersistedRuntimeCatalogSnapshot = Pick<
    AiSessionSnapshot,
    | "availableCommands"
    | "configOptions"
    | "modeId"
    | "modes"
    | "modelId"
    | "models"
>;

export interface AiPersistenceGateway {
    deleteSession(sessionId: string): Awaitable<void>;
    listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): Awaitable<readonly AiHistorySessionSummary[]>;
    loadSessionSnapshot(sessionId: string): Awaitable<AiSessionSnapshot | null>;
    loadSessionTranscriptPage(
        input: GetAiSessionTranscriptPageInput,
    ): Awaitable<AiSessionTranscriptPage | null>;
    loadLatestRuntimeCatalog(
        runtimeId: AiSessionSnapshot["runtimeId"],
    ): PersistedRuntimeCatalogSnapshot | null;
    loadRuntimeSelectionPreferences(
        runtimeId: AiSessionSnapshot["runtimeId"],
    ): PersistedRuntimeSelectionPreferences;
    listSessionRuntimeMappingsForParent?(
        parentSessionId: string,
    ): Awaitable<readonly PersistedAiSessionRuntimeMapping[]>;
    resolveAppSessionIdByRuntimeSessionId?(
        runtimeSessionId: string,
    ): Awaitable<string | null>;
    saveRuntimeSelectionPreferences(
        runtimeId: AiSessionSnapshot["runtimeId"],
        patch: Partial<PersistedRuntimeSelectionPreferences>,
    ): void;
    saveRuntimeSelectionPreferenceOption(
        runtimeId: AiSessionSnapshot["runtimeId"],
        optionId: string,
        value: boolean | string,
    ): void;
    saveRuntimeModePreference(
        runtimeId: AiSessionSnapshot["runtimeId"],
        modeId: string,
    ): void;
    saveRuntimeModelPreference(
        runtimeId: AiSessionSnapshot["runtimeId"],
        modelId: string,
    ): void;
    setSessionPinned(sessionId: string, pinned: boolean): Awaitable<void>;
    saveSessionSnapshot(snapshot: AiSessionSnapshot, draft?: string): void;
}

export class AiPersistence {
    readonly #connection: Database.Database;

    constructor(connection: Database.Database) {
        this.#connection = connection;
    }

    loadSessionSnapshot(sessionId: string): AiSessionSnapshot | null {
        return mainProcessPerformance.measureSync(
            "db.ai.loadSessionSnapshot",
            () => {
                const row = this.#connection
                    .prepare<[string], PersistedAiSessionRow | undefined>(
                        `
                        SELECT
                            chat_sessions.project_id,
                            chat_sessions.worktree_id,
                            chat_sessions.parent_session_id,
                            chat_sessions.title,
                            chat_sessions.runtime,
                            runtime_links.runtime_session_id,
                            chat_sessions.status,
                            chat_sessions.draft,
                            chat_sessions.updated_at,
                            runtime_state.state_json,
                            review_state.review_json
                        FROM chat_sessions
                        LEFT JOIN chat_session_runtime_links AS runtime_links
                            ON runtime_links.app_session_id = chat_sessions.id
                        LEFT JOIN chat_session_runtime_state AS runtime_state
                            ON runtime_state.session_id = chat_sessions.id
                        LEFT JOIN chat_session_review_state AS review_state
                            ON review_state.session_id = chat_sessions.id
                        WHERE chat_sessions.id = ?
                        `,
                    )
                    .get(sessionId);

                if (!row) {
                    return null;
                }

                const fallback = createEmptyAiSessionSnapshot({
                    projectId: row.project_id,
                    parentSessionId: normalizeParentSessionId(
                        row.parent_session_id,
                    ),
                    runtimeId: normalizeRuntimeId(row.runtime),
                    runtimeSessionId: normalizeRuntimeSessionId(
                        row.runtime_session_id,
                    ),
                    sessionId,
                    status: sanitizePersistedSessionStatus(
                        normalizeSessionStatus(row.status),
                    ),
                    title: row.title,
                    updatedAt: row.updated_at,
                    worktreeId: row.worktree_id,
                });
                const runtimeRaw = parseJsonWithFallback<Record<
                    string,
                    unknown
                > | null>(row.state_json, null);
                const reviewRaw = parseJsonWithFallback<Record<
                    string,
                    unknown
                > | null>(row.review_json, null);
                const stateRaw = runtimeRaw;
                const shadowMessages = this.#loadAllTranscriptMessages(
                    sessionId,
                );

                if (!stateRaw && !shadowMessages) {
                    return mergeRuntimeCatalogIntoSnapshot(
                        fallback,
                        this.loadLatestRuntimeCatalog(fallback.runtimeId),
                    );
                }

                const rawParentSessionId = normalizeParentSessionId(
                    typeof stateRaw?.parentSessionId === "string"
                        ? stateRaw.parentSessionId
                        : null,
                );
                const parentSessionId = this.#resolvePersistedParentSessionId({
                    persistedParentSessionId: row.parent_session_id,
                    rawParentSessionId,
                    sessionId,
                });
                const runtimeSessionId = normalizeRuntimeSessionId(
                    row.runtime_session_id ??
                        (typeof stateRaw?.runtimeSessionId === "string"
                            ? stateRaw.runtimeSessionId
                            : null),
                );
                const messages =
                    shadowMessages ?? normalizeMessages(stateRaw?.messages);
                const snapshot = sanitizeLoadedSessionSnapshot({
                    activeTurnStartedAt:
                        typeof stateRaw?.activeTurnStartedAt === "string"
                            ? stateRaw.activeTurnStartedAt
                            : null,
                    availableCommands: normalizeAvailableCommands(
                        stateRaw?.availableCommands,
                    ),
                    closedAt:
                        typeof stateRaw?.closedAt === "string"
                            ? stateRaw.closedAt
                            : null,
                    configOptions: normalizeConfigOptions(
                        stateRaw?.configOptions,
                    ),
                    lastError:
                        typeof stateRaw?.lastError === "string"
                            ? stateRaw.lastError
                            : null,
                    messages,
                    modeId:
                        typeof stateRaw?.modeId === "string"
                            ? stateRaw.modeId
                            : null,
                    modes: normalizeSessionModes(stateRaw?.modes),
                    modelId:
                        typeof stateRaw?.modelId === "string"
                            ? stateRaw.modelId
                            : null,
                    models: normalizeSessionModels(stateRaw?.models),
                    pendingPermission: normalizePermissionRequest(
                        stateRaw?.pendingPermission,
                    ),
                    pendingUserInput: normalizeUserInputRequest(
                        stateRaw?.pendingUserInput,
                    ),
                    plan: normalizePlan(stateRaw?.plan),
                    parentSessionId,
                    projectId: row.project_id,
                    runtimeId:
                        typeof stateRaw?.runtimeId === "string"
                            ? normalizeRuntimeId(stateRaw.runtimeId)
                            : fallback.runtimeId,
                    runtimeSessionId,
                    sessionId: fallback.sessionId,
                    status: normalizeSessionStatus(
                        stateRaw?.status ?? row.status,
                    ),
                    title:
                        typeof stateRaw?.title === "string"
                            ? stateRaw.title
                            : fallback.title,
                    tokenUsage: normalizeTokenUsage(stateRaw?.tokenUsage),
                    toolActivity: normalizeToolActivity(stateRaw?.toolActivity),
                    trackedFiles: normalizeTrackedFiles(
                        reviewRaw?.trackedFiles,
                    ),
                    updatedAt:
                        typeof stateRaw?.updatedAt === "string"
                            ? stateRaw.updatedAt
                            : fallback.updatedAt,
                    worktreeId:
                        typeof stateRaw?.worktreeId === "string" ||
                        stateRaw?.worktreeId === null
                            ? stateRaw.worktreeId
                            : fallback.worktreeId,
                });

                this.#syncPersistedParentLinkIfNeeded({
                    parentSessionId,
                    rawParentSessionId,
                    sessionId,
                    storedParentSessionId: row.parent_session_id,
                });

                return mergeRuntimeCatalogIntoSnapshot(
                    snapshot,
                    this.loadLatestRuntimeCatalog(snapshot.runtimeId),
                );
            },
        );
    }

    listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): readonly AiHistorySessionSummary[] {
        return mainProcessPerformance.measureSync(
            "db.ai.listSessionHistory",
            () => {
                const scopedHistoryQuery = buildScopedSessionHistoryQuery(input);
                const rows = this.#connection
                    .prepare(scopedHistoryQuery.sql)
                    .all(
                        ...scopedHistoryQuery.params,
                    ) as readonly PersistedAiHistorySessionRow[];

                return rows
                    .map((row) => createHistorySessionSummary(row))
                    .filter(
                        (session) =>
                            session.messageCount > 0 ||
                            session.parentSessionId !== null,
                    );
            },
        );
    }

    loadSessionTranscriptPage(
        input: GetAiSessionTranscriptPageInput,
    ): AiSessionTranscriptPage | null {
        return mainProcessPerformance.measureSync(
            "db.ai.loadSessionTranscriptPage",
            () => {
                const row = this.#connection
                    .prepare<[string], PersistedAiTranscriptRow | undefined>(
                        `
                        SELECT
                            chat_sessions.id AS session_id
                        FROM chat_sessions
                        WHERE chat_sessions.id = ?
                        LIMIT 1
                        `,
                    )
                    .get(input.sessionId);

                if (!row) {
                    return null;
                }

                const offset = normalizeHistoryOffset(input.offset);
                const limit = normalizeTranscriptPageLimit(input.limit);
                const shadowMessageCount = this.#countTranscriptMessages(
                    input.sessionId,
                );

                return {
                    messages: this.#loadTranscriptMessagePage({
                        limit,
                        offset,
                        sessionId: input.sessionId,
                    }),
                    offset,
                    sessionId: input.sessionId,
                    totalMessages: shadowMessageCount,
                };
            },
        );
    }

    loadLatestRuntimeCatalog(
        runtimeId: AiSessionSnapshot["runtimeId"],
    ): Pick<
        AiSessionSnapshot,
        | "availableCommands"
        | "configOptions"
        | "modeId"
        | "modes"
        | "modelId"
        | "models"
    > | null {
        const row = this.#connection
            .prepare<
                [string],
                PersistedRuntimeCatalogRow | undefined
            >(LATEST_RUNTIME_CATALOG_QUERY)
            .get(getRuntimeCatalogKey(runtimeId));

        const rawJson = row?.value ?? null;
        if (!rawJson) {
            return null;
        }

        const raw = parseJsonWithFallback<Record<string, unknown> | null>(
            rawJson,
            null,
        );

        if (!raw) {
            return null;
        }

        return applyRuntimeSelectionPreferencesToCatalog(
            {
                availableCommands: normalizeAvailableCommands(
                    raw.availableCommands,
                ),
                configOptions: normalizeConfigOptions(raw.configOptions),
                modeId: typeof raw.modeId === "string" ? raw.modeId : null,
                modes: normalizeSessionModes(raw.modes),
                modelId: typeof raw.modelId === "string" ? raw.modelId : null,
                models: normalizeSessionModels(raw.models),
            },
            this.loadRuntimeSelectionPreferences(runtimeId),
        );
    }

    loadRuntimeSelectionPreferences(
        runtimeId: AiSessionSnapshot["runtimeId"],
    ): PersistedRuntimeSelectionPreferences {
        const raw = this.#connection
            .prepare<[string], PersistedRuntimePreferencesRow | undefined>(
                `
                SELECT value
                FROM app_settings
                WHERE key = ?
                LIMIT 1
                `,
            )
            .get(getRuntimeSelectionPreferencesKey(runtimeId))?.value;
        const parsed =
            parseJsonWithFallback<PersistedRuntimeSelectionPreferences | null>(
                raw ?? null,
                null,
            );

        if (!parsed || typeof parsed !== "object") {
            return createEmptyRuntimeSelectionPreferences();
        }

        return {
            configOptions: normalizeSelectionPreferenceOptions(
                parsed.configOptions,
            ),
            modeId: typeof parsed.modeId === "string" ? parsed.modeId : null,
            modelId: typeof parsed.modelId === "string" ? parsed.modelId : null,
        };
    }

    saveRuntimeSelectionPreferences(
        runtimeId: AiSessionSnapshot["runtimeId"],
        patch: Partial<PersistedRuntimeSelectionPreferences>,
    ): void {
        const now = new Date().toISOString();
        const current = this.loadRuntimeSelectionPreferences(runtimeId);
        const next = {
            configOptions: {
                ...current.configOptions,
                ...(patch.configOptions ?? {}),
            },
            modeId: patch.modeId === undefined ? current.modeId : patch.modeId,
            modelId:
                patch.modelId === undefined ? current.modelId : patch.modelId,
        } satisfies PersistedRuntimeSelectionPreferences;

        this.#connection
            .prepare<[string, string, string], void>(
                `
                INSERT INTO app_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                `,
            )
            .run(
                getRuntimeSelectionPreferencesKey(runtimeId),
                JSON.stringify(next),
                now,
            );
    }

    saveRuntimeSelectionPreferenceOption(
        runtimeId: AiSessionSnapshot["runtimeId"],
        optionId: string,
        value: boolean | string,
    ): void {
        this.saveRuntimeSelectionPreferences(runtimeId, {
            configOptions: {
                [optionId]: value,
            },
        });
    }

    saveRuntimeModePreference(
        runtimeId: AiSessionSnapshot["runtimeId"],
        modeId: string,
    ): void {
        this.saveRuntimeSelectionPreferences(runtimeId, { modeId });
    }

    saveRuntimeModelPreference(
        runtimeId: AiSessionSnapshot["runtimeId"],
        modelId: string,
    ): void {
        this.saveRuntimeSelectionPreferences(runtimeId, { modelId });
    }

    saveSessionSnapshot(snapshot: AiSessionSnapshot, draft?: string): void {
        mainProcessPerformance.measureSync("db.ai.saveSessionSnapshot", () => {
            const saveSnapshot = this.#connection.transaction(
                (nextSnapshot: AiSessionSnapshot, nextDraft: string | undefined) => {
                    this.#saveSessionSnapshotAtomic(nextSnapshot, nextDraft);
                },
            );
            saveSnapshot(snapshot, draft);
        });
    }

    #saveSessionSnapshotAtomic(
        snapshot: AiSessionSnapshot,
        draft?: string,
    ): void {
        const now = new Date().toISOString();
        const draftToPersist =
            draft ?? this.#loadCurrentDraft(snapshot.sessionId);
        const runtimeCatalog = extractRuntimeCatalog(snapshot);
        const parentSessionId = normalizeParentSessionId(
            snapshot.parentSessionId,
        );
        const runtimeSessionId = normalizeRuntimeSessionId(
            snapshot.runtimeSessionId,
        );
        const isSelfParent =
            parentSessionId === snapshot.sessionId ||
            (runtimeSessionId !== null && parentSessionId === runtimeSessionId);
        const persistedParentSessionId = isSelfParent
            ? null
            : this.#resolveAppSessionIdBySessionRef(parentSessionId);
        const transcriptParentSessionId =
            persistedParentSessionId ?? (isSelfParent ? null : parentSessionId);
        const snapshotToPersist =
            (snapshot.parentSessionId ?? null) === transcriptParentSessionId
                ? snapshot
                : {
                      ...snapshot,
                      parentSessionId: transcriptParentSessionId,
                  };
        const persistedSnapshot =
            createPersistedSessionSnapshot(snapshotToPersist);

        this.#connection
            .prepare<
                [
                    string,
                    string | null,
                    string | null,
                    string | null,
                    string,
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
                    parent_session_id,
                    title,
                    runtime,
                    status,
                    draft,
                    created_at,
                    updated_at,
                    last_opened_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    project_id = excluded.project_id,
                    worktree_id = excluded.worktree_id,
                    parent_session_id = excluded.parent_session_id,
                    title = excluded.title,
                    runtime = excluded.runtime,
                    status = excluded.status,
                    draft = excluded.draft,
                    updated_at = excluded.updated_at,
                    last_opened_at = excluded.last_opened_at
                `,
            )
            .run(
                snapshot.sessionId,
                snapshot.projectId,
                snapshot.worktreeId ?? null,
                persistedParentSessionId,
                snapshot.title,
                snapshot.runtimeId,
                persistedSnapshot.status,
                draftToPersist,
                now,
                now,
                now,
            );

        if (hasRuntimeCatalog(runtimeCatalog)) {
            this.#connection
                .prepare<[string, string, string], void>(
                    `
                    INSERT INTO app_settings (key, value, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at
                    `,
                )
                .run(
                    getRuntimeCatalogKey(snapshot.runtimeId),
                    JSON.stringify(runtimeCatalog),
                    now,
                );
        }

        this.#connection
            .prepare<
                [string, string, string, number, string, string, string],
                void
            >(
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
                ON CONFLICT(session_id) DO UPDATE SET
                    transcript_json = excluded.transcript_json,
                    message_count = excluded.message_count,
                    preview = excluded.preview,
                    updated_at = excluded.updated_at
                `,
            )
            .run(
                `transcript:${snapshot.sessionId}`,
                snapshot.sessionId,
                "{}",
                persistedSnapshot.messages.length,
                serializePersistedPreview(
                    deriveSessionPreview(persistedSnapshot.messages),
                ),
                now,
                now,
            );

        this.#saveSessionTranscriptMessages(persistedSnapshot, now);
        this.#saveSessionRuntimeState(persistedSnapshot, now);
        this.#saveSessionReviewState(persistedSnapshot, now);

        this.#upsertRuntimeSessionLink({
            appSessionId: snapshot.sessionId,
            now,
            parentAppSessionId: persistedParentSessionId,
            parentRuntimeSessionId: this.#resolveParentRuntimeSessionId({
                parentAppSessionId: persistedParentSessionId,
                parentSessionId,
            }),
            runtimeSessionId,
        });
        this.#backfillChildParentLinks({
            appSessionId: snapshot.sessionId,
            now,
            runtimeSessionId,
        });
    }

    #saveSessionTranscriptMessages(
        snapshot: PersistedSessionSnapshot,
        now: string,
    ): void {
        const messageIds = snapshot.messages.map((message) => message.id);
        const existingMessageIds = this.#loadPersistedTranscriptMessageIds(
            snapshot.sessionId,
        );

        if (
            existingMessageIds.length > 0 &&
            !areStringArraysEqual(existingMessageIds, messageIds)
        ) {
            this.#connection
                .prepare<[string], void>(
                    `
                    UPDATE chat_transcript_messages
                    SET message_index = -message_index - 1
                    WHERE session_id = ?
                    `,
                )
                .run(snapshot.sessionId);
        }

        if (messageIds.length === 0) {
            this.#connection
                .prepare<[string], void>(
                    `
                    DELETE FROM chat_transcript_messages
                    WHERE session_id = ?
                    `,
                )
                .run(snapshot.sessionId);
            return;
        }

        const placeholders = messageIds.map(() => "?").join(", ");
        this.#connection
            .prepare(
                `
                DELETE FROM chat_transcript_messages
                WHERE session_id = ?
                  AND message_id NOT IN (${placeholders})
                `,
            )
            .run(snapshot.sessionId, ...messageIds);

        const upsertMessage = this.#connection.prepare<
            [
                string,
                number,
                string,
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
            INSERT INTO chat_transcript_messages (
                session_id,
                message_index,
                message_id,
                kind,
                role,
                payload_json,
                content_hash,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, message_id) DO UPDATE SET
                message_index = excluded.message_index,
                kind = excluded.kind,
                role = excluded.role,
                payload_json = excluded.payload_json,
                content_hash = excluded.content_hash,
                updated_at = excluded.updated_at
            WHERE chat_transcript_messages.message_index <> excluded.message_index
               OR chat_transcript_messages.kind <> excluded.kind
               OR chat_transcript_messages.role <> excluded.role
               OR chat_transcript_messages.content_hash <> excluded.content_hash
            `,
        );

        snapshot.messages.forEach((message, index) => {
            const payloadJson = JSON.stringify(message);
            upsertMessage.run(
                snapshot.sessionId,
                index,
                message.id,
                "message",
                message.kind,
                payloadJson,
                createContentHash(payloadJson),
                message.createdAt,
                now,
            );
        });
    }

    #loadPersistedTranscriptMessageIds(
        sessionId: string,
    ): readonly string[] {
        return this.#connection
            .prepare<[string], PersistedTranscriptMessageOrderRow>(
                `
                SELECT message_id
                FROM chat_transcript_messages
                WHERE session_id = ?
                ORDER BY message_index ASC
                `,
            )
            .all(sessionId)
            .map((row) => row.message_id);
    }

    #countTranscriptMessages(sessionId: string): number {
        const row = this.#connection
            .prepare<[string], { readonly count: number }>(
                `
                SELECT COUNT(*) AS count
                FROM chat_transcript_messages
                WHERE session_id = ?
                `,
            )
            .get(sessionId);

        return row?.count ?? 0;
    }

    #loadAllTranscriptMessages(sessionId: string): readonly AiMessage[] | null {
        const count = this.#countTranscriptMessages(sessionId);
        if (count === 0) {
            return null;
        }

        return this.#loadTranscriptMessagePage({
            limit: count,
            offset: 0,
            sessionId,
        });
    }

    #loadTranscriptMessagePage(input: {
        readonly limit: number;
        readonly offset: number;
        readonly sessionId: string;
    }): readonly AiMessage[] {
        const rows = this.#connection
            .prepare<[string, number, number], PersistedTranscriptMessageRow>(
                `
                SELECT message_id, payload_json
                FROM chat_transcript_messages
                WHERE session_id = ?
                ORDER BY message_index ASC
                LIMIT ?
                OFFSET ?
                `,
            )
            .all(input.sessionId, input.limit, input.offset);

        const messages = rows.flatMap((row) => {
            const raw = parseJsonWithFallback<Record<string, unknown> | null>(
                row.payload_json,
                null,
            );
            return normalizeMessages(raw ? [raw] : []);
        });
        return sanitizePersistedMessages(messages);
    }

    #saveSessionRuntimeState(
        snapshot: PersistedSessionSnapshot,
        now: string,
    ): void {
        const state = {
            activeTurnStartedAt: snapshot.activeTurnStartedAt,
            closedAt: snapshot.closedAt ?? null,
            lastError: snapshot.lastError,
            modeId: snapshot.modeId,
            modelId: snapshot.modelId,
            parentSessionId: snapshot.parentSessionId,
            pendingPermission: snapshot.pendingPermission,
            pendingUserInput: snapshot.pendingUserInput,
            persistenceVersion: snapshot.persistenceVersion,
            plan: snapshot.plan,
            projectId: snapshot.projectId,
            runtimeId: snapshot.runtimeId,
            runtimeSessionId: snapshot.runtimeSessionId,
            sessionId: snapshot.sessionId,
            status: snapshot.status,
            title: snapshot.title,
            tokenUsage: snapshot.tokenUsage,
            toolActivity: snapshot.toolActivity,
            updatedAt: snapshot.updatedAt,
            worktreeId: snapshot.worktreeId,
        };

        this.#connection
            .prepare<[string, string, string, string], void>(
                `
                INSERT INTO chat_session_runtime_state (
                    session_id,
                    state_json,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    state_json = excluded.state_json,
                    updated_at = excluded.updated_at
                `,
            )
            .run(snapshot.sessionId, JSON.stringify(state), now, now);
    }

    #saveSessionReviewState(
        snapshot: PersistedSessionSnapshot,
        now: string,
    ): void {
        const reviewState = {
            trackedFiles: snapshot.trackedFiles,
            updatedAt: snapshot.updatedAt,
        };

        this.#connection
            .prepare<[string, string, string, string], void>(
                `
                INSERT INTO chat_session_review_state (
                    session_id,
                    review_json,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    review_json = excluded.review_json,
                    updated_at = excluded.updated_at
                `,
            )
            .run(snapshot.sessionId, JSON.stringify(reviewState), now, now);
    }

    listSessionRuntimeMappingsForParent(
        parentSessionId: string,
    ): readonly PersistedAiSessionRuntimeMapping[] {
        const normalizedParentSessionId =
            normalizeParentSessionId(parentSessionId);
        if (!normalizedParentSessionId) {
            return [];
        }

        const parentRuntimeSessionId =
            this.#findRuntimeSessionIdByAppSessionId(normalizedParentSessionId);
        const rows = this.#connection
            .prepare<
                [string, string | null, string | null],
                PersistedSessionRuntimeLinkRow
            >(
                `
                SELECT
                    runtime_session_id,
                    app_session_id,
                    parent_runtime_session_id,
                    parent_app_session_id
                FROM chat_session_runtime_links
                WHERE parent_app_session_id = ?
                   OR (
                        ? IS NOT NULL
                        AND parent_runtime_session_id = ?
                   )
                ORDER BY updated_at ASC
                `,
            )
            .all(
                normalizedParentSessionId,
                parentRuntimeSessionId,
                parentRuntimeSessionId,
            );

        return rows.map(createRuntimeMapping);
    }

    resolveAppSessionIdByRuntimeSessionId(runtimeSessionId: string): string | null {
        return this.#resolveAppSessionIdByRuntimeSessionId(runtimeSessionId);
    }

    deleteSession(sessionId: string): void {
        mainProcessPerformance.measureSync("db.ai.deleteSession", () => {
            this.#connection
                .prepare<[string], void>(
                    `
                    DELETE FROM chat_sessions
                    WHERE id = ?
                    `,
                )
                .run(sessionId);
        });
    }

    #resolvePersistedParentSessionId(input: {
        readonly persistedParentSessionId: string | null;
        readonly rawParentSessionId: string | null;
        readonly sessionId: string;
    }): string | null {
        const storedParentSessionId = normalizeParentSessionId(
            input.persistedParentSessionId,
        );
        if (
            storedParentSessionId &&
            storedParentSessionId !== input.sessionId &&
            this.#hasPersistedSession(storedParentSessionId)
        ) {
            return storedParentSessionId;
        }

        const rawParentSessionId = normalizeParentSessionId(
            input.rawParentSessionId,
        );
        if (!rawParentSessionId || rawParentSessionId === input.sessionId) {
            return null;
        }

        return this.#resolveAppSessionIdBySessionRef(rawParentSessionId) ??
            rawParentSessionId;
    }

    #syncPersistedParentLinkIfNeeded(input: {
        readonly parentSessionId: string | null;
        readonly rawParentSessionId: string | null;
        readonly sessionId: string;
        readonly storedParentSessionId: string | null;
    }): void {
        const parentSessionId = normalizeParentSessionId(input.parentSessionId);
        if (
            !parentSessionId ||
            parentSessionId === input.sessionId ||
            parentSessionId === normalizeParentSessionId(input.storedParentSessionId) ||
            !this.#hasPersistedSession(parentSessionId)
        ) {
            return;
        }

        this.#connection
            .prepare<[string, string], void>(
                `
                UPDATE chat_sessions
                SET parent_session_id = ?
                WHERE id = ?
                `,
            )
            .run(parentSessionId, input.sessionId);
    }

    #resolveAppSessionIdBySessionRef(sessionRef: string | null): string | null {
        const normalizedRef = normalizeParentSessionId(sessionRef);
        if (!normalizedRef) {
            return null;
        }

        if (this.#hasPersistedSession(normalizedRef)) {
            return normalizedRef;
        }

        return this.#resolveAppSessionIdByRuntimeSessionId(normalizedRef);
    }

    #resolveAppSessionIdByRuntimeSessionId(
        runtimeSessionId: string | null,
    ): string | null {
        const normalizedRuntimeSessionId =
            normalizeRuntimeSessionId(runtimeSessionId);
        if (!normalizedRuntimeSessionId) {
            return null;
        }

        const row = this.#connection
            .prepare<[string], { readonly app_session_id: string } | undefined>(
                `
                SELECT app_session_id
                FROM chat_session_runtime_links
                WHERE runtime_session_id = ?
                LIMIT 1
                `,
            )
            .get(normalizedRuntimeSessionId);

        return row?.app_session_id ?? null;
    }

    #findRuntimeSessionIdByAppSessionId(appSessionId: string | null): string | null {
        const normalizedAppSessionId = normalizeParentSessionId(appSessionId);
        if (!normalizedAppSessionId) {
            return null;
        }

        const row = this.#connection
            .prepare<
                [string],
                { readonly runtime_session_id: string } | undefined
            >(
                `
                SELECT runtime_session_id
                FROM chat_session_runtime_links
                WHERE app_session_id = ?
                LIMIT 1
                `,
            )
            .get(normalizedAppSessionId);

        return row?.runtime_session_id ?? null;
    }

    #resolveParentRuntimeSessionId(input: {
        readonly parentAppSessionId: string | null;
        readonly parentSessionId: string | null;
    }): string | null {
        const parentRuntimeSessionId = this.#findRuntimeSessionIdByAppSessionId(
            input.parentAppSessionId,
        );
        if (parentRuntimeSessionId) {
            return parentRuntimeSessionId;
        }

        const parentSessionId = normalizeParentSessionId(input.parentSessionId);
        if (!parentSessionId || parentSessionId === input.parentAppSessionId) {
            return null;
        }

        return parentSessionId;
    }

    #upsertRuntimeSessionLink(input: {
        readonly appSessionId: string;
        readonly now: string;
        readonly parentAppSessionId: string | null;
        readonly parentRuntimeSessionId: string | null;
        readonly runtimeSessionId: string | null;
    }): void {
        if (!input.runtimeSessionId) {
            return;
        }

        this.#connection
            .prepare<[string, string], void>(
                `
                DELETE FROM chat_session_runtime_links
                WHERE app_session_id = ?
                  AND runtime_session_id <> ?
                `,
            )
            .run(input.appSessionId, input.runtimeSessionId);

        this.#connection
            .prepare<
                [string, string, string | null, string | null, string, string],
                void
            >(
                `
                INSERT INTO chat_session_runtime_links (
                    runtime_session_id,
                    app_session_id,
                    parent_runtime_session_id,
                    parent_app_session_id,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(runtime_session_id) DO UPDATE SET
                    app_session_id = excluded.app_session_id,
                    parent_runtime_session_id = COALESCE(
                        excluded.parent_runtime_session_id,
                        chat_session_runtime_links.parent_runtime_session_id
                    ),
                    parent_app_session_id = COALESCE(
                        excluded.parent_app_session_id,
                        chat_session_runtime_links.parent_app_session_id
                    ),
                    updated_at = excluded.updated_at
                `,
            )
            .run(
                input.runtimeSessionId,
                input.appSessionId,
                input.parentRuntimeSessionId,
                input.parentAppSessionId,
                input.now,
                input.now,
            );
    }

    #backfillChildParentLinks(input: {
        readonly appSessionId: string;
        readonly now: string;
        readonly runtimeSessionId: string | null;
    }): void {
        const parentRefs = [
            input.appSessionId,
            input.runtimeSessionId,
        ].filter((value): value is string => Boolean(value));
        if (parentRefs.length === 0) {
            return;
        }

        for (const parentRef of parentRefs) {
            this.#connection
                .prepare<[string, string, string, string], void>(
                    `
                    UPDATE chat_session_runtime_links
                    SET
                        parent_app_session_id = ?,
                        updated_at = ?
                    WHERE app_session_id <> ?
                      AND parent_app_session_id IS NULL
                      AND parent_runtime_session_id = ?
                    `,
                )
                .run(input.appSessionId, input.now, input.appSessionId, parentRef);

            this.#connection
                .prepare<[string, string, string], void>(
                    `
                    UPDATE chat_sessions
                    SET parent_session_id = ?
                    WHERE id <> ?
                      AND parent_session_id IS NULL
                      AND EXISTS (
                        SELECT 1
                        FROM chat_session_runtime_links
                        WHERE chat_session_runtime_links.app_session_id = chat_sessions.id
                          AND chat_session_runtime_links.parent_app_session_id = ?
                      )
                    `,
                )
                .run(input.appSessionId, input.appSessionId, input.appSessionId);
        }
    }

    #hasPersistedSession(sessionId: string | null): boolean {
        if (!sessionId) {
            return false;
        }

        const row = this.#connection
            .prepare<[string], { readonly id: string }>(
                `
                SELECT id
                FROM chat_sessions
                WHERE id = ?
                LIMIT 1
                `,
            )
            .get(sessionId);

        return row !== undefined;
    }

    setSessionPinned(sessionId: string, pinned: boolean): void {
        mainProcessPerformance.measureSync("db.ai.setSessionPinned", () => {
            this.#connection
                .prepare<[string | null, string], void>(
                    `
                    UPDATE chat_sessions
                    SET pinned_at = ?
                    WHERE id = ?
                    `,
                )
                .run(pinned ? new Date().toISOString() : null, sessionId);
        });
    }

    #loadCurrentDraft(sessionId: string): string {
        const row = this.#connection
            .prepare<[string], ExistingDraftRow | undefined>(
                `
                SELECT draft
                FROM chat_sessions
                WHERE id = ?
                `,
            )
            .get(sessionId);

        return row?.draft ?? "";
    }

}

function getRuntimeSelectionPreferencesKey(
    runtimeId: AiSessionSnapshot["runtimeId"],
): string {
    return `ai.runtime_preferences.${runtimeId}`;
}

function getRuntimeCatalogKey(
    runtimeId: AiSessionSnapshot["runtimeId"],
): string {
    return `ai.runtime_catalog.${runtimeId}`;
}

function createEmptyRuntimeSelectionPreferences(): PersistedRuntimeSelectionPreferences {
    return {
        configOptions: {},
        modeId: null,
        modelId: null,
    };
}

function normalizeSelectionPreferenceOptions(
    value: unknown,
): Record<string, boolean | string> {
    if (!isRecord(value)) {
        return {};
    }

    const normalized: Record<string, boolean | string> = {};

    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "boolean" || typeof entry === "string") {
            normalized[key] = entry;
        }
    }

    return normalized;
}

function getPreferredConfigOptionValue(
    preferences: PersistedRuntimeSelectionPreferences,
    optionId: string,
): boolean | string | null {
    if (Object.prototype.hasOwnProperty.call(preferences.configOptions, optionId)) {
        return preferences.configOptions[optionId];
    }

    const aliasIds =
        optionId === "effort"
            ? ["effort_level"]
            : optionId === "effort_level"
              ? ["effort"]
              : [];

    for (const aliasId of aliasIds) {
        if (
            Object.prototype.hasOwnProperty.call(
                preferences.configOptions,
                aliasId,
            )
        ) {
            return preferences.configOptions[aliasId];
        }
    }

    return null;
}

function applyRuntimeSelectionPreferencesToCatalog(
    catalog: Pick<
        AiSessionSnapshot,
        | "availableCommands"
        | "configOptions"
        | "modeId"
        | "modes"
        | "modelId"
        | "models"
    >,
    preferences: PersistedRuntimeSelectionPreferences,
): Pick<
    AiSessionSnapshot,
    | "availableCommands"
    | "configOptions"
    | "modeId"
    | "modes"
    | "modelId"
    | "models"
> {
    const configOptions = catalog.configOptions.map((option) => {
        const configOptionValue = getPreferredConfigOptionValue(
            preferences,
            option.id,
        );
        const preferredValue =
            option.type === "select" &&
            (option.category === "mode" || option.id.toLowerCase() === "mode")
                ? (preferences.modeId ?? configOptionValue)
                : option.type === "select" &&
                    (option.category === "model" ||
                        option.id.toLowerCase() === "model")
                  ? (preferences.modelId ?? configOptionValue)
                  : configOptionValue;
        if (preferredValue === null) {
            return option;
        }

        if (option.type === "boolean" && typeof preferredValue === "boolean") {
            return {
                ...option,
                value: preferredValue,
            };
        }

        if (
            option.type === "select" &&
            typeof preferredValue === "string" &&
            option.options.some(
                (candidate) => candidate.value === preferredValue,
            )
        ) {
            return {
                ...option,
                value: preferredValue,
            };
        }

        return option;
    });

    const mergedConfigOptions = mergeMissingModelOptions(
        configOptions,
        catalog.models,
    );
    const modeOption =
        mergedConfigOptions.find(
            (option) =>
                option.type === "select" &&
                (option.category === "mode" ||
                    option.id.toLowerCase() === "mode"),
        ) ?? null;
    const modelOption =
        mergedConfigOptions.find(
            (option) =>
                option.type === "select" &&
                (option.category === "model" ||
                    option.id.toLowerCase() === "model"),
        ) ?? null;

    const modelId =
        modelOption?.type === "select"
            ? modelOption.value
            : (preferences.modelId ?? catalog.modelId);
    const synchronizedConfigOptions = syncSelectedModelOption(
        mergedConfigOptions,
        modelId,
    );

    return {
        ...catalog,
        configOptions: synchronizedConfigOptions,
        modeId:
            modeOption?.type === "select"
                ? modeOption.value
                : (preferences.modeId ?? catalog.modeId),
        modelId,
    };
}

export function createEmptyAiSessionSnapshot(options: {
    readonly parentSessionId?: string | null;
    readonly projectId: string | null;
    readonly runtimeId: AiSessionSnapshot["runtimeId"];
    readonly runtimeSessionId?: string | null;
    readonly sessionId: string;
    readonly status?: AiSessionSnapshot["status"];
    readonly title: string;
    readonly updatedAt?: string;
    readonly worktreeId?: string | null;
}): AiSessionSnapshot {
    const now = options.updatedAt ?? new Date().toISOString();

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
        parentSessionId: options.parentSessionId ?? null,
        projectId: options.projectId,
        runtimeId: options.runtimeId,
        runtimeSessionId: options.runtimeSessionId ?? null,
        sessionId: options.sessionId,
        status: options.status ?? "idle",
        title: options.title,
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: now,
        worktreeId: options.worktreeId ?? null,
    };
}

function createPersistedSessionSnapshot(
    snapshot: AiSessionSnapshot,
): PersistedSessionSnapshot {
    const sanitizedSnapshot = sanitizeLoadedSessionSnapshot(snapshot);

    return {
        activeTurnStartedAt: sanitizedSnapshot.activeTurnStartedAt ?? null,
        closedAt: sanitizedSnapshot.closedAt ?? null,
        lastError: sanitizedSnapshot.lastError,
        messages: sanitizedSnapshot.messages,
        modeId: sanitizedSnapshot.modeId,
        modelId: sanitizedSnapshot.modelId,
        pendingPermission: sanitizedSnapshot.pendingPermission,
        pendingUserInput: sanitizedSnapshot.pendingUserInput,
        persistenceVersion: CURRENT_PERSISTED_SESSION_VERSION,
        plan: sanitizedSnapshot.plan,
        parentSessionId: sanitizedSnapshot.parentSessionId ?? null,
        projectId: sanitizedSnapshot.projectId,
        runtimeId: sanitizedSnapshot.runtimeId,
        runtimeSessionId: sanitizedSnapshot.runtimeSessionId,
        sessionId: sanitizedSnapshot.sessionId,
        status: sanitizedSnapshot.status,
        title: sanitizedSnapshot.title,
        tokenUsage: sanitizedSnapshot.tokenUsage,
        toolActivity: sanitizedSnapshot.toolActivity,
        trackedFiles: sanitizedSnapshot.trackedFiles,
        updatedAt: sanitizedSnapshot.updatedAt,
        worktreeId: sanitizedSnapshot.worktreeId ?? null,
    };
}

function sanitizeLoadedSessionSnapshot(
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    return {
        ...snapshot,
        activeTurnStartedAt: null,
        messages: sanitizePersistedMessages(snapshot.messages),
        pendingPermission: null,
        pendingUserInput: null,
        status: sanitizePersistedSessionStatus(snapshot.status),
        toolActivity: sanitizePersistedToolActivity(snapshot.toolActivity),
    };
}

function sanitizePersistedSessionStatus(
    status: AiSessionSnapshot["status"],
): AiSessionSnapshot["status"] {
    return status === "error" ? "error" : "idle";
}

function sanitizePersistedMessages(
    messages: readonly AiMessage[],
): readonly AiMessage[] {
    return messages.map((message) =>
        message.status === "streaming"
            ? {
                  ...message,
                  status: "completed",
              }
            : message,
    );
}

function sanitizePersistedToolActivity(
    entries: readonly AiToolActivity[],
): readonly AiToolActivity[] {
    return entries.map((entry) => ({
        ...entry,
        diffs: sanitizePersistedFileDiffs(entry.diffs),
        rawInputJson: sanitizeNullableString(
            entry.rawInputJson,
            MAX_PERSISTED_RAW_INPUT_JSON_CHARS,
            "null",
        ),
        rawOutputJson: sanitizeNullableString(
            entry.rawOutputJson,
            MAX_PERSISTED_RAW_OUTPUT_JSON_CHARS,
            "null",
        ),
        terminalOutput: sanitizeNullableString(
            entry.terminalOutput,
            MAX_PERSISTED_TERMINAL_OUTPUT_CHARS,
            "truncate",
        ),
    }));
}

function sanitizeNullableString(
    value: string | null,
    maxChars: number,
    strategy: "null" | "truncate",
): string | null {
    if (value === null || value.length <= maxChars) {
        return value;
    }

    return strategy === "truncate" ? value.slice(-maxChars) : null;
}

function sanitizePersistedFileDiffs(
    diffs: AiToolActivity["diffs"],
): AiToolActivity["diffs"] {
    const tooManyDiffs = diffs.length > MAX_PERSISTED_DIFFS_PER_ACTIVITY;
    const retainedDiffs = tooManyDiffs
        ? diffs.slice(0, MAX_PERSISTED_DIFFS_PER_ACTIVITY)
        : diffs;
    let remainingTextBudget = tooManyDiffs
        ? 0
        : MAX_PERSISTED_DIFF_TEXT_TOTAL_CHARS;

    return retainedDiffs.map((diff) => {
        const oldText = sanitizePersistedDiffText(
            diff.oldText,
            remainingTextBudget,
        );
        if (oldText !== null) {
            remainingTextBudget -= oldText.length;
        }

        const newText = sanitizePersistedDiffText(
            diff.newText,
            remainingTextBudget,
        );
        if (newText !== null) {
            remainingTextBudget -= newText.length;
        }

        return {
            ...diff,
            hunks: sanitizePersistedDiffHunks(diff.hunks, tooManyDiffs),
            newText,
            oldText,
        };
    });
}

function sanitizePersistedDiffText(
    value: string | null,
    remainingBudget: number,
): string | null {
    if (
        value === null ||
        value.length > MAX_PERSISTED_DIFF_TEXT_CHARS ||
        value.length > remainingBudget
    ) {
        return null;
    }

    return value;
}

function sanitizePersistedDiffHunks(
    hunks: readonly AiDiffHunk[],
    forceEmpty: boolean,
): readonly AiDiffHunk[] {
    if (forceEmpty || countDiffHunkLines(hunks) > MAX_PERSISTED_DIFF_HUNK_LINES) {
        return [];
    }

    return getJsonLength(hunks) > MAX_PERSISTED_DIFF_HUNKS_JSON_CHARS
        ? []
        : hunks;
}

function countDiffHunkLines(hunks: readonly AiDiffHunk[]): number {
    return hunks.reduce((count, hunk) => count + hunk.lines.length, 0);
}

function getJsonLength(value: unknown): number {
    return JSON.stringify(value).length;
}

function createContentHash(payloadJson: string): string {
    return createHash("sha256").update(payloadJson).digest("hex");
}

function areStringArraysEqual(
    left: readonly string[],
    right: readonly string[],
): boolean {
    return left.length === right.length &&
        left.every((value, index) => value === right[index]);
}

function extractRuntimeCatalog(
    snapshot: Pick<
        AiSessionSnapshot,
        | "availableCommands"
        | "configOptions"
        | "modeId"
        | "modes"
        | "modelId"
        | "models"
    >,
): Pick<
    AiSessionSnapshot,
    | "availableCommands"
    | "configOptions"
    | "modeId"
    | "modes"
    | "modelId"
    | "models"
> {
    return {
        availableCommands: snapshot.availableCommands,
        configOptions: snapshot.configOptions,
        modeId: snapshot.modeId,
        modes: snapshot.modes,
        modelId: snapshot.modelId,
        models: snapshot.models,
    };
}

function hasRuntimeCatalog(
    catalog: Pick<
        AiSessionSnapshot,
        | "availableCommands"
        | "configOptions"
        | "modeId"
        | "modes"
        | "modelId"
        | "models"
    > | null,
): boolean {
    return Boolean(
        catalog &&
        (catalog.availableCommands.length > 0 ||
            catalog.configOptions.length > 0 ||
            catalog.modes.length > 0 ||
            catalog.models.length > 0),
    );
}

function mergeRuntimeCatalogIntoSnapshot(
    snapshot: AiSessionSnapshot,
    catalog: Pick<
        AiSessionSnapshot,
        | "availableCommands"
        | "configOptions"
        | "modeId"
        | "modes"
        | "modelId"
        | "models"
    > | null,
): AiSessionSnapshot {
    if (!catalog) {
        return snapshot;
    }

    return {
        ...snapshot,
        availableCommands:
            snapshot.availableCommands.length > 0
                ? snapshot.availableCommands
                : catalog.availableCommands,
        configOptions:
            snapshot.configOptions.length > 0
                ? snapshot.configOptions
                : catalog.configOptions,
        modeId: snapshot.modeId ?? catalog.modeId,
        modes: snapshot.modes.length > 0 ? snapshot.modes : catalog.modes,
        modelId: snapshot.modelId ?? catalog.modelId,
        models: snapshot.models.length > 0 ? snapshot.models : catalog.models,
    };
}

function normalizeSessionModes(value: unknown): readonly AiSessionMode[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        if (
            !isRecord(entry) ||
            typeof entry.id !== "string" ||
            typeof entry.name !== "string"
        ) {
            return [];
        }

        return [
            {
                description:
                    typeof entry.description === "string"
                        ? entry.description
                        : null,
                id: entry.id,
                name: entry.name,
            },
        ];
    });
}

function normalizeSessionModels(value: unknown): readonly AiSessionModel[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        if (
            !isRecord(entry) ||
            typeof entry.id !== "string" ||
            typeof entry.name !== "string"
        ) {
            return [];
        }

        return [
            {
                description:
                    typeof entry.description === "string"
                        ? entry.description
                        : null,
                id: entry.id,
                name: entry.name,
            },
        ];
    });
}

function normalizeConfigOptions(
    value: unknown,
): readonly AiSessionConfigOption[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const normalized: AiSessionConfigOption[] = [];

    for (const entry of value) {
        if (
            !isRecord(entry) ||
            typeof entry.id !== "string" ||
            typeof entry.label !== "string" ||
            typeof entry.category !== "string" ||
            typeof entry.type !== "string"
        ) {
            continue;
        }

        if (entry.type === "boolean" && typeof entry.value === "boolean") {
            normalized.push({
                category: normalizeConfigCategory(entry.category),
                description:
                    typeof entry.description === "string"
                        ? entry.description
                        : null,
                id: entry.id,
                label: entry.label,
                type: "boolean",
                value: entry.value,
            });
            continue;
        }

        if (entry.type === "select" && typeof entry.value === "string") {
            const options = Array.isArray(entry.options)
                ? entry.options.flatMap((option) => {
                      if (
                          !isRecord(option) ||
                          typeof option.label !== "string" ||
                          typeof option.value !== "string"
                      ) {
                          return [];
                      }

                      return [
                          {
                              description:
                                  typeof option.description === "string"
                                      ? option.description
                                      : null,
                              groupLabel:
                                  typeof option.groupLabel === "string"
                                      ? option.groupLabel
                                      : null,
                              label: option.label,
                              value: option.value,
                          },
                      ];
                  })
                : [];

            normalized.push({
                category: normalizeConfigCategory(entry.category),
                description:
                    typeof entry.description === "string"
                        ? entry.description
                        : null,
                id: entry.id,
                label: entry.label,
                options,
                type: "select",
                value: entry.value,
            });
        }
    }

    return normalized;
}

function normalizeConfigCategory(
    value: unknown,
): AiSessionConfigOption["category"] {
    if (value === "effort") {
        return "reasoning";
    }

    return value === "mode" ||
        value === "model" ||
        value === "other" ||
        value === "reasoning"
        ? value
        : "other";
}

function parseJsonWithFallback<T>(value: string | null, fallback: T): T {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value) as T;
    } catch (error) {
        debugBenignError("ai.persistence.parseJson", error);
        return fallback;
    }
}

function normalizeSessionStatus(value: unknown): AiSessionSnapshot["status"] {
    return value === "error" ||
        value === "idle" ||
        value === "starting" ||
        value === "streaming" ||
        value === "waiting_permission" ||
        value === "waiting_user_input"
        ? value
        : "idle";
}

function normalizeMessages(value: unknown): readonly AiMessage[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.content !== "string") {
            return [];
        }

        const kind =
            entry.kind === "assistant" ||
            entry.kind === "image" ||
            entry.kind === "thinking" ||
            entry.kind === "user" ||
            entry.kind === "user_input_request"
                ? entry.kind
                : "assistant";
        const status =
            entry.status === "completed" || entry.status === "streaming"
                ? entry.status
                : "completed";
        const generatedImage = normalizeGeneratedImage(entry.generatedImage);

        return [
            {
                attachments: normalizeImageAttachments(entry.attachments),
                content: entry.content,
                createdAt:
                    typeof entry.createdAt === "string"
                        ? entry.createdAt
                        : new Date().toISOString(),
                ...(generatedImage ? { generatedImage } : {}),
                id:
                    typeof entry.id === "string"
                        ? entry.id
                        : crypto.randomUUID(),
                kind,
                status,
            } satisfies AiMessage,
        ];
    });
}

function normalizeGeneratedImage(value: unknown): AiGeneratedImage | null {
    if (!isRecord(value)) {
        return null;
    }

    return {
        error: typeof value.error === "string" ? value.error : null,
        mimeType: typeof value.mimeType === "string" ? value.mimeType : null,
        path: typeof value.path === "string" ? value.path : null,
        result: typeof value.result === "string" ? value.result : null,
        revisedPrompt:
            typeof value.revisedPrompt === "string"
                ? value.revisedPrompt
                : null,
        status: typeof value.status === "string" ? value.status : "completed",
        title:
            typeof value.title === "string" && value.title.trim().length > 0
                ? value.title
                : "Generated image",
    };
}

function normalizeImageAttachments(
    value: unknown,
): readonly AiImageAttachment[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        if (
            !isRecord(entry) ||
            typeof entry.id !== "string" ||
            typeof entry.dataBase64 !== "string" ||
            typeof entry.mimeType !== "string"
        ) {
            return [];
        }

        return [
            {
                dataBase64: entry.dataBase64,
                id: entry.id,
                mimeType: entry.mimeType,
                name: typeof entry.name === "string" ? entry.name : null,
                sizeBytes:
                    typeof entry.sizeBytes === "number"
                        ? entry.sizeBytes
                        : null,
            } satisfies AiImageAttachment,
        ];
    });
}

function normalizeAvailableCommands(
    value: unknown,
): readonly AiAvailableCommand[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        if (!isRecord(entry)) {
            return [];
        }

        return [
            {
                description:
                    typeof entry.description === "string"
                        ? entry.description
                        : "",
                id:
                    typeof entry.id === "string"
                        ? entry.id
                        : crypto.randomUUID(),
                insertText:
                    typeof entry.insertText === "string"
                        ? entry.insertText
                        : "",
                label: typeof entry.label === "string" ? entry.label : "",
            } satisfies AiAvailableCommand,
        ];
    });
}

function normalizePlan(value: unknown): AiPlan | null {
    if (!isRecord(value) || !Array.isArray(value.entries)) {
        return null;
    }

    return {
        entries: value.entries.flatMap((entry) => {
            if (!isRecord(entry) || typeof entry.content !== "string") {
                return [];
            }

            return [
                {
                    content: entry.content,
                    priority:
                        entry.priority === "high" ||
                        entry.priority === "low" ||
                        entry.priority === "medium"
                            ? entry.priority
                            : "medium",
                    status:
                        entry.status === "completed" ||
                        entry.status === "in_progress" ||
                        entry.status === "pending"
                            ? entry.status
                            : "pending",
                },
            ];
        }),
        title:
            typeof value.title === "string" && value.title.trim().length > 0
                ? value.title.trim()
                : null,
        updatedAt:
            typeof value.updatedAt === "string"
                ? value.updatedAt
                : new Date().toISOString(),
    };
}

function normalizePermissionRequest(
    value: unknown,
): AiPermissionRequest | null {
    if (!isRecord(value)) {
        return null;
    }

    const options = Array.isArray(value.options)
        ? value.options.flatMap((entry) => {
              if (!isRecord(entry)) {
                  return [];
              }

              const kind: AiPermissionRequest["options"][number]["kind"] =
                  entry.kind === "allow_always" ||
                  entry.kind === "allow_once" ||
                  entry.kind === "reject_always" ||
                  entry.kind === "reject_once"
                      ? entry.kind
                      : "reject_once";

              return [
                  {
                      kind,
                      name: typeof entry.name === "string" ? entry.name : "",
                      optionId:
                          typeof entry.optionId === "string"
                              ? entry.optionId
                              : crypto.randomUUID(),
                  },
              ];
          })
        : [];

    if (
        typeof value.requestId !== "string" ||
        typeof value.sessionId !== "string" ||
        typeof value.title !== "string" ||
        typeof value.toolCallId !== "string"
    ) {
        return null;
    }

    return {
        description:
            typeof value.description === "string" ? value.description : null,
        options,
        requestId: value.requestId,
        sessionId: value.sessionId,
        title: value.title,
        toolCallId: value.toolCallId,
        updatedAt:
            typeof value.updatedAt === "string"
                ? value.updatedAt
                : new Date().toISOString(),
    };
}

function normalizeToolActivity(value: unknown): readonly AiToolActivity[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.id !== "string") {
            return [];
        }

        const updatedAt =
            typeof entry.updatedAt === "string"
                ? entry.updatedAt
                : new Date().toISOString();
        const action = normalizeToolActivityAction(entry.action);

        return [
            {
                ...(action ? { action } : {}),
                createdAt:
                    typeof entry.createdAt === "string"
                        ? entry.createdAt
                        : updatedAt,
                diffs: normalizeFileDiffs(entry.diffs),
                exitCode:
                    typeof entry.exitCode === "number" ? entry.exitCode : null,
                id: entry.id,
                kind: typeof entry.kind === "string" ? entry.kind : "unknown",
                locations: normalizeToolActivityLocations(entry.locations),
                rawInputJson:
                    typeof entry.rawInputJson === "string"
                        ? entry.rawInputJson
                        : null,
                rawOutputJson:
                    typeof entry.rawOutputJson === "string"
                        ? entry.rawOutputJson
                        : null,
                sessionId:
                    typeof entry.sessionId === "string" ? entry.sessionId : "",
                status:
                    entry.status === "completed" ||
                    entry.status === "failed" ||
                    entry.status === "in_progress" ||
                    entry.status === "pending"
                        ? entry.status
                        : "pending",
                summary:
                    typeof entry.summary === "string" ? entry.summary : null,
                terminalOutput:
                    typeof entry.terminalOutput === "string"
                        ? entry.terminalOutput
                        : null,
                title:
                    typeof entry.title === "string" ? entry.title : "Tool call",
                updatedAt,
            } satisfies AiToolActivity,
        ];
    });
}

function normalizeToolActivityAction(
    value: unknown,
): AiToolActivity["action"] {
    if (!isRecord(value) || value.kind !== "open_session") {
        return undefined;
    }

    const sessionId = normalizeParentSessionId(value.sessionId);
    if (!sessionId) {
        return undefined;
    }

    return {
        kind: "open_session",
        sessionId,
    };
}

function normalizeToolActivityLocations(
    value: unknown,
): AiToolActivity["locations"] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        if (typeof entry === "string") {
            return entry.trim()
                ? [
                      {
                          endLine: null,
                          line: null,
                          path: entry,
                      },
                  ]
                : [];
        }

        if (!isRecord(entry) || typeof entry.path !== "string") {
            return [];
        }

        return [
            {
                endLine: normalizePersistedLineNumber(entry.endLine),
                line: normalizePersistedLineNumber(entry.line),
                path: entry.path,
            },
        ];
    });
}

function normalizePersistedLineNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
        ? value
        : null;
}

function normalizeTokenUsage(value: unknown): AiTokenUsage | null {
    if (!isRecord(value)) {
        return null;
    }
    const size = Number(value.size);
    const used = Number(value.used);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(used)) {
        return null;
    }
    const costRecord = isRecord(value.cost) ? value.cost : null;
    const cost =
        costRecord &&
        typeof costRecord.amount === "number" &&
        typeof costRecord.currency === "string"
            ? { amount: costRecord.amount, currency: costRecord.currency }
            : null;
    return {
        cost,
        size,
        updatedAt:
            typeof value.updatedAt === "string"
                ? value.updatedAt
                : new Date().toISOString(),
        used: Math.max(0, used),
    };
}

function normalizeTrackedFiles(value: unknown): readonly AiTrackedFile[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        if (
            !isRecord(entry) ||
            typeof entry.identityKey !== "string" ||
            typeof entry.path !== "string" ||
            typeof entry.sessionId !== "string"
        ) {
            return [];
        }

        return [
            syncTrackedFile({
                identityKey: entry.identityKey,
                currentText:
                    typeof entry.currentText === "string"
                        ? entry.currentText
                        : undefined,
                diffBase:
                    typeof entry.diffBase === "string"
                        ? entry.diffBase
                        : undefined,
                isText: typeof entry.isText === "boolean" ? entry.isText : true,
                kind:
                    entry.kind === "create" ||
                    entry.kind === "delete" ||
                    entry.kind === "move" ||
                    entry.kind === "update"
                        ? entry.kind
                        : "update",
                hunks: normalizeDiffHunks(entry.hunks),
                hunksAreAnchored:
                    entry.hunksAreAnchored === true ? true : undefined,
                newText:
                    typeof entry.newText === "string" ? entry.newText : null,
                oldText:
                    typeof entry.oldText === "string" ? entry.oldText : null,
                path: entry.path,
                previousPath:
                    typeof entry.previousPath === "string"
                        ? entry.previousPath
                        : null,
                reversible:
                    typeof entry.reversible === "boolean"
                        ? entry.reversible
                        : entry.kind === "create" ||
                          typeof entry.oldText === "string",
                reviewState:
                    entry.reviewState === "kept" ||
                    entry.reviewState === "pending" ||
                    entry.reviewState === "rejected"
                        ? entry.reviewState
                        : "pending",
                sessionId: entry.sessionId,
                toolCallId:
                    typeof entry.toolCallId === "string"
                        ? entry.toolCallId
                        : null,
                updatedAt:
                    typeof entry.updatedAt === "string"
                        ? entry.updatedAt
                        : new Date().toISOString(),
                version:
                    typeof entry.version === "number"
                        ? entry.version
                        : undefined,
            } satisfies AiTrackedFile),
        ];
    });
}

function normalizeFileDiffs(value: unknown): AiToolActivity["diffs"] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.path !== "string") {
            return [];
        }

        return [
            {
                kind:
                    entry.kind === "create" ||
                    entry.kind === "delete" ||
                    entry.kind === "move" ||
                    entry.kind === "update"
                        ? entry.kind
                        : "update",
                hunks: normalizeDiffHunks(entry.hunks),
                newText:
                    typeof entry.newText === "string" ? entry.newText : null,
                oldText:
                    typeof entry.oldText === "string" ? entry.oldText : null,
                isText: typeof entry.isText === "boolean" ? entry.isText : true,
                path: entry.path,
                previousPath:
                    typeof entry.previousPath === "string"
                        ? entry.previousPath
                        : null,
                reversible:
                    typeof entry.reversible === "boolean"
                        ? entry.reversible
                        : entry.kind === "create" ||
                          typeof entry.oldText === "string",
            },
        ];
    });
}

function normalizeUserInputRequest(value: unknown): AiUserInputRequest | null {
    if (!isRecord(value)) {
        return null;
    }

    if (
        typeof value.requestId !== "string" ||
        typeof value.sessionId !== "string" ||
        typeof value.title !== "string" ||
        typeof value.toolCallId !== "string" ||
        (typeof value.turnId !== "string" && value.turnId !== null)
    ) {
        return null;
    }

    return {
        questions: Array.isArray(value.questions)
            ? value.questions.flatMap((entry) => {
                  if (!isRecord(entry) || typeof entry.id !== "string") {
                      return [];
                  }

                  return [
                      {
                          header:
                              typeof entry.header === "string"
                                  ? entry.header
                                  : "",
                          id: entry.id,
                          isOther: Boolean(entry.isOther),
                          isSecret: Boolean(entry.isSecret),
                          options: Array.isArray(entry.options)
                              ? entry.options.flatMap((option) => {
                                    if (!isRecord(option)) {
                                        return [];
                                    }

                                    return [
                                        {
                                            description:
                                                typeof option.description ===
                                                "string"
                                                    ? option.description
                                                    : "",
                                            label:
                                                typeof option.label === "string"
                                                    ? option.label
                                                    : "",
                                        },
                                    ];
                                })
                              : [],
                          question:
                              typeof entry.question === "string"
                                  ? entry.question
                                  : "",
                      },
                  ];
              })
            : [],
        requestId: value.requestId,
        sessionId: value.sessionId,
        title: value.title,
        toolCallId: value.toolCallId,
        turnId: typeof value.turnId === "string" ? value.turnId : null,
        updatedAt:
            typeof value.updatedAt === "string"
                ? value.updatedAt
                : new Date().toISOString(),
    };
}

function normalizeDiffHunks(value: unknown): readonly AiDiffHunk[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry, index) => {
        if (!isRecord(entry)) {
            return [];
        }

        const lines = Array.isArray(entry.lines)
            ? entry.lines.flatMap((line, lineIndex) => {
                  if (!isRecord(line) || typeof line.text !== "string") {
                      return [];
                  }

                  const lineType: "add" | "context" | "remove" =
                      line.type === "add" ||
                      line.type === "context" ||
                      line.type === "remove"
                          ? line.type
                          : "context";

                  return [
                      {
                          id:
                              typeof line.id === "string"
                                  ? line.id
                                  : `line-${index}-${lineIndex}`,
                          text: line.text,
                          type: lineType,
                      },
                  ];
              })
            : [];

        return [
            {
                id: typeof entry.id === "string" ? entry.id : `hunk-${index}`,
                lines,
                newCount:
                    typeof entry.newCount === "number" ? entry.newCount : 0,
                newStart:
                    typeof entry.newStart === "number" ? entry.newStart : 1,
                oldCount:
                    typeof entry.oldCount === "number" ? entry.oldCount : 0,
                oldStart:
                    typeof entry.oldStart === "number" ? entry.oldStart : 1,
                visualEndLine:
                    typeof entry.visualEndLine === "number"
                        ? entry.visualEndLine
                        : undefined,
                visualStartLine:
                    typeof entry.visualStartLine === "number"
                        ? entry.visualStartLine
                        : undefined,
            } satisfies AiDiffHunk,
        ];
    });
}

function normalizeRuntimeId(
    value: unknown,
): AiSessionSnapshot["runtimeId"] {
    return isKnownAiRuntimeId(value) ? value : "codex";
}

function normalizeParentSessionId(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const parentSessionId = value.trim();
    return parentSessionId.length > 0 ? parentSessionId : null;
}

function normalizeRuntimeSessionId(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const runtimeSessionId = value.trim();
    return runtimeSessionId.length > 0 ? runtimeSessionId : null;
}

function normalizeHistoryLimit(value: number | null | undefined): number | null {
    if (value === null) {
        return null;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 100;
    }

    return Math.max(1, Math.min(250, Math.trunc(value)));
}

function buildScopedSessionHistoryQuery(input: ListAiSessionHistoryInput): {
    readonly params: readonly (number | string)[];
    readonly sql: string;
} {
    const whereClauses: string[] = [];
    const params: Array<number | string> = [];
    const worktreeId = input.worktreeId ?? null;
    const limit = normalizeHistoryLimit(input.limit);

    if (input.projectId === null) {
        whereClauses.push("chat_sessions.project_id IS NULL");
    } else {
        whereClauses.push("chat_sessions.project_id = ?");
        params.push(input.projectId);
    }

    if (worktreeId === null) {
        whereClauses.push("chat_sessions.worktree_id IS NULL");
    } else {
        whereClauses.push("chat_sessions.worktree_id = ?");
        params.push(worktreeId);
    }

    if (limit !== null) {
        params.push(limit);
    }

    return {
        params,
        sql: `
            SELECT
                history_rows.session_id,
                history_rows.project_id,
                history_rows.worktree_id,
                COALESCE(
                    history_rows.parent_session_id,
                    runtime_links.parent_app_session_id
                ) AS parent_session_id,
                history_rows.title,
                history_rows.runtime,
                runtime_links.runtime_session_id,
                history_rows.created_at,
                history_rows.pinned_at,
                history_rows.updated_at,
                history_rows.message_count,
                history_rows.preview
            FROM (
                SELECT
                    chat_sessions.id AS session_id,
                    chat_sessions.project_id,
                    chat_sessions.worktree_id,
                    chat_sessions.parent_session_id,
                    chat_sessions.title,
                    chat_sessions.runtime,
                    chat_sessions.created_at,
                    chat_sessions.pinned_at,
                    chat_sessions.updated_at,
                    chat_transcripts.message_count,
                    chat_transcripts.preview
                FROM chat_sessions
                LEFT JOIN chat_transcripts
                    ON chat_transcripts.session_id = chat_sessions.id
                WHERE ${whereClauses.join(" AND ")}
            ) AS history_rows
            LEFT JOIN chat_session_runtime_links AS runtime_links
                ON runtime_links.app_session_id = history_rows.session_id
            ORDER BY history_rows.updated_at DESC
            ${limit === null ? "" : "LIMIT ?"}
        `,
    };
}

function normalizeHistoryOffset(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.trunc(value));
}

function normalizeTranscriptPageLimit(value: number): number {
    if (!Number.isFinite(value)) {
        return 50;
    }

    return Math.max(1, Math.min(200, Math.trunc(value)));
}

function deriveSessionPreview(messages: readonly AiMessage[]): string | null {
    const message =
        [...messages]
            .reverse()
            .find((entry) => messagePreviewText(entry).length > 0) ??
        messages.find((entry) => messagePreviewText(entry).length > 0) ??
        null;

    if (!message) {
        return null;
    }

    const preview = messagePreviewText(message);
    return preview.length > 280 ? `${preview.slice(0, 277)}...` : preview;
}

function messagePreviewText(message: AiMessage): string {
    const content = normalizePreviewText(message.content);
    if (content.length > 0) {
        return content;
    }

    if (message.kind !== "image" || !message.generatedImage) {
        return "";
    }

    const status = message.generatedImage.status.toLowerCase();
    if (
        message.status === "streaming" ||
        status === "pending" ||
        status === "in_progress" ||
        status === "running"
    ) {
        return "Generating image...";
    }

    if (
        message.generatedImage.error ||
        status === "failed" ||
        status === "error" ||
        status === "cancelled" ||
        status === "canceled"
    ) {
        return "Image generation failed";
    }

    return "Generated image";
}

function normalizePreviewText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function createHistorySessionSummary(
    row: PersistedAiHistorySessionRow,
): AiHistorySessionSummary {
    const messageCount = Math.max(row.message_count ?? 0, 0);

    return {
        createdAt: row.created_at,
        messageCount,
        parentSessionId: normalizeParentSessionId(row.parent_session_id),
        pinnedAt: row.pinned_at,
        preview: deserializePersistedPreview(row.preview),
        projectId: row.project_id,
        runtimeId: normalizeRuntimeId(row.runtime),
        runtimeSessionId: normalizeRuntimeSessionId(row.runtime_session_id),
        sessionId: row.session_id,
        title: row.title,
        updatedAt: row.updated_at,
        worktreeId: row.worktree_id,
    };
}

function createRuntimeMapping(
    row: PersistedSessionRuntimeLinkRow,
): PersistedAiSessionRuntimeMapping {
    return {
        appSessionId: row.app_session_id,
        parentAppSessionId: normalizeParentSessionId(row.parent_app_session_id),
        parentRuntimeSessionId: normalizeRuntimeSessionId(
            row.parent_runtime_session_id,
        ),
        runtimeSessionId: row.runtime_session_id,
    };
}

function serializePersistedPreview(value: string | null): string {
    return value ?? "";
}

function deserializePersistedPreview(value: string | null): string | null {
    if (value === null || value.length === 0) {
        return null;
    }

    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object";
}
