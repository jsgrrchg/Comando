import {
    MultiFileDiff,
    type FileContents,
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

export type PierreGitDiffInput =
    | {
          readonly newFile: FileContents;
          readonly oldFile: FileContents;
      }
    | {
          readonly newFile: FileContents;
          readonly oldFile: null;
      }
    | {
          readonly newFile: null;
          readonly oldFile: FileContents;
      };

const DEFAULT_PIERRE_FONT_SIZE_PX = 13;
const DEFAULT_PIERRE_LINE_HEIGHT = 1.55;

function createPierreFile(
    cacheKey: string,
    contents: string,
    name: string,
): FileContents {
    return { cacheKey, contents, name };
}

export function getPierreGitDiffInput(
    file: GitDiffFile,
): PierreGitDiffInput | null {
    if (!file.isText) {
        return null;
    }

    if (file.kind === "create") {
        return typeof file.newText === "string"
            ? {
                  newFile: createPierreFile(
                      `${file.id}:new`,
                      file.newText,
                      file.path,
                  ),
                  oldFile: null,
              }
            : null;
    }

    if (file.kind === "delete") {
        return typeof file.oldText === "string"
            ? {
                  newFile: null,
                  oldFile: createPierreFile(
                      `${file.id}:old`,
                      file.oldText,
                      file.previousPath ?? file.path,
                  ),
              }
            : null;
    }

    if (typeof file.oldText !== "string" || typeof file.newText !== "string") {
        return null;
    }

    return {
        newFile: createPierreFile(`${file.id}:new`, file.newText, file.path),
        oldFile: createPierreFile(
            `${file.id}:old`,
            file.oldText,
            file.previousPath ?? file.path,
        ),
    };
}

export function canRenderGitDiffWithPierre(file: GitDiffFile): boolean {
    return getPierreGitDiffInput(file) !== null;
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
    const input = useMemo(() => getPierreGitDiffInput(file), [file]);
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

    if (!input) {
        return null;
    }

    return (
        <MultiFileDiff
            {...input}
            className="block min-w-0 select-text"
            metrics={metrics}
            options={options}
            style={style}
        />
    );
}
