import type { AiFileDiff } from "@shared/ipc";

import {
    computeDecisionHunks,
    computeDiffLines,
    computeVisualDiffBlocks,
} from "./reviewDiff";

interface DiffPreviewWorkerRequest {
    readonly diff: AiFileDiff;
    readonly id: number;
}

self.onmessage = ({ data }: MessageEvent<DiffPreviewWorkerRequest>) => {
    const lines = computeDiffLines(data.diff);
    self.postMessage({
        decisionHunks: computeDecisionHunks(data.diff),
        id: data.id,
        lines,
        visualBlocks: computeVisualDiffBlocks(data.diff),
    });
};
