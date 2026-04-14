import type Database from "better-sqlite3";

import type {
    AiAvailableCommand,
    AiDiffHunk,
    AiMessage,
    AiPermissionRequest,
    AiPlan,
    AiSessionSnapshot,
    AiToolActivity,
    AiTrackedFile,
    AiUserInputRequest,
} from "@shared/ipc";

interface PersistedAiSessionRow {
    readonly draft: string;
    readonly project_id: string | null;
    readonly runtime: string;
    readonly status: string;
    readonly title: string;
    readonly transcript_json: string | null;
    readonly updated_at: string;
}

interface ExistingDraftRow {
    readonly draft: string;
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
            runtimeId: row.runtime === "codex" ? "codex" : "codex",
            sessionId,
            status: normalizeSessionStatus(row.status),
            title: row.title,
            updatedAt: row.updated_at,
        });
        const raw = parseJsonWithFallback<Record<string, unknown> | null>(
            row.transcript_json,
            null,
        );

        if (!raw) {
            return fallback;
        }

        return {
            availableCommands: normalizeAvailableCommands(
                raw.availableCommands,
            ),
            lastError: typeof raw.lastError === "string" ? raw.lastError : null,
            messages: normalizeMessages(raw.messages),
            pendingPermission: normalizePermissionRequest(
                raw.pendingPermission,
            ),
            pendingUserInput: normalizeUserInputRequest(raw.pendingUserInput),
            plan: normalizePlan(raw.plan),
            projectId: row.project_id,
            runtimeId:
                raw.runtimeId === "codex" ? raw.runtimeId : fallback.runtimeId,
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
        };
    }

    saveSessionSnapshot(snapshot: AiSessionSnapshot, draft?: string): void {
        const now = new Date().toISOString();
        const draftToPersist =
            draft ?? this.#loadCurrentDraft(snapshot.sessionId);

        this.#connection
            .prepare<
                [
                    string,
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
                    title,
                    runtime,
                    status,
                    draft,
                    created_at,
                    updated_at,
                    last_opened_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    project_id = excluded.project_id,
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
                snapshot.title,
                snapshot.runtimeId,
                snapshot.status,
                draftToPersist,
                now,
                now,
                now,
            );

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
                JSON.stringify(snapshot),
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

export function createEmptyAiSessionSnapshot(options: {
    readonly projectId: string | null;
    readonly runtimeId: AiSessionSnapshot["runtimeId"];
    readonly runtimeSessionId?: string | null;
    readonly sessionId: string;
    readonly status?: AiSessionSnapshot["status"];
    readonly title: string;
    readonly updatedAt?: string;
}): AiSessionSnapshot {
    const now = options.updatedAt ?? new Date().toISOString();

    return {
        availableCommands: [],
        lastError: null,
        messages: [],
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
    };
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

        return [
            {
                diffs: normalizeFileDiffs(entry.diffs),
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
                title:
                    typeof entry.title === "string" ? entry.title : "Tool call",
                updatedAt:
                    typeof entry.updatedAt === "string"
                        ? entry.updatedAt
                        : new Date().toISOString(),
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
            {
                identityKey: entry.identityKey,
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
            } satisfies AiTrackedFile,
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
            } satisfies AiDiffHunk,
        ];
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object";
}
