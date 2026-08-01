import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("durable workspace rollout retirement", () => {
    it("keeps v4 bootstrap unconditional and removed runtime flags retired", () => {
        const appData = source("src/main/native-backend/app-data.ts");
        const removedFlags = resolve(
            root,
            "src/shared/durable-workspace-feature-flags.ts",
        );

        expect(existsSync(removedFlags)).toBe(false);
        expect(appData).toContain("runWorkspaceMigration(migrationInput)");
        expect(appData).toContain('HOST_PERSISTENCE_KEY = "persistence.mainWindow"');
        expect(appData).not.toContain("durableWorkspaceFeatureFlags");
        expect(appData).not.toContain("syncLegacyProjection");
    });

    it("keeps v3 compatibility confined to migration and explicit rollout policy", () => {
        const durableAdapter = source(
            "src/renderer/src/app/workspace/durable-workspace-layout-adapter.ts",
        );
        const surfaceRuntime = source(
            "src/renderer/src/app/workspace/workspace-surface-layout-runtime.ts",
        );
        const appData = source("src/main/native-backend/app-data.ts");

        expect(durableAdapter).not.toContain("workspaceRestore");
        expect(surfaceRuntime).not.toContain("workspaceRestore");
        expect(appData).toContain("syncLegacyWorkspaceMigration(migrationInput)");
        expect(appData).toContain('rollout.stage === "internal"');
    });
});
