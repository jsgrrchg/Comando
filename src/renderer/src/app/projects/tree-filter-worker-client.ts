import type { ProjectTreeNode } from "@shared/ipc";

import {
    filterProjectEntriesForTreeFilter,
    type ProjectEntriesFilterStrategy,
} from "./tree-filter";

let worker: Worker | null = null;
let requestId = 0;
const pending = new Map<number, (matches: readonly ProjectTreeNode[]) => void>();

function getWorker(): Worker | null {
    if (typeof Worker === "undefined") return null;
    if (worker) return worker;
    worker = new Worker(new URL("./tree-filter.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<{ readonly id: number; readonly matches: readonly ProjectTreeNode[] }>) => {
        const resolve = pending.get(data.id);
        pending.delete(data.id);
        resolve?.(data.matches);
    };
    return worker;
}

export function filterProjectEntriesInWorker(input: {
    readonly entries: readonly ProjectTreeNode[];
    readonly query: string;
    readonly signal: AbortSignal;
    readonly strategy: ProjectEntriesFilterStrategy;
}): Promise<readonly ProjectTreeNode[]> {
    const filterWorker = getWorker();
    if (!filterWorker) {
        return Promise.resolve(filterProjectEntriesForTreeFilter(input.entries, input.query, input.strategy));
    }
    const id = requestId++;
    return new Promise((resolve) => {
        const abort = () => {
            pending.delete(id);
            resolve([]);
        };
        if (input.signal.aborted) return abort();
        input.signal.addEventListener("abort", abort, { once: true });
        pending.set(id, (matches) => {
            input.signal.removeEventListener("abort", abort);
            resolve(matches);
        });
        filterWorker.postMessage({ entries: input.entries, id, query: input.query, strategy: input.strategy });
    });
}
