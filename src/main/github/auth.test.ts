import { EventEmitter } from "node:events";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type GhProcess = EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter & {
        setEncoding: ReturnType<typeof vi.fn>;
    };
};

interface GhSpawnOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly stdio: readonly ["ignore", "pipe", "ignore"];
}

type GhSpawnMock = (
    command: string,
    args: readonly string[],
    options: GhSpawnOptions,
) => GhProcess;

const spawnMock = vi.hoisted(() => vi.fn<GhSpawnMock>());

vi.mock("node:child_process", () => ({
    spawn: spawnMock,
}));

import { loadGhCliToken } from "@main/github/auth";

describe("GitHub auth", () => {
    const originalPath = process.env.PATH;

    beforeEach(() => {
        spawnMock.mockReset();
        process.env.PATH = originalPath;
    });

    afterEach(() => {
        process.env.PATH = originalPath;
        vi.useRealTimers();
    });

    it("loads a token from the gh CLI for github.com", async () => {
        spawnMock.mockImplementationOnce(() =>
            createGhProcess({ stdout: "gho_cli_token\n" }),
        );

        await expect(loadGhCliToken("github.com")).resolves.toBe(
            "gho_cli_token",
        );
        const [command, args, options] = readSpawnCall();
        expect(command).toBe("gh");
        expect(args).toEqual(["auth", "token"]);
        expect(options.env?.PATH).toEqual(expect.any(String));
        expect(options.stdio).toEqual(["ignore", "pipe", "ignore"]);
    });

    it("passes a hostname for GitHub Enterprise hosts", async () => {
        spawnMock.mockImplementationOnce(() =>
            createGhProcess({ stdout: "ghe_token\n" }),
        );

        await expect(
            loadGhCliToken("https://ghe.example.com/acme/repo"),
        ).resolves.toBe("ghe_token");
        const [command, args, options] = readSpawnCall();
        expect(command).toBe("gh");
        expect(args).toEqual(
            ["auth", "token", "--hostname", "ghe.example.com"],
        );
        expect(options.stdio).toEqual(["ignore", "pipe", "ignore"]);
    });

    it("adds common Homebrew paths before launching gh", async () => {
        process.env.PATH = ["/usr/bin", "/bin", "/opt/homebrew/bin"].join(
            path.delimiter,
        );
        spawnMock.mockImplementationOnce(() =>
            createGhProcess({ stdout: "gho_cli_token\n" }),
        );

        await expect(loadGhCliToken("github.com")).resolves.toBe(
            "gho_cli_token",
        );

        const [, , options] = readSpawnCall();
        expect(options.env?.PATH).toBe(
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/opt/local/bin",
                "/usr/bin",
                "/bin",
            ].join(path.delimiter),
        );
    });

    it("returns null when gh is unavailable or exits unsuccessfully", async () => {
        spawnMock
            .mockImplementationOnce(() =>
                createGhProcess({ error: new Error("ENOENT") }),
            )
            .mockImplementationOnce(() => createGhProcess({ code: 1 }));

        await expect(loadGhCliToken("github.com")).resolves.toBeNull();
        await expect(loadGhCliToken("github.com")).resolves.toBeNull();
    });

    it("kills gh and returns null when token lookup times out", async () => {
        vi.useFakeTimers();
        const child = createGhProcess({ autoClose: false });
        spawnMock.mockReturnValueOnce(child);

        const token = loadGhCliToken("github.com");
        await vi.advanceTimersByTimeAsync(5000);

        await expect(token).resolves.toBeNull();
        expect(child.kill).toHaveBeenCalled();
    });
});

function readSpawnCall(): readonly [
    command: string,
    args: readonly string[],
    options: GhSpawnOptions,
] {
    const call = spawnMock.mock.calls[0];
    if (!call) {
        throw new Error("Expected gh spawn to be called.");
    }

    return call;
}

function createGhProcess({
    autoClose = true,
    code = 0,
    error = null,
    stdout = "",
}: {
    readonly autoClose?: boolean;
    readonly code?: number;
    readonly error?: Error | null;
    readonly stdout?: string;
}): GhProcess {
    const child = new EventEmitter() as GhProcess;
    child.kill = vi.fn();
    child.stdout = new EventEmitter() as EventEmitter & {
        setEncoding: ReturnType<typeof vi.fn>;
    };
    child.stdout.setEncoding = vi.fn();

    if (autoClose) {
        queueMicrotask(() => {
            if (error) {
                child.emit("error", error);
                return;
            }
            if (stdout) {
                child.stdout.emit("data", stdout);
            }
            child.emit("close", code);
        });
    }

    return child;
}
