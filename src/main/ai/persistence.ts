import type Database from "better-sqlite3";

import type {
    AiAvailableCommand,
    AiDiffHunk,
    AiImageAttachment,
    AiMessage,
    AiPermissionRequest,
    AiPlan,
    AiSessionConfigOption,
    AiSessionMode,
    AiSessionModel,
    AiSessionSnapshot,
    AiToolActivity,
    AiTrackedFile,
    AiUserInputRequest,
} from "@shared/ipc";
import { syncTrackedFile } from "@shared/ai-tracked-file";

interface PersistedAiSessionRow {
    readonly draft: string;
    readonly project_id: string | null;
    readonly runtime: string;
    readonly status: string;
    readonly title: string;
    readonly transcript_json: string | null;
    readonly updated_at: string;
    readonly worktree_id: string | null;
}

interface ExistingDraftRow {
    readonly draft: string;
}

interface PersistedRuntimeCatalogRow {
    readonly value: string | null;
    readonly transcript_json: string | null;
}

interface PersistedRuntimePreferencesRow {
    readonly value: string;
}

interface PersistedRuntimeSelectionPreferences {
    readonly configOptions: Record<string, boolean | string>;
    readonly modeId: string | null;
    readonly modelId: string | null;
}

export class AiPersistence {
    readonly #connection: Database.Database;

    constructor(connection: Database.Database) {
        this.#connection = connection;
    }

    loadSessionSnapshot(sessionId: string): AiSessionSnapshot | null {
        const row = this.#connection
            .prepare<[string], PersistedAiSessionRow | undefined>(
                `
                SELECT
                    chat_sessions.project_id,
                    chat_sessions.worktree_id,
                    chat_sessions.title,
                    chat_sessions.runtime,
                    chat_sessions.status,
                    chat_sessions.draft,
                    chat_sessions.updated_at,
                    chat_transcripts.transcript_json
                FROM chat_sessions
                LEFT JOIN chat_transcripts
                    ON chat_transcripts.session_id = chat_sessions.id
                WHERE chat_sessions.id = ?
                `,
            )
            .get(sessionId);

        if (!row) {
            return null;
        }

        const fallback = createEmptyAiSessionSnapshot({
            projectId: row.project_id,
            runtimeId:
                row.runtime === "claude" ||
                row.runtime === "codex" ||
                row.runtime === "gemini" ||
                row.runtime === "kilo"
                    ? row.runtime
                    : "codex",
            sessionId,
            status: normalizeSessionStatus(row.status),
            title: row.title,
            updatedAt: row.updated_at,
            worktreeId: row.worktree_id,
        });
        const raw = parseJsonWithFallback<Record<string, unknown> | null>(
            row.transcript_json,
            null,
        );

        if (!raw) {
            return mergeRuntimeCatalogIntoSnapshot(
                fallback,
                this.loadLatestRuntimeCatalog(fallback.runtimeId),
            );
        }

        const snapshot = {
            availableCommands: normalizeAvailableCommands(
                raw.availableCommands,
            ),
            configOptions: normalizeConfigOptions(raw.configOptions),
            lastError: typeof raw.lastError === "string" ? raw.lastError : null,
            messages: normalizeMessages(raw.messages),
            modeId: typeof raw.modeId === "string" ? raw.modeId : null,
            modes: normalizeSessionModes(raw.modes),
            modelId: typeof raw.modelId === "string" ? raw.modelId : null,
            models: normalizeSessionModels(raw.models),
            pendingPermission: normalizePermissionRequest(
                raw.pendingPermission,
            ),
            pendingUserInput: normalizeUserInputRequest(raw.pendingUserInput),
            plan: normalizePlan(raw.plan),
            projectId: row.project_id,
            runtimeId:
                raw.runtimeId === "claude" ||
                raw.runtimeId === "codex" ||
                raw.runtimeId === "gemini" ||
                raw.runtimeId === "kilo"
                    ? raw.runtimeId
                    : fallback.runtimeId,
            runtimeSessionId:
                typeof raw.runtimeSessionId === "string"
                    ? raw.runtimeSessionId
                    : null,
            sessionId:
                typeof raw.sessionId === "string"
                    ? raw.sessionId
                    : fallback.sessionId,
            status: normalizeSessionStatus(raw.status),
            title: typeof raw.title === "string" ? raw.title : fallback.title,
            toolActivity: normalizeToolActivity(raw.toolActivity),
            trackedFiles: normalizeTrackedFiles(raw.trackedFiles),
            updatedAt:
                typeof raw.updatedAt === "string"
                    ? raw.updatedAt
                    : fallback.updatedAt,
            worktreeId:
                typeof raw.worktreeId === "string" || raw.worktreeId === null
                    ? raw.worktreeId
                    : fallback.worktreeId,
        };

        return mergeRuntimeCatalogIntoSnapshot(
            snapshot,
            this.loadLatestRuntimeCatalog(snapshot.runtimeId),
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
                [string, AiSessionSnapshot["runtimeId"]],
                PersistedRuntimeCatalogRow | undefined
            >(
                `
                SELECT
                    (
                        SELECT value
                        FROM app_settings
                        WHERE key = ?
                        LIMIT 1
                    ) AS value,
                    (
                        SELECT chat_transcripts.transcript_json
                        FROM chat_sessions
                        LEFT JOIN chat_transcripts
                            ON chat_transcripts.session_id = chat_sessions.id
                        WHERE chat_sessions.runtime = ?
                        ORDER BY chat_sessions.updated_at DESC
                        LIMIT 1
                    ) AS transcript_json
                `,
            )
            .get(getRuntimeCatalogKey(runtimeId), runtimeId);

        const rawJson = row?.value ?? row?.transcript_json ?? null;
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
        const now = new Date().toISOString();
        const draftToPersist =
            draft ?? this.#loadCurrentDraft(snapshot.sessionId);
        const runtimeCatalog = extractRuntimeCatalog(snapshot);

        this.#connection
            .prepare<
                [
                    string,
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
                    title,
                    runtime,
                    status,
                    draft,
                    created_at,
                    updated_at,
                    last_opened_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    project_id = excluded.project_id,
                    worktree_id = excluded.worktree_id,
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
                snapshot.title,
                snapshot.runtimeId,
                snapshot.status,
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
            .prepare<[string, string, string, number, string, string], void>(
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
                ON CONFLICT(session_id) DO UPDATE SET
                    transcript_json = excluded.transcript_json,
                    message_count = excluded.message_count,
                    updated_at = excluded.updated_at
                `,
            )
            .run(
                `transcript:${snapshot.sessionId}`,
                snapshot.sessionId,
                JSON.stringify(createPersistedSessionSnapshot(snapshot)),
                snapshot.messages.length,
                now,
                now,
            );
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
        const preferredValue =
            option.type === "select" &&
            (option.category === "mode" || option.id.toLowerCase() === "mode")
                ? (preferences.modeId ?? preferences.configOptions[option.id])
                : option.type === "select" &&
                    (option.category === "model" ||
                        option.id.toLowerCase() === "model")
                  ? (preferences.modelId ??
                    preferences.configOptions[option.id])
                  : preferences.configOptions[option.id];
        if (preferredValue === undefined) {
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

    const modeOption =
        configOptions.find(
            (option) =>
                option.type === "select" &&
                (option.category === "mode" ||
                    option.id.toLowerCase() === "mode"),
        ) ?? null;
    const modelOption =
        configOptions.find(
            (option) =>
                option.type === "select" &&
                (option.category === "model" ||
                    option.id.toLowerCase() === "model"),
        ) ?? null;

    return {
        ...catalog,
        configOptions,
        modeId:
            modeOption?.type === "select"
                ? modeOption.value
                : (preferences.modeId ?? catalog.modeId),
        modelId:
            modelOption?.type === "select"
                ? modelOption.value
                : (preferences.modelId ?? catalog.modelId),
    };
}

export function createEmptyAiSessionSnapshot(options: {
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
        availableCommands: [],
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
        projectId: options.projectId,
        runtimeId: options.runtimeId,
        runtimeSessionId: options.runtimeSessionId ?? null,
        sessionId: options.sessionId,
        status: options.status ?? "idle",
        title: options.title,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: now,
        worktreeId: options.worktreeId ?? null,
    };
}

function createPersistedSessionSnapshot(
    snapshot: AiSessionSnapshot,
): Omit<
    AiSessionSnapshot,
    "availableCommands" | "configOptions" | "modes" | "models"
> {
    return {
        lastError: snapshot.lastError,
        messages: snapshot.messages,
        modeId: snapshot.modeId,
        modelId: snapshot.modelId,
        pendingPermission: snapshot.pendingPermission,
        pendingUserInput: snapshot.pendingUserInput,
        plan: snapshot.plan,
        projectId: snapshot.projectId,
        runtimeId: snapshot.runtimeId,
        runtimeSessionId: snapshot.runtimeSessionId,
        sessionId: snapshot.sessionId,
        status: snapshot.status,
        title: snapshot.title,
        toolActivity: snapshot.toolActivity,
        trackedFiles: snapshot.trackedFiles,
        updatedAt: snapshot.updatedAt,
        worktreeId: snapshot.worktreeId ?? null,
    };
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
    } catch {
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
            entry.kind === "thinking" ||
            entry.kind === "user" ||
            entry.kind === "user_input_request"
                ? entry.kind
                : "assistant";
        const status =
            entry.status === "completed" || entry.status === "streaming"
                ? entry.status
                : "completed";

        return [
            {
                attachments: normalizeImageAttachments(entry.attachments),
                content: entry.content,
                createdAt:
                    typeof entry.createdAt === "string"
                        ? entry.createdAt
                        : new Date().toISOString(),
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

        return [
            {
                createdAt:
                    typeof entry.createdAt === "string"
                        ? entry.createdAt
                        : updatedAt,
                diffs: normalizeFileDiffs(entry.diffs),
                exitCode:
                    typeof entry.exitCode === "number" ? entry.exitCode : null,
                id: entry.id,
                kind: typeof entry.kind === "string" ? entry.kind : "unknown",
                locations: Array.isArray(entry.locations)
                    ? entry.locations.filter(
                          (location): location is string =>
                              typeof location === "string",
                      )
                    : [],
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object";
}
