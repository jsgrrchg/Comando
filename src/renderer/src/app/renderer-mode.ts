export type RendererMode =
    | "legacy"
    | "settings"
    | "workspace-host"
    | "workspace-surface";

export interface WorkspaceSurfaceRendererDescriptor {
    readonly generation: string;
    readonly projectId: string;
    readonly revision: number;
    readonly scopeKey: string;
    readonly worktreeId: string | null;
}

export const RENDERER_MODE_SUBSYSTEMS = {
    legacy: ["host", "layout", "runtime"] as const,
    settings: ["settings"] as const,
    "workspace-host": ["catalog", "navigation", "shell"] as const,
    "workspace-surface": ["layout", "runtime"] as const,
};

export function resolveRendererMode(search: string): RendererMode {
    const mode = new URLSearchParams(search).get("window");
    if (
        mode === "settings" ||
        mode === "workspace-host" ||
        mode === "workspace-surface"
    ) {
        return mode;
    }
    return "legacy";
}

export function parseWorkspaceSurfaceRendererDescriptor(
    search: string,
): WorkspaceSurfaceRendererDescriptor | null {
    const params = new URLSearchParams(search);
    if (params.get("window") !== "workspace-surface") {
        return null;
    }

    const generation = params.get("surface")?.trim() ?? "";
    const projectId = params.get("project")?.trim() ?? "";
    const scopeKey = params.get("scope")?.trim() ?? "";
    const revisionValue = Number(params.get("revision") ?? "0");
    if (
        !generation ||
        !projectId ||
        !scopeKey ||
        !Number.isSafeInteger(revisionValue) ||
        revisionValue < 0
    ) {
        return null;
    }

    return {
        generation,
        projectId,
        revision: revisionValue,
        scopeKey,
        worktreeId: params.get("worktree") || null,
    };
}

export function rendererModeRequiresReviewEngine(mode: RendererMode): boolean {
    return mode === "legacy" || mode === "workspace-surface";
}
