import { describe, expect, it, vi } from "vitest";

import {
    NativePersistenceGateway,
    type NativeBackendRequester,
} from "./persistence";

describe("NativePersistenceGateway", () => {
    it("opens native storage with the expected command", async () => {
        const requestMock = vi.fn(
            (command: string, args?: Record<string, unknown>) => {
                void command;
                void args;
                return Promise.resolve({
                    metadataReady: true,
                    opened: true,
                    schemaVersion: "1",
                    storageMode: "sqlite-current",
                });
            },
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
            (command: string, args?: Record<string, unknown>) => {
                void command;
                void args;
                return Promise.resolve({
                    checkedAt: "2026-06-20T00:00:00.000Z",
                    databaseReachable: true,
                    metadataReady: true,
                    opened: true,
                    projectCount: 2,
                    schemaCompatible: true,
                    worktreeCount: 3,
                });
            },
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
