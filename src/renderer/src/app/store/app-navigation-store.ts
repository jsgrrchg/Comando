import { createStore } from "zustand/vanilla";

import type { WorkspaceNavigationSnapshot } from "@shared/ipc";
import type { NativeAppWorkspaceNavigation } from "@shared/native-backend";

export interface AppNavigationSnapshot {
    readonly activeScopeKey: string | null;
    readonly recentScopeKeys: readonly string[];
    readonly revision: number | null;
    readonly source: "durable" | "legacy-v3";
    readonly updatedAt: string | null;
}

interface AppNavigationState extends AppNavigationSnapshot {
    readonly error: string | null;
    readonly status: "idle" | "loading" | "ready" | "error";
    replaceDurable: (navigation: NativeAppWorkspaceNavigation) => void;
    replaceLegacy: (navigation: WorkspaceNavigationSnapshot) => void;
    setError: (error: string) => void;
    setLoading: () => void;
}

const EMPTY_NAVIGATION: AppNavigationSnapshot = {
    activeScopeKey: null,
    recentScopeKeys: [],
    revision: null,
    source: "legacy-v3",
    updatedAt: null,
};

export const appNavigationStore = createStore<AppNavigationState>((set) => ({
    ...EMPTY_NAVIGATION,
    error: null,
    status: "idle",
    replaceDurable: (navigation) => {
        set({
            activeScopeKey: navigation.activeScopeKey,
            error: null,
            recentScopeKeys: navigation.recentScopeKeys,
            revision: navigation.revision,
            source: "durable",
            status: "ready",
            updatedAt: navigation.updatedAt,
        });
    },
    replaceLegacy: (navigation) => {
        const recentScopeKeys = navigation.contexts
            .toSorted((left, right) =>
                right.lastActivatedAt.localeCompare(left.lastActivatedAt),
            )
            .map((context) => context.key);
        set({
            activeScopeKey: navigation.activeContextKey,
            error: null,
            recentScopeKeys,
            revision: null,
            source: "legacy-v3",
            status: "ready",
            updatedAt:
                navigation.contexts
                    .map((context) => context.lastActivatedAt)
                    .toSorted()
                    .at(-1) ?? null,
        });
    },
    setError: (error) => set({ error, status: "error" }),
    setLoading: () => set({ error: null, status: "loading" }),
}));

export function resetAppNavigationStoreForTests(): void {
    appNavigationStore.setState({
        ...EMPTY_NAVIGATION,
        error: null,
        status: "idle",
    });
}
