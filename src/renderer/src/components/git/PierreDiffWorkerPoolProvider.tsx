import {
    WorkerPoolContextProvider,
    type WorkerInitializationRenderOptions,
    type WorkerPoolOptions,
} from "@pierre/diffs/react";
import pierreDiffWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import type { ReactNode } from "react";

const DEFAULT_AVAILABLE_CORES = 2;
const MAX_PIERRE_DIFF_WORKERS = 4;

function resolvePierreDiffWorkerCount(): number {
    const availableCores =
        typeof navigator === "undefined"
            ? DEFAULT_AVAILABLE_CORES
            : (navigator.hardwareConcurrency ?? DEFAULT_AVAILABLE_CORES);

    return Math.max(1, Math.min(MAX_PIERRE_DIFF_WORKERS, Math.floor(availableCores / 2)));
}

// Pierre injects its official stylesheet through the custom element imported by its React entry point.
const pierreDiffWorkerPoolOptions: WorkerPoolOptions = {
    poolSize: resolvePierreDiffWorkerCount(),
    // Resolve the worker as an emitted URL so importing this module never evaluates worker code in Vitest or SSR.
    workerFactory: () => new Worker(pierreDiffWorkerUrl, { type: "module" }),
};

const pierreDiffHighlighterOptions: WorkerInitializationRenderOptions = {
    langs: [],
};

export function PierreDiffWorkerPoolProvider({
    children,
}: {
    readonly children: ReactNode;
}) {
    if (typeof window === "undefined" || typeof Worker === "undefined") {
        return children;
    }

    return (
        <WorkerPoolContextProvider
            highlighterOptions={pierreDiffHighlighterOptions}
            poolOptions={pierreDiffWorkerPoolOptions}
        >
            {children}
        </WorkerPoolContextProvider>
    );
}
