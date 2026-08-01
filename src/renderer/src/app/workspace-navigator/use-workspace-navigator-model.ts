import { useMemo } from "react";
import { useStore } from "zustand";

import { getGitContextKey } from "../git/context-key";
import { useGitStore } from "../store/git-store";
import { useProjectsStore } from "../store/projects-store";
import { workspaceCatalogStore } from "../store/workspace-catalog-store";
import {
    buildWorkspaceNavigatorModel,
    type WorkspaceNavigatorModel,
} from "./model";

export function useWorkspaceNavigatorModel(): WorkspaceNavigatorModel {
    const projects = useProjectsStore((state) => state.projects);
    const worktreesByProject = useGitStore(
        (state) => state.worktreesByProject,
    );
    const gitErrors = useGitStore((state) => state.errors);
    const loadingContexts = useGitStore((state) => state.loadingContexts);
    const catalog = useStore(workspaceCatalogStore, (state) => state);

    return useMemo(() => {
        const inventoryErrorsByProject = Object.fromEntries(
            projects.map((project) => [
                project.id,
                gitErrors[getGitContextKey(project.id, null)] ?? null,
            ]),
        );
        const inventoryLoadingByProject = Object.fromEntries(
            projects.map((project) => [
                project.id,
                loadingContexts[getGitContextKey(project.id, null)] === true,
            ]),
        );
        return buildWorkspaceNavigatorModel({
            catalogEntries: catalog.entriesByScopeKey,
            diagnostics: catalog.surfaceDiagnostics,
            inventoryErrorsByProject,
            inventoryLoadingByProject,
            projects,
            pendingDeletionByScopeKey: catalog.pendingDeletionByScopeKey,
            recoveryByScopeKey: catalog.recoveryByScopeKey,
            worktreesByProject,
        });
    }, [catalog, gitErrors, loadingContexts, projects, worktreesByProject]);
}
