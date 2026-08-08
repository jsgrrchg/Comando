import { describe, expect, it } from "vitest";

import {
    createChatLoadFixture,
    createTerminalStreamPressureFixture,
} from "./chatLoadFactories";
import {
    createChatLoadDiagnosticSummary,
    normalizeChatLoadScenario,
    stringifyChatLoadDiagnostic,
    type ChatLoadScenario,
} from "./chatLoadScenario";

const scenario: ChatLoadScenario = {
    activeTools: 12,
    aggregateDiffBytes: 8_192,
    deltaBytes: 32,
    diffCount: 7,
    historyMessages: 20,
    seed: 42,
    sessionCount: 3,
    streamingDeltas: 9,
    terminalOutputBytes: 1_024,
};

describe("chatLoadScenario", () => {
    it("generates identical transcripts from the same seed", () => {
        expect(createChatLoadFixture(scenario)).toEqual(
            createChatLoadFixture(scenario),
        );
    });

    it("distributes configured totals without multiplying them by session count", () => {
        const fixture = createChatLoadFixture(scenario);
        const messages = fixture.sessions.flatMap((session) => session.messages);
        const tools = fixture.sessions.flatMap(
            (session) => session.toolActivity,
        );
        const deltas = fixture.sessions.flatMap(
            (session) => session.streamingDeltas,
        );
        const diffs = tools.flatMap((tool) => tool.diffs);

        expect(fixture.sessions).toHaveLength(3);
        expect(messages).toHaveLength(scenario.historyMessages);
        expect(tools).toHaveLength(scenario.activeTools);
        expect(deltas).toHaveLength(scenario.streamingDeltas);
        expect(diffs).toHaveLength(scenario.diffCount);
        expect(
            diffs.reduce(
                (total, diff) => total + (diff.newText?.length ?? 0),
                0,
            ),
        ).toBe(scenario.aggregateDiffBytes);
        expect(
            tools.reduce(
                (total, tool) =>
                    total + (tool.terminalOutput?.length ?? 0),
                0,
            ),
        ).toBe(scenario.terminalOutputBytes);
        expect(deltas.every((delta) => delta.length === scenario.deltaBytes)).toBe(
            true,
        );
    });

    it("changes generated payloads when the seed changes", () => {
        const first = createChatLoadFixture(scenario);
        const second = createChatLoadFixture({ ...scenario, seed: 43 });

        expect(first.sessions[0]?.messages[0]?.content).not.toBe(
            second.sessions[0]?.messages[0]?.content,
        );
    });

    it("produces a bounded numeric diagnostic without generated content", () => {
        const fixture = createChatLoadFixture(scenario);
        const diagnostic = stringifyChatLoadDiagnostic(scenario);

        expect(createChatLoadDiagnosticSummary(scenario).generated).toEqual({
            aggregateDiffBytes: 8_192,
            historyMessages: 20,
            sessions: 3,
            streamingBytes: 288,
            streamingDeltas: 9,
            terminalOutputBytes: 1_024,
            tools: 12,
        });
        expect(createChatLoadDiagnosticSummary(scenario).contractVersion).toBe(1);
        expect(diagnostic).not.toContain(
            fixture.sessions[0]?.messages[0]?.content ?? "",
        );
        expect(diagnostic).not.toContain("src/generated");
    });

    it("normalizes invalid values before allocating fixtures", () => {
        expect(
            normalizeChatLoadScenario({
                ...scenario,
                activeTools: -1,
                historyMessages: Number.NaN,
                seed: -1,
                sessionCount: 0,
                streamingDeltas: 1.9,
            }),
        ).toMatchObject({
            activeTools: 0,
            historyMessages: 0,
            seed: 4_294_967_295,
            sessionCount: 1,
            streamingDeltas: 1,
        });
    });

    it("generates the documented tool mix with failures and subagents", () => {
        const tools = createChatLoadFixture({
            ...scenario,
            activeTools: 100,
            aggregateDiffBytes: 45_000,
            diffCount: 45,
            terminalOutputBytes: 1_000,
        }).sessions.flatMap((session) => session.toolActivity);

        const readOrSearchTools = tools.filter(
            (tool) =>
                tool.kind === "read" ||
                tool.kind === "search" ||
                tool.kind === "fetch",
        );
        const completedShellTools = tools.filter(
            (tool) => tool.kind === "shell" && tool.status === "completed",
        );
        const editTools = tools.filter((tool) => tool.kind === "edit");
        const failedTools = tools.filter((tool) => tool.status === "failed");
        const subagents = tools.filter(
            (tool) => tool.kind === "subagent" && tool.status === "in_progress",
        );

        expect(readOrSearchTools).toHaveLength(55);
        expect(completedShellTools).toHaveLength(15);
        expect(editTools).toHaveLength(25);
        expect(editTools.filter((tool) => tool.diffs.length >= 2).length).toBeGreaterThanOrEqual(
            10,
        );
        expect(failedTools).toHaveLength(3);
        expect(subagents).toHaveLength(2);
        expect(
            tools
                .filter((tool) => tool.diffs.length > 0)
                .every((tool) => tool.kind === "edit"),
        ).toBe(true);
    });

    it("generates a provider-independent terminal pressure stream", () => {
        for (const runtimeId of ["codex", "claude", "custom:fixture"] as const) {
            const fixture = createTerminalStreamPressureFixture({
                chunkBytes: 7,
                chunkCount: 10_000,
                durationMs: 10_000,
                runtimeId,
            });

            expect(fixture.chunks).toHaveLength(10_000);
            expect(fixture.events).toHaveLength(10_002);
            expect(fixture.events[0]?.activity.status).toBe("in_progress");
            expect(fixture.events.at(-1)?.activity).toMatchObject({
                exitCode: 0,
                status: "completed",
                terminalOutput: fixture.expectedFinalOutput,
            });
            expect(fixture.expectedFinalOutput).toHaveLength(10_000);
            expect(fixture.diagnostic).toEqual({
                chunkBytes: 7,
                chunkCount: 10_000,
                durationMs: 10_000,
                eventCount: 10_002,
                finalOutputBytes: 10_000,
            });
        }
    });

    it("keeps terminal pressure diagnostics numeric and content-free", () => {
        const fixture = createTerminalStreamPressureFixture({
            chunkBytes: 32,
            chunkCount: 8,
            durationMs: 250,
            runtimeId: "opencode",
        });
        const diagnostic = JSON.stringify(fixture.diagnostic);

        expect(Object.values(fixture.diagnostic).every(Number.isFinite)).toBe(true);
        expect(diagnostic).not.toContain(fixture.chunks[0] ?? "fixture-content");
        expect(diagnostic).not.toContain("terminal-pressure-session");
        expect(diagnostic).not.toContain("Run command");
    });
});
