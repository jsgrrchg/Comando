import path from "node:path";
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";

import { mainProcessPerformance } from "../observability/performance";
import {
    logWorkerClientCallFailure,
    RpcWorkerSupervisor,
    WORKER_TIMEOUTS_MS,
} from "../workers/supervisor";
import type { GitGateway } from "./service";
import gitWorkerPath from "./worker?modulePath";

interface GitWorkerReadyMessage {
    readonly type: "ready";
}

interface GitWorkerFatalMessage {
    readonly error: {
        readonly message: string;
        readonly name: string;
        readonly stack?: string;
    };
    readonly type: "fatal";
}

export interface GitWorkerClient extends GitGateway {
    close(): Promise<void>;
}

class GitRpcClient {
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

class GitWorkerGateway implements GitWorkerClient {
    readonly #rpc: GitRpcClient;

    constructor(rpc: GitRpcClient) {
        this.#rpc = rpc;
    }

    async resolveRepository(inputPath: string) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["resolveRepository"]>>
        >("git.resolveRepository", inputPath);
    }

    async getRepositorySnapshot(inputPath: string) {
        return await mainProcessPerformance.measureAsync(
            "git.getRepositorySnapshot",
            async () =>
                await this.#rpc.call<
                    Awaited<ReturnType<GitGateway["getRepositorySnapshot"]>>
                >("git.getRepositorySnapshot", inputPath),
            {
                inputPath: path.resolve(inputPath),
                transport: "worker",
            },
        );
    }

    async getStatus(inputPath: string) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["getStatus"]>>
        >("git.getStatus", inputPath);
    }

    async getSyncStatus(inputPath: string) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["getSyncStatus"]>>
        >("git.getSyncStatus", inputPath);
    }

    async listWorktrees(inputPath: string) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["listWorktrees"]>>
        >("git.listWorktrees", inputPath);
    }

    async listBranches(
        inputPath: string,
        options?: Parameters<GitGateway["listBranches"]>[1],
    ) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["listBranches"]>>
        >("git.listBranches", {
            inputPath,
            options,
        });
    }

    async listRemotes(
        inputPath: string,
        trackingBranchName: string | null,
        aheadBy: number,
        behindBy: number,
    ) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["listRemotes"]>>
        >("git.listRemotes", {
            aheadBy,
            behindBy,
            inputPath,
            trackingBranchName,
        });
    }

    async getDiffStats(inputPath: string) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["getDiffStats"]>>
        >("git.getDiffStats", inputPath);
    }

    async getFileDiff(
        inputPath: string,
        relativePath: string,
        options?: Parameters<GitGateway["getFileDiff"]>[2],
    ) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["getFileDiff"]>>
        >("git.getFileDiff", {
            inputPath,
            options,
            relativePath,
        });
    }

    async listHistory(
        inputPath: string,
        options?: Parameters<GitGateway["listHistory"]>[1],
    ) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["listHistory"]>>
        >("git.listHistory", {
            inputPath,
            options,
        });
    }

    async getCommitDetail(inputPath: string, commitSha: string) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["getCommitDetail"]>>
        >("git.getCommitDetail", {
            commitSha,
            inputPath,
        });
    }

    async stagePaths(inputPath: string, relativePaths: readonly string[]) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["stagePaths"]>>
        >("git.stagePaths", {
            inputPath,
            relativePaths,
        });
    }

    async unstagePaths(inputPath: string, relativePaths: readonly string[]) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["unstagePaths"]>>
        >("git.unstagePaths", {
            inputPath,
            relativePaths,
        });
    }

    async discardPaths(inputPath: string, relativePaths: readonly string[]) {
        return await mainProcessPerformance.measureAsync(
            "git.discardPaths",
            async () =>
                await this.#rpc.call<
                    Awaited<ReturnType<GitGateway["discardPaths"]>>
                >("git.discardPaths", {
                    inputPath,
                    relativePaths,
                }),
            {
                inputPath: path.resolve(inputPath),
                pathCount: relativePaths.length,
                transport: "worker",
            },
        );
    }

    async commit(
        inputPath: string,
        message: string,
        options?: Parameters<GitGateway["commit"]>[2],
    ) {
        return await this.#rpc.call<Awaited<ReturnType<GitGateway["commit"]>>>(
            "git.commit",
            {
                inputPath,
                message,
                options,
            },
        );
    }

    async checkoutBranch(
        inputPath: string,
        options: Parameters<GitGateway["checkoutBranch"]>[1],
    ) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["checkoutBranch"]>>
        >("git.checkoutBranch", {
            inputPath,
            options,
        });
    }

    async createWorktree(
        inputPath: string,
        options: Parameters<GitGateway["createWorktree"]>[1],
    ) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["createWorktree"]>>
        >("git.createWorktree", {
            inputPath,
            options,
        });
    }

    async removeWorktree(
        inputPath: string,
        options: Parameters<GitGateway["removeWorktree"]>[1],
    ) {
        return await this.#rpc.call<
            Awaited<ReturnType<GitGateway["removeWorktree"]>>
        >("git.removeWorktree", {
            inputPath,
            options,
        });
    }

    async fetch(
        inputPath: string,
        options?: Parameters<GitGateway["fetch"]>[1],
    ) {
        return await this.#rpc.call<Awaited<ReturnType<GitGateway["fetch"]>>>(
            "git.fetch",
            {
                inputPath,
                options,
            },
        );
    }

    async pull(inputPath: string, options?: Parameters<GitGateway["pull"]>[1]) {
        return await this.#rpc.call<Awaited<ReturnType<GitGateway["pull"]>>>(
            "git.pull",
            {
                inputPath,
                options,
            },
        );
    }

    async push(inputPath: string, options?: Parameters<GitGateway["push"]>[1]) {
        return await this.#rpc.call<Awaited<ReturnType<GitGateway["push"]>>>(
            "git.push",
            {
                inputPath,
                options,
            },
        );
    }

    invalidate(inputPath?: string): void {
        void this.#rpc.call("git.invalidate", inputPath).catch((error) => {
            logGitWorkerError("git.invalidate", error);
        });
    }

    clear(): void {
        void this.#rpc.call("git.clear").catch((error) => {
            logGitWorkerError("git.clear", error);
        });
    }

    async close(): Promise<void> {
        await this.#rpc.close();
    }
}

export async function createGitWorkerClient(): Promise<GitWorkerClient> {
    const supervisor = new RpcWorkerSupervisor<void>({
        connect: async () => {
            const worker = new Worker(gitWorkerPath, {
                name: "comando-git-worker",
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
        },
        domain: "git",
        timeoutMs: WORKER_TIMEOUTS_MS.git,
    });
    const rpc = new GitRpcClient(supervisor);

    await rpc.ready();
    return new GitWorkerGateway(rpc);
}

function waitForWorkerReady(worker: Worker, port: MessagePort): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            port.close();
            void worker.terminate();
            reject(
                new Error(
                    "Timed out waiting for the git worker to become ready.",
                ),
            );
        }, WORKER_TIMEOUTS_MS.git);
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
            const payload = message as
                | GitWorkerFatalMessage
                | GitWorkerReadyMessage;
            if (payload.type === "fatal") {
                cleanup();
                port.close();
                void worker.terminate();
                reject(deserializeWorkerError(payload.error));
                return;
            }

            if (payload.type === "ready") {
                cleanup();
                resolve();
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

function logGitWorkerError(method: string, error: unknown): void {
    logWorkerClientCallFailure("git", method, error);
}
