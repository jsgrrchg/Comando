import type {
    WorkspaceSurfaceHardLease,
    WorkspaceSurfaceHardLeaseKind,
} from "@shared/ipc";

import type { RuntimeWorkspaceTab } from "./tree";

interface WorkspaceSurfaceLeaseSource {
    readonly tabsById: Readonly<Record<string, RuntimeWorkspaceTab>>;
}

export class WorkspaceSurfaceLeaseRegistry {
    readonly #leases = new Map<string, WorkspaceSurfaceHardLease>();
    readonly #listeners = new Set<() => void>();

    acquire(input: {
        readonly id: string;
        readonly kind: WorkspaceSurfaceHardLeaseKind;
        readonly message: string;
    }): () => void {
        const lease: WorkspaceSurfaceHardLease = {
            acquiredAt: new Date().toISOString(),
            ...input,
        };
        this.#leases.set(input.id, lease);
        this.#emit();
        return () => {
            if (this.#leases.get(input.id) === lease) {
                this.#leases.delete(input.id);
                this.#emit();
            }
        };
    }

    list(): readonly WorkspaceSurfaceHardLease[] {
        return [...this.#leases.values()];
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    clearForTests(): void {
        this.#leases.clear();
        this.#emit();
    }

    #emit(): void {
        for (const listener of this.#listeners) {
            listener();
        }
    }
}

export function collectWorkspaceSurfaceStateLeases(
    state: WorkspaceSurfaceLeaseSource,
    acquiredAt = new Date().toISOString(),
): readonly WorkspaceSurfaceHardLease[] {
    const leases: WorkspaceSurfaceHardLease[] = [];
    for (const tab of Object.values(state.tabsById)) {
        if (tab.kind !== "file") {
            continue;
        }
        if (tab.isDirty) {
            leases.push({
                acquiredAt,
                id: `dirty-file:${tab.id}`,
                kind: "dirty-file",
                message: "A file has unsaved changes.",
            });
        }
        if (tab.isSaving) {
            leases.push({
                acquiredAt,
                id: `saving-file:${tab.id}`,
                kind: "saving-file",
                message: "A file save is still in progress.",
            });
        }
        if (tab.hasExternalChange) {
            leases.push({
                acquiredAt,
                id: `external-file-conflict:${tab.id}`,
                kind: "external-file-conflict",
                message: "A file has an unresolved external change.",
            });
        }
        if (tab.saveError) {
            leases.push({
                acquiredAt,
                id: `failed-save:${tab.id}`,
                kind: "failed-save",
                message: "A file could not be saved.",
            });
        }
    }
    return leases;
}

export const workspaceSurfaceLeaseRegistry =
    new WorkspaceSurfaceLeaseRegistry();
