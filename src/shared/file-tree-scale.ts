export const FILE_TREE_SCALE_DEFAULT = 1;
export const FILE_TREE_SCALE_MIN = 0.85;
export const FILE_TREE_SCALE_MAX = 1.35;
export const FILE_TREE_SCALE_STEP = 0.05;

export function clampFileTreeScale(value: number): number {
    if (!Number.isFinite(value)) {
        return FILE_TREE_SCALE_DEFAULT;
    }

    return Math.min(
        FILE_TREE_SCALE_MAX,
        Math.max(FILE_TREE_SCALE_MIN, Math.round(value * 100) / 100),
    );
}

export function formatFileTreeScalePercent(value: number): string {
    return `${Math.round(clampFileTreeScale(value) * 100)}%`;
}
