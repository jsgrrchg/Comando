import { EventEmitter } from "node:events";
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
        const request = JSON.parse(await linePromise);
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

    it("handles out-of-order responses by id", async () => {
        const { child, client } = createClient();
        const linesPromise = readStdinLines(child, 2);

        const first = client.request("backend_ping");
        const second = client.request("backend_capabilities");
        const [firstRequest, secondRequest] = (await linesPromise).map((line) =>
            JSON.parse(line),
        );

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
        const request = JSON.parse(await linePromise);
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
        const request = JSON.parse(await linePromise);
        child.stdout.write(
            `${JSON.stringify({
                type: "response",
                id: request.id,
                ok: false,
                error: {
                    code: "unknown_command",
                    message: "Unknown command: backend_missing",
                    details: null,
                },
            })}\n`,
        );

        await expect(requestPromise).rejects.toMatchObject({
            code: "unknown_command",
            name: "NativeBackendError",
        } satisfies Partial<NativeBackendError>);
    });

    it("disposes idempotently after graceful shutdown", async () => {
        const { child, client } = createClient({ shutdownTimeoutMs: 50 });
        const linePromise = readStdinLine(child);

        const firstDispose = client.dispose();
        const secondDispose = client.dispose();
        const request = JSON.parse(await linePromise);
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
});

type CreateClientOptions = {
    readonly onDiagnostic?: (message: string) => void;
    readonly requestTimeoutMs?: number;
    readonly shutdownTimeoutMs?: number;
};

function createClient(options: CreateClientOptions = {}) {
    const child = createMockChildProcess();
    const spawnProcess = vi.fn(() => child) as unknown as NativeBackendSpawn;
    const client = new NativeBackendClient({
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
