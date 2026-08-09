export const CHAT_HISTORY_RETENTION_DAYS = [0, 1, 7, 30, 90, 365] as const;

export type ChatHistoryRetentionDays =
    (typeof CHAT_HISTORY_RETENTION_DAYS)[number];

export interface ChatHistoryRetentionOption {
    readonly label: string;
    readonly value: ChatHistoryRetentionDays;
}

export const CHAT_HISTORY_RETENTION_OPTIONS: ChatHistoryRetentionOption[] = [
    { value: 0, label: "Forever" },
    { value: 1, label: "1 day" },
    { value: 7, label: "7 days" },
    { value: 30, label: "30 days" },
    { value: 90, label: "90 days" },
    { value: 365, label: "1 year" },
];

export function normalizeChatHistoryRetentionDays(
    value: unknown,
): ChatHistoryRetentionDays {
    return CHAT_HISTORY_RETENTION_DAYS.includes(
        value as ChatHistoryRetentionDays,
    )
        ? (value as ChatHistoryRetentionDays)
        : 0;
}

export function isMoreRestrictiveHistoryRetention(
    previous: ChatHistoryRetentionDays,
    next: ChatHistoryRetentionDays,
): boolean {
    return next > 0 && (previous === 0 || next < previous);
}
