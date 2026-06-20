export type NativeBackendRequestId = number | string;

export type NativeBackendErrorPayload = {
    readonly code: string;
    readonly message: string;
    readonly details: unknown | null;
};

export type NativeBackendResponse =
    | {
          readonly type: "response";
          readonly id: NativeBackendRequestId | null;
          readonly ok: true;
          readonly result?: unknown;
      }
    | {
          readonly type: "response";
          readonly id: NativeBackendRequestId | null;
          readonly ok: false;
          readonly error: NativeBackendErrorPayload;
      };

export type NativeBackendEvent = {
    readonly type: "event";
    readonly eventName: string;
    readonly payload: unknown;
};

export type NativeBackendOutput = NativeBackendResponse | NativeBackendEvent;

export const NATIVE_BACKEND_IPC_EVENT = "native-backend:event";

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
        };
    }

    if (value.ok === false) {
        if (!isRecord(value.error)) {
            throw new Error("Native backend error response is missing error.");
        }

        return {
            type: "response",
            id,
            ok: false,
            error: {
                code:
                    typeof value.error.code === "string"
                        ? value.error.code
                        : "unknown_error",
                message:
                    typeof value.error.message === "string"
                        ? value.error.message
                        : "Native backend request failed.",
                details: value.error.details ?? null,
            },
        };
    }

    throw new Error("Native backend response ok must be a boolean.");
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
