import { create } from "zustand";
export const useAppStore = create((set) => ({
    bootstrap: null,
    error: null,
    status: "idle",
    hydrate: async () => {
        set({ error: null, status: "loading" });
        try {
            const bootstrap = await window.comando.getBootstrapSnapshot();
            set({ bootstrap, status: "ready" });
        }
        catch (error) {
            const message = error instanceof Error
                ? error.message
                : "Could not hydrate the app.";
            set({ error: message, status: "error" });
        }
    },
}));
