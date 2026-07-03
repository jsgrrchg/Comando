import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeBackendClient, NativeBackendError, type NativeBackendSpawn } from "./client";

beforeEach(() => {
    vi.useRealTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("NativeBackendClient", () => {
    it("resolves requests from matching responses", async () => {
        const { child, client } = createClient();
        const linePromise = readStdinLine(child);

        const requestPromise = client.request("backend_ping");
        const request = parseRequestLine(await linePromise);
        expect(request.id).toBe("req_1");
        expect(request.meta).toMatchObject({ protocolVersion: 1 });
        child.stdout.write(
            `${JSON.stringify({
                type: "response",
                id: request.id,
                ok: true,
                result: { pong: true },
            })}\n`,
        );

        await expect(requestPromise).resolves.toEqual({ pong: true });
    });

    it("performs a versioned handshake", async () => {
        const { child, client } = createClient();
        const linePromise = readStdinLine(child);

        const handshakePromise = client.handshake({ clientVersion: "0.1.0-test" });
        const request = parseRequestLine(await linePromise);
        expect(request.command).toBe("backend_handshake");
        expect(request.args).toEqual({
            clientName: "comando-electron-main",
            clientVersion: "0.1.0-test",
            protocolVersion: 1,
            supportedProtocolVersions: [1],
        });
        child.stdout.write(
            `${JSON.stringify({
                type: "response",
                id: request.id,
                ok: true,
                result: {
                    backendName: "comando-native-backend",
                    backendVersion: "0.1.0",
                    protocolVersion: 1,
                    minimumClientProtocolVersion: 1,
                    capabilities: {
                        domains: ["backend"],
                        commands: ["backend_ping", "backend_handshake"],
                        events: ["backend://test-event"],
                        features: ["bootstrap", "versioned-protocol"],
                    },
                },
            })}\n`,
        );

        await expect(handshakePromise).resolves.toMatchObject({
            backendName: "comando-native-backend",
            protocolVersion: 1,
        });
    });

    it("rejects unsupported handshake protocol versions clearly", async () => {
        const { child, client } = createClient();
        const linePromise = readStdinLine(child);

        const handshakePromise = client.handshake();
        const request = parseRequestLine(await linePromise);
        child.stdout.write(
            `${JSON.stringify({
                type: "response",
                id: request.id,
                ok: true,
                result: {
                    backendName: "comando-native-backend",
                    backendVersion: "0.1.0",
                    protocolVersion: 99,
                    minimumClientProtocolVersion: 99,
                    capabilities: {
                        domains: ["backend"],
                        commands: [],
                        events: [],
                        features: [],
                    },
                },
            })}\n`,
        );

        await expect(handshakePromise).rejects.toMatchObject({
            code: "unsupported_protocol_version",
            name: "NativeBackendError",
        });
    });

    it("rejects a backend that requires a newer client minimum", async () => {
        const { child, client } = createClient();
        const linePromise = readStdinLine(child);

        const handshakePromise = client.handshake();
        const request = parseRequestLine(await linePromise);
        child.stdout.write(
            `${JSON.stringify({
                type: "response",
                id: request.id,
                ok: true,
                result: {
                    backendName: "comando-native-backend",
                    backendVersion: "0.1.0",
                    protocolVersion: 1,
                    minimumClientProtocolVersion: 2,
                    capabilities: {
                        domains: ["backend"],
                        commands: [],
                        events: [],
                        features: [],
                    },
                },
            })}\n`,
        );

        await expect(handshakePromise).rejects.toMatchObject({
            code: "unsupported_protocol_version",
            details: {
                clientProtocolVersion: 1,
                minimumClientProtocolVersion: 2,
            },
        });
    });

    it("handles out-of-order responses by id", async () => {
        const { child, client } = createClient();
        const linesPromise = readStdinLines(child, 2);

        const first = client.request("backend_ping");
        const second = client.request("backend_capabilities");
        const requests = (await linesPromise).map(parseRequestLine);
        const firstRequest = requests[0];
        const secondRequest = requests[1];
        if (!firstRequest || !secondRequest) {
            throw new Error("Expected two native backend requests.");
        }

        child.stdout.write(
            `${JSON.stringify({
                type: "response",
                id: secondRequest.id,
                ok: true,
                result: { protocolVersion: 1 },
            })}\n`,
        );
        child.stdout.write(
            `${JSON.stringify({
                type: "response",
                id: firstRequest.id,
                ok: true,
                result: { pong: true },
            })}\n`,
        );

        await expect(first).resolves.toEqual({ pong: true });
        await expect(second).resolves.toEqual({ protocolVersion: 1 });
    });

    it("parses stdout JSONL with unicode line separators inside strings", async () => {
        const { child, client } = createClient();
        const linePromise = readStdinLine(child);

        const requestPromise = client.request("backend_ping");
        const request = parseRequestLine(await linePromise);
        child.stdout.write(
            `${JSON.stringify({
                type: "response",
                id: request.id,
                ok: true,
                result: {
                    message: "first line\u2028second line",
                },
            })}\n`,
        );

        await expect(requestPromise).resolves.toEqual({
            message: "first line\u2028second line",
        });
    });

    it("preserves UTF-8 characters split across stdout chunks", async () => {
        const { child, client } = createClient();
        const linePromise = readStdinLine(child);

        const requestPromise = client.request("backend_ping");
        const request = parseRequestLine(await linePromise);
        const response = Buffer.from(
            `${JSON.stringify({
                type: "response",
                id: request.id,
                ok: true,
                result: {
                    message: "branch/café",
                },
            })}\n`,
            "utf8",
        );
        const splitIndex = response.indexOf(Buffer.from("é", "utf8")) + 1;

        child.stdout.write(response.subarray(0, splitIndex));
        child.stdout.write(response.subarray(splitIndex));

        await expect(requestPromise).resolves.toEqual({
            message: "branch/café",
        });
    });

    it("delivers native backend events", async () => {
        const { child, client } = createClient();
        const listener = vi.fn();
        client.onEvent(listener);

        child.stdout.write(
            `${JSON.stringify({
                type: "event",
                eventName: "backend://test-event",
                payload: { message: "hello" },
            })}\n`,
        );
        await waitForMicrotasks();

        expect(listener).toHaveBeenCalledWith({
            type: "event",
            eventName: "backend://test-event",
            payload: { message: "hello" },
        });
    });

    it("reports stderr diagnostics without touching stdout parsing", async () => {
        const diagnostic = vi.fn();
        const { child, client } = createClient({ onDiagnostic: diagnostic });
        const linePromise = readStdinLine(child);

        const requestPromise = client.request("backend_ping");
        const request = parseRequestLine(await linePromise);
        child.stderr.write("warmup warning\n");
        child.stdout.write(
            `${JSON.stringify({
                type: "response",
                id: request.id,
                ok: true,
                result: { pong: true },
            })}\n`,
        );

        await expect(requestPromise).resolves.toEqual({ pong: true });
        expect(diagnostic).toHaveBeenCalledWith("warmup warning");
    });

    it("rejects pending requests when stdout is invalid", async () => {
        const diagnostic = vi.fn();
        const { child, client } = createClient({ onDiagnostic: diagnostic });
        const linePromise = readStdinLine(child);

        const requestPromise = client.request("backend_ping");
        await linePromise;
        child.stdout.write("not-json\n");

        await expect(requestPromise).rejects.toThrow(
            "Native backend emitted invalid stdout JSONL",
        );
        expect(child.kill).toHaveBeenCalled();
        expect(diagnostic).toHaveBeenCalled();
    });

    it("rejects pending requests when the process exits", async () => {
        const { child, client } = createClient();
        const linePromise = readStdinLine(child);

        const requestPromise = client.request("backend_ping");
        await linePromise;
        child.emit("exit", 1, null);

        await expect(requestPromise).rejects.toThrow(
            "Native backend process exited",
        );
    });

    it("rejects timed out requests", async () => {
        vi.useFakeTimers();
        const { child, client } = createClient({ requestTimeoutMs: 50 });
        const linePromise = readStdinLine(child);

        const requestPromise = client.request("backend_ping");
        await linePromise;
        const assertion = expect(requestPromise).rejects.toThrow(
            "Native backend request timed out: backend_ping",
        );
        await vi.advanceTimersByTimeAsync(51);

        await assertion;
    });

    it("rejects backend error responses with the native error type", async () => {
        const { child, client } = createClient();
        const linePromise = readStdinLine(child);

        const requestPromise = client.request("backend_missing");
        const request = parseRequestLine(await linePromise);
        child.stdout.write(
            `${JSON.stringify({
                type: "response",
                id: request.id,
                ok: false,
                error: {
                    code: "unknown_command",
                    message: "Unknown command: backend_missing",
                    details: null,
                    retryable: false,
                },
            })}\n`,
        );

        await expect(requestPromise).rejects.toMatchObject({
            code: "unknown_command",
            name: "NativeBackendError",
        } satisfies Partial<NativeBackendError>);
    });

    it("includes backend stderr details in the rejected error message", async () => {
        const { child, client } = createClient();
        const linePromise = readStdinLine(child);

        const requestPromise = client.request("git_push");
        const request = parseRequestLine(await linePromise);
        child.stdout.write(
            `${JSON.stringify({
                type: "response",
                id: request.id,
                ok: false,
                error: {
                    code: "internal_error",
                    message: "Git command failed with exit code Some(1).",
                    details: {
                        gitCode: "git_command_failed",
                        stderr: "fatal: could not read Username",
                    },
                    retryable: false,
                },
            })}\n`,
        );

        await expect(requestPromise).rejects.toThrow(
            "fatal: could not read Username",
        );
    });

    it("disposes idempotently after graceful shutdown", async () => {
        const { child, client } = createClient({ shutdownTimeoutMs: 50 });
        const linePromise = readStdinLine(child);

        const firstDispose = client.dispose();
        const secondDispose = client.dispose();
        const request = parseRequestLine(await linePromise);
        child.stdout.write(
            `${JSON.stringify({
                type: "response",
                id: request.id,
                ok: true,
                result: { accepted: true },
            })}\n`,
        );
        child.emit("exit", 0, null);

        await expect(Promise.all([firstDispose, secondDispose])).resolves.toEqual([
            undefined,
            undefined,
        ]);
        expect(child.kill).not.toHaveBeenCalled();
    });

    it("kills the process when shutdown times out", async () => {
        vi.useFakeTimers();
        const { child, client } = createClient({ shutdownTimeoutMs: 50 });
        const linePromise = readStdinLine(child);

        const disposePromise = client.dispose();
        await linePromise;
        await vi.advanceTimersByTimeAsync(110);
        await disposePromise;

        expect(child.kill).toHaveBeenCalled();
    });

    it("passes the packaged AI resource directory to the sidecar", () => {
        const { spawnProcess } = createClient({
            aiResourceDir: "/tmp/Comando.app/Contents/Resources/ai",
        });
        const spawnCall = vi.mocked(spawnProcess).mock.calls[0];

        expect(spawnCall?.[0]).toBe("/tmp/comando-native-backend");
        expect(spawnCall?.[1]).toEqual([]);
        expect(spawnCall?.[2].env?.COMANDO_ELECTRON_AI_RESOURCE_DIR).toBe(
            "/tmp/Comando.app/Contents/Resources/ai",
        );
    });

    it("enriches the sidecar PATH for git helper commands", () => {
        const previousPath = process.env.PATH;
        process.env.PATH = "/custom/bin";
        try {
            const { spawnProcess } = createClient();
            const spawnCall = vi.mocked(spawnProcess).mock.calls[0];
            const pathEntries = String(spawnCall?.[2].env?.PATH ?? "").split(
                path.delimiter,
            );

            expect(pathEntries).toContain("/custom/bin");
            expect(pathEntries).toContain("/usr/bin");
            expect(pathEntries).toContain("/bin");
            if (process.platform === "darwin") {
                expect(pathEntries).toContain("/opt/homebrew/bin");
                expect(pathEntries).toContain("/usr/local/bin");
            }
        } finally {
            if (previousPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = previousPath;
            }
        }
    });
});

type CreateClientOptions = {
    readonly aiResourceDir?: string | null;
    readonly onDiagnostic?: (message: string) => void;
    readonly requestTimeoutMs?: number;
    readonly shutdownTimeoutMs?: number;
};

function createClient(options: CreateClientOptions = {}) {
    const child = createMockChildProcess();
    const spawnProcess = vi.fn(() => child) as unknown as NativeBackendSpawn;
    const client = new NativeBackendClient({
        aiResourceDir: options.aiResourceDir,
        binaryPath: "/tmp/comando-native-backend",
        onDiagnostic: options.onDiagnostic,
        requestTimeoutMs: options.requestTimeoutMs,
        shutdownTimeoutMs: options.shutdownTimeoutMs,
        spawnProcess,
    });

    return { child, client, spawnProcess };
}

function createMockChildProcess() {
    const emitter = new EventEmitter();
    const child = {
        emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
        kill: vi.fn(() => true),
        off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            emitter.off(event, listener);
            return child;
        }),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            emitter.on(event, listener);
            return child;
        }),
        once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            emitter.once(event, listener);
            return child;
        }),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
    };

    return child;
}

type MockChildProcess = ReturnType<typeof createMockChildProcess>;

type ParsedRequestLine = {
    readonly id: string;
    readonly args?: unknown;
    readonly command?: string;
    readonly meta?: unknown;
};

function parseRequestLine(line: string): ParsedRequestLine {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed.id !== "string") {
        throw new Error("Expected native backend request line with an id.");
    }

    return {
        args: parsed.args,
        command: typeof parsed.command === "string" ? parsed.command : undefined,
        id: parsed.id,
        meta: parsed.meta,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStdinLine(child: MockChildProcess): Promise<string> {
    return readStdinLines(child, 1).then(([line]) => line ?? "");
}

function readStdinLines(
    child: MockChildProcess,
    count: number,
): Promise<readonly string[]> {
    return new Promise((resolve) => {
        const lines: string[] = [];
        let buffer = "";
        const onData = (chunk: Buffer | string) => {
            buffer += chunk.toString();
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex >= 0) {
                lines.push(buffer.slice(0, newlineIndex));
                buffer = buffer.slice(newlineIndex + 1);
                if (lines.length === count) {
                    child.stdin.off("data", onData);
                    resolve(lines);
                    return;
                }

                newlineIndex = buffer.indexOf("\n");
            }
        };

        child.stdin.on("data", onData);
    });
}

function waitForMicrotasks(): Promise<void> {
    return new Promise((resolve) => {
        setImmediate(resolve);
    });
}
