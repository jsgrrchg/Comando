import type { AiRuntimeId } from "@shared/ipc";
import { getAiRuntimeDisplayName } from "@shared/ai-runtimes";

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en", {
    numeric: "auto",
});

export function getHistoryRuntimeLabel(runtimeId: AiRuntimeId): string {
    return getAiRuntimeDisplayName(runtimeId);
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

export function formatHistoryRelativeDateCompact(
    value: string,
    nowMs: number = Date.now(),
): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        return "—";
    }

    const deltaMs = nowMs - timestamp;
    const deltaSeconds = Math.round(deltaMs / 1000);

    if (Math.abs(deltaSeconds) < 60) {
        return "now";
    }

    const deltaMinutes = Math.round(deltaSeconds / 60);
    if (Math.abs(deltaMinutes) < 60) {
        return `${Math.abs(deltaMinutes)}m`;
    }

    const deltaHours = Math.round(deltaMinutes / 60);
    if (Math.abs(deltaHours) < 24) {
        return `${Math.abs(deltaHours)}h`;
    }

    const deltaDays = Math.round(deltaHours / 24);
    if (Math.abs(deltaDays) < 7) {
        return `${Math.abs(deltaDays)}d`;
    }

    const date = new Date(timestamp);
    const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
    return new Intl.DateTimeFormat("en", {
        day: "numeric",
        month: "short",
        year: sameYear ? undefined : "2-digit",
    }).format(date);
}

export function formatHistoryMessageCount(count: number): string {
    return count === 1 ? "1 message" : `${count} messages`;
}

export function formatHistoryScope(worktreeId: string | null | undefined): string {
    return worktreeId ?? "Primary";
}
