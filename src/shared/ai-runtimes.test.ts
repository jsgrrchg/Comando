import { describe, expect, it, vi } from "vitest";

import {
    buildAiRuntimeCatalog,
    createCustomAcpRuntimeId,
    getAiRuntimeDisplayName,
    isBuiltInAiRuntimeId,
    isCustomAcpRuntimeId,
    isKnownAiRuntimeId,
} from "./ai-runtimes";

describe("AI runtime identity", () => {
    it("accepts built-ins and reserved custom UUID IDs", () => {
        const customId = "custom:550e8400-e29b-41d4-a716-446655440000";

        expect(isBuiltInAiRuntimeId("codex")).toBe(true);
        expect(isCustomAcpRuntimeId(customId)).toBe(true);
        expect(isKnownAiRuntimeId(customId)).toBe(true);
    });

    it.each([
        "",
        "custom:",
        "custom:codex",
        "custom:550e8400-e29b-11d4-1716-446655440000",
        "other:550e8400-e29b-41d4-a716-446655440000",
    ])("rejects malformed or unreserved ID %j", (runtimeId) => {
        expect(isKnownAiRuntimeId(runtimeId)).toBe(false);
    });

    it("generates IDs without accepting renderer input", () => {
        const randomUUID = vi
            .spyOn(globalThis.crypto, "randomUUID")
            .mockReturnValue("550e8400-e29b-41d4-a716-446655440000");

        expect(createCustomAcpRuntimeId()).toBe(
            "custom:550e8400-e29b-41d4-a716-446655440000",
        );
        randomUUID.mockRestore();
    });
});

describe("AI runtime catalog", () => {
    it("combines built-ins and valid custom descriptors conservatively", () => {
        const id = "custom:550e8400-e29b-41d4-a716-446655440000";
        const catalog = buildAiRuntimeCatalog([
            { displayName: "  Pi development  ", id },
        ]);
        const custom = catalog.find((runtime) => runtime.id === id);

        expect(catalog.slice(0, 5).map((runtime) => runtime.id)).toEqual([
            "codex",
            "claude",
            "grok",
            "kilo",
            "opencode",
        ]);
        expect(custom).toMatchObject({
            available: true,
            displayName: "Pi development",
            kind: "custom-acp",
        });
        expect(custom?.capabilities).toEqual({
            internalAuthentication: false,
            proprietaryActions: false,
            subagents: false,
        });
        expect(getAiRuntimeDisplayName(id, catalog)).toBe("Pi development");
    });

    it("does not leak a custom runtime into built-in-only behavior", () => {
        const id = "custom:550e8400-e29b-41d4-a716-446655440000";
        const catalog = buildAiRuntimeCatalog([{ displayName: "Pi", id }]);
        const custom = catalog.find((runtime) => runtime.id === id);

        expect(isBuiltInAiRuntimeId(custom?.id)).toBe(false);
        expect(custom?.capabilities.internalAuthentication).toBe(false);
        expect(custom?.capabilities.proprietaryActions).toBe(false);
    });
});
