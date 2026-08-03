import { useCallback, useSyncExternalStore } from "react";

import type { GitDiffStyle } from "./types";

export const GIT_DIFF_STYLE_STORAGE_KEY = "comando.workspace.gitDiffStyle:v1";

const DEFAULT_GIT_DIFF_STYLE: GitDiffStyle = "unified";
const listeners = new Set<() => void>();

function getStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

export function readPersistedGitDiffStyle(): GitDiffStyle {
    try {
        return getStorage()?.getItem(GIT_DIFF_STYLE_STORAGE_KEY) === "split"
            ? "split"
            : DEFAULT_GIT_DIFF_STYLE;
    } catch {
        return DEFAULT_GIT_DIFF_STYLE;
    }
}

export function persistGitDiffStyle(style: GitDiffStyle): GitDiffStyle {
    try {
        getStorage()?.setItem(GIT_DIFF_STYLE_STORAGE_KEY, style);
    } catch {
        // Ignore unavailable browser storage and keep the default on the next read.
    }

    return style;
}

function subscribeToGitDiffStyle(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function notifyGitDiffStyleChange(): void {
    for (const listener of listeners) {
        listener();
    }
}

export function usePersistedGitDiffStyle(): readonly [
    GitDiffStyle,
    (style: GitDiffStyle) => void,
] {
    const style = useSyncExternalStore(
        subscribeToGitDiffStyle,
        readPersistedGitDiffStyle,
        () => DEFAULT_GIT_DIFF_STYLE,
    );
    const setStyle = useCallback((nextStyle: GitDiffStyle) => {
        persistGitDiffStyle(nextStyle);
        notifyGitDiffStyleChange();
    }, []);

    return [style, setStyle];
}
