import { describe, expect, it, vi } from "vitest";

import type {
    AiSessionDomainEvent,
    AiSessionToolActivityEvent,
    AiToolActivity,
} from "@shared/ipc";
import { createTerminalStreamPressureFixture } from "@shared/testing/chatLoadFactories";

import {
    AiSessionEventFrameBuffer,
    isFrameBufferableAiSessionEvent,
} from "./aiSessionEventFrameBuffer";

describe("AiSessionEventFrameBuffer", () => {
    it("reduces thousands of live tool updates to one frame application", () => {
        const scheduled: Array<() => void> = [];
        const applied: AiSessionDomainEvent[] = [];
        const fixture = createTerminalStreamPressureFixture({
            chunkBytes: 4,
            chunkCount: 10_000,
            durationMs: 100,
            runtimeId: "codex",
        });
        const buffer = new AiSessionEventFrameBuffer({
            apply: (event) => applied.push(event),
            schedule: (flush) => {
                scheduled.push(flush);
                return () => undefined;
            },
        });

        for (const event of fixture.events.slice(0, -1)) buffer.buffer(event);
        expect(scheduled).toHaveLength(1);
        scheduled[0]?.();

        expect(applied).toHaveLength(1);
        expect(applied[0]).toMatchObject({
            activity: {
                terminalOutput:
                    fixture.events.at(-2)?.activity.terminalOutput ?? null,
            },
            kind: "tool-activity",
        });
    });

    it("keeps first slot order and rich activity fields", () => {
        const applied: AiSessionDomainEvent[] = [];
        const buffer = new AiSessionEventFrameBuffer({
            apply: (event) => applied.push(event),
            schedule: () => () => undefined,
        });
        const first = toolEvent("tool-a", {
            diffs: [
                {
                    hunks: [],
                    isText: true,
                    kind: "update",
                    newText: "after",
                    oldText: "before",
                    path: "src/a.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
            rawInputJson: "rich-input",
            terminalOutput: "first",
        });
        buffer.buffer(first);
        buffer.buffer(toolEvent("tool-b"));
        buffer.buffer(
            toolEvent("tool-a", {
                summary: "Latest",
                terminalOutput: null,
                updatedAt: "2026-01-01T00:00:02.000Z",
            }),
        );
        buffer.flushSession("session-1");

        expect(
            applied.map((event) =>
                event.kind === "tool-activity" ? event.activity.id : event.kind,
            ),
        ).toEqual(["tool-a", "tool-b"]);
        expect(applied[0]).toMatchObject({
            activity: {
                diffs: first.activity.diffs,
                rawInputJson: "rich-input",
                summary: "Latest",
                terminalOutput: "first",
            },
        });
    });

    it("does not buffer terminal tool states", () => {
        expect(isFrameBufferableAiSessionEvent(toolEvent("tool-a"))).toBe(true);
        expect(
            isFrameBufferableAiSessionEvent(
                toolEvent("tool-a", { status: "completed" }),
            ),
        ).toBe(false);
        expect(
            isFrameBufferableAiSessionEvent(
                toolEvent("tool-a", { status: "failed" }),
            ),
        ).toBe(false);
    });

    it("cancels scheduled work and drops retained sessions on reset", () => {
        const cancel = vi.fn();
        const applied: AiSessionDomainEvent[] = [];
        const buffer = new AiSessionEventFrameBuffer({
            apply: (event) => applied.push(event),
            schedule: () => cancel,
        });
        buffer.buffer(toolEvent("tool-a"));

        buffer.reset();
        buffer.flushSession("session-1");

        expect(cancel).toHaveBeenCalledOnce();
        expect(applied).toHaveLength(0);
    });
});

function toolEvent(
    id: string,
    overrides: Partial<AiToolActivity> = {},
): AiSessionToolActivityEvent {
    const updatedAt = overrides.updatedAt ?? "2026-01-01T00:00:01.000Z";
    return {
        activity: {
            createdAt: "2026-01-01T00:00:00.000Z",
            diffs: [],
            exitCode: null,
            id,
            kind: "shell",
            locations: [],
            rawInputJson: null,
            rawOutputJson: null,
            sessionId: "session-1",
            status: "in_progress",
            summary: null,
            terminalOutput: null,
            title: "Run command",
            updatedAt,
            ...overrides,
        },
        kind: "tool-activity",
        origin: "live",
        parentSessionId: null,
        runtimeId: "codex",
        runtimeSessionId: "runtime-session-1",
        sessionId: "session-1",
        updatedAt,
    };
}
