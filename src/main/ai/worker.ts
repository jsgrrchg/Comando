import { parentPort, type MessagePort } from "node:worker_threads";

import {
    type AiWorkerFatalMessage,
    type AiWorkerInitMessage,
    type AiWorkerReadyMessage,
} from "./contracts";
import { AiWorkerRuntime } from "./worker-runtime";

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

let aiWorkerRuntime: AiWorkerRuntime | null = null;
let rpcPort: MessagePort | null = null;

// Prevent a stray throw inside any one session from terminating the whole
// worker thread. The Node default for an uncaught exception or rejection in
// a worker is to exit, which the supervisor interprets as a crash and
// restarts us — cancelling every concurrent AI session along the way.
process.on("uncaughtException", (error) => {
    console.error("[ai-worker] uncaughtException:", error);
});
process.on("unhandledRejection", (reason) => {
    console.error("[ai-worker] unhandledRejection:", reason);
});

parentPort?.once("message", (message: unknown) => {
    initializeWorker(message as AiWorkerInitMessage);
});

function initializeWorker(message: AiWorkerInitMessage): void {
    try {
        rpcPort = message.port;
        aiWorkerRuntime = new AiWorkerRuntime({
            debugLogsEnabled: process.env.COMANDO_DEBUG_AI_WORKER === "1",
            emitEvent: (event) => {
                rpcPort?.postMessage(event);
            },
        });

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
