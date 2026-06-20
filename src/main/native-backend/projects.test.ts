import { describe, expect, it, vi } from "vitest";

import type {
    ProjectRecord,
    ProjectStore,
    ProjectStoreAddPathsResult,
    ProjectStoreStateSnapshot,
    ProjectStoreWorktreeRecord,
} from "../projects/store";
import {
    NATIVE_PROJECT_REGISTRY_ENABLED_ENV,
    NATIVE_PROJECT_REGISTRY_MODE_ENV,
    NativeProjectRegistryGateway,
    compareProjectRegistryStates,
    createNativeProjectRegistryStore,
    nativeProjectStateToStoreSnapshot,
    resolveNativeProjectRegistryMode,
} from "./projects";
import type { NativeBackendRequester } from "./persistence";

describe("native project registry flags", () => {
    it("defaults off and defaults enabled mode to shadow", () => {
        expect(resolveNativeProjectRegistryMode({})).toBeNull();
        expect(
            resolveNativeProjectRegistryMode({
                [NATIVE_PROJECT_REGISTRY_ENABLED_ENV]: "1",
            }),
        ).toBe("shadow");
        expect(
            resolveNativeProjectRegistryMode({
                [NATIVE_PROJECT_REGISTRY_ENABLED_ENV]: "1",
                [NATIVE_PROJECT_REGISTRY_MODE_ENV]: "write",
            }),
        ).toBe("write");
    });
});

describe("NativeProjectRegistryGateway", () => {
    it("calls list and add commands", async () => {
        const requestMock = vi.fn(
            async (command: string, _args?: Record<string, unknown>) => {
            if (command === "project_add") {
                return {
                    projectIdsToOpen: ["project-1"],
                    projects: [nativeProject()],
                    state: nativeState(),
                    touchedRootPaths: ["/tmp/project"],
                };
            }
            return nativeState();
            },
        );
        const request: NativeBackendRequester["request"] = async (...args) =>
            (await requestMock(...args)) as never;
        const gateway = new NativeProjectRegistryGateway({ request });

        await expect(gateway.listProjects()).resolves.toMatchObject({
            projects: [{ id: "project-1" }],
        });
        await expect(
            gateway.addProjectPaths(["/tmp/project"]),
        ).resolves.toMatchObject({
            projectIdsToOpen: ["project-1"],
            touchedRootPaths: ["/tmp/project"],
        });
        expect(requestMock).toHaveBeenCalledWith("project_list");
        expect(requestMock).toHaveBeenCalledWith("project_add", {
            ownerWindowId: null,
            projectPaths: ["/tmp/project"],
        });
    });
});

describe("native project adapters and parity", () => {
    it("adapts native state to ProjectStore snapshots", () => {
        expect(nativeProjectStateToStoreSnapshot(nativeState())).toEqual({
            projects: [
                expect.objectContaining({
                    canonicalRootPath: "/tmp/project",
                    id: "project-1",
                }),
            ],
            worktrees: [
                expect.objectContaining({
                    headSha: null,
                    id: "project-1:primary",
                }),
            ],
        });
    });

    it("reports parity without logging raw paths", () => {
        const nativeSnapshot = nativeProjectStateToStoreSnapshot(nativeState());
        const legacySnapshot: ProjectStoreStateSnapshot = {
            projects: [
                {
                    ...nativeSnapshot.projects[0],
                    rootPath: "/private/tmp/project",
                },
            ],
            worktrees: nativeSnapshot.worktrees,
        };

        const report = compareProjectRegistryStates(
            nativeSnapshot,
            legacySnapshot,
        );

        expect(report.equal).toBe(false);
        expect(report.mismatchedProjectIds).toEqual(["project-1"]);
        expect(JSON.stringify(report)).not.toContain("/private/tmp");
    });
});

describe("createNativeProjectRegistryStore", () => {
    it("leaves the legacy store untouched when disabled", async () => {
        const legacy = createLegacyStore();

        await expect(
            createNativeProjectRegistryStore({
                env: {},
                legacyStore: legacy,
                nativeClient: null,
            }),
        ).resolves.toBe(legacy);
    });

    it("routes add/list through native in write mode", async () => {
        const legacy = createLegacyStore();
        const requestMock = vi.fn(
            async (command: string, _args?: Record<string, unknown>) => {
            if (command === "project_add") {
                return {
                    projectIdsToOpen: ["project-1"],
                    projects: [nativeProject()],
                    state: nativeState(),
                    touchedRootPaths: ["/tmp/project"],
                };
            }
            return nativeState();
            },
        );
        const request: NativeBackendRequester["request"] = async (...args) =>
            (await requestMock(...args)) as never;
        const store = await createNativeProjectRegistryStore({
            env: {
                [NATIVE_PROJECT_REGISTRY_ENABLED_ENV]: "1",
                [NATIVE_PROJECT_REGISTRY_MODE_ENV]: "write",
            },
            legacyStore: legacy,
            nativeClient: { request },
        });

        expect(store.listProjects()).toEqual([
            expect.objectContaining({ id: "project-1" }),
        ]);
        await expect(store.addProjectPaths(["/tmp/project"])).resolves.toEqual({
            projects: [expect.objectContaining({ id: "project-1" })],
            touchedProjectIds: ["project-1"],
            touchedRootPaths: ["/tmp/project"],
        });
        expect(legacy.addProjectPaths).not.toHaveBeenCalled();
    });
});

function nativeState() {
    return {
        projects: [nativeProject()],
        worktrees: [
            {
                branchName: null,
                headSha: null,
                id: "project-1:primary",
                isPrimary: true,
                projectId: "project-1",
                rootPath: "/tmp/project",
                updatedAt: "2026-06-20T00:00:00.000Z",
            },
        ],
    };
}

function nativeProject() {
    return {
        canonicalRootPath: "/tmp/project",
        createdAt: "2026-06-20T00:00:00.000Z",
        id: "project-1",
        lastOpenedAt: "2026-06-20T00:00:00.000Z",
        name: "Project",
        rootPath: "/tmp/project",
        updatedAt: "2026-06-20T00:00:00.000Z",
    };
}

function createLegacyStore(): ProjectStore & {
    readonly addProjectPaths: ReturnType<typeof vi.fn>;
} {
    const state = nativeProjectStateToStoreSnapshot(nativeState());
    return {
        addProjectPaths: vi.fn(
            async (): Promise<ProjectStoreAddPathsResult> => ({
                projects: state.projects,
                touchedProjectIds: ["legacy-project"],
                touchedRootPaths: ["/tmp/legacy"],
            }),
        ),
        clearProjectAppData: vi.fn(),
        getProject: (projectId: string): ProjectRecord | null =>
            state.projects.find((project) => project.id === projectId) ?? null,
        getProjectAppDataSummary: vi.fn(),
        getProjectWorktree: (
            worktreeId: string,
        ): ProjectStoreWorktreeRecord | null =>
            state.worktrees.find((worktree) => worktree.id === worktreeId) ??
            null,
        listProjectWorktrees: (projectId: string) =>
            state.worktrees.filter((worktree) => worktree.projectId === projectId),
        listProjects: () => state.projects,
        loadState: () => state,
        relocateProject: vi.fn(),
        removeProject: vi.fn(),
        syncProjectWorktrees: vi.fn(),
        touchProject: vi.fn(),
    };
}
