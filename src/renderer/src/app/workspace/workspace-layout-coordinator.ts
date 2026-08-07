import type { WorkspaceLayoutSnapshot } from "@shared/ipc";

import type {
    WorkspaceLayoutBinding,
    WorkspaceLayoutRecord,
    WorkspaceLayoutStore,
} from "../store/workspace-layout-store";

export interface WorkspaceLayoutAdapter {
    load(binding: WorkspaceLayoutBinding): Promise<WorkspaceLayoutRecord>;
    save(
        binding: WorkspaceLayoutBinding,
        layout: WorkspaceLayoutSnapshot,
        lastActivatedAt: string,
    ): Promise<WorkspaceLayoutRecord>;
}

export class WorkspaceLayoutCoordinator {
    readonly #adapter: WorkspaceLayoutAdapter;
    readonly #store: WorkspaceLayoutStore;
    #operation = 0;

    constructor(store: WorkspaceLayoutStore, adapter: WorkspaceLayoutAdapter) {
        this.#adapter = adapter;
        this.#store = store;
    }

    async hydrate(): Promise<WorkspaceLayoutRecord | null> {
        const operation = ++this.#operation;
        const binding = this.#store.getState().binding;
        this.#store.setState({ error: null, status: "loading" });

        try {
            const record = await this.#adapter.load(binding);
            if (!this.#isCurrent(operation, binding)) {
                return null;
            }
            this.#assertRecordMatchesBinding(record, binding);
            this.#store.setState({
                binding: {
                    ...binding,
                    revision: record.revision,
                },
                error: null,
                lastActivatedAt: record.lastActivatedAt,
                layout: record.layout,
                status: "ready",
            });
            return record;
        } catch (error) {
            if (this.#isCurrent(operation, binding)) {
                this.#store.setState({
                    error:
                        error instanceof Error
                            ? error.message
                            : "Could not restore the workspace layout.",
                    status: "error",
                });
            }
            throw error;
        }
    }

    async persist(layout: WorkspaceLayoutSnapshot): Promise<boolean> {
        const operation = ++this.#operation;
        const state = this.#store.getState();
        const binding = state.binding;
        const lastActivatedAt =
            state.lastActivatedAt ?? new Date().toISOString();
        this.#store.setState({ error: null, status: "saving" });

        try {
            const record = await this.#saveWithConflictRecovery(
                binding,
                layout,
                lastActivatedAt,
            );
            if (!this.#isCurrent(operation, binding)) {
                return false;
            }
            this.#assertRecordMatchesBinding(record, binding);
            this.#store.setState({
                binding: {
                    ...binding,
                    revision: record.revision,
                },
                error: null,
                lastActivatedAt: record.lastActivatedAt,
                layout: record.layout,
                status: "ready",
            });
            return true;
        } catch (error) {
            if (this.#isCurrent(operation, binding)) {
                this.#store.setState({
                    error:
                        error instanceof Error
                            ? error.message
                            : "Could not save the workspace layout.",
                    status: "error",
                });
            }
            throw error;
        }
    }

    dispose(): void {
        this.#operation += 1;
    }

    async #saveWithConflictRecovery(
        binding: WorkspaceLayoutBinding,
        layout: WorkspaceLayoutSnapshot,
        lastActivatedAt: string,
    ): Promise<WorkspaceLayoutRecord> {
        try {
            return await this.#adapter.save(binding, layout, lastActivatedAt);
        } catch (error) {
            if (!isWorkspaceRevisionConflict(error)) {
                throw error;
            }

            // Refresh the CAS token before one retry so a completed save from
            // a previous surface lifecycle cannot leave this renderer stale.
            const current = await this.#adapter.load(binding);
            this.#assertRecordMatchesBinding(current, binding);
            return await this.#adapter.save(
                {
                    ...binding,
                    revision: current.revision,
                },
                layout,
                lastActivatedAt,
            );
        }
    }

    #assertRecordMatchesBinding(
        record: WorkspaceLayoutRecord,
        binding: WorkspaceLayoutBinding,
    ): void {
        if (
            record.scopeKey !== binding.scopeKey ||
            record.generation !== binding.generation ||
            record.projectId !== binding.projectId ||
            record.worktreeId !== binding.worktreeId
        ) {
            throw new Error(
                "The workspace layout response does not match this surface.",
            );
        }
    }

    #isCurrent(
        operation: number,
        binding: WorkspaceLayoutBinding,
    ): boolean {
        const current = this.#store.getState().binding;
        return (
            operation === this.#operation &&
            current.scopeKey === binding.scopeKey &&
            current.generation === binding.generation &&
            current.revision === binding.revision
        );
    }
}

function isWorkspaceRevisionConflict(error: unknown): boolean {
    return (
        error instanceof Error &&
        error.message.includes("The durable workspace revision changed")
    );
}
