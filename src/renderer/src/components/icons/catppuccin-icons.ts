import catppuccinIconSetJson from "@iconify-json/catppuccin/icons.json";

export type CatppuccinIconName = string;

export const FALLBACK_CATPPUCCIN_ICON = "file";

export interface CatppuccinIconData {
    readonly body: string;
    readonly height?: number;
    readonly left?: number;
    readonly top?: number;
    readonly width?: number;
}

const catppuccinIconSet = catppuccinIconSetJson as {
    readonly height?: number;
    readonly icons: Record<string, CatppuccinIconData>;
    readonly left?: number;
    readonly top?: number;
    readonly width?: number;
};

export function hasCatppuccinIcon(name: CatppuccinIconName): boolean {
    return Object.hasOwn(catppuccinIconSet.icons, name);
}

export function getCatppuccinIcon(
    name: CatppuccinIconName,
): CatppuccinIconData | null {
    return catppuccinIconSet.icons[name] ?? null;
}

export function resolveAvailableCatppuccinIcon(
    name: CatppuccinIconName,
    fallback: CatppuccinIconName = FALLBACK_CATPPUCCIN_ICON,
): CatppuccinIconName {
    if (hasCatppuccinIcon(name)) {
        return name;
    }

    return hasCatppuccinIcon(fallback) ? fallback : FALLBACK_CATPPUCCIN_ICON;
}

export function getCatppuccinViewBox(icon: CatppuccinIconData): string {
    const left = icon.left ?? catppuccinIconSet.left ?? 0;
    const top = icon.top ?? catppuccinIconSet.top ?? 0;
    const width = icon.width ?? catppuccinIconSet.width ?? 16;
    const height = icon.height ?? catppuccinIconSet.height ?? 16;

    return `${left} ${top} ${width} ${height}`;
}
