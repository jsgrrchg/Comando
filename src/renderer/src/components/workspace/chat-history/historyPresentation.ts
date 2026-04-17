import type { AiRuntimeId } from "@shared/ipc";

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en", {
    numeric: "auto",
});

export function getHistoryRuntimeLabel(runtimeId: AiRuntimeId): string {
    switch (runtimeId) {
        case "claude":
            return "Claude";
        case "gemini":
            return "Gemini";
        case "kilo":
            return "Kilo";
        case "codex":
        default:
            return "Codex";
    }
}

export function formatHistoryRelativeDate(
    value: string,
    nowMs: number = Date.now(),
): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        return "Unknown";
    }

    const deltaMs = timestamp - nowMs;
    const deltaMinutes = Math.round(deltaMs / (60 * 1000));
    const absoluteMinutes = Math.abs(deltaMinutes);

    if (absoluteMinutes < 1) {
        return "Just now";
    }

    if (absoluteMinutes < 60) {
        return relativeTimeFormatter.format(deltaMinutes, "minute");
    }

    const deltaHours = Math.round(deltaMinutes / 60);
    if (Math.abs(deltaHours) < 24) {
        return relativeTimeFormatter.format(deltaHours, "hour");
    }

    const deltaDays = Math.round(deltaHours / 24);
    if (Math.abs(deltaDays) < 7) {
        return relativeTimeFormatter.format(deltaDays, "day");
    }

    const formatter = new Intl.DateTimeFormat("en", {
        day: "numeric",
        month: "short",
        year:
            new Date(timestamp).getFullYear() === new Date(nowMs).getFullYear()
                ? undefined
                : "numeric",
    });

    return formatter.format(new Date(timestamp));
}

export function formatHistoryMessageCount(count: number): string {
    return count === 1 ? "1 message" : `${count} messages`;
}

export function formatHistoryScope(worktreeId: string | null | undefined): string {
    return worktreeId ?? "Primary";
}
