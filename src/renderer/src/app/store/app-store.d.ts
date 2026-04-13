import type { AppBootstrapSnapshot } from "@shared/ipc";
type BootStatus = "idle" | "loading" | "ready" | "error";
interface AppStore {
    readonly bootstrap: AppBootstrapSnapshot | null;
    readonly error: string | null;
    readonly status: BootStatus;
    hydrate: () => Promise<void>;
}
export declare const useAppStore: import("zustand").UseBoundStore<import("zustand").StoreApi<AppStore>>;
export {};
