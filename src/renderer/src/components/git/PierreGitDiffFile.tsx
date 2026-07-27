export {
    canRenderGitDiffWithPierre,
    compactPartialHunkOffsets,
    createPierreGitDiffItem,
    getPierreDiffVirtualMetrics,
    getPierreGitDiffPatch,
    PIERRE_GIT_DIFF_HEADER_HEIGHT_PX,
} from "./PierreGitDiffModel";

export const PIERRE_GIT_DIFF_UNSAFE_CSS = `
[data-diffs-header="default"] {
    min-height: 34px;
    padding-inline: 8px;
    border-bottom: 1px solid var(--diffs-bg-separator);
}

[data-diffs-header="default"] [data-header-content] {
    flex: 1 1 auto;
}

[data-diffs-header="default"] [data-metadata] {
    flex: 0 0 auto;
}

[data-diffs-header="default"][data-sticky] {
    z-index: 4;
}
`;
