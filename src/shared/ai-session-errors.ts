const CUSTOM_RUNTIME_CHANGE_CONFIRMATION_MARKER =
    "[ai:custom-runtime-change-confirmation-required]";

export function createCustomRuntimeChangeConfirmationErrorMessage(
    message: string,
): string {
    return `${CUSTOM_RUNTIME_CHANGE_CONFIRMATION_MARKER} ${message}`;
}

export function getCustomRuntimeChangeConfirmationMessage(
    error: unknown,
): string | null {
    const rawMessage =
        error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : null;
    if (!rawMessage) {
        return null;
    }

    const markerIndex = rawMessage.indexOf(
        CUSTOM_RUNTIME_CHANGE_CONFIRMATION_MARKER,
    );
    if (markerIndex < 0) {
        return null;
    }

    // Electron may prepend IPC context, so only the marked suffix is user-facing.
    const message = rawMessage
        .slice(markerIndex + CUSTOM_RUNTIME_CHANGE_CONFIRMATION_MARKER.length)
        .trim();
    return (
        message ||
        "This custom ACP runtime changed since the session was created."
    );
}
