import { describe, expect, it } from "vitest";

import {
    calculateCustomAcpLaunchFingerprint,
    createCustomAcpRuntimeDefinition,
    normalizeCustomAcpRuntimesSettings,
    updateCustomAcpRuntimeDefinition,
    validateCustomAcpRuntimeInput,
} from "./custom-acp-runtimes";

const INPUT = {
    args: [] as const,
    authMode: "external" as const,
    command: "/opt/homebrew/bin/pi-acp",
    displayName: "Pi",
    env: {},
};

describe("custom ACP runtime definitions", () => {
    it("creates Main-owned IDs, revisions and fingerprints", () => {
        const definition = createCustomAcpRuntimeDefinition(
            INPUT,
            [],
            () => "550e8400-e29b-41d4-a716-446655440000",
        );

        expect(definition).toMatchObject({
            id: "custom:550e8400-e29b-41d4-a716-446655440000",
            revision: 1,
        });
        expect(definition.launchFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it("keeps the fingerprint stable for display-only changes", () => {
        const current = createCustomAcpRuntimeDefinition(
            INPUT,
            [],
            () => "550e8400-e29b-41d4-a716-446655440000",
        );
        const updated = updateCustomAcpRuntimeDefinition(
            current,
            { ...INPUT, displayName: "Pi renamed" },
            [current],
        );

        expect(updated.revision).toBe(2);
        expect(updated.launchFingerprint).toBe(current.launchFingerprint);
    });

    it("changes the fingerprint when launch semantics change", () => {
        const base = calculateCustomAcpLaunchFingerprint(INPUT);
        const changed = calculateCustomAcpLaunchFingerprint({
            ...INPUT,
            args: ["--profile", "development"],
        });

        expect(changed).not.toBe(base);
    });

    it("rejects duplicate names case-insensitively", () => {
        const current = createCustomAcpRuntimeDefinition(
            INPUT,
            [],
            () => "550e8400-e29b-41d4-a716-446655440000",
        );

        expect(() =>
            validateCustomAcpRuntimeInput(
                { ...INPUT, displayName: "pi" },
                { existingDefinitions: [current] },
            ),
        ).toThrow(/already exists/);
    });

    it.each(["OPENAI_API_KEY", "AUTH_TOKEN", "MY_PASSWORD", "CLIENT_SECRET"])(
        "rejects secret-looking environment key %s",
        (key) => {
            expect(() =>
                validateCustomAcpRuntimeInput({
                    ...INPUT,
                    env: { [key]: "plaintext" },
                }),
            ).toThrow(/looks secret/);
        },
    );

    it("rejects renderer-controlled identity fields by normalizing only input", () => {
        const untrusted = {
            ...INPUT,
            id: "custom:550e8400-e29b-41d4-a716-446655440000",
            launchFingerprint: "renderer-value",
            revision: 999,
        };
        const definition = createCustomAcpRuntimeDefinition(
            untrusted,
            [],
            () => "67e55044-10b1-426f-9247-bb680e5fe0c8",
        );

        expect(definition.id).toBe(
            "custom:67e55044-10b1-426f-9247-bb680e5fe0c8",
        );
        expect(definition.revision).toBe(1);
        expect(definition.launchFingerprint).not.toBe("renderer-value");
    });

    it("drops malformed persisted entries and recomputes fingerprints", () => {
        const diagnostics: string[] = [];
        const settings = normalizeCustomAcpRuntimesSettings(
            {
                runtimes: [
                    {
                        ...INPUT,
                        id: "custom:550e8400-e29b-41d4-a716-446655440000",
                        launchFingerprint: "untrusted",
                        revision: 3,
                    },
                    {
                        ...INPUT,
                        displayName: "Broken",
                        id: "custom:not-a-uuid",
                        revision: 1,
                    },
                ],
                version: 1,
            },
            (message) => diagnostics.push(message),
        );

        expect(settings.runtimes).toHaveLength(1);
        expect(settings.runtimes[0]?.launchFingerprint).toMatch(
            /^[0-9a-f]{64}$/,
        );
        expect(diagnostics).toHaveLength(1);
    });
});
