export type NativeErrorCode =
    | "invalid_json"
    | "invalid_request"
    | "unknown_command"
    | "invalid_args"
    | "unsupported_protocol_version"
    | "unsupported_schema_version"
    | "not_supported"
    | "backend_not_ready"
    | "operation_cancelled"
    | "operation_timeout"
    | "permission_denied"
    | "not_found"
    | "conflict"
    | "too_large"
    | "binary_file"
    | "external_change"
    | "ai_runtime_missing"
    | "ai_runtime_not_native"
    | "ai_runtime_not_ready"
    | "ai_runtime_launch_context_invalid"
    | "ai_runtime_auth_missing"
    | "ai_session_not_found"
    | "ai_session_busy"
    | "ai_session_owner_mismatch"
    | "ai_prompt_rejected"
    | "ai_cancel_failed"
    | "ai_permission_not_found"
    | "ai_user_input_not_found"
    | "ai_runtime_exited"
    | "internal_error";

export type NativeError = {
    readonly code: NativeErrorCode | string;
    readonly message: string;
    readonly details: unknown | null;
    readonly retryable: boolean;
};

export type NativeBackendErrorPayload = NativeError;
