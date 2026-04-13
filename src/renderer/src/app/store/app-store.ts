import { create } from "zustand";

import type { AppBootstrapSnapshot } from "@shared/ipc";

type BootStatus = "idle" | "loading" | "ready" | "error";

interface AppStore {
    readonly bootstrap: AppBootstrapSnapshot | null;
    readonly error: string | null;
    readonly status: BootStatus;
    hydrate: () => Promise<void>;
}

export const useAppStore = create<AppStore>((set) => ({
    bootstrap: null,
    error: null,
    status: "idle",
    hydrate: async () => {
        set({ error: null, status: "loading" });

        try {
            const bootstrap = await window.comando.getBootstrapSnapshot();
            set({ bootstrap, status: "ready" });
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Could not hydrate the app.";
            set({ error: message, status: "error" });
        }
    },
}));
