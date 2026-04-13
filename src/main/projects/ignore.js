const ignoredDirectoryNames = new Set([
    ".git",
    "node_modules",
    "dist",
    "target",
    "build",
    "coverage",
    "out",
]);
const ignoredFileNames = new Set([".DS_Store", "Thumbs.db"]);
export function shouldIgnoreEntry(name, isDirectory) {
    if (ignoredFileNames.has(name)) {
        return true;
    }
    if (isDirectory && ignoredDirectoryNames.has(name)) {
        return true;
    }
    return false;
}
