export type WorkspaceEditorModelVariant =
    | "editor"
    | "review-modified"
    | "review-original";

export function buildWorkspaceEditorModelPath(
    absolutePath: string,
    tabId: string,
    variant: WorkspaceEditorModelVariant,
): string {
    return `${absolutePath}::workspace-tab::${tabId}::${variant}`;
}
