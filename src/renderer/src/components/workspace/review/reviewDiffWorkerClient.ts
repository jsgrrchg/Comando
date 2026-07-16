import type { AiFileDiff } from "@shared/ipc";

import {
    computeDecisionHunks,
    computeDiffLines,
    computeVisualDiffBlocks,
    type DecisionHunk,
    type DiffLine,
    type VisualDiffBlock,
} from "./reviewDiff";

export interface PreparedDiffPreview {
    readonly decisionHunks: readonly DecisionHunk[];
    readonly lines: readonly DiffLine[];
    readonly visualBlocks: readonly VisualDiffBlock[];
}

interface WorkerResponse extends PreparedDiffPreview {
    readonly id: number;
}

let nextRequestId = 0;

export function prepareDiffPreview(
    diff: AiFileDiff,
    signal: AbortSignal,
): Promise<PreparedDiffPreview> {
    if (typeof Worker === "undefined") {
        return Promise.resolve({
            decisionHunks: computeDecisionHunks(diff),
            lines: computeDiffLines(diff),
            visualBlocks: computeVisualDiffBlocks(diff),
        });
    }

    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise<PreparedDiffPreview>((resolve, reject) => {
        const diffWorker = new Worker(
            new URL("./reviewDiff.worker.ts", import.meta.url),
            { type: "module" },
        );
        const abort = () => {
            const error = new Error("The diff request was cancelled.");
            error.name = "AbortError";
            reject(error);
            diffWorker.terminate();
        };
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener("abort", abort, { once: true });
        diffWorker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
            if (data.id !== id) return;
            signal.removeEventListener("abort", abort);
            diffWorker.terminate();
            resolve({ decisionHunks: data.decisionHunks, lines: data.lines, visualBlocks: data.visualBlocks });
        };
        diffWorker.onerror = (event) => {
            signal.removeEventListener("abort", abort);
            diffWorker.terminate();
            reject(new Error(event.message || "The diff worker failed."));
        };
        diffWorker.postMessage({ diff, id });
    });
}
