export function joinProjectPath(
    rootPath: string,
    relativePath: string,
): string {
    if (!relativePath) {
        return rootPath;
    }

    const separator = rootPath.includes("\\") ? "\\" : "/";
    return `${rootPath.replace(/[\\/]+$/, "")}${separator}${relativePath
        .split("/")
        .join(separator)}`;
}

export function resolveProjectFileFullPath(input: {
    readonly absolutePath?: string | null;
    readonly relativePath: string;
    readonly rootPath: string | null;
}): string | null {
    // Loaded documents are authoritative, especially when the tab belongs to a worktree.
    if (input.absolutePath) {
        return input.absolutePath;
    }

    return input.rootPath
        ? joinProjectPath(input.rootPath, input.relativePath)
        : null;
}
