import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), "utf8");
const retired = (...parts: string[]) => parts.join("");

describe("macro workspace navigation retirement", () => {
    it("keeps removed tab-strip modules out of the renderer", () => {
        const removedFiles = [
            ["Desktop", "TopBar.tsx"],
            ["Project", "ContextMenu.tsx"],
            ["useProject", "ContextTabDrag.ts"],
        ].map((parts) =>
            resolve(root, "src/renderer/src/components", retired(...parts)),
        );

        for (const file of removedFiles) {
            expect(existsSync(file)).toBe(false);
        }
    });

    it("keeps runtime navigation free from macro tab contracts", () => {
        const store = source("src/renderer/src/app/store/workspace-store.ts");
        const manager = source("src/main/workspace/surface-manager.ts");
        const ipc = source("src/shared/ipc.ts");
        const styles = source("src/renderer/src/styles.css");

        for (const token of [
            retired("close", "Context"),
            retired("reorder", "Context"),
            retired("MAX_CLOSED_", "WORKSPACE_CONTEXTS"),
            retired("getWorkspace", "Snapshot"),
            retired("saveWorkspace", "Snapshot"),
        ]) {
            expect(store).not.toContain(token);
            expect(ipc).not.toContain(token);
        }
        expect(manager).not.toContain(retired("open", "ContextKeys"));
        expect(manager).not.toContain(retired("Workspace", "NavigationSnapshot"));
        expect(styles).not.toContain(retired("project-context-", "tab"));
    });

    it("persists surface layouts through the durable adapter", () => {
        const runtime = source(
            "src/renderer/src/app/workspace/workspace-surface-layout-runtime.ts",
        );
        const removedAdapter = resolve(
            root,
            "src/renderer/src/app/workspace",
            retired("legacy", "-v3-", "workspace-layout-adapter.ts"),
        );

        expect(runtime).toContain("DurableWorkspaceLayoutAdapter");
        expect(existsSync(removedAdapter)).toBe(false);
    });
});
