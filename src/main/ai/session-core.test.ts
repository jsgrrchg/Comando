import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot } from "@shared/ipc";

import { applySessionCatalogToSnapshot } from "./session-core";

describe("session-core model reconciliation", () => {
    it("merges runtime models into stale model config options", () => {
        const snapshot = createSnapshot({ sessionId: "session-codex" });

        const nextSnapshot = applySessionCatalogToSnapshot(snapshot, {
            configOptions: [
                {
                    category: "model",
                    currentValue: "gpt-5.4",
                    description: "Choose which model Codex should use",
                    name: "Model",
                    id: "model",
                    options: [
                        {
                            description: "Strong model for everyday coding.",
                            name: "gpt-5.4",
                            value: "gpt-5.4",
                        },
                    ],
                    type: "select",
                } as any,
            ],
            models: {
                availableModels: [
                    {
                        description: null,
                        modelId: "gpt-5.5",
                        name: "gpt-5.5",
                    },
                    {
                        description: "Strong model for everyday coding.",
                        modelId: "gpt-5.4",
                        name: "gpt-5.4",
                    },
                ],
                currentModelId: "gpt-5.5",
            } as any,
            modes: null,
        });

        const modelConfig = nextSnapshot.configOptions.find(
            (option) => option.id === "model",
        );

        expect(nextSnapshot.modelId).toBe("gpt-5.5");
        expect(
            nextSnapshot.models.some((model) => model.id === "gpt-5.5"),
        ).toBe(true);
        expect(modelConfig?.type).toBe("select");
        expect(modelConfig?.type === "select" && modelConfig.value).toBe(
            "gpt-5.5",
        );
        expect(
            modelConfig?.type === "select" &&
                modelConfig.options.some(
                    (option) => option.value === "gpt-5.5",
                ),
        ).toBe(true);
    });
});

function createSnapshot(
    overrides: Partial<AiSessionSnapshot> & { readonly sessionId: string },
): AiSessionSnapshot {
    const { sessionId, ...rest } = overrides;
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
        projectId: null,
        runtimeId: "codex",
        runtimeSessionId: "runtime-session-1",
        sessionId,
        status: "idle",
        title: "Session",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-23T00:00:00.000Z",
        worktreeId: null,
        ...rest,
    };
}
