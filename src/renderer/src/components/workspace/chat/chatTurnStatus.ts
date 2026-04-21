import type { AiSessionSnapshot } from "@shared/ipc";

type AiSessionStatus = AiSessionSnapshot["status"];

export function isChatStreamingStatus(status: AiSessionStatus): boolean {
    return status === "starting" || status === "streaming";
}

export function isActiveChatTurnStatus(status: AiSessionStatus): boolean {
    return (
        isChatStreamingStatus(status) ||
        status === "waiting_permission" ||
        status === "waiting_user_input"
    );
}
