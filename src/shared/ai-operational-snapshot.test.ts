import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot } from "./ipc";

import { toAiSessionOperationalSnapshot } from "./ai-operational-snapshot";

describe("AiSessionOperationalSnapshot", () => {
    it("does not grow with sealed transcript arrays", () => {
        const snapshot = {
            activeTurnStartedAt: null,
            availableCommands: [],
            configOptions: [],
            lastError: null,
            messages: Array.from({ length: 1_000 }, () => ({ content: "sealed" })),
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
            sessionId: "session-1",
            status: "idle",
            title: "Fixture",
            tokenUsage: null,
            toolActivity: Array.from({ length: 1_000 }, () => ({ title: "tool" })),
            trackedFiles: [],
            updatedAt: "2026-01-01T00:00:00.000Z",
        } as unknown as AiSessionSnapshot;
        const operational = toAiSessionOperationalSnapshot(snapshot, {
            blockMetadata: [],
            capabilityVersion: 1,
            liveTail: [],
        });

        expect("messages" in operational).toBe(false);
        expect("toolActivity" in operational).toBe(false);
        expect(JSON.stringify(operational).length).toBeLessThan(10_000);
    });
});
