import type {
    AiFileDiff,
    AiMessage,
    AiToolActivity,
} from "../ipc";

import {
    createSeededChatLoadRandom,
    normalizeChatLoadScenario,
    type ChatLoadScenario,
    type NormalizedChatLoadScenario,
    type SeededChatLoadRandom,
} from "./chatLoadScenario";

export interface ChatLoadSessionFixture {
    readonly messages: readonly AiMessage[];
    readonly sessionId: string;
    readonly streamingDeltas: readonly string[];
    readonly toolActivity: readonly AiToolActivity[];
}

export interface ChatLoadFixture {
    readonly scenario: NormalizedChatLoadScenario;
    readonly sessions: readonly ChatLoadSessionFixture[];
}

const FIXTURE_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function createChatLoadFixture(
    input: ChatLoadScenario,
): ChatLoadFixture {
    const scenario = normalizeChatLoadScenario(input);
    const random = createSeededChatLoadRandom(scenario.seed);
    const sessions = Array.from(
        { length: scenario.sessionCount },
        (_, sessionIndex): MutableChatLoadSessionFixture => ({
            messages: [],
            sessionId: `load-session-${sessionIndex + 1}`,
            streamingDeltas: [],
            toolActivity: [],
        }),
    );

    for (let index = 0; index < scenario.historyMessages; index += 1) {
        const session = sessions[index % sessions.length];
        session?.messages.push(createMessage(random, session.sessionId, index));
    }

    const categories = Array.from(
        { length: scenario.activeTools },
        (_, index) => categoryForTool(index, scenario.activeTools),
    );
    const diffsByToolIndex = distributeDiffs(
        random,
        categories,
        scenario.diffCount,
        scenario.aggregateDiffBytes,
    );
    const terminalBytesByToolIndex = distributeTerminalBytes(
        scenario.terminalOutputBytes,
        categories,
    );
    for (let index = 0; index < scenario.activeTools; index += 1) {
        const session = sessions[index % sessions.length];
        session?.toolActivity.push(
            createToolActivity(
                random,
                session.sessionId,
                index,
                categories[index] ?? "read-search",
                diffsByToolIndex[index] ?? [],
                terminalBytesByToolIndex[index] ?? 0,
            ),
        );
    }

    for (let index = 0; index < scenario.streamingDeltas; index += 1) {
        const session = sessions[index % sessions.length];
        session?.streamingDeltas.push(
            createSizedText(random, scenario.deltaBytes),
        );
    }

    return {
        scenario,
        sessions,
    };
}

interface MutableChatLoadSessionFixture {
    readonly messages: AiMessage[];
    readonly sessionId: string;
    readonly streamingDeltas: string[];
    readonly toolActivity: AiToolActivity[];
}

interface DiffDefinition {
    readonly byteLength: number;
    readonly index: number;
}

type SyntheticToolCategory =
    | "read-search"
    | "terminal"
    | "single-file-edit"
    | "multi-file-edit"
    | "failed"
    | "subagent";

function createMessage(
    random: SeededChatLoadRandom,
    sessionId: string,
    index: number,
): AiMessage {
    const kind = index % 2 === 0 ? "user" : "assistant";
    const token = createSizedText(random, 24);
    return {
        attachments: [],
        content:
            kind === "user"
                ? `Inspect synthetic load item ${index + 1}: ${token}`
                : [
                      `## Synthetic result ${index + 1}`,
                      "",
                      `Deterministic payload ${token}.`,
                      "",
                      "```ts",
                      `export const fixture${index + 1} = true;`,
                      "```",
                  ].join("\n"),
        createdAt: timestampFor(index),
        id: `${sessionId}-message-${index + 1}`,
        kind,
        status: "completed",
    };
}

function createToolActivity(
    random: SeededChatLoadRandom,
    sessionId: string,
    index: number,
    category: SyntheticToolCategory,
    diffDefinitions: readonly DiffDefinition[],
    terminalOutputBytes: number,
): AiToolActivity {
    const path = `src/generated/session-${sessionId.slice(-1)}/file-${index + 1}.ts`;
    const kind = resolveToolKind(index, category);
    const terminalOutput =
        terminalOutputBytes > 0
            ? createSizedText(random, terminalOutputBytes)
            : null;
    const diffs = diffDefinitions.map((definition) =>
        createDiff(random, path, definition),
    );
    const additions = diffs.reduce(
        (total, diff) =>
            total +
            diff.hunks.reduce((lines, hunk) => lines + hunk.newCount, 0),
        0,
    );
    const deletions = diffs.reduce(
        (total, diff) =>
            total +
            diff.hunks.reduce((lines, hunk) => lines + hunk.oldCount, 0),
        0,
    );

    return {
        action:
            category === "subagent"
                ? {
                      kind: "open_session",
                      sessionId: `${sessionId}-subagent-${index + 1}`,
                  }
                : null,
        changeStats:
            diffs.length > 0
                ? {
                      additions,
                      approximate: false,
                      deletions,
                      fileCount: diffs.length,
                  }
                : null,
        createdAt: timestampFor(index),
        diffs,
        exitCode: kind === "shell" ? (category === "failed" ? 1 : 0) : null,
        id: `${sessionId}-tool-${index + 1}`,
        kind,
        locations: [{ endLine: 2, line: 1, path }],
        rawInputJson: JSON.stringify({ operation: kind, path }),
        rawOutputJson: createToolOutput(random, kind, category),
        sessionId,
        status: toolStatus(category),
        summary: toolSummary(kind, category),
        terminalOutput,
        title: `${toolTitle(kind)} ${path}`,
        updatedAt: timestampFor(index + 1),
    };
}

function createDiff(
    random: SeededChatLoadRandom,
    basePath: string,
    definition: DiffDefinition,
): AiFileDiff {
    const path = basePath.replace(
        /\.ts$/,
        `-diff-${definition.index + 1}.ts`,
    );
    const newText = createSizedText(random, definition.byteLength);
    return {
        hunks: [
            {
                id: `hunk-${definition.index + 1}`,
                lines: [
                    {
                        id: `line-${definition.index + 1}`,
                        text: newText,
                        type: "add",
                    },
                ],
                newCount: 1,
                newStart: 1,
                oldCount: 0,
                oldStart: 1,
            },
        ],
        isText: true,
        kind: "update",
        newText,
        oldText: "",
        path,
        previousPath: null,
        reversible: true,
    };
}

function distributeDiffs(
    random: SeededChatLoadRandom,
    categories: readonly SyntheticToolCategory[],
    diffCount: number,
    aggregateBytes: number,
): readonly (readonly DiffDefinition[])[] {
    if (categories.length === 0) {
        return [];
    }
    const bytesByDiff = distributeBytes(aggregateBytes, diffCount);
    const output = Array.from(
        { length: categories.length },
        (): DiffDefinition[] => [],
    );
    const editableToolIndexes = categories.flatMap((category, index) => {
        if (category === "single-file-edit") return [index];
        // Multi-file edits receive two definitions before later diffs are spread.
        if (category === "multi-file-edit") return [index, index];
        return [];
    });
    const targets =
        editableToolIndexes.length > 0
            ? editableToolIndexes
            : categories.map((_, index) => index);
    const offset = random.nextInt(targets.length);
    for (let index = 0; index < diffCount; index += 1) {
        const toolIndex = targets[(index + offset) % targets.length];
        if (toolIndex === undefined) continue;
        output[toolIndex]?.push({
            byteLength: bytesByDiff[index] ?? 0,
            index,
        });
    }
    return output;
}

function distributeBytes(totalBytes: number, itemCount: number): number[] {
    if (itemCount <= 0) {
        return [];
    }
    const base = Math.floor(totalBytes / itemCount);
    const remainder = totalBytes % itemCount;
    return Array.from(
        { length: itemCount },
        (_, index) => base + (index < remainder ? 1 : 0),
    );
}

function distributeTerminalBytes(
    totalBytes: number,
    categories: readonly SyntheticToolCategory[],
): number[] {
    const output = Array.from({ length: categories.length }, () => 0);
    const terminalToolIndexes = categories.flatMap((category, index) =>
        category === "terminal" || category === "failed" ? [index] : [],
    );
    const targets =
        terminalToolIndexes.length > 0
            ? terminalToolIndexes
            : output.map((_, index) => index);
    const bytesByTarget = distributeBytes(totalBytes, targets.length);
    targets.forEach((toolIndex, index) => {
        output[toolIndex] = bytesByTarget[index] ?? 0;
    });
    return output;
}

function createSizedText(
    random: SeededChatLoadRandom,
    byteLength: number,
): string {
    if (byteLength === 0) {
        return "";
    }
    const patternLength = Math.min(256, byteLength);
    const pattern = Array.from(
        { length: patternLength },
        () => ALPHABET[random.nextInt(ALPHABET.length)] ?? "x",
    ).join("");
    return pattern
        .repeat(Math.ceil(byteLength / patternLength))
        .slice(0, byteLength);
}

function categoryForTool(
    index: number,
    total: number,
): SyntheticToolCategory {
    // Floor boundaries keep the target mix exact for the common 100-tool case.
    const position = Math.floor((index * 100) / Math.max(1, total));
    if (position < 55) return "read-search";
    if (position < 70) return "terminal";
    if (position < 85) return "single-file-edit";
    if (position < 95) return "multi-file-edit";
    if (position < 98) return "failed";
    return "subagent";
}

function resolveToolKind(index: number, category: SyntheticToolCategory): string {
    if (category === "single-file-edit" || category === "multi-file-edit") {
        return "edit";
    }
    if (category === "terminal" || category === "failed") return "shell";
    if (category === "subagent") return "subagent";
    const bucket = index % 20;
    if (bucket < 11) return "read";
    if (bucket < 14) return "search";
    return "fetch";
}

function toolTitle(kind: string): string {
    if (kind === "edit") return "Edit";
    if (kind === "shell") return "Run";
    if (kind === "search") return "Search";
    if (kind === "fetch") return "Fetch";
    if (kind === "subagent") return "Delegate";
    return "Read";
}

function toolStatus(
    category: SyntheticToolCategory,
): AiToolActivity["status"] {
    if (category === "failed") return "failed";
    if (category === "subagent") return "in_progress";
    return "completed";
}

function toolSummary(kind: string, category: SyntheticToolCategory): string {
    if (category === "failed") return `${kind} failed with a synthetic diagnostic`;
    if (category === "subagent") return "Subagent is working";
    return `${kind} completed`;
}

function createToolOutput(
    random: SeededChatLoadRandom,
    kind: string,
    category: SyntheticToolCategory,
): string | null {
    if (category === "failed") {
        return JSON.stringify({ error: "Synthetic command failure", retryable: true });
    }
    if (category === "subagent") {
        return JSON.stringify({ state: "running", progress: random.nextInt(100) });
    }
    if (kind === "search") {
        return JSON.stringify({ matches: random.nextInt(20) });
    }
    return null;
}

function timestampFor(index: number): string {
    return new Date(FIXTURE_EPOCH_MS + index * 1_000).toISOString();
}
