import {
    NATIVE_PROTOCOL_VERSION,
    type NativeBackendHandshakeInput,
} from "./capabilities";
import type { NativeCommandName } from "./common";
import type { NativeBackendErrorPayload } from "./errors";
import type {
    NativeBackendRequestId,
    NativeProjectId,
    NativeWindowId,
    NativeWorktreeId,
} from "./ids";

export type NativeRequestMeta = {
    readonly protocolVersion: number;
    readonly sentAt?: string | null;
    readonly windowId?: NativeWindowId | null;
    readonly projectId?: NativeProjectId | null;
    readonly worktreeId?: NativeWorktreeId | null;
};

export type NativeResponseMeta = {
    readonly protocolVersion: number;
    readonly handledAt?: string | null;
};

export type NativeEventMeta = {
    readonly protocolVersion: number;
    readonly emittedAt?: string | null;
    readonly projectId?: NativeProjectId | null;
    readonly worktreeId?: NativeWorktreeId | null;
    readonly windowId?: NativeWindowId | null;
};

export type NativeRpcRequest = {
    readonly id: NativeBackendRequestId;
    readonly command: NativeCommandName;
    readonly args: Record<string, unknown>;
    readonly meta?: NativeRequestMeta;
};

export type NativeBackendResponse =
    | {
          readonly type: "response";
          readonly id: NativeBackendRequestId | null;
          readonly ok: true;
          readonly result?: unknown;
          readonly meta?: NativeResponseMeta;
      }
    | {
          readonly type: "response";
          readonly id: NativeBackendRequestId | null;
          readonly ok: false;
          readonly error: NativeBackendErrorPayload;
          readonly meta?: NativeResponseMeta;
      };

export type NativeBackendEvent = {
    readonly type: "event";
    readonly eventName: string;
    readonly payload: unknown;
    readonly meta?: NativeEventMeta;
};

export type NativeBackendOutput = NativeBackendResponse | NativeBackendEvent;

export const NATIVE_BACKEND_IPC_EVENT = "native-backend:event";

export function createNativeRequestMeta(
    overrides: Partial<NativeRequestMeta> = {},
): NativeRequestMeta {
    return {
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        sentAt: new Date().toISOString(),
        windowId: null,
        projectId: null,
        worktreeId: null,
        ...overrides,
    };
}

export function createNativeHandshakeInput(
    overrides: Partial<NativeBackendHandshakeInput> = {},
): NativeBackendHandshakeInput {
    return {
        clientName: "comando-electron-main",
        clientVersion: "0.1.0",
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        supportedProtocolVersions: [NATIVE_PROTOCOL_VERSION],
        ...overrides,
    };
}

export function parseNativeBackendOutput(value: unknown): NativeBackendOutput {
    if (!isRecord(value)) {
        throw new Error("Native backend output must be an object.");
    }

    if (value.type === "response") {
        return parseNativeBackendResponse(value);
    }

    if (value.type === "event") {
        if (typeof value.eventName !== "string") {
            throw new Error("Native backend eventName must be a string.");
        }

        return {
            type: "event",
            eventName: value.eventName,
            payload: value.payload,
            meta: parseOptionalEventMeta(value.meta),
        };
    }

    throw new Error("Native backend output type is not supported.");
}

function parseNativeBackendResponse(
    value: Record<string, unknown>,
): NativeBackendResponse {
    const id = parseResponseId(value.id);
    if (value.ok === true) {
        return {
            type: "response",
            id,
            ok: true,
            result: value.result,
            meta: parseOptionalResponseMeta(value.meta),
        };
    }

    if (value.ok === false) {
        if (!isRecord(value.error)) {
            throw new Error("Native backend error response is missing error.");
        }
        const error = parseNativeError(value.error);

        return {
            type: "response",
            id,
            ok: false,
            error,
            meta: parseOptionalResponseMeta(value.meta),
        };
    }

    throw new Error("Native backend response ok must be a boolean.");
}

function parseNativeError(
    value: Record<string, unknown>,
): NativeBackendErrorPayload {
    if (typeof value.code !== "string") {
        throw new Error("Native backend error code must be a string.");
    }

    if (typeof value.message !== "string") {
        throw new Error("Native backend error message must be a string.");
    }

    if (!Object.hasOwn(value, "details")) {
        throw new Error("Native backend error details is required.");
    }

    if (typeof value.retryable !== "boolean") {
        throw new Error("Native backend error retryable must be a boolean.");
    }

    return {
        code: value.code,
        message: value.message,
        details: value.details,
        retryable: value.retryable,
    };
}

function parseResponseId(value: unknown): NativeBackendRequestId | null {
    if (typeof value === "string" || typeof value === "number") {
        return value;
    }

    if (value === null) {
        return null;
    }

    throw new Error("Native backend response id must be a string, number, or null.");
}

function parseOptionalResponseMeta(value: unknown): NativeResponseMeta | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value) || typeof value.protocolVersion !== "number") {
        throw new Error("Native backend response meta is invalid.");
    }

    return {
        protocolVersion: value.protocolVersion,
        handledAt:
            typeof value.handledAt === "string" || value.handledAt === null
                ? value.handledAt
                : undefined,
    };
}

function parseOptionalEventMeta(value: unknown): NativeEventMeta | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value) || typeof value.protocolVersion !== "number") {
        throw new Error("Native backend event meta is invalid.");
    }

    return {
        protocolVersion: value.protocolVersion,
        emittedAt:
            typeof value.emittedAt === "string" || value.emittedAt === null
                ? value.emittedAt
                : undefined,
        projectId:
            typeof value.projectId === "string" || value.projectId === null
                ? value.projectId
                : undefined,
        worktreeId:
            typeof value.worktreeId === "string" || value.worktreeId === null
                ? value.worktreeId
                : undefined,
        windowId:
            typeof value.windowId === "string" || value.windowId === null
                ? value.windowId
                : undefined,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
