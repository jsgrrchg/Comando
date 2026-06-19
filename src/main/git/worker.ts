import { parentPort, type MessagePort } from "node:worker_threads";

import { GitService } from "./service";

interface GitWorkerInitMessage {
    readonly port: MessagePort;
}

interface GitWorkerRequest {
    readonly id: number;
    readonly method: string;
    readonly params?: unknown;
}

interface GitWorkerResponse {
    readonly error?: SerializedError;
    readonly id: number;
    readonly result?: unknown;
}

interface SerializedError {
    readonly message: string;
    readonly name: string;
    readonly stack?: string;
}

interface GitWorkerReadyMessage {
    readonly type: "ready";
}

interface GitWorkerFatalMessage {
    readonly error: SerializedError;
    readonly type: "fatal";
}

let gitService: GitService | null = null;
let rpcPort: MessagePort | null = null;

parentPort?.once("message", (message: unknown) => {
    initializeWorker(message as GitWorkerInitMessage);
});

function initializeWorker(message: GitWorkerInitMessage): void {
    try {
        gitService = new GitService();
        rpcPort = message.port;

        rpcPort.on("message", (request: unknown) => {
            void handleRequest(request as GitWorkerRequest);
        });
        rpcPort.start();
        rpcPort.postMessage({
            type: "ready",
        } satisfies GitWorkerReadyMessage);
    } catch (error) {
        const payload = {
            error: serializeError(error),
            type: "fatal",
        } satisfies GitWorkerFatalMessage;

        message.port.postMessage(payload);
    }
}

async function handleRequest(request: GitWorkerRequest): Promise<void> {
    if (!rpcPort) {
        return;
    }

    if (request.method === "system.shutdown") {
        try {
            rpcPort.postMessage({
                id: request.id,
                result: true,
            } satisfies GitWorkerResponse);
        } finally {
            gitService?.clear();
            rpcPort.close();
        }
        return;
    }

    try {
        const result = await dispatchMethod(request.method, request.params);
        rpcPort.postMessage({
            id: request.id,
            result,
        } satisfies GitWorkerResponse);
    } catch (error) {
        rpcPort.postMessage({
            error: serializeError(error),
            id: request.id,
        } satisfies GitWorkerResponse);
    }
}

async function dispatchMethod(
    method: string,
    params: unknown,
): Promise<unknown> {
    if (!gitService) {
        throw new Error("The Git worker is not initialized yet.");
    }

    switch (method) {
        case "git.resolveRepository":
            return await gitService.resolveRepository(params as string);
        case "git.getRepositorySnapshot":
            return await gitService.getRepositorySnapshot(params as string);
        case "git.getStatus":
            return await gitService.getStatus(params as string);
        case "git.getSyncStatus":
            return await gitService.getSyncStatus(params as string);
        case "git.listWorktrees":
            return await gitService.listWorktrees(params as string);
        case "git.listBranches": {
            const input = params as {
                readonly inputPath: string;
                readonly options?: Parameters<GitService["listBranches"]>[1];
            };
            return await gitService.listBranches(
                input.inputPath,
                input.options,
            );
        }
        case "git.listRemotes": {
            const input = params as {
                readonly aheadBy: number;
                readonly behindBy: number;
                readonly inputPath: string;
                readonly trackingBranchName: string | null;
            };
            return await gitService.listRemotes(
                input.inputPath,
                input.trackingBranchName,
                input.aheadBy,
                input.behindBy,
            );
        }
        case "git.getDiffStats":
            return await gitService.getDiffStats(params as string);
        case "git.getFileDiff": {
            const input = params as {
                readonly inputPath: string;
                readonly options?: Parameters<GitService["getFileDiff"]>[2];
                readonly relativePath: string;
            };
            return await gitService.getFileDiff(
                input.inputPath,
                input.relativePath,
                input.options,
            );
        }
        case "git.getFileText": {
            const input = params as {
                readonly inputPath: string;
                readonly reference: Parameters<GitService["getFileText"]>[2];
                readonly relativePath: string;
            };
            return await gitService.getFileText(
                input.inputPath,
                input.relativePath,
                input.reference,
            );
        }
        case "git.listHistory": {
            const input = params as {
                readonly inputPath: string;
                readonly options?: Parameters<GitService["listHistory"]>[1];
            };
            return await gitService.listHistory(input.inputPath, input.options);
        }
        case "git.getCommitDetail": {
            const input = params as {
                readonly commitSha: string;
                readonly inputPath: string;
            };
            return await gitService.getCommitDetail(
                input.inputPath,
                input.commitSha,
            );
        }
        case "git.initRepository":
            return await gitService.initRepository(params as string);
        case "git.stagePaths": {
            const input = params as {
                readonly inputPath: string;
                readonly relativePaths: readonly string[];
            };
            return await gitService.stagePaths(
                input.inputPath,
                input.relativePaths,
            );
        }
        case "git.unstagePaths": {
            const input = params as {
                readonly inputPath: string;
                readonly relativePaths: readonly string[];
            };
            return await gitService.unstagePaths(
                input.inputPath,
                input.relativePaths,
            );
        }
        case "git.discardPaths": {
            const input = params as {
                readonly inputPath: string;
                readonly relativePaths: readonly string[];
            };
            return await gitService.discardPaths(
                input.inputPath,
                input.relativePaths,
            );
        }
        case "git.commit": {
            const input = params as {
                readonly inputPath: string;
                readonly message: string;
                readonly options?: Parameters<GitService["commit"]>[2];
            };
            return await gitService.commit(
                input.inputPath,
                input.message,
                input.options,
            );
        }
        case "git.checkoutBranch": {
            const input = params as {
                readonly inputPath: string;
                readonly options: Parameters<GitService["checkoutBranch"]>[1];
            };
            return await gitService.checkoutBranch(
                input.inputPath,
                input.options,
            );
        }
        case "git.createWorktree": {
            const input = params as {
                readonly inputPath: string;
                readonly options: Parameters<GitService["createWorktree"]>[1];
            };
            return await gitService.createWorktree(
                input.inputPath,
                input.options,
            );
        }
        case "git.removeWorktree": {
            const input = params as {
                readonly inputPath: string;
                readonly options: Parameters<GitService["removeWorktree"]>[1];
            };
            return await gitService.removeWorktree(
                input.inputPath,
                input.options,
            );
        }
        case "git.deleteLocalBranch": {
            const input = params as {
                readonly inputPath: string;
                readonly options: Parameters<
                    GitService["deleteLocalBranch"]
                >[1];
            };
            return await gitService.deleteLocalBranch(
                input.inputPath,
                input.options,
            );
        }
        case "git.deleteRemoteBranch": {
            const input = params as {
                readonly inputPath: string;
                readonly options: Parameters<
                    GitService["deleteRemoteBranch"]
                >[1];
            };
            return await gitService.deleteRemoteBranch(
                input.inputPath,
                input.options,
            );
        }
        case "git.fetch": {
            const input = params as {
                readonly inputPath: string;
                readonly options?: Parameters<GitService["fetch"]>[1];
            };
            return await gitService.fetch(input.inputPath, input.options);
        }
        case "git.pull": {
            const input = params as {
                readonly inputPath: string;
                readonly options?: Parameters<GitService["pull"]>[1];
            };
            return await gitService.pull(input.inputPath, input.options);
        }
        case "git.push": {
            const input = params as {
                readonly inputPath: string;
                readonly options?: Parameters<GitService["push"]>[1];
            };
            return await gitService.push(input.inputPath, input.options);
        }
        case "git.invalidate":
            gitService.invalidate(params as string | undefined);
            return null;
        case "git.clear":
            gitService.clear();
            return null;
        default:
            throw new Error(`Unknown Git worker method: ${method}`);
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
