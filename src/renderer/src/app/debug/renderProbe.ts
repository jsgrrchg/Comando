import { useEffect, useRef } from "react";

const RENDER_PROBE_STORAGE_KEY = "comando:render-probe";

type RenderProbeValue = boolean | number | string | null | undefined;
type RenderProbeDetails = Record<string, RenderProbeValue>;
type RenderProbePhase = "commit" | "dispose" | "mount";

interface RenderProbeEvent {
    readonly component: string;
    readonly count: number;
    readonly details: RenderProbeDetails;
    readonly phase: RenderProbePhase;
    readonly sinceLastMs: number | null;
    readonly timestamp: number;
}

interface RenderProbeStore {
    readonly counts: Record<string, number>;
    readonly events: RenderProbeEvent[];
}

function getProbePattern(): string | null {
    if (!import.meta.env.DEV || typeof window === "undefined") {
        return null;
    }

    const raw = window.localStorage.getItem(RENDER_PROBE_STORAGE_KEY)?.trim();
    return raw ? raw : null;
}

function isRenderProbeEnabled(component: string): boolean {
    const pattern = getProbePattern();
    if (!pattern) {
        return false;
    }

    if (pattern === "1" || pattern === "*" || pattern === "all") {
        return true;
    }

    const candidates = pattern
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    return candidates.includes(component);
}

function getRenderProbeStore(): RenderProbeStore {
    const root = globalThis as typeof globalThis & {
        __COMANDO_RENDER_PROBE__?: RenderProbeStore;
        __comandoRenderProbeDump?: () => RenderProbeStore;
        __comandoRenderProbeReset?: () => void;
    };

    if (!root.__COMANDO_RENDER_PROBE__) {
        root.__COMANDO_RENDER_PROBE__ = {
            counts: {},
            events: [],
        };

        root.__comandoRenderProbeDump = () => root.__COMANDO_RENDER_PROBE__!;
        root.__comandoRenderProbeReset = () => {
            if (!root.__COMANDO_RENDER_PROBE__) {
                return;
            }

            root.__COMANDO_RENDER_PROBE__.events.length = 0;
            for (const key of Object.keys(
                root.__COMANDO_RENDER_PROBE__.counts,
            )) {
                delete root.__COMANDO_RENDER_PROBE__.counts[key];
            }
        };
    }

    return root.__COMANDO_RENDER_PROBE__;
}

function formatRenderProbeLabel(
    component: string,
    phase: RenderProbePhase,
    details: RenderProbeDetails,
): string {
    const identity = Object.entries(details)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");

    const phaseLabel = phase === "commit" ? component : `${component}:${phase}`;

    return identity ? `${phaseLabel} ${identity}` : phaseLabel;
}

function recordRenderProbeEvent(
    component: string,
    phase: RenderProbePhase,
    details: RenderProbeDetails = {},
    sinceLastMs: number | null = null,
): void {
    if (!isRenderProbeEnabled(component)) {
        return;
    }

    const store = getRenderProbeStore();
    const countKey = phase === "commit" ? component : `${component}:${phase}`;
    const count = (store.counts[countKey] ?? 0) + 1;

    store.counts[countKey] = count;
    store.events.push({
        component,
        count,
        details,
        phase,
        sinceLastMs,
        timestamp: Date.now(),
    });

    if (store.events.length > 400) {
        store.events.splice(0, store.events.length - 400);
    }

    console.debug("[render-probe]", formatRenderProbeLabel(component, phase, details), {
        count,
        sinceLastMs,
    });
}

export function useRenderProbe(
    component: string,
    details: RenderProbeDetails = {},
): void {
    const enabled = isRenderProbeEnabled(component);
    const lastCommitAtRef = useRef<number | null>(null);

    useEffect(() => {
        if (!enabled) {
            return;
        }

        const now = performance.now();
        const sinceLastMs =
            lastCommitAtRef.current === null
                ? null
                : now - lastCommitAtRef.current;
        const roundedSinceLastMs =
            sinceLastMs === null ? null : Number(sinceLastMs.toFixed(2));

        lastCommitAtRef.current = now;
        recordRenderProbeEvent(component, "commit", details, roundedSinceLastMs);
    });
}

export function useLifecycleProbe(
    component: string,
    details: RenderProbeDetails = {},
): void {
    const detailsRef = useRef(details);

    useEffect(() => {
        const lifecycleDetails = detailsRef.current;

        recordRenderProbeEvent(component, "mount", lifecycleDetails);

        return () => {
            recordRenderProbeEvent(component, "dispose", lifecycleDetails);
        };
    }, [component]);
}

export function recordProbeLifecycleEvent(
    component: string,
    phase: Exclude<RenderProbePhase, "commit">,
    details: RenderProbeDetails = {},
): void {
    recordRenderProbeEvent(component, phase, details);
}
