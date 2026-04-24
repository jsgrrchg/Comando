export const AGENTS_SIDEBAR_SCALE_DEFAULT = 1;
export const AGENTS_SIDEBAR_SCALE_MIN = 0.9;
export const AGENTS_SIDEBAR_SCALE_MAX = 1.4;
export const AGENTS_SIDEBAR_SCALE_STEP = 0.05;

export function clampAgentsSidebarScale(value: number): number {
    if (!Number.isFinite(value)) {
        return AGENTS_SIDEBAR_SCALE_DEFAULT;
    }

    return Math.min(
        AGENTS_SIDEBAR_SCALE_MAX,
        Math.max(AGENTS_SIDEBAR_SCALE_MIN, Math.round(value * 100) / 100),
    );
}

export function formatAgentsSidebarScalePercent(value: number): string {
    return `${Math.round(clampAgentsSidebarScale(value) * 100)}%`;
}
