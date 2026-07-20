export type TranscriptPrefetchDirection = "backward" | "forward";

export function resolveTranscriptPrefetchBlockId(
    blockIds: readonly string[],
    loadedBlockIds: ReadonlySet<string>,
    direction: TranscriptPrefetchDirection,
): string | null {
    let boundaryIndex: number | null = null;

    for (const [index, blockId] of blockIds.entries()) {
        if (!loadedBlockIds.has(blockId)) continue;
        boundaryIndex =
            direction === "backward"
                ? boundaryIndex === null
                    ? index
                    : Math.min(boundaryIndex, index)
                : Math.max(boundaryIndex ?? index, index);
    }

    if (boundaryIndex === null) return null;
    const targetIndex =
        direction === "backward" ? boundaryIndex - 1 : boundaryIndex + 1;
    return blockIds[targetIndex] ?? null;
}
