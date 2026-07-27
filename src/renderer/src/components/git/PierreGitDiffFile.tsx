import {
    PatchDiff,
    type VirtualFileMetrics,
} from "@pierre/diffs/react";
import { DEFAULT_VIRTUAL_FILE_METRICS } from "@pierre/diffs";
import { useMemo } from "react";

import {
    buildPierreDiffHostStyle,
    getComandoPierreThemes,
} from "@renderer/app/editor/pierreShikiTheme";
import {
    resolveComandoThemeTokens,
    resolveIsDark,
} from "@renderer/app/settings/theme";
import { useSettingsStore } from "@renderer/app/store/settings-store";

import type { GitDiffFile } from "./types";

const DEFAULT_PIERRE_FONT_SIZE_PX = 13;
const DEFAULT_PIERRE_LINE_HEIGHT = 1.55;

function buildUnifiedPatchHeader(file: GitDiffFile): string {
    const oldPath = file.previousPath ?? file.path;

    if (file.kind === "create") {
        return `--- /dev/null\n+++ ${file.path}\n`;
    }

    if (file.kind === "delete") {
        return `--- ${oldPath}\n+++ /dev/null\n`;
    }

    return `--- ${oldPath}\n+++ ${file.path}\n`;
}

function buildPatchFromHunks(file: GitDiffFile): string | null {
    if (file.hunks.length === 0) {
        return null;
    }

    const hunks = file.hunks
        .map((hunk) => {
            const header =
                hunk.header ||
                `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
            const lines = hunk.lines
                .map((line) => {
                    const prefix =
                        line.kind === "add"
                            ? "+"
                            : line.kind === "remove"
                              ? "-"
                              : " ";
                    return `${prefix}${line.text}\n`;
                })
                .join("");

            return `${header}\n${lines}`;
        })
        .join("");

    return `${buildUnifiedPatchHeader(file)}${hunks}`;
}

function getPatchWithFileHeader(file: GitDiffFile, patch: string): string {
    const contentStart = patch.search(/\S/);
    const trimmedPatch = contentStart >= 0 ? patch.slice(contentStart) : "";

    if (
        trimmedPatch.startsWith("diff --git") ||
        trimmedPatch.startsWith("--- ")
    ) {
        return trimmedPatch;
    }

    // GitHub sends hunk bodies without the single-file boundary PatchDiff requires.
    return `${buildUnifiedPatchHeader(file)}${trimmedPatch}`;
}

export function getPierreGitDiffPatch(file: GitDiffFile): string | null {
    if (!file.isText) {
        return null;
    }

    if (typeof file.patch === "string" && file.patch.trim().length > 0) {
        return getPatchWithFileHeader(file, file.patch);
    }

    return buildPatchFromHunks(file);
}

export function canRenderGitDiffWithPierre(file: GitDiffFile): boolean {
    return getPierreGitDiffPatch(file) !== null;
}

export function getPierreDiffVirtualMetrics(
    codeFontSize: number | null,
    codeLineHeight: number | null,
): VirtualFileMetrics {
    const fontSize =
        typeof codeFontSize === "number" &&
        Number.isFinite(codeFontSize) &&
        codeFontSize > 0
            ? codeFontSize
            : DEFAULT_PIERRE_FONT_SIZE_PX;
    const lineHeight =
        typeof codeLineHeight === "number" &&
        Number.isFinite(codeLineHeight) &&
        codeLineHeight > 0
            ? codeLineHeight
            : DEFAULT_PIERRE_LINE_HEIGHT;

    return {
        ...DEFAULT_VIRTUAL_FILE_METRICS,
        lineHeight: lineHeight > 4 ? lineHeight : fontSize * lineHeight,
    };
}

export function PierreGitDiffFile({
    codeFontFamily,
    codeFontSize,
    codeLineHeight,
    file,
    lineWrapping,
}: {
    readonly codeFontFamily: string | null;
    readonly codeFontSize: number | null;
    readonly codeLineHeight: number | null;
    readonly file: GitDiffFile;
    readonly lineWrapping: boolean;
}) {
    const appearance = useSettingsStore((state) => state.appearance);
    const systemIsDark = useSettingsStore((state) => state.systemTheme.isDark);
    const patch = useMemo(() => getPierreGitDiffPatch(file), [file]);
    const isDark = resolveIsDark(appearance.themeMode, systemIsDark);
    const options = useMemo(
        () => ({
            diffStyle: "unified" as const,
            disableErrorHandling: true,
            disableFileHeader: true,
            overflow: lineWrapping ? ("wrap" as const) : ("scroll" as const),
            theme: getComandoPierreThemes(appearance.themePreset),
            themeType: isDark ? ("dark" as const) : ("light" as const),
        }),
        [appearance.themePreset, isDark, lineWrapping],
    );
    const style = useMemo(
        () =>
            buildPierreDiffHostStyle(
                resolveComandoThemeTokens(
                    appearance.themePreset,
                    isDark,
                    appearance.boostCodeContrast,
                ),
                {
                    fontFamily: codeFontFamily,
                    fontSize: codeFontSize,
                    lineHeight: codeLineHeight,
                },
            ),
        [
            appearance.boostCodeContrast,
            appearance.themePreset,
            codeFontFamily,
            codeFontSize,
            codeLineHeight,
            isDark,
        ],
    );
    const metrics = useMemo(
        () => getPierreDiffVirtualMetrics(codeFontSize, codeLineHeight),
        [codeFontSize, codeLineHeight],
    );

    if (!patch) {
        return null;
    }

    return (
        <PatchDiff
            className="block min-w-0 select-text"
            metrics={metrics}
            options={options}
            patch={patch}
            style={style}
        />
    );
}
