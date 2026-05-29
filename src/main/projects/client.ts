import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";

import type {
    ProjectEntryMutationResult,
    ProjectFileDocument,
    ProjectTreeInvalidation,
    ProjectTreeNode,
} from "@shared/ipc";

import {
    ProjectRuntime,
    type ProjectRuntimeCreateEntryInput,
    type ProjectRuntimeDeleteEntryInput,
    type ProjectRuntimeListEntriesInput,
    type ProjectRuntimeOpenFileInput,
    type ProjectRuntimeRegistrySnapshot,
    type ProjectRuntimeRenameEntryInput,
    type ProjectRuntimeSaveFileInput,
    type ProjectRuntimeSearchInput,
    type ProjectRuntimeSearchResponse,
    type ProjectRuntimeTreeInput,
} from "./runtime";
import { RpcWorkerSupervisor, WORKER_TIMEOUTS_MS } from "../workers/supervisor";
import projectWorkerPath from "./worker?modulePath";

interface ProjectWorkerReadyMessage {
    readonly type: "ready";
}

interface ProjectWorkerFatalMessage {
    readonly error: SerializedError;
    readonly type: "fatal";
}

interface ProjectWorkerEventMessage {
    readonly event: "project.invalidated";
    readonly payload: ProjectTreeInvalidation;
    readonly type: "event";
}

interface SerializedError {
    readonly message: string;
    readonly name: string;
    readonly stack?: string;
}

export interface ProjectWorkerClientOptions {
    readonly onProjectTreeInvalidated: (
        payload: ProjectTreeInvalidation,
    ) => void;
    readonly onWorkerRestarted?: () => void;
}

export interface ProjectWorkerGateway {
    syncRegistry(snapshot: ProjectRuntimeRegistrySnapshot): Promise<void>;
    refreshAfterRestart(): Promise<void>;
    removeProject(projectId: string): Promise<void>;
    listProjectTreeChildren(
        input: ProjectRuntimeTreeInput,
    ): Promise<readonly ProjectTreeNode[]>;
    listProjectEntries(
        input: ProjectRuntimeListEntriesInput,
    ): Promise<ProjectRuntimeSearchResponse>;
    openProjectFile(
        input: ProjectRuntimeOpenFileInput,
    ): Promise<ProjectFileDocument>;
    saveProjectFile(
        input: ProjectRuntimeSaveFileInput,
    ): Promise<ProjectFileDocument>;
    createProjectEntry(
        input: ProjectRuntimeCreateEntryInput,
    ): Promise<ProjectEntryMutationResult>;
    renameProjectEntry(
        input: ProjectRuntimeRenameEntryInput,
    ): Promise<ProjectEntryMutationResult>;
    deleteProjectEntry(input: ProjectRuntimeDeleteEntryInput): Promise<void>;
    searchProjectEntries(
        input: ProjectRuntimeSearchInput,
    ): Promise<ProjectRuntimeSearchResponse>;
    close(): Promise<void>;
}

class ProjectRpcClient {
    readonly #supervisor: RpcWorkerSupervisor<void>;

    constructor(supervisor: RpcWorkerSupervisor<void>) {
        this.#supervisor = supervisor;
    }

    async ready(): Promise<void> {
        await this.#supervisor.ready();
    }

    async call<TResult>(method: string, params?: unknown): Promise<TResult> {
        return await this.#supervisor.call<TResult>(method, params);
    }

    async close(): Promise<void> {
        await this.#supervisor.close();
    }
}

class RemoteProjectWorkerClient implements ProjectWorkerGateway {
    readonly #rpc: ProjectRpcClient;

    constructor(rpc: ProjectRpcClient) {
        this.#rpc = rpc;
    }

    async syncRegistry(
        snapshot: ProjectRuntimeRegistrySnapshot,
    ): Promise<void> {
        await this.#rpc.call("projects.syncRegistry", snapshot);
    }

    refreshAfterRestart(): Promise<void> {
        return Promise.resolve();
    }

    async removeProject(projectId: string): Promise<void> {
        await this.#rpc.call("projects.removeProject", projectId);
    }

    async listProjectTreeChildren(
        input: ProjectRuntimeTreeInput,
    ): Promise<readonly ProjectTreeNode[]> {
        return await this.#rpc.call("projects.listProjectTreeChildren", input);
    }

    async listProjectEntries(
        input: ProjectRuntimeListEntriesInput,
    ): Promise<ProjectRuntimeSearchResponse> {
        return await this.#rpc.call("projects.listProjectEntries", input);
    }

    async openProjectFile(
        input: ProjectRuntimeOpenFileInput,
    ): Promise<ProjectFileDocument> {
        return await this.#rpc.call("projects.openProjectFile", input);
    }

    async saveProjectFile(
        input: ProjectRuntimeSaveFileInput,
    ): Promise<ProjectFileDocument> {
        return await this.#rpc.call("projects.saveProjectFile", input);
    }

    async createProjectEntry(
        input: ProjectRuntimeCreateEntryInput,
    ): Promise<ProjectEntryMutationResult> {
        return await this.#rpc.call("projects.createProjectEntry", input);
    }

    async renameProjectEntry(
        input: ProjectRuntimeRenameEntryInput,
    ): Promise<ProjectEntryMutationResult> {
        return await this.#rpc.call("projects.renameProjectEntry", input);
    }

    async deleteProjectEntry(
        input: ProjectRuntimeDeleteEntryInput,
    ): Promise<void> {
        await this.#rpc.call("projects.deleteProjectEntry", input);
    }

    async searchProjectEntries(
        input: ProjectRuntimeSearchInput,
    ): Promise<ProjectRuntimeSearchResponse> {
        return await this.#rpc.call("projects.searchProjectEntries", input);
    }

    async close(): Promise<void> {
        await this.#rpc.close();
    }
}

class LocalProjectWorkerClient implements ProjectWorkerGateway {
    readonly #onProjectTreeInvalidated: (
        payload: ProjectTreeInvalidation,
    ) => void;
    #runtime: ProjectRuntime;

    constructor(options: ProjectWorkerClientOptions) {
        this.#onProjectTreeInvalidated = options.onProjectTreeInvalidated;
        this.#runtime = this.#createRuntime();
    }

    syncRegistry(snapshot: ProjectRuntimeRegistrySnapshot): Promise<void> {
        this.#runtime.syncRegistry(snapshot);
        return Promise.resolve();
    }

    refreshAfterRestart(): Promise<void> {
        this.#runtime.close();
        this.#runtime = this.#createRuntime();
        return Promise.resolve();
    }

    removeProject(projectId: string): Promise<void> {
        this.#runtime.removeProject(projectId);
        return Promise.resolve();
    }

    async listProjectTreeChildren(
        input: ProjectRuntimeTreeInput,
    ): Promise<readonly ProjectTreeNode[]> {
        return await this.#runtime.listProjectTreeChildren(input);
    }

    async listProjectEntries(
        input: ProjectRuntimeListEntriesInput,
    ): Promise<ProjectRuntimeSearchResponse> {
        return await this.#runtime.listProjectEntries(input);
    }

    async openProjectFile(
        input: ProjectRuntimeOpenFileInput,
    ): Promise<ProjectFileDocument> {
        return await this.#runtime.openProjectFile(input);
    }

    async saveProjectFile(
        input: ProjectRuntimeSaveFileInput,
    ): Promise<ProjectFileDocument> {
        return await this.#runtime.saveProjectFile(input);
    }

    async createProjectEntry(
        input: ProjectRuntimeCreateEntryInput,
    ): Promise<ProjectEntryMutationResult> {
        return await this.#runtime.createProjectEntry(input);
    }

    async renameProjectEntry(
        input: ProjectRuntimeRenameEntryInput,
    ): Promise<ProjectEntryMutationResult> {
        return await this.#runtime.renameProjectEntry(input);
    }

    async deleteProjectEntry(
        input: ProjectRuntimeDeleteEntryInput,
    ): Promise<void> {
        await this.#runtime.deleteProjectEntry(input);
    }

    async searchProjectEntries(
        input: ProjectRuntimeSearchInput,
    ): Promise<ProjectRuntimeSearchResponse> {
        return await this.#runtime.searchProjectEntries(input);
    }

    close(): Promise<void> {
        this.#runtime.close();
        return Promise.resolve();
    }

    #createRuntime(): ProjectRuntime {
        return new ProjectRuntime({
            onProjectTreeInvalidated: this.#onProjectTreeInvalidated,
        });
    }
}

export function createLocalProjectWorkerClient(
    options: ProjectWorkerClientOptions,
): ProjectWorkerGateway {
    return new LocalProjectWorkerClient(options);
}

export async function createProjectWorkerClient(
    options: ProjectWorkerClientOptions,
): Promise<ProjectWorkerGateway> {
    const supervisor = new RpcWorkerSupervisor<void>({
        connect: async () => {
            const worker = new Worker(projectWorkerPath, {
                name: "comando-project-worker",
            });
            const channel = new MessageChannel();
            worker.postMessage(
                {
                    port: channel.port2,
                },
                [channel.port2],
            );
            await waitForWorkerReady(worker, channel.port1);

            return {
                port: channel.port1,
                readyValue: undefined,
                worker,
            };
        },
        domain: "projects",
        onConnected: (_readyValue, context) => {
            if (context.reason === "restart") {
                options.onWorkerRestarted?.();
            }
        },
        onMessage: (message) => {
            const payload = message as ProjectWorkerEventMessage;
            options.onProjectTreeInvalidated(payload.payload);
            return true;
        },
        timeoutMs: WORKER_TIMEOUTS_MS.projects,
    });
    const rpc = new ProjectRpcClient(supervisor);

    await rpc.ready();
    return new RemoteProjectWorkerClient(rpc);
}

function waitForWorkerReady(worker: Worker, port: MessagePort): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            port.close();
            void worker.terminate();
            reject(
                new Error(
                    "Timed out waiting for the project worker to become ready.",
                ),
            );
        }, WORKER_TIMEOUTS_MS.projects);
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
            const payload = message as
                | ProjectWorkerFatalMessage
                | ProjectWorkerReadyMessage;
            if (payload.type === "fatal") {
                cleanup();
                port.close();
                void worker.terminate();
                reject(deserializeWorkerError(payload.error));
                return;
            }

            cleanup();
            resolve();
        };

        port.on("message", handleMessage);
        worker.on("error", handleError);
        port.start();
    });
}

function deserializeWorkerError(input: SerializedError): Error {
    const error = new Error(input.message);
    error.name = input.name;
    error.stack = input.stack;
    return error;
}
