import type { AiSessionSnapshot } from "@shared/ipc";

export type WorkspaceChatTabActivityIndicator = {
    readonly title: string;
    readonly tone: "danger" | "working";
} | null;

const ERROR_ACTIVITY_INDICATOR: WorkspaceChatTabActivityIndicator = {
    title: "Agent error",
    tone: "danger",
};

const WORKING_ACTIVITY_INDICATOR: WorkspaceChatTabActivityIndicator = {
    title: "Agent busy",
    tone: "working",
};

export function resolveWorkspaceChatTabActivityIndicator(input: {
    readonly localError: string | null;
    readonly snapshot: Pick<AiSessionSnapshot, "status"> | null;
}): WorkspaceChatTabActivityIndicator {
    if (input.localError) {
        return ERROR_ACTIVITY_INDICATOR;
    }

    switch (input.snapshot?.status) {
        case "error":
            return ERROR_ACTIVITY_INDICATOR;
        case "starting":
        case "streaming":
        case "waiting_permission":
        case "waiting_user_input":
            return WORKING_ACTIVITY_INDICATOR;
        default:
            return null;
    }
}
