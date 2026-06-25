import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot } from "@shared/ipc";

import {
    applyNormalizedSessionCatalogToSnapshot,
    applySessionCatalogToSnapshot,
    isPathInsideRoot,
    isSamePath,
    normalizeAdditionalRoots,
    resolveSessionScopedPath,
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
