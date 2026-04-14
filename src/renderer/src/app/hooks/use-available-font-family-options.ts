import { useEffect, useState } from "react";

import type { EditorFontFamily } from "@shared/ipc";

import { EDITOR_FONT_FAMILY_OPTIONS } from "../settings/theme";

const FONT_DETECTION_SAMPLE = "mmmmmmmmmwwwiii@@@1234567890";
const FONT_DETECTION_SIZE = "72px";
const FALLBACK_FONT_FAMILIES = ["monospace", "sans-serif", "serif"] as const;
const ALWAYS_AVAILABLE_FONT_IDS = new Set<EditorFontFamily>(["system"]);
const UNAVAILABLE_LABEL_SUFFIX = " (unavailable on this device)";

export function useAvailableFontFamilyIds():
    | ReadonlySet<EditorFontFamily>
    | null {
    const [availableFontIds, setAvailableFontIds] = useState<
        ReadonlySet<EditorFontFamily> | null
    >(null);

    useEffect(() => {
        let cancelled = false;

        const detectFontAvailability = async () => {
            if (typeof document === "undefined") {
                return;
            }

            try {
                await document.fonts?.ready;
            } catch {
                // Ignore FontFaceSet readiness issues and continue with canvas checks.
            }

            const nextAvailableFontIds = new Set<EditorFontFamily>();

            for (const fontOption of EDITOR_FONT_FAMILY_OPTIONS) {
                if (
                    fontOption.source === "bundled" ||
                    ALWAYS_AVAILABLE_FONT_IDS.has(fontOption.id) ||
                    isFontFamilyAvailable(fontOption.primaryFamily)
                ) {
                    nextAvailableFontIds.add(fontOption.id);
                }
            }

            if (!cancelled) {
                setAvailableFontIds(nextAvailableFontIds);
            }
        };

        void detectFontAvailability();

        return () => {
            cancelled = true;
        };
    }, []);

    return availableFontIds;
}

export function buildSelectableFontFamilyOptions<
    T extends { readonly id: string; readonly label: string },
>(
    options: readonly T[],
    availableIds: ReadonlySet<T["id"]> | null,
    currentId: T["id"],
): Array<T & { readonly disabled?: boolean }> {
    if (availableIds === null) {
        return [...options];
    }

    return options.flatMap((option) => {
        if (availableIds.has(option.id)) {
            return [option];
        }

        if (option.id === currentId) {
            return [
                {
                    ...option,
                    disabled: true,
                    label: `${option.label}${UNAVAILABLE_LABEL_SUFFIX}`,
                },
            ];
        }

        return [];
    });
}

function isFontFamilyAvailable(fontFamily: string): boolean {
    if (typeof document === "undefined") {
        return false;
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
        return false;
    }

    const fallbackWidths = new Map(
        FALLBACK_FONT_FAMILIES.map((fallbackFontFamily) => [
            fallbackFontFamily,
            measureTextWidth(context, `${FONT_DETECTION_SIZE} ${fallbackFontFamily}`),
        ]),
    );

    return FALLBACK_FONT_FAMILIES.some((fallbackFontFamily) => {
        const candidateWidth = measureTextWidth(
            context,
            `${FONT_DETECTION_SIZE} "${fontFamily}", ${fallbackFontFamily}`,
        );

        return candidateWidth !== fallbackWidths.get(fallbackFontFamily);
    });
}

function measureTextWidth(
    context: CanvasRenderingContext2D,
    font: string,
): number {
    context.font = font;
    return context.measureText(FONT_DETECTION_SAMPLE).width;
}
