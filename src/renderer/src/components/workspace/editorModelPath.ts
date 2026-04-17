export type WorkspaceEditorModelVariant =
    | "editor"
    | "review-modified"
    | "review-original";

function sanitizeModelSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function splitPathExtension(absolutePath: string): {
    readonly extension: string;
    readonly stem: string;
} {
    const normalizedPath = absolutePath.replaceAll("\\", "/");
    const lowerCasePath = normalizedPath.toLowerCase();
    const compoundExtensions = [".d.ts", ".d.mts", ".d.cts"];

    for (const extension of compoundExtensions) {
        if (lowerCasePath.endsWith(extension)) {
            return {
                extension: absolutePath.slice(-extension.length),
                stem: absolutePath.slice(0, -extension.length),
            };
        }
    }

    const lastSeparatorIndex = normalizedPath.lastIndexOf("/");
    const lastDotIndex = normalizedPath.lastIndexOf(".");

    if (lastDotIndex <= lastSeparatorIndex + 1) {
        return {
            extension: "",
            stem: absolutePath,
        };
    }

    return {
        extension: absolutePath.slice(lastDotIndex),
        stem: absolutePath.slice(0, lastDotIndex),
    };
}

export function buildWorkspaceEditorModelPath(
    absolutePath: string,
    tabId: string,
    variant: WorkspaceEditorModelVariant,
): string {
    const { extension, stem } = splitPathExtension(absolutePath);
    const modelSuffix = [
        "__workspace-tab__",
        sanitizeModelSegment(tabId),
        "__",
        sanitizeModelSegment(variant),
    ].join("");

    return extension
        ? `${stem}${modelSuffix}${extension}`
        : `${absolutePath}${modelSuffix}`;
}
