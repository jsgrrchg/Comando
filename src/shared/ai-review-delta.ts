import type { AiReviewDeltaSummary, AiTrackedFile } from "./ipc";
import type { NativeReviewDeltaReference } from "./native-backend/ai";

export function toNativeReviewDeltaReference(
    delta: AiReviewDeltaSummary,
): NativeReviewDeltaReference {
    return {
        deltaId: delta.deltaId,
        expectedRevision: delta.revision,
        inputRevision: delta.inputRevision,
        observedHashes: delta.files,
        sessionId: delta.sessionId,
        toolCallId: delta.toolCallId,
        workCycleId: delta.workCycleId,
    };
}

export function attachNativeReviewDeltaToTrackedFile(
    file: AiTrackedFile,
    delta: AiReviewDeltaSummary,
): AiTrackedFile {
    return {
        ...file,
        nativeReviewDeltaId: delta.deltaId,
        nativeReviewInputRevision: delta.inputRevision,
        nativeReviewState: delta.state,
        nativeReviewWorkCycleId: delta.workCycleId,
        toolCallId: delta.toolCallId,
        version: delta.revision,
    };
}
