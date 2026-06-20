import { describe, expect, it, vi } from "vitest";

import {
    NATIVE_PERSISTENCE_ENABLED_ENV,
    NATIVE_PERSISTENCE_STRICT_ENV,
    NativePersistenceGateway,
    isNativePersistenceEnabled,
    isNativePersistenceStrict,
    normalizeNativePersistenceMode,
    type NativeBackendRequester,
} from "./persistence";

describe("native persistence flags", () => {
    it("defaults persistence off", () => {
        expect(isNativePersistenceEnabled({})).toBe(false);
        expect(isNativePersistenceStrict({})).toBe(false);
    });

    it("requires explicit opt-in", () => {
        expect(
            isNativePersistenceEnabled({
                [NATIVE_PERSISTENCE_ENABLED_ENV]: "1",
            }),
        ).toBe(true);
        expect(
            isNativePersistenceStrict({
                [NATIVE_PERSISTENCE_STRICT_ENV]: "1",
            }),
        ).toBe(true);
    });

    it("normalizes persistence mode defensively", () => {
        expect(normalizeNativePersistenceMode(undefined)).toBe("shadow");
        expect(normalizeNativePersistenceMode("shadow")).toBe("shadow");
        expect(normalizeNativePersistenceMode("write")).toBe("write");
    });
});

describe("NativePersistenceGateway", () => {
    it("opens native storage with the expected command", async () => {
        const requestMock = vi.fn(
            async (_command: string, _args?: Record<string, unknown>) => ({
            metadataReady: true,
            opened: true,
            schemaVersion: "1",
            storageMode: "sqlite-current",
            }),
        );
        const request: NativeBackendRequester["request"] = async (...args) =>
            (await requestMock(...args)) as never;
        const gateway = new NativePersistenceGateway({
            request,
        } satisfies NativeBackendRequester);

        await expect(
            gateway.openStore({
                appDataDir: "/tmp/app",
                databasePath: "/tmp/app/comando.sqlite3",
                mode: "shadow",
            }),
        ).resolves.toMatchObject({ opened: true });

        expect(requestMock).toHaveBeenCalledWith("persistence_open_store", {
            appDataDir: "/tmp/app",
            databasePath: "/tmp/app/comando.sqlite3",
            mode: "shadow",
        });
    });

    it("loads storage health", async () => {
        const requestMock = vi.fn(
            async (_command: string, _args?: Record<string, unknown>) => ({
            checkedAt: "2026-06-20T00:00:00.000Z",
            databaseReachable: true,
            metadataReady: true,
            opened: true,
            projectCount: 2,
            schemaCompatible: true,
            worktreeCount: 3,
            }),
        );
        const request: NativeBackendRequester["request"] = async (...args) =>
            (await requestMock(...args)) as never;
        const gateway = new NativePersistenceGateway({
            request,
        });

        await expect(gateway.getStorageHealth()).resolves.toMatchObject({
            projectCount: 2,
            worktreeCount: 3,
        });
    });
});
