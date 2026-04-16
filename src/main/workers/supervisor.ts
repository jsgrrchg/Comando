import type { MessagePort, Worker } from "node:worker_threads";

import {
    mainProcessPerformance,
    type PerformanceOperationName,
} from "../observability/performance";

export type WorkerDomain = "db" | "git" | "projects";

export interface SerializedWorkerError {
    readonly message: string;
    readonly name: string;
    readonly stack?: string;
}

export interface RpcWorkerConnection<TReady> {
    readonly port: MessagePort;
    readonly readyValue: TReady;
    readonly worker: Worker;
}

interface RpcWorkerRequest {
    readonly id: number;
    readonly method: string;
    readonly params?: unknown;
    readonly requestId: string;
}

interface RpcWorkerResponse {
    readonly error?: SerializedWorkerError;
    readonly id: number;
    readonly result?: unknown;
}

interface PendingRequest {
    readonly method: string;
    readonly reject: (error: Error) => void;
    readonly requestId: string;
    readonly resolve: (value: unknown) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
}

interface ManagedConnection<TReady> extends RpcWorkerConnection<TReady> {
    cleanup(): void;
    faulted: boolean;
}

interface WorkerConnectedContext {
    readonly reason: "initial" | "restart";
}

export interface RpcWorkerSupervisorOptions<TReady> {
    readonly connect: () => Promise<RpcWorkerConnection<TReady>>;
    readonly domain: WorkerDomain;
    readonly onConnected?: (
        readyValue: TReady,
        context: WorkerConnectedContext,
    ) => void | Promise<void>;
    readonly onMessage?: (message: unknown) => boolean;
    readonly timeoutMs: number;
}

export const WORKER_TIMEOUTS_MS: Record<WorkerDomain, number> = {
    db: 5_000,
    git: 90_000,
    projects: 15_000,
};

const RESTART_BASE_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 5_000;
const DOMAIN_OPERATION: Record<WorkerDomain, PerformanceOperationName> = {
    db: "workers.db.rpc",
    git: "workers.git.rpc",
    projects: "workers.projects.rpc",
};

export class RpcWorkerSupervisor<TReady> {
    readonly #connect: () => Promise<RpcWorkerConnection<TReady>>;
    readonly #domain: WorkerDomain;
    readonly #onConnected?: (
        readyValue: TReady,
        context: WorkerConnectedContext,
    ) => void | Promise<void>;
    readonly #onMessage?: (message: unknown) => boolean;
    readonly #pending = new Map<number, PendingRequest>();
    readonly #timeoutMs: number;
    #closed = false;
    #connectPromise: Promise<ManagedConnection<TReady>> | null = null;
    #connection: ManagedConnection<TReady> | null = null;
    #hasConnectedOnce = false;
    #nextRequestId = 1;
    #restartAttempt = 0;
    #restartTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: RpcWorkerSupervisorOptions<TReady>) {
        this.#connect = options.connect;
        this.#domain = options.domain;
        this.#onConnected = options.onConnected;
        this.#onMessage = options.onMessage;
        this.#timeoutMs = options.timeoutMs;
    }

    async ready(): Promise<TReady> {
        const connection = await this.#ensureConnection();
        return connection.readyValue;
    }

    async call<TResult>(method: string, params?: unknown): Promise<TResult> {
        if (this.#closed) {
            throw createAlreadyClosedWorkerError(this.#domain);
        }

        const id = this.#nextRequestId++;
        const requestId = `${this.#domain}-${id}`;

        return await mainProcessPerformance.measureAsync(
            DOMAIN_OPERATION[this.#domain],
            async () => {
                const connection = await this.#ensureConnection();
                return await this.#dispatchRequest<TResult>(
                    connection,
                    id,
                    method,
                    params,
                    requestId,
                );
            },
            {
                method,
                requestId,
            },
        );
    }

    async close(): Promise<void> {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        this.#clearRestartTimer();

        const connecting = this.#connectPromise;
        const connection =
            this.#connection ??
            (connecting ? await connecting.catch(() => null) : null);
        if (!connection) {
            this.#rejectPending(createClosedWorkerError(this.#domain));
            return;
        }

        try {
            await this.#dispatchRequest(
                connection,
                this.#nextRequestId++,
                "system.shutdown",
                undefined,
                `${this.#domain}-shutdown`,
            );
        } catch {
            // Ignore graceful shutdown failures during app exit.
        }

        this.#disposeConnection(connection);
        this.#connection = null;
        this.#rejectPending(createClosedWorkerError(this.#domain));

        try {
            connection.port.close();
        } catch {
            // Ignore repeated port shutdown attempts.
        }

        await connection.worker.terminate();
    }

    async #ensureConnection(): Promise<ManagedConnection<TReady>> {
        if (this.#closed) {
            throw createAlreadyClosedWorkerError(this.#domain);
        }

        if (this.#connection) {
            return this.#connection;
        }

        this.#clearRestartTimer();

        if (!this.#connectPromise) {
            const reason = this.#hasConnectedOnce ? "restart" : "initial";
            this.#connectPromise = this.#connectAndBind(reason)
                .catch((error) => {
                    if (!this.#closed && this.#hasConnectedOnce) {
                        this.#scheduleRestart();
                    }
                    throw error;
                })
                .finally(() => {
                    this.#connectPromise = null;
                });
        }

        return await this.#connectPromise;
    }

    async #connectAndBind(
        reason: "initial" | "restart",
    ): Promise<ManagedConnection<TReady>> {
        if (reason === "restart") {
            logWorkerEvent("warn", this.#domain, "restart-started", {
                attempt: this.#restartAttempt,
            });
        }

        const connection = await this.#connect();
        const managedConnection = this.#bindConnection(connection);

        this.#connection = managedConnection;
        this.#hasConnectedOnce = true;
        this.#restartAttempt = 0;
        logWorkerEvent("info", this.#domain, "ready", {
            reason,
            threadId: managedConnection.worker.threadId,
        });

        if (this.#onConnected) {
            void Promise.resolve(
                this.#onConnected(managedConnection.readyValue, { reason }),
            ).catch((error) => {
                logWorkerEvent("warn", this.#domain, "on-connected-failed", {
                    error: formatErrorMessage(error),
                });
            });
        }

        return managedConnection;
    }

    #bindConnection(
        connection: RpcWorkerConnection<TReady>,
    ): ManagedConnection<TReady> {
        const handleMessage = (message: unknown) => {
            if (this.#onMessage?.(message)) {
                return;
            }

            const response = message as RpcWorkerResponse;
            if (typeof response.id !== "number") {
                return;
            }

            const pending = this.#pending.get(response.id);
            if (!pending) {
                return;
            }

            clearTimeout(pending.timeout);
            this.#pending.delete(response.id);

            if (response.error) {
                pending.reject(deserializeWorkerError(response.error));
                return;
            }

            pending.resolve(response.result);
        };
        const handleError = (error: Error) => {
            this.#handleConnectionFailure(
                managedConnection,
                "error",
                error instanceof Error ? error : new Error(String(error)),
            );
        };
        const handleExit = (code: number) => {
            this.#handleConnectionFailure(
                managedConnection,
                "exit",
                new Error("The worker thread exited unexpectedly."),
                {
                    exitCode: code,
                },
            );
        };

        const managedConnection: ManagedConnection<TReady> = {
            ...connection,
            cleanup: () => {
                connection.port.off("message", handleMessage);
                connection.worker.off("error", handleError);
                connection.worker.off("exit", handleExit);
            },
            faulted: false,
        };

        connection.port.on("message", handleMessage);
        connection.port.start?.();
        connection.worker.on("error", handleError);
        connection.worker.on("exit", handleExit);

        return managedConnection;
    }

    async #dispatchRequest<TResult>(
        connection: ManagedConnection<TReady>,
        id: number,
        method: string,
        params: unknown,
        requestId: string,
    ): Promise<TResult> {
        return await new Promise<TResult>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.#pending.delete(id);

                const timeoutError = new Error(
                    `The ${this.#domain} worker request timed out after ${this.#timeoutMs}ms.`,
                );
                logWorkerEvent("warn", this.#domain, "request-timeout", {
                    method,
                    requestId,
                    timeoutMs: this.#timeoutMs,
                });

                reject(timeoutError);
                this.#handleConnectionFailure(
                    connection,
                    "timeout",
                    timeoutError,
                    {
                        method,
                        requestId,
                        timeoutMs: this.#timeoutMs,
                    },
                );
            }, this.#timeoutMs);
            timeout.unref?.();

            this.#pending.set(id, {
                method,
                reject,
                requestId,
                resolve: resolve as (value: unknown) => void,
                timeout,
            });

            try {
                connection.port.postMessage({
                    id,
                    method,
                    params,
                    requestId,
                } satisfies RpcWorkerRequest);
            } catch (error) {
                clearTimeout(timeout);
                this.#pending.delete(id);
                reject(
                    error instanceof Error ? error : new Error(String(error)),
                );
                this.#handleConnectionFailure(
                    connection,
                    "post-message-failed",
                    error instanceof Error ? error : new Error(String(error)),
                    {
                        method,
                        requestId,
                    },
                );
            }
        });
    }

    #handleConnectionFailure(
        connection: ManagedConnection<TReady>,
        reason: "error" | "exit" | "post-message-failed" | "timeout",
        error: Error,
        metadata?: Record<string, number | string>,
    ): void {
        if (connection.faulted) {
            return;
        }

        connection.faulted = true;
        this.#disposeConnection(connection);

        if (this.#connection === connection) {
            this.#connection = null;
        }

        if (this.#closed) {
            this.#rejectPending(createClosedWorkerError(this.#domain));
            try {
                connection.port.close();
            } catch {
                // Ignore repeated port shutdown attempts.
            }
            return;
        }

        const workerError =
            reason === "timeout"
                ? error
                : new Error(`The ${this.#domain} worker stopped unexpectedly.`);
        this.#rejectPending(workerError);

        logWorkerEvent(
            reason === "exit" ? "warn" : "error",
            this.#domain,
            reason,
            {
                ...metadata,
                error: error.message,
                threadId: connection.worker.threadId,
            },
        );

        try {
            connection.port.close();
        } catch {
            // Ignore repeated port shutdown attempts.
        }

        if (reason !== "exit") {
            void connection.worker.terminate().catch(() => {
                // Ignore repeated termination attempts.
            });
        }

        if (!this.#closed) {
            this.#scheduleRestart();
        }
    }

    #disposeConnection(connection: ManagedConnection<TReady>): void {
        connection.cleanup();
    }

    #rejectPending(error: Error): void {
        for (const [id, pending] of this.#pending.entries()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
            this.#pending.delete(id);
        }
    }

    #scheduleRestart(): void {
        if (this.#closed || this.#restartTimer || this.#connectPromise) {
            return;
        }

        this.#restartAttempt += 1;
        const delayMs = Math.min(
            RESTART_BASE_DELAY_MS * 2 ** (this.#restartAttempt - 1),
            RESTART_MAX_DELAY_MS,
        );

        logWorkerEvent("warn", this.#domain, "restart-scheduled", {
            attempt: this.#restartAttempt,
            delayMs,
        });

        this.#restartTimer = setTimeout(() => {
            this.#restartTimer = null;
            void this.#ensureConnection().catch((error) => {
                logWorkerEvent("error", this.#domain, "restart-failed", {
                    attempt: this.#restartAttempt,
                    error: formatErrorMessage(error),
                });
                this.#scheduleRestart();
            });
        }, delayMs);
        this.#restartTimer.unref?.();
    }

    #clearRestartTimer(): void {
        if (!this.#restartTimer) {
            return;
        }

        clearTimeout(this.#restartTimer);
        this.#restartTimer = null;
    }
}

export function logWorkerClientCallFailure(
    domain: WorkerDomain,
    method: string,
    error: unknown,
): void {
    if (isBenignWorkerCloseError(error)) {
        return;
    }

    logWorkerEvent("warn", domain, "call-failed", {
        error: formatErrorMessage(error),
        method,
    });
}

function deserializeWorkerError(input: SerializedWorkerError): Error {
    const error = new Error(input.message);
    error.name = input.name;
    error.stack = input.stack;
    return error;
}

function createAlreadyClosedWorkerError(domain: WorkerDomain): Error {
    return new Error(`The ${domain} worker client is already closed.`);
}

function createClosedWorkerError(domain: WorkerDomain): Error {
    return new Error(`The ${domain} worker client was closed.`);
}

function formatErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isBenignWorkerCloseError(error: unknown): boolean {
    return (
        error instanceof Error &&
        /worker client (is already closed|was closed)/i.test(error.message)
    );
}

function logWorkerEvent(
    level: "error" | "info" | "warn",
    domain: WorkerDomain,
    event: string,
    metadata?: Record<string, number | string | undefined>,
): void {
    void level;
    void domain;
    void event;
    void metadata;
}
