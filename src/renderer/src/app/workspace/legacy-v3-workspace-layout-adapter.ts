import type {
    ComandoApi,
    WorkspaceLayoutSnapshot,
    WorkspaceNavigationSnapshot,
} from "@shared/ipc";
import { normalizeWorkspaceNavigationSnapshot } from "@shared/workspace-restore";

import type { WorkspaceLayoutBinding } from "../store/workspace-layout-store";
import type {
    WorkspaceLayoutAdapter,
} from "./workspace-layout-coordinator";

export class LegacyV3WorkspaceLayoutAdapter implements WorkspaceLayoutAdapter {
    readonly #api: Pick<
        ComandoApi,
        "getWorkspaceSnapshot" | "saveWorkspaceSnapshot"
    >;

    constructor(
        api: Pick<
            ComandoApi,
            "getWorkspaceSnapshot" | "saveWorkspaceSnapshot"
        >,
    ) {
        this.#api = api;
    }

    async load(binding: WorkspaceLayoutBinding) {
        const persisted = await this.#api.getWorkspaceSnapshot();
        const navigation = normalizeWorkspaceNavigationSnapshot(persisted, {
            projectId: binding.projectId,
            worktreeId: binding.worktreeId,
        }).snapshot;
        const context = navigation.contexts.find(
            (candidate) => candidate.key === binding.scopeKey,
        );
        if (!context) {
            throw new Error("This surface has no matching workspace layout.");
        }

        return {
            ...binding,
            lastActivatedAt: context.lastActivatedAt,
            layout: context.workspace,
        };
    }

    async save(
        binding: WorkspaceLayoutBinding,
        layout: WorkspaceLayoutSnapshot,
        lastActivatedAt: string,
    ) {
        const snapshot: WorkspaceNavigationSnapshot = {
            activeContextKey: binding.scopeKey,
            contexts: [
                {
                    key: binding.scopeKey,
                    lastActivatedAt,
                    projectId: binding.projectId,
                    workspace: layout,
                    worktreeId: binding.worktreeId,
                },
            ],
            openContextKeys: [binding.scopeKey],
            version: 3,
        };
        await this.#api.saveWorkspaceSnapshot(snapshot);

        return {
            ...binding,
            lastActivatedAt,
            layout,
            revision: binding.revision + 1,
        };
    }
}
