import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot } from "@shared/ipc";

import {
    applyNormalizedSessionCatalogToSnapshot,
    applySessionCatalogToSnapshot,
    isPathInsideRoot,
    isSamePath,
    normalizeAdditionalRoots,
    resolveSessionScopedPath,
    setConfigOptionOnSnapshot,
    setManualTitleOnSnapshot,
    setRuntimeTitleOnSnapshot,
} from "./session-core";

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
                },
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
            },
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

    it("derives runtime catalog from normalized native config options", () => {
        const snapshot = createSnapshot({ sessionId: "session-native" });

        const nextSnapshot = applyNormalizedSessionCatalogToSnapshot(snapshot, {
            availableCommands: [
                {
                    description: "Create a plan",
                    id: "plan",
                    insertText: "/plan ",
                    label: "/plan",
                },
            ],
            configOptions: [
                {
                    category: "mode",
                    description: null,
                    id: "mode",
                    label: "Mode",
                    options: [
                        {
                            description: "Implementation mode",
                            groupLabel: null,
                            label: "Build",
                            value: "build",
                        },
                    ],
                    type: "select",
                    value: "build",
                },
                {
                    category: "model",
                    description: null,
                    id: "model",
                    label: "Model",
                    options: [
                        {
                            description: "Fast model",
                            groupLabel: "OpenAI",
                            label: "GPT-5",
                            value: "gpt-5",
                        },
                    ],
                    type: "select",
                    value: "gpt-5",
                },
            ],
        });

        expect(nextSnapshot.availableCommands).toHaveLength(1);
        expect(nextSnapshot.modeId).toBe("build");
        expect(nextSnapshot.modes).toEqual([
            {
                description: "Implementation mode",
                id: "build",
                name: "Build",
            },
        ]);
        expect(nextSnapshot.modelId).toBe("gpt-5");
        expect(nextSnapshot.models).toEqual([
            {
                description: "Fast model",
                id: "gpt-5",
                name: "GPT-5",
            },
        ]);
    });

    it("applies normalized native mode updates without replacing catalog options", () => {
        const snapshot = createSnapshot({
            sessionId: "session-native",
            configOptions: [
                {
                    category: "mode",
                    description: null,
                    id: "mode",
                    label: "Mode",
                    options: [
                        {
                            description: null,
                            groupLabel: null,
                            label: "Ask",
                            value: "ask",
                        },
                        {
                            description: null,
                            groupLabel: null,
                            label: "Build",
                            value: "build",
                        },
                    ],
                    type: "select",
                    value: "ask",
                },
            ],
            modeId: "ask",
            modes: [
                { description: null, id: "ask", name: "Ask" },
                { description: null, id: "build", name: "Build" },
            ],
        });

        const nextSnapshot = applyNormalizedSessionCatalogToSnapshot(snapshot, {
            modeId: "build",
        });

        const modeConfig = nextSnapshot.configOptions.find(
            (option) => option.id === "mode",
        );
        expect(nextSnapshot.modeId).toBe("build");
        expect(nextSnapshot.modes).toEqual(snapshot.modes);
        expect(modeConfig?.type === "select" && modeConfig.value).toBe("build");
    });

    it("clears the active mode when the catalog reports modeId null", () => {
        const snapshot = createSnapshot({
            sessionId: "session-native",
            modeId: "ask",
            modes: [
                { description: null, id: "ask", name: "Ask" },
                { description: null, id: "build", name: "Build" },
            ],
        });

        // `null` is an explicit "clear" signal, distinct from `undefined`
        // (leave untouched). The adapter preserves it, so it must reach here.
        const nextSnapshot = applyNormalizedSessionCatalogToSnapshot(snapshot, {
            modeId: null,
        });

        expect(nextSnapshot.modeId).toBeNull();
        expect(nextSnapshot.modes).toEqual(snapshot.modes);
    });

    it("applies stored subagent reasoning effort when normalized catalog options arrive", () => {
        const snapshot = createSnapshot({
            sessionId: "session-native",
            reasoningEffort: "high",
        });

        const nextSnapshot = applyNormalizedSessionCatalogToSnapshot(snapshot, {
            configOptions: [
                {
                    category: "other",
                    description: null,
                    id: "thought_level",
                    label: "Reasoning",
                    options: [
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
                    value: "medium",
                },
            ],
        });

        const reasoningConfig = nextSnapshot.configOptions.find(
            (option) => option.id === "thought_level",
        );
        expect(nextSnapshot.reasoningEffort).toBe("high");
        expect(reasoningConfig?.type === "select" && reasoningConfig.value).toBe(
            "high",
        );
    });

    it("preserves existing config selections when normalized catalog options refresh", () => {
        const snapshot = createSnapshot({
            configOptions: [
                {
                    category: "reasoning",
                    description: null,
                    id: "reasoning_effort",
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
                            label: "High",
                            value: "high",
                        },
                    ],
                    type: "select",
                    value: "high",
                },
            ],
            sessionId: "session-native",
        });

        const nextSnapshot = applyNormalizedSessionCatalogToSnapshot(snapshot, {
            configOptions: [
                {
                    category: "reasoning",
                    description: null,
                    id: "reasoning_effort",
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
                            label: "High",
                            value: "high",
                        },
                    ],
                    type: "select",
                    value: "low",
                },
            ],
        });

        expect(
            nextSnapshot.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("high");
    });

    it("keeps old snapshots without config options compatible", () => {
        const snapshot = createSnapshot({
            modelId: "gpt-5-mini",
            sessionId: "session-native",
        });

        const nextSnapshot = applyNormalizedSessionCatalogToSnapshot(snapshot, {
            availableCommands: [
                {
                    description: "Create a plan",
                    id: "plan",
                    insertText: "/plan ",
                    label: "/plan",
                },
            ],
        });

        expect(nextSnapshot.configOptions).toEqual([]);
        expect(nextSnapshot.modelId).toBe("gpt-5-mini");
        expect(nextSnapshot.reasoningEffort).toBeUndefined();
    });

    it("keeps a snapshot modelId when refreshed options omit the model config", () => {
        const snapshot = createSnapshot({
            modelId: "gpt-5-mini",
            sessionId: "session-native",
        });

        const nextSnapshot = applyNormalizedSessionCatalogToSnapshot(snapshot, {
            configOptions: [
                {
                    category: "reasoning",
                    description: null,
                    id: "reasoning_effort",
                    label: "Reasoning",
                    options: [
                        {
                            description: null,
                            groupLabel: null,
                            label: "Low",
                            value: "low",
                        },
                    ],
                    type: "select",
                    value: "low",
                },
            ],
        });

        expect(nextSnapshot.modelId).toBe("gpt-5-mini");
        expect(nextSnapshot.models).toEqual([]);
    });

    it("does not invent reasoning effort when null or absent", () => {
        const snapshot = createSnapshot({
            reasoningEffort: null,
            sessionId: "session-native",
        });

        const nextSnapshot = applyNormalizedSessionCatalogToSnapshot(snapshot, {
            configOptions: [
                {
                    category: "reasoning",
                    description: null,
                    id: "reasoning_effort",
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
                            label: "High",
                            value: "high",
                        },
                    ],
                    type: "select",
                    value: "low",
                },
            ],
        });

        const reasoningConfig = nextSnapshot.configOptions.find(
            (option) => option.id === "reasoning_effort",
        );
        expect(nextSnapshot.reasoningEffort).toBeNull();
        expect(reasoningConfig?.type === "select" && reasoningConfig.value).toBe(
            "low",
        );
    });

    it("does not apply stored reasoning effort to models without a matching effort value", () => {
        const snapshot = createSnapshot({
            reasoningEffort: "high",
            sessionId: "session-native",
        });

        const nextSnapshot = applyNormalizedSessionCatalogToSnapshot(snapshot, {
            configOptions: [
                {
                    category: "reasoning",
                    description: null,
                    id: "reasoning_effort",
                    label: "Reasoning",
                    options: [
                        {
                            description: null,
                            groupLabel: null,
                            label: "Low",
                            value: "low",
                        },
                    ],
                    type: "select",
                    value: "low",
                },
            ],
        });

        const reasoningConfig = nextSnapshot.configOptions.find(
            (option) => option.id === "reasoning_effort",
        );
        expect(nextSnapshot.reasoningEffort).toBe("high");
        expect(reasoningConfig?.type === "select" && reasoningConfig.value).toBe(
            "low",
        );
    });

    it("updates reasoningEffort when the reasoning config option changes", () => {
        const snapshot = createSnapshot({
            configOptions: [
                {
                    category: "reasoning",
                    description: null,
                    id: "reasoning_effort",
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
                            label: "High",
                            value: "high",
                        },
                    ],
                    type: "select",
                    value: "high",
                },
            ],
            reasoningEffort: "high",
            sessionId: "session-native",
        });

        const nextSnapshot = setConfigOptionOnSnapshot(
            snapshot,
            "reasoning_effort",
            "low",
        );

        expect(nextSnapshot.reasoningEffort).toBe("low");
    });

    it("keeps valid reasoning effort when model refreshes regenerate options", () => {
        const snapshot = createSnapshot({
            configOptions: [
                {
                    category: "model",
                    description: null,
                    id: "model",
                    label: "Model",
                    options: [
                        {
                            description: null,
                            groupLabel: null,
                            label: "GPT-5 Mini",
                            value: "gpt-5-mini",
                        },
                    ],
                    type: "select",
                    value: "gpt-5-mini",
                },
                {
                    category: "reasoning",
                    description: null,
                    id: "reasoning_effort",
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
                            label: "High",
                            value: "high",
                        },
                    ],
                    type: "select",
                    value: "high",
                },
            ],
            modelId: "gpt-5-mini",
            reasoningEffort: "high",
            sessionId: "session-native",
        });

        const nextSnapshot = applyNormalizedSessionCatalogToSnapshot(snapshot, {
            configOptions: [
                {
                    category: "model",
                    description: null,
                    id: "model",
                    label: "Model",
                    options: [
                        {
                            description: null,
                            groupLabel: null,
                            label: "GPT-5 Mini",
                            value: "gpt-5-mini",
                        },
                        {
                            description: null,
                            groupLabel: null,
                            label: "GPT-5 Pro",
                            value: "gpt-5-pro",
                        },
                    ],
                    type: "select",
                    value: "gpt-5-pro",
                },
                {
                    category: "reasoning",
                    description: null,
                    id: "reasoning_effort",
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
                            label: "High",
                            value: "high",
                        },
                    ],
                    type: "select",
                    value: "low",
                },
            ],
        });

        const reasoningConfig = nextSnapshot.configOptions.find(
            (option) => option.id === "reasoning_effort",
        );
        expect(nextSnapshot.reasoningEffort).toBe("high");
        expect(reasoningConfig?.type === "select" && reasoningConfig.value).toBe(
            "high",
        );
    });

    it("keeps manual titles when runtime titles arrive later", () => {
        const snapshot = createSnapshot({
            sessionId: "session-claude",
            title: "Initial runtime title",
        });

        const renamed = setManualTitleOnSnapshot(
            snapshot,
            "Manual title",
            "2026-04-23T00:01:00.000Z",
        );
        const updated = setRuntimeTitleOnSnapshot(
            renamed,
            "Late Claude title",
            "2026-04-23T00:02:00.000Z",
        );

        expect(updated).toMatchObject({
            manualTitle: "Manual title",
            title: "Manual title",
            updatedAt: "2026-04-23T00:02:00.000Z",
        });
    });

    it("applies runtime titles when the session was not manually renamed", () => {
        const snapshot = createSnapshot({
            sessionId: "session-claude",
            title: "Initial runtime title",
        });

        const updated = setRuntimeTitleOnSnapshot(
            snapshot,
            "Late Claude title",
            "2026-04-23T00:02:00.000Z",
        );

        expect(updated).toMatchObject({
            title: "Late Claude title",
            updatedAt: "2026-04-23T00:02:00.000Z",
        });
        expect(updated.manualTitle).toBeUndefined();
    });
});

describe("session-core path scope identity", () => {
    it("treats Windows drive-letter casing as the same project scope", () => {
        expect(
            isPathInsideRoot("c:\\repo\\src\\file.ts", "C:\\Repo", {
                platform: "win32",
            }),
        ).toBe(true);
        expect(
            isSamePath("c:\\repo", "C:\\Repo", { platform: "win32" }),
        ).toBe(true);
    });

    it("normalizes equivalent Windows absolute paths to display relatives", () => {
        expect(
            resolveSessionScopedPath("C:\\Repo", "c:\\repo\\src\\File.ts", {
                platform: "win32",
            }),
        ).toMatchObject({
            absolutePath: "c:\\repo\\src\\File.ts",
            insideRoot: true,
            isAbsoluteInput: true,
            relativePath: "src/File.ts",
        });
    });

    it("keeps Windows sibling paths outside the project scope", () => {
        expect(
            resolveSessionScopedPath(
                "C:\\Repo",
                "c:\\repo-other\\src\\File.ts",
                { platform: "win32" },
            ),
        ).toMatchObject({
            insideRoot: false,
            isAbsoluteInput: true,
            relativePath: null,
        });
    });

    it("deduplicates additional roots with Windows casing differences", () => {
        expect(
            normalizeAdditionalRoots([
                "C:\\Repo\\Shared",
                "c:\\repo\\shared",
                "C:\\Repo\\Other",
            ], { platform: "win32" }),
        ).toEqual(["C:\\Repo\\Other", "C:\\Repo\\Shared"]);
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
