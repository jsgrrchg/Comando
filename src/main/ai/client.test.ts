import { EventEmitter } from "node:events";
import type { MessagePort, Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import { createAiWorkerClient } from "./client";
import type { AiWorkerBootstrapState } from "./contracts";

class FakePort extends EventEmitter {
    readonly messages: unknown[] = [];
    onPostMessage?: (message: unknown) => void;

    postMessage(message: unknown): void {
        this.messages.push(message);
        this.onPostMessage?.(message);
    }

    close(): void {
        this.removeAllListeners();
    }

    start(): void {
        // No-op for tests.
    }
}

interface RpcMessage {
    readonly id?: number;
    readonly method?: string;
    readonly params?: unknown;
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
            connect: () => Promise.resolve({
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

    it("routes session RPCs to a stable shard and broadcasts global worker state", async () => {
        const { connect, ports } = createShardedWorkerHarness(2);
        const client = await createAiWorkerClient({
            connect,
            shardCount: 2,
        });

        await client.prepareSession(createPrepareInput("stable-session"));
        await client.sendPrompt(createSendPromptInput("stable-session"));
        await client.cancelSession("stable-session");

        const sessionPorts = ports.filter((port) =>
            port.messages.some((message) =>
                isRpcMethod(message, "ai.prepareSession"),
            ),
        );
        expect(sessionPorts).toHaveLength(1);
        expect(
            sessionPorts[0].messages
                .filter((message) => isAiRpcMessage(message))
                .map((message) => message.method),
        ).toEqual([
            "ai.prepareSession",
            "ai.sendPrompt",
            "ai.cancelSession",
        ]);

        await client.notifyFileBuffer({
            absolutePath: "/tmp/sharded-buffer.txt",
            content: "buffer",
        });
        await client.closeOwnedByWindow("window-1");

        for (const port of ports) {
            expect(
                port.messages.some((message) =>
                    isRpcMethod(message, "ai.notifyFileBuffer"),
                ),
            ).toBe(true);
            expect(
                port.messages.some((message) =>
                    isRpcMethod(message, "ai.closeOwnedByWindow"),
                ),
            ).toBe(true);
        }

        await client.close();
    });

    it("splits project scope refreshes across the shards that own the sessions", async () => {
        const { connect, ports } = createShardedWorkerHarness(2);
        const client = await createAiWorkerClient({
            connect,
            shardCount: 2,
        });
        const sessionIds = await findSessionIdsOnDifferentShards(client, ports);
        clearPortMessages(ports);

        await client.refreshProjectScopes({
            projectId: "project-1",
            sessions: sessionIds.map((sessionId) =>
                createPrepareInput(sessionId).launch,
            ),
        });

        const refreshCalls = ports.flatMap((port, shardIndex) =>
            port.messages
                .filter((message) =>
                    isRpcMethod(message, "ai.refreshProjectScopes"),
                )
                .map((message) => ({
                    message: message as RpcMessage,
                    shardIndex,
                })),
        );
        expect(refreshCalls).toHaveLength(2);
        expect(
            refreshCalls.map((call) => {
                const params = call.message.params as {
                    readonly sessions: readonly {
                        readonly input: { readonly sessionId: string };
                    }[];
                };
                return params.sessions.map(
                    (session) => session.input.sessionId,
                );
            }),
        ).toEqual(expect.arrayContaining([[sessionIds[0]], [sessionIds[1]]]));

        await client.close();
    });
});

function createShardedWorkerHarness(shardCount: number) {
    const ports = Array.from({ length: shardCount }, () => new FakePort());
    const connect = vi.fn((context: { readonly shardIndex: number }) => {
        const port = ports[context.shardIndex];
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
            const payload = message as RpcMessage;
            if (
                typeof payload.id !== "number" ||
                typeof payload.method !== "string"
            ) {
                return;
            }

            port.emit("message", {
                id: payload.id,
                result: getRpcResult(payload),
            });
        };
        return Promise.resolve({
            port: port as unknown as MessagePort,
            readyValue: bootstrap,
            worker: worker as unknown as Worker,
        });
    });

    return {
        connect,
        ports,
    };
}

async function findSessionIdsOnDifferentShards(
    client: Awaited<ReturnType<typeof createAiWorkerClient>>,
    ports: readonly FakePort[],
): Promise<[string, string]> {
    const sessionIdByShard = new Map<number, string>();
    for (let index = 0; sessionIdByShard.size < 2 && index < 100; index += 1) {
        const sessionId = `session-${index}`;
        clearPortMessages(ports);
        await client.prepareSession(createPrepareInput(sessionId));
        const shardIndex = ports.findIndex((port) =>
            port.messages.some((message) =>
                isRpcMethod(message, "ai.prepareSession"),
            ),
        );
        if (shardIndex >= 0 && !sessionIdByShard.has(shardIndex)) {
            sessionIdByShard.set(shardIndex, sessionId);
        }
    }

    const sessionIds = [...sessionIdByShard.values()];
    if (sessionIds.length < 2) {
        throw new Error("Could not find test sessions on different shards.");
    }

    return [sessionIds[0], sessionIds[1]];
}

function clearPortMessages(ports: readonly FakePort[]): void {
    for (const port of ports) {
        port.messages.splice(0, port.messages.length);
    }
}

function isAiRpcMessage(message: unknown): message is RpcMessage {
    return (
        typeof (message as RpcMessage).id === "number" &&
        typeof (message as RpcMessage).method === "string" &&
        (message as RpcMessage).method?.startsWith("ai.") === true
    );
}

function isRpcMethod(message: unknown, method: string): boolean {
    return isAiRpcMessage(message) && message.method === method;
}

function getRpcResult(message: RpcMessage): unknown {
    if (message.method === "system.shutdown") {
        return true;
    }

    if (message.method === "ai.prepareSession") {
        const params = message.params as {
            readonly input: { readonly sessionId: string };
        };
        return createSnapshot(params.input.sessionId);
    }

    if (message.method === "ai.sendPrompt") {
        const params = message.params as {
            readonly input: { readonly sessionId: string };
        };
        return {
            sessionId: params.input.sessionId,
            stopReason: "completed",
        };
    }

    return null;
}

function createPrepareInput(sessionId: string) {
    return {
        input: {
            projectId: "project-1",
            runtimeId: "codex",
            sessionId,
            title: sessionId,
            worktreeId: null,
        },
        launch: {
            additionalRoots: [],
            cwd: process.cwd(),
            desiredSelections: {
                configOptions: [],
                modeId: null,
                modelId: null,
                preferredConfigOptions: {},
            },
            input: {
                additionalRoots: [],
                projectId: "project-1",
                runtimeId: "codex",
                sessionId,
                title: sessionId,
                worktreeId: null,
            },
            ownerWindowId: "window-1",
            persistedSnapshot: createSnapshot(sessionId),
            persistedSubagentSessionMappings: [],
            projectRoot: process.cwd(),
            resolvedRuntime: {
                args: [],
                command: "mock-codex-acp",
                env: {},
                executable: "mock-codex-acp",
                status: {
                    authMethod: "chatgpt",
                    authMethods: [],
                    authReady: true,
                    checkedAt: "2026-04-15T00:00:00.000Z",
                    command: "mock-codex-acp",
                    hasCustomBinaryPath: false,
                    hasGatewayConfig: false,
                    hasGatewayUrl: false,
                    message: null,
                    onboardingRequired: false,
                    runtimeId: "codex",
                    source: "bundled",
                    state: "ready",
                },
            },
        },
    } as const;
}

function createSendPromptInput(sessionId: string) {
    return {
        input: {
            attachments: [],
            messageId: "message-1",
            projectId: "project-1",
            prompt: "hello",
            runtimeId: "codex",
            sessionId,
            title: sessionId,
            worktreeId: null,
        },
        launch: createPrepareInput(sessionId).launch,
    } as const;
}

function createSnapshot(sessionId: string) {
    return {
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: "project-1",
        runtimeId: "codex",
        runtimeSessionId: `runtime-${sessionId}`,
        sessionId,
        status: "idle",
        title: sessionId,
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-15T00:00:00.000Z",
        worktreeId: null,
    } as const;
}
