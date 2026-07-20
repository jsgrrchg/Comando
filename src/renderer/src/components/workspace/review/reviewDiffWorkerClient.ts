import type { AiFileDiff } from "@shared/ipc";
import { incrementChatPerformanceCounter } from "@renderer/app/debug/chatPerformanceCounters";
import {
    getChatPerformanceTimestamp,
    measureChatPerformance,
    recordChatPerformanceMetric,
} from "@renderer/app/debug/chatPerformanceProbe";

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
    incrementChatPerformanceCounter("diff_prepares");
    const lineCount = diff.hunks.reduce(
        (count, hunk) => count + hunk.lines.length,
        0,
    );
    if (typeof Worker === "undefined") {
        return Promise.resolve(
            measureChatPerformance(
                "diff_prepare_ms",
                { values: { cacheHit: 0, lineCount, worker: 0 } },
                () => ({
                    decisionHunks: computeDecisionHunks(diff),
                    lines: computeDiffLines(diff),
                    visualBlocks: computeVisualDiffBlocks(diff),
                }),
            ),
        );
    }

    const startedAt = getChatPerformanceTimestamp();
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
            if (startedAt !== null) {
                recordChatPerformanceMetric("diff_prepare_ms", {
                    durationMs: performance.now() - startedAt,
                    values: { cacheHit: 0, lineCount, worker: 1 },
                });
            }
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
