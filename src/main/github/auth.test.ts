import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
    spawn: spawnMock,
}));

import { loadGhCliToken } from "@main/github/auth";

describe("GitHub auth", () => {
    beforeEach(() => {
        spawnMock.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("loads a token from the gh CLI for github.com", async () => {
        spawnMock.mockImplementationOnce(() =>
            createGhProcess({ stdout: "gho_cli_token\n" }),
        );

        await expect(loadGhCliToken("github.com")).resolves.toBe(
            "gho_cli_token",
        );
        expect(spawnMock).toHaveBeenCalledWith("gh", ["auth", "token"], {
            stdio: ["ignore", "pipe", "ignore"],
        });
    });

    it("passes a hostname for GitHub Enterprise hosts", async () => {
        spawnMock.mockImplementationOnce(() =>
            createGhProcess({ stdout: "ghe_token\n" }),
        );

        await expect(
            loadGhCliToken("https://ghe.example.com/acme/repo"),
        ).resolves.toBe("ghe_token");
        expect(spawnMock).toHaveBeenCalledWith(
            "gh",
            ["auth", "token", "--hostname", "ghe.example.com"],
            {
                stdio: ["ignore", "pipe", "ignore"],
            },
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
}) {
    const child = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
        stdout: EventEmitter & {
            setEncoding: ReturnType<typeof vi.fn>;
        };
    };
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
