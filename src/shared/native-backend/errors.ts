export type NativeErrorCode =
    | "invalid_json"
    | "invalid_request"
    | "unknown_command"
    | "invalid_args"
    | "unsupported_protocol_version"
    | "backend_not_ready"
    | "operation_cancelled"
    | "operation_timeout"
    | "permission_denied"
    | "not_found"
    | "conflict"
    | "too_large"
    | "binary_file"
    | "external_change"
    | "internal_error";

export type NativeError = {
    readonly code: NativeErrorCode | string;
    readonly message: string;
    readonly details: unknown | null;
    readonly retryable: boolean;
};

export type NativeBackendErrorPayload = NativeError;
