import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";

import type {
    AiPermissionResponseInput,
    AiPromptResult,
    AiRuntimeStatus,
    AiSessionDomainEvent,
    AiSessionConfigOptionMutationInput,
    AiSessionModeMutationInput,
    AiSessionModelMutationInput,
    AiSessionRenameMutationInput,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiUserInputResponseInput,
    FileBufferNotificationInput,
} from "@shared/ipc";

import {
    type AiWorkerBootstrapState,
    type AiWorkerEventMessage,
    type AiWorkerFatalMessage,
    type AiWorkerFreezeSessionRpcInput,
    type AiWorkerFreezeSessionResult,
    type AiWorkerLogEventPayload,
    type AiWorkerGateway,
    type AiWorkerPrepareSessionRpcInput,
    type AiWorkerRefreshProjectScopesRpcInput,
    type AiWorkerReadyMessage,
    type AiWorkerReviewSessionRpcInput,
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
    readonly connect?: (
        context: AiWorkerConnectionContext,
    ) => Promise<RpcWorkerConnection<AiWorkerBootstrapState>>;
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
    readonly onSessionEvent?: (
        ownerWindowId: string,
        event: AiSessionDomainEvent,
    ) => void;
    readonly onWorkerRestarted?: (
        bootstrap: AiWorkerBootstrapState,
    ) => void | Promise<void>;
    readonly shardCount?: number;
}

export type AiWorkerClient = AiWorkerGateway;

export interface AiWorkerConnectionContext {
    readonly shardCount: number;
    readonly shardIndex: number;
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
        input: AiWorkerPrepareSessionRpcInput,
    ): Promise<AiSessionSnapshot> {
        return await this.#rpc.call("ai.prepareSession", input);
    }

    async sendPrompt(
        input: AiWorkerSendPromptRpcInput,
    ): Promise<AiPromptResult> {
        return await this.#rpc.call("ai.sendPrompt", input);
    }

    async cancelSession(sessionId: string): Promise<void> {
        await this.#rpc.call("ai.cancelSession", sessionId);
    }

    async closeSession(sessionId: string): Promise<void> {
        await this.#rpc.call("ai.closeSession", sessionId);
    }

    async freezeSession(
        input: AiWorkerFreezeSessionRpcInput,
    ): Promise<AiWorkerFreezeSessionResult> {
        return await this.#rpc.call("ai.freezeSession", input);
    }

    async closeOwnedByWindow(ownerWindowId: string): Promise<void> {
        await this.#rpc.call("ai.closeOwnedByWindow", ownerWindowId);
    }

    async keepTrackedFile(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileMutationInput>,
    ) {
        return await this.#rpc.call("ai.keepTrackedFile", input);
    }

    async rejectTrackedFile(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileMutationInput>,
    ) {
        return await this.#rpc.call("ai.rejectTrackedFile", input);
    }

    async keepTrackedFileHunks(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileHunkMutationInput>,
    ) {
        return await this.#rpc.call("ai.keepTrackedFileHunks", input);
    }

    async rejectTrackedFileHunks(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileHunkMutationInput>,
    ) {
        return await this.#rpc.call("ai.rejectTrackedFileHunks", input);
    }

    async keepAllTrackedFiles(
        input: AiWorkerReviewSessionRpcInput<string>,
    ) {
        return await this.#rpc.call("ai.keepAllTrackedFiles", input);
    }

    async rejectAllTrackedFiles(
        input: AiWorkerReviewSessionRpcInput<string>,
    ) {
        return await this.#rpc.call("ai.rejectAllTrackedFiles", input);
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

    async refreshProjectScopes(
        input: AiWorkerRefreshProjectScopesRpcInput,
    ): Promise<void> {
        await this.#rpc.call("ai.refreshProjectScopes", input);
    }

    async notifyFileBuffer(input: FileBufferNotificationInput): Promise<void> {
        await this.#rpc.call("ai.notifyFileBuffer", input);
    }

    async setSessionMode(input: AiSessionModeMutationInput): Promise<void> {
        await this.#rpc.call("ai.setSessionMode", input);
    }

    async setSessionModel(input: AiSessionModelMutationInput): Promise<void> {
        await this.#rpc.call("ai.setSessionModel", input);
    }

    async setSessionConfigOption(
        input: AiSessionConfigOptionMutationInput,
    ): Promise<void> {
        await this.#rpc.call("ai.setSessionConfigOption", input);
    }

    async renameSession(input: AiSessionRenameMutationInput): Promise<void> {
        await this.#rpc.call("ai.renameSession", input);
    }

    async close(): Promise<void> {
        await this.#rpc.close();
    }
}

class AiWorkerPool implements AiWorkerClient {
    readonly #shards: readonly RemoteAiWorkerClient[];

    constructor(shards: readonly RemoteAiWorkerClient[]) {
        if (shards.length === 0) {
            throw new Error("The AI worker pool needs at least one shard.");
        }
        this.#shards = shards;
    }

    async prepareSession(
        input: AiWorkerPrepareSessionRpcInput,
    ): Promise<AiSessionSnapshot> {
        return await this.#forSession(input.input.sessionId).prepareSession(
            input,
        );
    }

    async sendPrompt(
        input: AiWorkerSendPromptRpcInput,
    ): Promise<AiPromptResult> {
        return await this.#forSession(input.input.sessionId).sendPrompt(input);
    }

    async cancelSession(sessionId: string): Promise<void> {
        await this.#forSession(sessionId).cancelSession(sessionId);
    }

    async closeSession(sessionId: string): Promise<void> {
        await this.#forSession(sessionId).closeSession(sessionId);
    }

    async freezeSession(
        input: AiWorkerFreezeSessionRpcInput,
    ): Promise<AiWorkerFreezeSessionResult> {
        return await this.#forSession(input.sessionId).freezeSession(input);
    }

    async closeOwnedByWindow(ownerWindowId: string): Promise<void> {
        await Promise.all(
            this.#shards.map(async (shard) => {
                await shard.closeOwnedByWindow(ownerWindowId);
            }),
        );
    }

    async keepTrackedFile(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileMutationInput>,
    ) {
        return await this.#forSession(
            input.context.snapshot.sessionId,
        ).keepTrackedFile(input);
    }

    async rejectTrackedFile(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileMutationInput>,
    ) {
        return await this.#forSession(
            input.context.snapshot.sessionId,
        ).rejectTrackedFile(input);
    }

    async keepTrackedFileHunks(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileHunkMutationInput>,
    ) {
        return await this.#forSession(
            input.context.snapshot.sessionId,
        ).keepTrackedFileHunks(input);
    }

    async rejectTrackedFileHunks(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileHunkMutationInput>,
    ) {
        return await this.#forSession(
            input.context.snapshot.sessionId,
        ).rejectTrackedFileHunks(input);
    }

    async keepAllTrackedFiles(input: AiWorkerReviewSessionRpcInput<string>) {
        return await this.#forSession(
            input.context.snapshot.sessionId,
        ).keepAllTrackedFiles(input);
    }

    async rejectAllTrackedFiles(input: AiWorkerReviewSessionRpcInput<string>) {
        return await this.#forSession(
            input.context.snapshot.sessionId,
        ).rejectAllTrackedFiles(input);
    }

    async respondPermission(input: AiPermissionResponseInput): Promise<void> {
        await this.#forSession(input.sessionId).respondPermission(input);
    }

    async respondUserInput(input: AiUserInputResponseInput): Promise<void> {
        await this.#forSession(input.sessionId).respondUserInput(input);
    }

    async refreshProjectScopes(
        input: AiWorkerRefreshProjectScopesRpcInput,
    ): Promise<void> {
        const sessionsByShard = new Map<
            RemoteAiWorkerClient,
            AiWorkerRefreshProjectScopesRpcInput["sessions"]
        >();
        for (const session of input.sessions) {
            const shard = this.#forSession(session.input.sessionId);
            sessionsByShard.set(shard, [
                ...(sessionsByShard.get(shard) ?? []),
                session,
            ]);
        }

        await Promise.all(
            [...sessionsByShard.entries()].map(async ([shard, sessions]) => {
                await shard.refreshProjectScopes({
                    projectId: input.projectId,
                    sessions,
                });
            }),
        );
    }

    async notifyFileBuffer(input: FileBufferNotificationInput): Promise<void> {
        await Promise.all(
            this.#shards.map(async (shard) => {
                await shard.notifyFileBuffer(input);
            }),
        );
    }

    async setSessionMode(input: AiSessionModeMutationInput): Promise<void> {
        await this.#forSession(input.sessionId).setSessionMode(input);
    }

    async setSessionModel(input: AiSessionModelMutationInput): Promise<void> {
        await this.#forSession(input.sessionId).setSessionModel(input);
    }

    async setSessionConfigOption(
        input: AiSessionConfigOptionMutationInput,
    ): Promise<void> {
        await this.#forSession(input.sessionId).setSessionConfigOption(input);
    }

    async renameSession(input: AiSessionRenameMutationInput): Promise<void> {
        await this.#forSession(input.sessionId).renameSession(input);
    }

    async close(): Promise<void> {
        await Promise.all(
            this.#shards.map(async (shard) => {
                await shard.close();
            }),
        );
    }

    #forSession(sessionId: string): RemoteAiWorkerClient {
        return this.#shards[
            getAiWorkerShardIndex(sessionId, this.#shards.length)
        ];
    }
}

export async function createAiWorkerClient(
    options: AiWorkerClientOptions = {},
): Promise<AiWorkerClient> {
    const shardCount = normalizeAiWorkerShardCount(options.shardCount);
    const shards = await Promise.all(
        Array.from({ length: shardCount }, async (_, shardIndex) => {
            const supervisor = new RpcWorkerSupervisor<AiWorkerBootstrapState>({
                connect: async () =>
                    await (options.connect ?? createAiWorkerConnection)({
                        shardCount,
                        shardIndex,
                    }),
                domain: "ai",
                // The ACP protocol signals turn completion explicitly and child-process
                // exits are observed independently, so inference RPCs do not need a
                // wall-clock deadman — a slow turn would otherwise tear down the whole
                // worker and cancel every concurrent session.
                methodTimeoutsMs: {
                    "ai.respondUserInput": null,
                    "ai.sendPrompt": null,
                },
                onConnected: (bootstrap, context) => {
                    if (context.reason === "restart") {
                        return options.onWorkerRestarted?.(bootstrap);
                    }

                    return undefined;
                },
                onMessage: (message) => handleAiWorkerMessage(message, options),
                timeoutMs: WORKER_TIMEOUTS_MS.ai,
            });
            const rpc = new AiRpcClient(supervisor);

            await rpc.ready();
            return new RemoteAiWorkerClient(rpc);
        }),
    );

    return new AiWorkerPool(shards);
}

function handleAiWorkerMessage(
    message: unknown,
    options: AiWorkerClientOptions,
): boolean {
    const payload = message as AiWorkerEventMessage;
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
        case "ai.session.event":
            options.onSessionEvent?.(
                payload.payload.ownerWindowId,
                payload.payload.event,
            );
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
}

function normalizeAiWorkerShardCount(value: number | null | undefined): number {
    if (!Number.isFinite(value) || !value) {
        return 1;
    }

    return Math.max(1, Math.min(8, Math.floor(value)));
}

function getAiWorkerShardIndex(sessionId: string, shardCount: number): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < sessionId.length; index += 1) {
        hash ^= sessionId.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0) % shardCount;
}

async function createAiWorkerConnection(
    context: AiWorkerConnectionContext,
): Promise<
    RpcWorkerConnection<AiWorkerBootstrapState>
> {
    const worker = new Worker(aiWorkerPath, {
        name:
            context.shardCount > 1
                ? `comando-ai-worker-${context.shardIndex + 1}`
                : "comando-ai-worker",
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
        timeout.unref();
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

            cleanup();
            resolve(payload.bootstrap);
        };

        port.on("message", handleMessage);
        worker.on("error", handleError);
        port.start();
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
