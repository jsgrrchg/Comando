import type {
    AiFileDiff,
    AiMessage,
    AiSessionSnapshot,
    AiToolActivity,
    AiTrackedFile,
} from "@shared/ipc";

const FIXTURE_STARTED_AT_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const FIXTURE_SESSION_ID = "performance-session";

export interface ChatPerformanceFixtureDefinition {
    readonly id: string;
    readonly messageCount: number;
    readonly toolActivityCount: number;
    readonly trackedFileCount: number;
}

export interface ChatPerformanceFixture {
    readonly definition: ChatPerformanceFixtureDefinition;
    readonly snapshot: AiSessionSnapshot;
}

export const CHAT_PERFORMANCE_FIXTURES = [
    {
        id: "chat-short",
        messageCount: 30,
        toolActivityCount: 10,
        trackedFileCount: 2,
    },
    {
        id: "chat-long-10k",
        messageCount: 10_000,
        toolActivityCount: 0,
        trackedFileCount: 0,
    },
    {
        id: "chat-extreme-100k",
        messageCount: 100_000,
        toolActivityCount: 0,
        trackedFileCount: 0,
    },
    {
        id: "chat-tool-heavy",
        messageCount: 1_000,
        toolActivityCount: 20_000,
        trackedFileCount: 2_000,
    },
] as const satisfies readonly ChatPerformanceFixtureDefinition[];

export const CHAT_INTERACTION_BUDGETS = {
    activityInitialItems: 20,
    maxFullRebuildsDuringStreaming: 0,
    maxMountedRows: 80,
    transcriptBlockEntries: 256,
} as const;

export type ChatPerformanceFixtureId =
    (typeof CHAT_PERFORMANCE_FIXTURES)[number]["id"];

export interface ChatPerformanceWorkspaceFixture {
    readonly activeStreamingSessionIds: readonly string[];
    readonly id: "workspace-multipane";
    readonly panes: readonly ChatPerformanceWorkspacePane[];
}

export interface ChatPerformanceWorkspacePane {
    readonly activeSessionId: string;
    readonly id: string;
    readonly retainedSessionIds: readonly string[];
}

export function createChatPerformanceFixture(
    definition: ChatPerformanceFixtureDefinition,
): ChatPerformanceFixture {
    const messages = Array.from(
        { length: definition.messageCount },
        (_, index) => createMessage(index),
    );
    const toolActivity = Array.from(
        { length: definition.toolActivityCount },
        (_, index) => createToolActivity(index),
    );
    const trackedFiles = Array.from(
        { length: definition.trackedFileCount },
        (_, index) =>
            createTrackedFile(
                index,
                definition.toolActivityCount === 0
                    ? null
                    : `tool-${(index % definition.toolActivityCount) + 1}`,
            ),
    );

    return {
        definition,
        snapshot: {
            activeTurnStartedAt: null,
            availableCommands: [],
            configOptions: [],
            lastError: null,
            messages,
            modeId: null,
            modes: [],
            modelId: "gpt-5",
            models: [],
            pendingPermission: null,
            pendingUserInput: null,
            plan: null,
            projectId: "performance-project",
            runtimeId: "codex",
            runtimeSessionId: "performance-runtime-session",
            sessionId: FIXTURE_SESSION_ID,
            status: "idle",
            title: `Performance fixture: ${definition.id}`,
            tokenUsage: null,
            toolActivity,
            trackedFiles,
            updatedAt: timestampFor(
                definition.messageCount + definition.toolActivityCount,
            ),
            worktreeId: null,
        },
    };
}

export function createChatPerformanceFixtureById(
    id: ChatPerformanceFixtureId,
): ChatPerformanceFixture {
    const definition = CHAT_PERFORMANCE_FIXTURES.find(
        (candidate) => candidate.id === id,
    );
    if (!definition) {
        throw new Error(`Unknown chat performance fixture: ${id}`);
    }

    return createChatPerformanceFixture(definition);
}

export function createChatPerformanceWorkspaceFixture(): ChatPerformanceWorkspaceFixture {
    const panes = Array.from({ length: 4 }, (_, paneIndex) => {
        const retainedSessionIds = Array.from(
            { length: 5 },
            (_, tabIndex) => `workspace-pane-${paneIndex + 1}-session-${tabIndex + 1}`,
        );
        const activeSessionId = retainedSessionIds[0];
        if (!activeSessionId) {
            throw new Error("A performance workspace pane must have an active session.");
        }

        return {
            activeSessionId,
            id: `workspace-pane-${paneIndex + 1}`,
            retainedSessionIds,
        };
    });

    return {
        activeStreamingSessionIds: [
            panes[0]?.activeSessionId ?? "",
            panes[1]?.activeSessionId ?? "",
        ],
        id: "workspace-multipane",
        panes,
    };
}

function createMessage(index: number): AiMessage {
    const isUser = index % 2 === 0;

    return {
        attachments: [],
        content: isUser
            ? `Inspect performance fixture item ${index + 1}.`
            : [
                  `## Result ${index + 1}`,
                  "",
                  "The deterministic fixture keeps message content stable.",
                  "",
                  "```ts",
                  `export const item${index + 1} = ${index + 1};`,
                  "```",
              ].join("\n"),
        createdAt: timestampFor(index),
        id: `message-${index + 1}`,
        kind: isUser ? "user" : "assistant",
        status: "completed",
    };
}

function createToolActivity(index: number): AiToolActivity {
    const toolId = `tool-${index + 1}`;
    const path = `src/performance/file-${(index % 2_000) + 1}.ts`;
    const kind = index % 5 === 0 ? "edit" : index % 3 === 0 ? "shell" : "read";

    return {
        createdAt: timestampFor(index),
        diffs: kind === "edit" ? [createDiff(index, path)] : [],
        exitCode: kind === "shell" ? 0 : null,
        id: toolId,
        kind,
        locations: [
            {
                endLine: index + 2,
                line: index + 1,
                path,
            },
        ],
        rawInputJson: JSON.stringify({ path, tool: kind }),
        rawOutputJson: null,
        sessionId: FIXTURE_SESSION_ID,
        status: "completed",
        summary: `${kind} ${path}`,
        terminalOutput:
            kind === "shell" ? `Checked ${path}\nNo issues found.` : null,
        title: `${kind === "edit" ? "Edit" : kind === "shell" ? "Run" : "Read"} ${path}`,
        updatedAt: timestampFor(index),
    };
}

function createTrackedFile(
    index: number,
    toolCallId: string | null,
): AiTrackedFile {
    const path = `src/performance/file-${index + 1}.ts`;

    return {
        hunks: [],
        identityKey: `tracked-file-${index + 1}`,
        isText: true,
        kind: "update",
        newText: `export const result${index + 1} = true;\n`,
        oldText: `export const result${index + 1} = false;\n`,
        path,
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: FIXTURE_SESSION_ID,
        toolCallId,
        updatedAt: timestampFor(index),
    };
}

function createDiff(index: number, path: string): AiFileDiff {
    return {
        hunks: [
            {
                id: `hunk-${index + 1}`,
                lines: [
                    {
                        id: `hunk-${index + 1}-remove`,
                        text: `export const result${index + 1} = false;`,
                        type: "remove",
                    },
                    {
                        id: `hunk-${index + 1}-add`,
                        text: `export const result${index + 1} = true;`,
                        type: "add",
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
        newText: `export const result${index + 1} = true;\n`,
        oldText: `export const result${index + 1} = false;\n`,
        path,
        previousPath: null,
        reversible: true,
    };
}

function timestampFor(index: number): string {
    return new Date(FIXTURE_STARTED_AT_MS + index * 1_000).toISOString();
}
