import path from "node:path";

// Resolves the user-level data directory where ACP runtimes persist auth
// state on disk (e.g. <data-dir>/<runtime>/auth.json). Lookup order:
//
//   1. XDG_DATA_HOME, if set.
//   2. LOCALAPPDATA on Windows, if set.
//   3. HOME or USERPROFILE joined with ".local/share".
//
// Returns null when none of those resolve to a non-empty path.
export function resolveXdgDataDir(
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    const xdgDataHome = env.XDG_DATA_HOME?.trim() ?? "";
    if (xdgDataHome) {
        return xdgDataHome;
    }

    if (process.platform === "win32") {
        const localAppData = env.LOCALAPPDATA?.trim() ?? "";
        if (localAppData) {
            return localAppData;
        }
    }

    const homeDir = env.HOME?.trim() || env.USERPROFILE?.trim() || "";
    if (!homeDir) {
        return null;
    }

    return path.join(homeDir, ".local", "share");
}
