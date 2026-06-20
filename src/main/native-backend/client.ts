import { spawn } from "node:child_process";
import type {
    ChildProcessWithoutNullStreams,
    SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import {
    createNativeHandshakeInput,
    createNativeRequestMeta,
    NATIVE_PROTOCOL_VERSION,
    type NativeBackendErrorPayload,
    type NativeBackendEvent,
    type NativeBackendHandshakeInput,
    type NativeBackendHandshakeOutput,
    type NativeBackendOutput,
    type NativeBackendRequestId,
    type NativeCommandName,
    parseNativeBackendCapabilitiesOutput,
    parseNativeBackendHandshakeOutput,
    parseNativeBackendOutput,
} from "@shared/native-backend";

export class NativeBackendError extends Error {
    readonly code: string;
    readonly details: unknown | null;
    readonly retryable: boolean;

    constructor(payload: NativeBackendErrorPayload) {
        super(payload.message);
        this.name = "NativeBackendError";
        this.code = payload.code;
        this.details = payload.details;
        this.retryable = payload.retryable;
    }
}

export type NativeBackendEventListener = (event: NativeBackendEvent) => void;
export type NativeBackendDiagnosticListener = (message: string) => void;

export type NativeBackendSpawn = (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type NativeBackendClientOptions = {
    readonly binaryPath: string;
    readonly onDiagnostic?: NativeBackendDiagnosticListener;
    readonly requestTimeoutMs?: number;
    readonly shutdownTimeoutMs?: number;
    readonly spawnProcess?: NativeBackendSpawn;
};

type PendingRequest = {
    readonly reject: (error: Error) => void;
    readonly resolve: (value: unknown) => void;
    readonly timeout: NodeJS.Timeout;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_500;

export class NativeBackendClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly eventListeners = new Set<NativeBackendEventListener>();
    private readonly onDiagnostic?: NativeBackendDiagnosticListener;
    private readonly pendingRequests = new Map<string, PendingRequest>();
    private readonly requestTimeoutMs: number;
    private readonly shutdownTimeoutMs: number;
    private readonly stdoutLines: ReadlineInterface;
    private disposePromise: Promise<void> | null = null;
    private exited = false;
    private nextRequestId = 1;
    private stderrRemainder = "";

    constructor(options: NativeBackendClientOptions) {
        this.onDiagnostic = options.onDiagnostic;
        this.requestTimeoutMs =
            options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.shutdownTimeoutMs =
            options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
        const spawnProcess = options.spawnProcess ?? (spawn as NativeBackendSpawn);
        this.child = spawnProcess(options.binaryPath, [], {
            stdio: "pipe",
            windowsHide: true,
        });
        this.stdoutLines = createInterface({
            crlfDelay: Number.POSITIVE_INFINITY,
            input: this.child.stdout,
        });

        this.stdoutLines.on("line", (line) => {
            this.handleStdoutLine(line);
        });
        this.child.stderr.on("data", (chunk: Buffer | string) => {
            this.handleStderrChunk(chunk);
        });
        this.child.stderr.on("end", () => {
            this.flushStderrRemainder();
        });
        this.child.once("error", (error) => {
            this.handleProcessEnd(error);
        });
        this.child.once("exit", (code, signal) => {
            this.handleProcessEnd(
                new Error(
                    `Native backend process exited with code ${code ?? "null"} and signal ${signal ?? "null"}.`,
                ),
            );
        });
    }

    async handshake(
        input: Partial<NativeBackendHandshakeInput> = {},
    ): Promise<NativeBackendHandshakeOutput> {
        const result = await this.request("backend_handshake", {
            ...createNativeHandshakeInput(input),
        });
        const handshake = parseNativeBackendHandshakeOutput(result);
        if (handshake.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
            throw new NativeBackendError({
                code: "unsupported_protocol_version",
                message: `Native backend protocol ${handshake.protocolVersion} is not supported by this client.`,
                details: {
                    backendProtocolVersion: handshake.protocolVersion,
                    clientProtocolVersion: NATIVE_PROTOCOL_VERSION,
                },
                retryable: false,
            });
        }

        return handshake;
    }

    request<T = unknown>(
        command: NativeCommandName,
        args: Record<string, unknown> = {},
    ): Promise<T> {
        return this.sendRequest(command, args, this.requestTimeoutMs);
    }

    onEvent(listener: NativeBackendEventListener): () => void {
        this.eventListeners.add(listener);
        return () => {
            this.eventListeners.delete(listener);
        };
    }

    dispose(): Promise<void> {
        if (this.disposePromise) {
            return this.disposePromise;
        }

        this.disposePromise = this.disposeOnce();
        return this.disposePromise;
    }

    private async disposeOnce(): Promise<void> {
        if (!this.exited) {
            try {
                await this.sendRequest(
                    "backend_shutdown",
                    {},
                    this.shutdownTimeoutMs,
                    true,
                );
            } catch (error) {
                this.reportDiagnostic(`Native backend shutdown request failed: ${formatError(error)}`);
            }

            if (!(await this.waitForExit(this.shutdownTimeoutMs))) {
                this.child.kill();
            }
        }

        this.stdoutLines.close();
        this.rejectPendingRequests(
            new Error("Native backend client has been disposed."),
        );
    }

    private sendRequest<T = unknown>(
        command: NativeCommandName,
        args: Record<string, unknown>,
        timeoutMs: number,
        allowDuringDispose = false,
    ): Promise<T> {
        if (this.exited) {
            return Promise.reject(
                new Error("Native backend process is not running."),
            );
        }

        if (this.disposePromise && !allowDuringDispose) {
            return Promise.reject(
                new Error("Native backend client is shutting down."),
            );
        }

        const id = `req_${this.nextRequestId}`;
        this.nextRequestId += 1;
        const request = `${JSON.stringify({
            id,
            command,
            args,
            meta: createNativeRequestMeta(),
        })}\n`;

        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestKey(id));
                reject(
                    new Error(
                        `Native backend request timed out: ${command}`,
                    ),
                );
            }, timeoutMs);

            this.pendingRequests.set(requestKey(id), {
                reject,
                resolve: (value) => {
                    resolve(value as T);
                },
                timeout,
            });

            this.child.stdin.write(request, (error) => {
                if (!error) {
                    return;
                }

                this.rejectPendingRequest(id, error);
            });
        });
    }

    private handleStdoutLine(line: string): void {
        if (!line.trim()) {
            return;
        }

        let output: NativeBackendOutput;
        try {
            output = parseNativeBackendOutput(JSON.parse(line));
        } catch (error) {
            const protocolError = new Error(
                `Native backend emitted invalid stdout JSONL: ${formatError(error)}`,
            );
            this.reportDiagnostic(protocolError.message);
            this.rejectPendingRequests(protocolError);
            this.child.kill();
            return;
        }

        if (output.type === "event") {
            this.emitEvent(output);
            return;
        }

        this.handleResponse(output);
    }

    private handleResponse(response: Extract<NativeBackendOutput, { type: "response" }>): void {
        const key = requestKey(response.id);
        const pending = this.pendingRequests.get(key);
        if (!pending) {
            this.reportDiagnostic(
                `Native backend returned an unknown response id: ${String(response.id)}.`,
            );
            return;
        }

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(key);

        if (response.ok) {
            pending.resolve(response.result ?? null);
            return;
        }

        pending.reject(new NativeBackendError(response.error));
    }

    private emitEvent(event: NativeBackendEvent): void {
        for (const listener of this.eventListeners) {
            try {
                listener(event);
            } catch (error) {
                this.reportDiagnostic(
                    `Native backend event listener failed: ${formatError(error)}`,
                );
            }
        }
    }

    private handleStderrChunk(chunk: Buffer | string): void {
        this.stderrRemainder += chunk.toString();
        const lines = this.stderrRemainder.split(/\r?\n/u);
        this.stderrRemainder = lines.pop() ?? "";

        for (const line of lines) {
            if (line.trim()) {
                this.reportDiagnostic(line);
            }
        }
    }

    private flushStderrRemainder(): void {
        const remainder = this.stderrRemainder.trim();
        this.stderrRemainder = "";
        if (remainder) {
            this.reportDiagnostic(remainder);
        }
    }

    private handleProcessEnd(error: Error): void {
        if (this.exited) {
            return;
        }

        this.exited = true;
        this.stdoutLines.close();
        this.rejectPendingRequests(error);
    }

    private waitForExit(timeoutMs: number): Promise<boolean> {
        if (this.exited) {
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                cleanup();
                resolve(false);
            }, timeoutMs);
            const onExit = () => {
                cleanup();
                resolve(true);
            };
            const cleanup = () => {
                clearTimeout(timeout);
                this.child.off("exit", onExit);
                this.child.off("error", onExit);
            };

            this.child.once("exit", onExit);
            this.child.once("error", onExit);
        });
    }

    private rejectPendingRequest(id: NativeBackendRequestId, error: Error): void {
        const key = requestKey(id);
        const pending = this.pendingRequests.get(key);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(key);
        pending.reject(error);
    }

    private rejectPendingRequests(error: Error): void {
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }

        this.pendingRequests.clear();
    }

    private reportDiagnostic(message: string): void {
        this.onDiagnostic?.(message);
    }
}

function requestKey(id: NativeBackendRequestId | null): string {
    return JSON.stringify(id);
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export { parseNativeBackendCapabilitiesOutput };
