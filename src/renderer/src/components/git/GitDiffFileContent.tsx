import type { RefObject } from "react";

import { GitEmptyState } from "./GitUi";
import { LegacyGitDiffHunks } from "./LegacyGitDiffHunks";
import type { GitDiffFile } from "./types";

export function GitDiffFileContent({
    codeFontFamily,
    codeFontSize,
    codeLineHeight,
    file,
    lineWrapping,
    scrollContainerRef,
    virtualizeLines,
}: {
    readonly codeFontFamily: string | null;
    readonly codeFontSize: number | null;
    readonly codeLineHeight: number | null;
    readonly file: GitDiffFile;
    readonly lineWrapping: boolean;
    readonly scrollContainerRef?: RefObject<HTMLElement | null>;
    readonly virtualizeLines: boolean;
}) {
    if (!file.isText) {
        return (
            <div className="p-3">
                <GitEmptyState>
                    This file is binary, so Comando can show metadata but not a
                    textual diff.
                </GitEmptyState>
            </div>
        );
    }

    const legacyHunks =
        file.hunks.length > 0 ? (
            <LegacyGitDiffHunks
                codeFontFamily={codeFontFamily}
                codeFontSize={codeFontSize}
                codeLineHeight={codeLineHeight}
                file={file}
                lineWrapping={lineWrapping}
                scrollContainerRef={scrollContainerRef}
                virtualizeLines={virtualizeLines}
            />
        ) : null;

    return legacyHunks ?? <EmptyGitDiffState file={file} />;
}

function EmptyGitDiffState({ file }: { readonly file: GitDiffFile }) {
    return (
        <div className="p-3">
            <GitEmptyState>
                {file.emptyState ?? "No hunks were produced for this file."}
            </GitEmptyState>
        </div>
    );
}
