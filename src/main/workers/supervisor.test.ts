import { EventEmitter } from "node:events";
import type { MessagePort, Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RpcWorkerSupervisor } from "./supervisor";

class FakePort extends EventEmitter {
    onPostMessage?: (message: unknown) => void;

    postMessage(message: unknown): void {
        this.onPostMessage?.(message);
    }

    close(): void {
        this.removeAllListeners();
    }

    start(): void {
        // No-op for tests.
    }
}

class FakeWorker extends EventEmitter {
    threadId = 42;
    terminate = vi.fn(() => Promise.resolve(0));
}

describe("RpcWorkerSupervisor", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("closes without waiting for timeout when a worker exits mid-shutdown", async () => {
        vi.useFakeTimers();

        const port = new FakePort();
        const worker = new FakeWorker();

        port.onPostMessage = (message) => {
            const payload = message as {
                readonly method?: string;
            };
            if (payload.method === "system.shutdown") {
                worker.emit("exit", 1);
            }
        };

        const supervisor = new RpcWorkerSupervisor<void>({
            connect: () =>
                Promise.resolve({
                    port: port as unknown as MessagePort,
                    readyValue: undefined,
                    worker: worker as unknown as Worker,
                }),
            domain: "git",
            timeoutMs: 1_000,
        });

        await supervisor.ready();

        let settled = false;
        const closePromise = supervisor.close().then(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(1);

        expect(settled).toBe(true);
        expect(worker.terminate).toHaveBeenCalledTimes(1);

        await closePromise;
    });

    it("does not force terminate when the worker exits gracefully after shutdown", async () => {
        const port = new FakePort();
        const worker = new FakeWorker();

        port.onPostMessage = (message) => {
            const payload = message as {
                readonly id?: number;
                readonly method?: string;
            };
            if (payload.method === "system.shutdown") {
                // Respond to the shutdown RPC and then exit on next tick,
                // mirroring the worker's real teardown sequence.
                queueMicrotask(() => {
                    port.emit("message", {
                        id: payload.id,
                        result: true,
                    });
                    queueMicrotask(() => {
                        worker.emit("exit", 0);
                    });
                });
            }
        };

        const supervisor = new RpcWorkerSupervisor<void>({
            connect: () =>
                Promise.resolve({
                    port: port as unknown as MessagePort,
                    readyValue: undefined,
                    worker: worker as unknown as Worker,
                }),
            domain: "db",
            timeoutMs: 1_000,
        });

        await supervisor.ready();
        await supervisor.close();

        expect(worker.terminate).not.toHaveBeenCalled();
    });
});
