import type { AiSessionSnapshot } from "@shared/ipc";

export type WorkspaceChatTabActivityIndicator =
    | {
          readonly title: string;
          readonly tone: "danger" | "working";
      }
    | null;

export function resolveWorkspaceChatTabActivityIndicator(input: {
    readonly localError: string | null;
    readonly snapshot: Pick<AiSessionSnapshot, "status"> | null;
}): WorkspaceChatTabActivityIndicator {
    if (input.localError) {
        return {
            title: "Agent error",
            tone: "danger",
        };
    }

    switch (input.snapshot?.status) {
        case "error":
            return {
                title: "Agent error",
                tone: "danger",
            };
        case "starting":
        case "streaming":
        case "waiting_permission":
        case "waiting_user_input":
            return {
                title: "Agent busy",
                tone: "working",
            };
        default:
            return null;
    }
}
