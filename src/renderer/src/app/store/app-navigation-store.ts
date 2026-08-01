import { createStore } from "zustand/vanilla";

import type { NativeAppWorkspaceNavigation } from "@shared/native-backend";

export interface AppNavigationSnapshot {
    readonly activeScopeKey: string | null;
    readonly recentScopeKeys: readonly string[];
    readonly revision: number | null;
    readonly source: "durable";
    readonly updatedAt: string | null;
}

interface AppNavigationState extends AppNavigationSnapshot {
    readonly error: string | null;
    readonly status: "idle" | "loading" | "ready" | "error";
    replaceDurable: (navigation: NativeAppWorkspaceNavigation) => void;
    setError: (error: string) => void;
    setLoading: () => void;
}

const EMPTY_NAVIGATION: AppNavigationSnapshot = {
    activeScopeKey: null,
    recentScopeKeys: [],
    revision: null,
    source: "durable",
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
