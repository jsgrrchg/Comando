let claudeCodeInstalledCache: boolean | null = null;

export async function checkClaudeCodeInstalled(): Promise<boolean> {
    if (claudeCodeInstalledCache !== null) {
        return claudeCodeInstalledCache;
    }

    try {
        const api = getComandoApi();
        const result = await api.checkCommandAvailability({ name: "claude" });
        claudeCodeInstalledCache = result.found;
    } catch {
        claudeCodeInstalledCache = false;
    }

    return claudeCodeInstalledCache;
}

export function resetClaudeCodeInstalledCacheForTests(): void {
    claudeCodeInstalledCache = null;
}

function getComandoApi() {
    const comandoWindow = globalThis.window;
    if (!comandoWindow?.comando) {
        throw new Error(
            "The desktop bridge is not available yet. Restart the Electron app and try again.",
        );
    }

    return comandoWindow.comando;
}
