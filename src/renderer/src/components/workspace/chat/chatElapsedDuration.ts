export function formatChatElapsedDuration(totalSeconds: number): string {
    // Normalize timer input so clock skew or invalid values never leak into the UI.
    const normalizedSeconds = Number.isFinite(totalSeconds)
        ? Math.max(0, Math.floor(totalSeconds))
        : 0;
    const hours = Math.floor(normalizedSeconds / 3600);
    const minutes = Math.floor((normalizedSeconds % 3600) / 60);
    const seconds = normalizedSeconds % 60;
    const paddedSeconds = String(seconds).padStart(2, "0");

    if (hours > 0) {
        return `${hours}h ${String(minutes).padStart(2, "0")}m ${paddedSeconds}s`;
    }

    if (minutes > 0) {
        return `${minutes}m ${paddedSeconds}s`;
    }

    return `${seconds}s`;
}
