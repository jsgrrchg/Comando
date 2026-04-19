import { EventEmitter } from "node:events";
import type { MessagePort, Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import { createAiWorkerClient } from "./client";
import type { AiWorkerBootstrapState } from "./contracts";

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
    threadId = 99;
    terminate = vi.fn(() => Promise.resolve(0));
}

describe("createAiWorkerClient", () => {
    it("starts and shuts down the AI worker through the shared RPC pattern", async () => {
        const port = new FakePort();
        const worker = new FakeWorker();
        const bootstrap: AiWorkerBootstrapState = {
            capabilities: {
                fileBufferMirroring: true,
                runtimeSessions: false,
            },
            protocolVersion: 1,
            startedAt: new Date().toISOString(),
        };

        port.onPostMessage = (message) => {
            const payload = message as {
                readonly id?: number;
                readonly method?: string;
            };
            if (
                typeof payload.id !== "number" ||
                typeof payload.method !== "string"
            ) {
                return;
            }

            port.emit("message", {
                id: payload.id,
                result: payload.method === "system.shutdown" ? true : null,
            });
        };

        const client = await createAiWorkerClient({
            connect: async () => ({
                port: port as unknown as MessagePort,
                readyValue: bootstrap,
                worker: worker as unknown as Worker,
            }),
        });

        await expect(
            client.notifyFileBuffer({
                absolutePath: "/tmp/comando-ai-worker-test.txt",
                content: "buffer",
            }),
        ).resolves.toBeUndefined();

        await expect(
            client.notifyFileBuffer({
                absolutePath: "/tmp/comando-ai-worker-test.txt",
                content: null,
            }),
        ).resolves.toBeUndefined();

        await expect(
            client.closeOwnedByWindow("window-ai-worker-test"),
        ).resolves.toBeUndefined();

        await expect(client.close()).resolves.toBeUndefined();
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });
});
