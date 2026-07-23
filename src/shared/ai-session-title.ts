export interface AiSessionTitleState {
    readonly manualTitle?: string | null;
    readonly title: string;
}

export function getAiSessionDisplayTitle(
    session: AiSessionTitleState,
): string {
    return session.manualTitle?.trim() || session.title;
}
