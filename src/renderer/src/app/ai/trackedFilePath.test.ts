import { afterEach, describe, expect, it } from "vitest";

import type { AppBootstrapSnapshot } from "@shared/ipc";

import { useAppStore } from "@renderer/app/store/app-store";
import {
    areTrackedFilePathReferencesEquivalent,
    areTrackedFilePathsEquivalent,
    TrackedFilePathReferenceSet,
} from "./trackedFilePath";

afterEach(() => {
    useAppStore.setState({
        bootstrap: null,
        error: null,
        status: "idle",
    });
});

describe("trackedFilePath", () => {
    it("matches relative forward-slash casing aliases on Windows", () => {
        setRendererPlatform("win32");

        expect(
            areTrackedFilePathsEquivalent("src/App.ts", "src/app.ts"),
        ).toBe(true);
    });

    it("keeps relative forward-slash casing distinct on Linux", () => {
        setRendererPlatform("linux");

        expect(
            areTrackedFilePathsEquivalent("src/App.ts", "src/app.ts"),
        ).toBe(false);
    });

    it("still treats explicit Windows-shaped paths as Windows aliases", () => {
        setRendererPlatform("linux");

        expect(
            areTrackedFilePathsEquivalent(
                "C:\\Repo\\src\\App.ts",
                "c:\\repo\\src\\app.ts",
            ),
        ).toBe(true);
    });

    it("matches normalized relative paths to absolute workspace references", () => {
        setRendererPlatform("darwin");

        expect(
            areTrackedFilePathReferencesEquivalent(
                "/Users/example/Comando/src/app.ts",
                "./src/app.ts",
            ),
        ).toBe(true);
    });

    it("matches Windows absolute and relative references across separators and casing", () => {
        expect(
            areTrackedFilePathReferencesEquivalent(
                "C:\\Workspace\\Comando\\src\\App.ts",
                ".\\src/app.ts",
            ),
        ).toBe(true);
    });

    it("does not merge absolute paths from different workspaces", () => {
        expect(
            areTrackedFilePathReferencesEquivalent(
                "/workspace/one/src/app.ts",
                "/workspace/two/src/app.ts",
            ),
        ).toBe(false);
    });

    it("deduplicates relative aliases without merging absolute workspaces", () => {
        setRendererPlatform("darwin");
        const paths = new TrackedFilePathReferenceSet();

        expect(paths.add("/workspace/one/src/app.ts")).toBe(true);
        expect(paths.add("./src/app.ts")).toBe(false);
        expect(paths.add("/workspace/two/src/app.ts")).toBe(true);
        expect(paths.size).toBe(2);
    });
});

function setRendererPlatform(platform: string): void {
    useAppStore.setState({
        bootstrap: createBootstrap(platform),
        error: null,
        status: "ready",
    });
}

function createBootstrap(platform: string): AppBootstrapSnapshot {
    return {
        app: {
            bundleId: "test.bundle",
            channel: "dev",
            iconPaths: {
                macos: "macos.icon",
                png: "app.png",
                windows: "windows.ico",
            },
            id: "test.app",
            name: "Test App",
            productName: "Test App",
            windowTitle: "Test App",
        },
        database: {
            appliedMigrations: [],
            databaseFile: ":memory:",
        },
        platform,
        startedAt: "2026-06-08T00:00:00.000Z",
        versions: {
            chrome: "0",
            electron: "0",
            node: "0",
        },
    };
}
