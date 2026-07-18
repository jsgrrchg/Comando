import type {
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
} from "@shared/ipc";

export interface TranscriptSemanticAnchor {
    readonly alignment: "start" | "center" | "end";
    readonly entryId: string;
    readonly offsetWithinEntry: number;
}

export type TranscriptVirtualBlock =
    | {
          readonly block: AiTranscriptBlock;
          readonly id: string;
          readonly kind: "loaded";
          readonly metadata: AiTranscriptBlockMetadata;
      }
    | {
          readonly estimatedHeight: number;
          readonly id: string;
          readonly kind: "spacer";
          readonly metadata: AiTranscriptBlockMetadata;
      };

export function buildTranscriptVirtualBlocks(
    metadata: readonly AiTranscriptBlockMetadata[],
    loaded: ReadonlyMap<string, AiTranscriptBlock>,
): readonly TranscriptVirtualBlock[] {
    return metadata.map((item) => {
        const block = loaded.get(item.blockId);
        return block
            ? { block, id: item.blockId, kind: "loaded", metadata: item }
            : {
                  estimatedHeight: item.estimatedHeight,
                  id: item.blockId,
                  kind: "spacer",
                  metadata: item,
              };
    });
}

export function resolveAnchorBlockId(
    anchor: TranscriptSemanticAnchor,
    blocks: readonly TranscriptVirtualBlock[],
): string | null {
    for (const block of blocks) {
        if (
            block.kind === "loaded" &&
            block.block.entries.some((entry) => entry.id === anchor.entryId)
        ) {
            return block.id;
        }
    }
    return null;
}

export function transcriptBlockEstimate(block: TranscriptVirtualBlock): number {
    return block.kind === "loaded"
        ? block.block.estimatedHeight
        : block.estimatedHeight;
}
