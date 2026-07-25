import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeTestExecutable } from "@main/testing/executable-fixture";

import { createCustomAcpRuntimeDefinition } from "./custom-acp-runtimes";
import {
    buildIsolatedCustomAcpEnv,
    resolveCustomAcpRuntime,
} from "./custom-acp-launch";

const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("custom ACP launch resolution", () => {
    it("resolves an absolute executable into an immutable launch", () => {
        const directory = createTempDir();
        const executable = writeTestExecutable(directory, "pi-acp");
        const definition = createDefinition(executable);
        const resolved = resolveCustomAcpRuntime(definition, {
            HOME: "/Users/example",
            OPENAI_API_KEY: "must-not-leak",
            PATH: "/sensitive/provider/path",
        });

        expect(resolved.status).toMatchObject({
            authCredentialSource: "external-runtime",
            authReady: true,
            state: "ready",
        });
        expect(resolved.customAcpLaunch).toMatchObject({
            executable,
            launchFingerprint: definition.launchFingerprint,
            runtimeId: definition.id,
            state: "ready",
        });
        expect(resolved.env).not.toHaveProperty("OPENAI_API_KEY");
        expect(resolved.env.PATH).not.toContain("/sensitive/provider/path");
    });

    it("resolves a command from the controlled runtime path", () => {
        const directory = createTempDir();
        const executable = writeTestExecutable(directory, "internal-acp");
        const home = path.join(directory, "home");
        const bin = path.join(home, "bin");
        fs.mkdirSync(bin, { recursive: true });
        fs.renameSync(executable, path.join(bin, path.basename(executable)));
        const definition = createDefinition("internal-acp");

        const resolved = resolveCustomAcpRuntime(definition, { HOME: home });

        expect(resolved.status.state).toBe("ready");
        expect(resolved.executable).toBe(
            path.join(bin, path.basename(executable)),
        );
    });

    it("fails before spawn for missing or non-executable commands", () => {
        const directory = createTempDir();
        const nonExecutable = path.join(directory, "not-executable");
        fs.writeFileSync(nonExecutable, "#!/bin/sh\n", { mode: 0o644 });

        expect(
            resolveCustomAcpRuntime(
                createDefinition(path.join(directory, "missing")),
                {},
            ).status.state,
        ).toBe("error");
        expect(
            resolveCustomAcpRuntime(createDefinition(nonExecutable), {}).status
                .state,
        ).toBe("error");
    });

    it("inherits only allowlisted platform variables and configured values", () => {
        const env = buildIsolatedCustomAcpEnv(
            {
                ANTHROPIC_API_KEY: "secret",
                HOME: "/Users/example",
                NODE_OPTIONS: "--inspect",
                XAI_API_KEY: "secret",
            },
            "/usr/bin/env",
            { PI_PROFILE: "development" },
        );

        expect(env).toMatchObject({
            HOME: "/Users/example",
            PI_PROFILE: "development",
        });
        expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
        expect(env).not.toHaveProperty("NODE_OPTIONS");
        expect(env).not.toHaveProperty("XAI_API_KEY");
    });
});

function createDefinition(command: string) {
    return createCustomAcpRuntimeDefinition(
        {
            args: [],
            authMode: "external",
            command,
            displayName: "Pi",
            env: {},
        },
        [],
        () => "550e8400-e29b-41d4-a716-446655440000",
    );
}

function createTempDir(): string {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "comando-custom-acp-"),
    );
    tempDirs.push(directory);
    return directory;
}
