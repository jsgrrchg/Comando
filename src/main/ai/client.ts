import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";

import type {
    AiPermissionResponseInput,
    AiPromptResult,
    AiRuntimeStatus,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiUserInputResponseInput,
    FileBufferNotificationInput,
    PrepareAiSessionInput,
    SendAiPromptInput,
} from "@shared/ipc";

import {
    type AiWorkerBootstrapState,
    type AiWorkerEventMessage,
    type AiWorkerFatalMessage,
    type AiWorkerLogEventPayload,
    type AiWorkerPrepareSessionRpcInput,
    type AiWorkerReadyMessage,
    type AiWorkerRpcMethodMap,
    type AiWorkerRespondPermissionRpcInput,
    type AiWorkerRespondUserInputRpcInput,
    type AiWorkerSendPromptRpcInput,
} from "./contracts";
import {
    type RpcWorkerConnection,
    RpcWorkerSupervisor,
    WORKER_TIMEOUTS_MS,
} from "../workers/supervisor";
import aiWorkerPath from "./worker?modulePath";

export interface AiWorkerClientOptions {
    readonly connect?: () => Promise<RpcWorkerConnection<AiWorkerBootstrapState>>;
    readonly onLog?: (payload: AiWorkerLogEventPayload) => void;
    readonly onRuntimeStatus?: (status: AiRuntimeStatus) => void;
    readonly onSessionClosed?: (payload: {
        readonly ownerWindowId: string;
        readonly sessionId: string;
    }) => void;
    readonly onSessionSnapshot?: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly onWorkerRestarted?: (
        bootstrap: AiWorkerBootstrapState,
    ) => void | Promise<void>;
}

export interface AiWorkerClient {
    cancelSession(sessionId: string): Promise<void>;
    close(): Promise<void>;
    closeOwnedByWindow(ownerWindowId: string): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
    notifyFileBuffer(input: FileBufferNotificationInput): Promise<void>;
    prepareSession(
        input: PrepareAiSessionInput,
        ownerWindowId: string,
    ): Promise<AiSessionSnapshot>;
    refreshProjectScopes(projectId: string): Promise<void>;
    respondPermission(input: AiPermissionResponseInput): Promise<void>;
    respondUserInput(input: AiUserInputResponseInput): Promise<void>;
    sendPrompt(
        input: SendAiPromptInput,
        ownerWindowId: string,
    ): Promise<AiPromptResult>;
}

class AiRpcClient {
    readonly #supervisor: RpcWorkerSupervisor<AiWorkerBootstrapState>;

    constructor(supervisor: RpcWorkerSupervisor<AiWorkerBootstrapState>) {
        this.#supervisor = supervisor;
    }

    async ready(): Promise<AiWorkerBootstrapState> {
        return await this.#supervisor.ready();
    }

    async call<TMethod extends keyof AiWorkerRpcMethodMap>(
        method: TMethod,
        params: AiWorkerRpcMethodMap[TMethod]["params"],
    ): Promise<AiWorkerRpcMethodMap[TMethod]["result"]> {
        return await this.#supervisor.call(method, params);
    }

    async close(): Promise<void> {
        await this.#supervisor.close();
    }
}

class RemoteAiWorkerClient implements AiWorkerClient {
    readonly #rpc: AiRpcClient;

    constructor(rpc: AiRpcClient) {
        this.#rpc = rpc;
    }

    async prepareSession(
        input: PrepareAiSessionInput,
        ownerWindowId: string,
    ): Promise<AiSessionSnapshot> {
        return await this.#rpc.call("ai.prepareSession", {
            input,
            ownerWindowId,
        } satisfies AiWorkerPrepareSessionRpcInput);
    }

    async sendPrompt(
        input: SendAiPromptInput,
        ownerWindowId: string,
    ): Promise<AiPromptResult> {
        return await this.#rpc.call("ai.sendPrompt", {
            input,
            ownerWindowId,
        } satisfies AiWorkerSendPromptRpcInput);
    }

    async cancelSession(sessionId: string): Promise<void> {
        await this.#rpc.call("ai.cancelSession", sessionId);
    }

    async closeSession(sessionId: string): Promise<void> {
        await this.#rpc.call("ai.closeSession", sessionId);
    }

    async closeOwnedByWindow(ownerWindowId: string): Promise<void> {
        await this.#rpc.call("ai.closeOwnedByWindow", ownerWindowId);
    }

    async respondPermission(input: AiPermissionResponseInput): Promise<void> {
        await this.#rpc.call("ai.respondPermission", {
            input,
        } satisfies AiWorkerRespondPermissionRpcInput);
    }

    async respondUserInput(input: AiUserInputResponseInput): Promise<void> {
        await this.#rpc.call("ai.respondUserInput", {
            input,
        } satisfies AiWorkerRespondUserInputRpcInput);
    }

    async refreshProjectScopes(projectId: string): Promise<void> {
        await this.#rpc.call("ai.refreshProjectScopes", projectId);
    }

    async notifyFileBuffer(input: FileBufferNotificationInput): Promise<void> {
        await this.#rpc.call("ai.notifyFileBuffer", input);
    }

    async close(): Promise<void> {
        await this.#rpc.close();
    }
}

export async function createAiWorkerClient(
    options: AiWorkerClientOptions = {},
): Promise<AiWorkerClient> {
    const supervisor = new RpcWorkerSupervisor<AiWorkerBootstrapState>({
        connect: options.connect ?? createAiWorkerConnection,
        domain: "ai",
        onConnected: (bootstrap, context) => {
            if (context.reason === "restart") {
                return options.onWorkerRestarted?.(bootstrap);
            }

            return undefined;
        },
        onMessage: (message) => {
            const payload = message as AiWorkerEventMessage;
            if (payload.type !== "event") {
                return false;
            }

            switch (payload.event) {
                case "ai.snapshot.updated":
                    options.onSessionSnapshot?.(
                        payload.payload.ownerWindowId,
                        payload.payload.update,
                    );
                    return true;
                case "ai.runtime.status":
                    options.onRuntimeStatus?.(payload.payload.status);
                    return true;
                case "ai.session.closed":
                    options.onSessionClosed?.(payload.payload);
                    return true;
                case "ai.log":
                    options.onLog?.(payload.payload);
                    return true;
                default:
                    return false;
            }
        },
        timeoutMs: WORKER_TIMEOUTS_MS.ai,
    });
    const rpc = new AiRpcClient(supervisor);

    await rpc.ready();
    return new RemoteAiWorkerClient(rpc);
}

async function createAiWorkerConnection(): Promise<
    RpcWorkerConnection<AiWorkerBootstrapState>
> {
    const worker = new Worker(aiWorkerPath, {
        name: "comando-ai-worker",
    });
    const channel = new MessageChannel();
    worker.postMessage(
        {
            port: channel.port2,
        },
        [channel.port2],
    );
    const readyValue = await waitForWorkerReady(worker, channel.port1);

    return {
        port: channel.port1,
        readyValue,
        worker,
    };
}

function waitForWorkerReady(
    worker: Worker,
    port: MessagePort,
): Promise<AiWorkerBootstrapState> {
    return new Promise<AiWorkerBootstrapState>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            port.close();
            void worker.terminate();
            reject(
                new Error(
                    "Timed out waiting for the AI worker to become ready.",
                ),
            );
        }, WORKER_TIMEOUTS_MS.ai);
        timeout.unref?.();
        const cleanup = () => {
            clearTimeout(timeout);
            port.off("message", handleMessage);
            worker.off("error", handleError);
        };
        const handleError = (error: Error) => {
            cleanup();
            port.close();
            void worker.terminate();
            reject(error);
        };
        const handleMessage = (message: unknown) => {
            const payload = message as AiWorkerFatalMessage | AiWorkerReadyMessage;
            if (payload.type === "fatal") {
                cleanup();
                port.close();
                void worker.terminate();
                reject(deserializeWorkerError(payload.error));
                return;
            }

            if (payload.type === "ready") {
                cleanup();
                resolve(payload.bootstrap);
            }
        };

        port.on("message", handleMessage);
        worker.on("error", handleError);
        port.start?.();
    });
}

function deserializeWorkerError(input: {
    readonly message: string;
    readonly name: string;
    readonly stack?: string;
}): Error {
    const error = new Error(input.message);
    error.name = input.name;
    error.stack = input.stack;
    return error;
}
