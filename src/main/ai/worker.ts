import { parentPort, type MessagePort } from "node:worker_threads";

import type { FileBufferNotificationInput } from "@shared/ipc";

import {
    type AiWorkerBootstrapState,
    type AiWorkerEventMessage,
    type AiWorkerFatalMessage,
    type AiWorkerInitMessage,
    type AiWorkerReadyMessage,
    type AiWorkerRpcMethodMap,
} from "./contracts";

interface AiWorkerRequest {
    readonly id: number;
    readonly method: string;
    readonly params?: unknown;
}

interface AiWorkerResponse {
    readonly error?: SerializedError;
    readonly id: number;
    readonly result?: unknown;
}

interface SerializedError {
    readonly message: string;
    readonly name: string;
    readonly stack?: string;
}

class AiWorkerRuntime {
    readonly #fileBuffers = new Map<string, string>();
    readonly #startedAt = new Date().toISOString();
    readonly #debugLogsEnabled = process.env.COMANDO_DEBUG_AI_WORKER === "1";
    #rpcPort: MessagePort | null = null;

    attachPort(port: MessagePort): void {
        this.#rpcPort = port;
        this.#emitLog("info", "AI worker initialized.", {
            fileBufferMirroring: true,
            runtimeSessions: false,
        });
    }

    getBootstrapState(): AiWorkerBootstrapState {
        return {
            capabilities: {
                fileBufferMirroring: true,
                runtimeSessions: false,
            },
            protocolVersion: 1,
            startedAt: this.#startedAt,
        };
    }

    async dispatchMethod(
        method: string,
        params: unknown,
    ): Promise<unknown> {
        switch (method as keyof AiWorkerRpcMethodMap) {
            case "ai.notifyFileBuffer":
                this.#notifyFileBuffer(
                    params as AiWorkerRpcMethodMap["ai.notifyFileBuffer"]["params"],
                );
                return null;
            case "ai.closeOwnedByWindow":
                this.#emitLog("debug", "Closing AI worker resources by window.", {
                    ownerWindowId: params as string,
                });
                return null;
            case "ai.refreshProjectScopes":
                this.#emitLog("debug", "Refreshing project scopes in AI worker.", {
                    projectId: params as string,
                });
                return null;
            case "ai.cancelSession":
            case "ai.closeSession":
            case "ai.prepareSession":
            case "ai.respondPermission":
            case "ai.respondUserInput":
            case "ai.sendPrompt":
                throw new Error(
                    `The AI worker RPC method \`${method}\` is not wired to live runtime sessions yet.`,
                );
            default:
                throw new Error(`Unknown AI worker method: ${method}`);
        }
    }

    shutdown(): void {
        this.#emitLog("info", "AI worker shutting down.", {
            trackedBuffers: this.#fileBuffers.size,
        });
        this.#fileBuffers.clear();
    }

    #notifyFileBuffer(input: FileBufferNotificationInput): void {
        if (input.content === null) {
            this.#fileBuffers.delete(input.absolutePath);
        } else {
            this.#fileBuffers.set(input.absolutePath, input.content);
        }

        this.#emitLog("debug", "Mirrored file buffer state into AI worker.", {
            action: input.content === null ? "forget" : "record",
            absolutePath: input.absolutePath,
            trackedBuffers: this.#fileBuffers.size,
        });
    }

    #emitEvent(message: AiWorkerEventMessage): void {
        this.#rpcPort?.postMessage(message);
    }

    #emitLog(
        level: "debug" | "error" | "info" | "warn",
        message: string,
        context?: Record<string, boolean | number | string | null | undefined>,
    ): void {
        if (!this.#debugLogsEnabled && level === "debug") {
            return;
        }

        if (!this.#debugLogsEnabled && level === "info") {
            return;
        }

        this.#emitEvent({
            event: "ai.log",
            payload: {
                context,
                level,
                message,
            },
            type: "event",
        });
    }
}

let aiWorkerRuntime: AiWorkerRuntime | null = null;
let rpcPort: MessagePort | null = null;

parentPort?.once("message", (message: unknown) => {
    initializeWorker(message as AiWorkerInitMessage);
});

function initializeWorker(message: AiWorkerInitMessage): void {
    try {
        rpcPort = message.port;
        aiWorkerRuntime = new AiWorkerRuntime();
        aiWorkerRuntime.attachPort(rpcPort);

        rpcPort.on("message", (request: unknown) => {
            void handleRequest(request as AiWorkerRequest);
        });
        rpcPort.start?.();
        rpcPort.postMessage({
            bootstrap: aiWorkerRuntime.getBootstrapState(),
            type: "ready",
        } satisfies AiWorkerReadyMessage);
    } catch (error) {
        const payload = {
            error: serializeError(error),
            type: "fatal",
        } satisfies AiWorkerFatalMessage;

        if (message.port) {
            message.port.postMessage(payload);
        } else {
            parentPort?.postMessage(payload);
        }
    }
}

async function handleRequest(request: AiWorkerRequest): Promise<void> {
    if (!rpcPort) {
        return;
    }

    if (request.method === "system.shutdown") {
        try {
            rpcPort.postMessage({
                id: request.id,
                result: true,
            } satisfies AiWorkerResponse);
        } finally {
            aiWorkerRuntime?.shutdown();
            rpcPort.close();
        }
        return;
    }

    try {
        const result = await aiWorkerRuntime?.dispatchMethod(
            request.method,
            request.params,
        );
        rpcPort.postMessage({
            id: request.id,
            result,
        } satisfies AiWorkerResponse);
    } catch (error) {
        rpcPort.postMessage({
            error: serializeError(error),
            id: request.id,
        } satisfies AiWorkerResponse);
    }
}

function serializeError(error: unknown): SerializedError {
    if (error instanceof Error) {
        return {
            message: error.message,
            name: error.name,
            stack: error.stack,
        };
    }

    return {
        message: String(error),
        name: "Error",
    };
}
