import { parentPort, type MessagePort } from "node:worker_threads";

import { ProjectRuntime } from "./runtime";

interface ProjectWorkerInitMessage {
    readonly port: MessagePort;
}

interface ProjectWorkerRequest {
    readonly id: number;
    readonly method: string;
    readonly params?: unknown;
}

interface ProjectWorkerResponse {
    readonly error?: SerializedError;
    readonly id: number;
    readonly result?: unknown;
}

interface ProjectWorkerReadyMessage {
    readonly type: "ready";
}

interface ProjectWorkerFatalMessage {
    readonly error: SerializedError;
    readonly type: "fatal";
}

interface ProjectWorkerEventMessage {
    readonly event: "project.invalidated";
    readonly payload: Parameters<
        ConstructorParameters<typeof ProjectRuntime>[0]["onProjectTreeInvalidated"]
    >[0];
    readonly type: "event";
}

interface SerializedError {
    readonly message: string;
    readonly name: string;
    readonly stack?: string;
}

let projectRuntime: ProjectRuntime | null = null;
let rpcPort: MessagePort | null = null;

parentPort?.once("message", (message: unknown) => {
    initializeWorker(message as ProjectWorkerInitMessage);
});

function initializeWorker(message: ProjectWorkerInitMessage): void {
    try {
        rpcPort = message.port;
        projectRuntime = new ProjectRuntime({
            onProjectTreeInvalidated: (payload) => {
                rpcPort?.postMessage({
                    event: "project.invalidated",
                    payload,
                    type: "event",
                } satisfies ProjectWorkerEventMessage);
            },
        });

        rpcPort.on("message", (request: unknown) => {
            void handleRequest(request as ProjectWorkerRequest);
        });
        rpcPort.start();
        rpcPort.postMessage({
            type: "ready",
        } satisfies ProjectWorkerReadyMessage);
    } catch (error) {
        const payload = {
            error: serializeError(error),
            type: "fatal",
        } satisfies ProjectWorkerFatalMessage;

        message.port.postMessage(payload);
    }
}

async function handleRequest(request: ProjectWorkerRequest): Promise<void> {
    if (!rpcPort) {
        return;
    }

    if (request.method === "system.shutdown") {
        try {
            rpcPort.postMessage({
                id: request.id,
                result: true,
            } satisfies ProjectWorkerResponse);
        } finally {
            projectRuntime?.close();
            rpcPort.close();
        }
        return;
    }

    try {
        const result = await dispatchMethod(request.method, request.params);
        rpcPort.postMessage({
            id: request.id,
            result,
        } satisfies ProjectWorkerResponse);
    } catch (error) {
        rpcPort.postMessage({
            error: serializeError(error),
            id: request.id,
        } satisfies ProjectWorkerResponse);
    }
}

async function dispatchMethod(method: string, params: unknown): Promise<unknown> {
    if (!projectRuntime) {
        throw new Error("The project worker is not initialized yet.");
    }

    switch (method) {
        case "projects.syncRegistry":
            projectRuntime.syncRegistry(
                params as Parameters<ProjectRuntime["syncRegistry"]>[0],
            );
            return null;
        case "projects.removeProject":
            projectRuntime.removeProject(params as string);
            return null;
        case "projects.listProjectTreeChildren":
            return await projectRuntime.listProjectTreeChildren(
                params as Parameters<ProjectRuntime["listProjectTreeChildren"]>[0],
            );
        case "projects.listProjectEntries":
            return await projectRuntime.listProjectEntries(
                params as Parameters<ProjectRuntime["listProjectEntries"]>[0],
            );
        case "projects.openProjectFile":
            return await projectRuntime.openProjectFile(
                params as Parameters<ProjectRuntime["openProjectFile"]>[0],
            );
        case "projects.saveProjectFile":
            return await projectRuntime.saveProjectFile(
                params as Parameters<ProjectRuntime["saveProjectFile"]>[0],
            );
        case "projects.createProjectEntry":
            return await projectRuntime.createProjectEntry(
                params as Parameters<ProjectRuntime["createProjectEntry"]>[0],
            );
        case "projects.copyProjectEntries":
            return await projectRuntime.copyProjectEntries(
                params as Parameters<ProjectRuntime["copyProjectEntries"]>[0],
            );
        case "projects.renameProjectEntry":
            return await projectRuntime.renameProjectEntry(
                params as Parameters<ProjectRuntime["renameProjectEntry"]>[0],
            );
        case "projects.deleteProjectEntry":
            await projectRuntime.deleteProjectEntry(
                params as Parameters<ProjectRuntime["deleteProjectEntry"]>[0],
            );
            return;
        case "projects.searchProjectEntries":
            return await projectRuntime.searchProjectEntries(
                params as Parameters<ProjectRuntime["searchProjectEntries"]>[0],
            );
        default:
            throw new Error(`Unknown project worker method: ${method}`);
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
