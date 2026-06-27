import type {
    AiTrackedFile,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
} from "@shared/ipc";

export function createReviewFileMutationInput(
    file: AiTrackedFile,
): AiTrackedFileMutationInput {
    return {
        expectedVersion: file.version ?? 1,
        path: file.path,
        sessionId: file.sessionId,
        trackedFileId: file.identityKey,
    };
}

export function createReviewHunkMutationInput(
    file: AiTrackedFile,
    hunkIds: readonly string[],
): AiTrackedFileHunkMutationInput {
    return {
        ...createReviewFileMutationInput(file),
        hunkIds,
    };
}
