import { describe, expect, it, vi } from "vitest";

import type { RuntimeWorkspaceTab } from "./tree";
import {
    collectWorkspaceSurfaceStateLeases,
    WorkspaceSurfaceLeaseRegistry,
} from "./surface-lease-registry";

describe("WorkspaceSurfaceLeaseRegistry", () => {
    it("reports dirty, saving, externally changed and failed file states", () => {
        const tab = {
            hasExternalChange: true,
            id: "file-a",
            isDirty: true,
            isSaving: true,
            kind: "file",
            saveError: "disk full",
        } as RuntimeWorkspaceTab;

        expect(
            collectWorkspaceSurfaceStateLeases({ tabsById: { [tab.id]: tab } }).map(
                (lease) => lease.kind,
            ),
        ).toEqual([
            "dirty-file",
            "saving-file",
            "external-file-conflict",
            "failed-save",
        ]);
    });

    it("uses identity-safe releases and notifies subscribers", () => {
        const registry = new WorkspaceSurfaceLeaseRegistry();
        const listener = vi.fn();
        registry.subscribe(listener);
        const releaseFirst = registry.acquire({
            id: "modal",
            kind: "critical-modal",
            message: "A confirmation is open.",
        });
        const releaseReplacement = registry.acquire({
            id: "modal",
            kind: "active-drag",
            message: "A drag is active.",
        });

        releaseFirst();
        expect(registry.list()).toMatchObject([{ kind: "active-drag" }]);
        releaseReplacement();
        expect(registry.list()).toEqual([]);
        expect(listener).toHaveBeenCalledTimes(3);
    });
});
