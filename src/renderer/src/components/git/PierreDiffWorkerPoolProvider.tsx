import {
    WorkerPoolContextProvider,
    useWorkerPool,
    type WorkerInitializationRenderOptions,
    type WorkerPoolOptions,
} from "@pierre/diffs/react";
import pierreDiffWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { useEffect, useMemo, type ReactNode } from "react";

import {
    getComandoPierreThemes,
    registerComandoPierreThemes,
} from "@renderer/app/editor/pierreShikiTheme";
import { useSettingsStore } from "@renderer/app/store/settings-store";

const DEFAULT_AVAILABLE_CORES = 2;
const MAX_PIERRE_DIFF_WORKERS = 4;

registerComandoPierreThemes();

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

function PierreDiffWorkerThemeSync({
    children,
    theme,
}: {
    readonly children: ReactNode;
    readonly theme: ReturnType<typeof getComandoPierreThemes>;
}) {
    const workerPool = useWorkerPool();

    useEffect(() => {
        // Pierre's pool owns a shared Shiki highlighter, so per-diff options alone cannot change token colors.
        void workerPool?.setRenderOptions({ theme });
    }, [theme, workerPool]);

    return children;
}

export function PierreDiffWorkerPoolProvider({
    children,
}: {
    readonly children: ReactNode;
}) {
    const themePreset = useSettingsStore((state) => state.appearance.themePreset);
    const boostCodeContrast = useSettingsStore(
        (state) => state.appearance.boostCodeContrast,
    );
    const theme = useMemo(
        () => getComandoPierreThemes(themePreset, boostCodeContrast),
        [boostCodeContrast, themePreset],
    );
    const highlighterOptions = useMemo<WorkerInitializationRenderOptions>(
        () => ({
            langs: [],
            theme,
        }),
        [theme],
    );

    if (typeof window === "undefined" || typeof Worker === "undefined") {
        return children;
    }

    return (
        <WorkerPoolContextProvider
            highlighterOptions={highlighterOptions}
            poolOptions={pierreDiffWorkerPoolOptions}
        >
            <PierreDiffWorkerThemeSync theme={theme}>
                {children}
            </PierreDiffWorkerThemeSync>
        </WorkerPoolContextProvider>
    );
}
