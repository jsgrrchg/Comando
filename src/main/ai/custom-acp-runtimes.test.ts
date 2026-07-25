import { readFileSync } from "node:fs";

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
const FINGERPRINT_CONTRACT_FIXTURE = JSON.parse(
    readFileSync(
        new URL(
            "../../../crates/comando-ai/tests/fixtures/custom-launch-fingerprint.json",
            import.meta.url,
        ),
        "utf8",
    ),
) as {
    readonly args: readonly string[];
    readonly authMode: "external";
    readonly command: string;
    readonly env: Readonly<Record<string, string>>;
    readonly expectedFingerprint: string;
    readonly profile: string;
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

    it("matches the native fingerprint contract for mixed-case environment keys", () => {
        const fingerprint = calculateCustomAcpLaunchFingerprint(
            FINGERPRINT_CONTRACT_FIXTURE,
        );
        const normalized = validateCustomAcpRuntimeInput({
            ...FINGERPRINT_CONTRACT_FIXTURE,
            displayName: "Pi",
        });

        expect(FINGERPRINT_CONTRACT_FIXTURE.profile).toBe(
            "acp-current14-custom-v1",
        );
        expect(Object.keys(normalized.env)).toEqual(["B", "a"]);
        expect(fingerprint).toBe(
            FINGERPRINT_CONTRACT_FIXTURE.expectedFingerprint,
        );
        expect(
            calculateCustomAcpLaunchFingerprint({
                ...FINGERPRINT_CONTRACT_FIXTURE,
                env: { B: "two", a: "one" },
            }),
        ).toBe(fingerprint);
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

    it("rejects attempts to replace the controlled PATH", () => {
        expect(() =>
            validateCustomAcpRuntimeInput({
                ...INPUT,
                env: { PATH: "/untrusted/bin" },
            }),
        ).toThrow(/controlled by Comando/);
    });

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

    it("reports persisted active runtimes beyond the supported maximum", () => {
        const diagnostics: string[] = [];
        const runtimes = Array.from({ length: 33 }, (_, index) => ({
            ...INPUT,
            displayName: `Runtime ${index}`,
            id: `custom:550e8400-e29b-41d4-a716-${String(index).padStart(12, "0")}`,
            launchFingerprint: "untrusted",
            revision: 1,
        }));

        const settings = normalizeCustomAcpRuntimesSettings(
            { runtimes, version: 1 },
            (message) => diagnostics.push(message),
        );

        expect(settings.runtimes).toHaveLength(32);
        expect(diagnostics).toContain(
            "Discarded custom ACP runtimes beyond the supported maximum of 32.",
        );
    });
});
