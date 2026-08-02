import { describe, expect, it, vi } from "vitest";

import {
    NativeProjectRegistryGateway,
    createNativeProjectRegistryStore,
    nativeProjectStateToStoreSnapshot,
} from "./projects";
import type { NativeBackendRequester } from "./persistence";

describe("NativeProjectRegistryGateway", () => {
    it("routes project registry commands through the native backend", async () => {
        const requestMock = vi.fn(
            (command: string, args?: Record<string, unknown>) => {
                if (command === "project_add") {
                    expect(args).toEqual({
                        ownerWindowId: null,
                        projectPaths: ["/tmp/project"],
                    });
                    return Promise.resolve(nativeAddResult());
                }

                if (command === "project_remove") {
                    expect(args).toEqual({ projectId: "project-1" });
                    return Promise.resolve({ state: emptyNativeState() });
                }

                if (command === "project_touch") {
                    expect(args).toEqual({ projectId: "project-1" });
                    return Promise.resolve({ state: nativeState() });
                }

                if (command === "project_relocate") {
                    expect(args).toEqual({
                        projectId: "project-1",
                        projectPath: "/tmp/renamed",
                    });
                    return Promise.resolve({
                        project: nativeProject({
                            name: "Renamed",
                            rootPath: "/tmp/renamed",
                        }),
                        state: nativeState({
                            name: "Renamed",
                            rootPath: "/tmp/renamed",
                        }),
                        touchedRootPaths: ["/tmp/renamed"],
                    });
                }

                if (command === "project_get_app_data_summary") {
                    expect(args).toEqual({ projectId: "project-1" });
                    return Promise.resolve(nativeAppDataSummary());
                }

                if (command === "project_clear_app_data") {
                    expect(args).toEqual({ projectId: "project-1" });
                    return Promise.resolve({
                        cleared: nativeAppDataSummary({ chatSessionCount: 2 }),
                        state: nativeState(),
                    });
                }

                return Promise.resolve(nativeState());
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
        await expect(gateway.removeProject("project-1")).resolves.toEqual({
            state: emptyNativeState(),
        });
        await expect(gateway.touchProject("project-1")).resolves.toMatchObject({
            state: { projects: [{ id: "project-1" }] },
        });
        await expect(
            gateway.relocateProject("project-1", "/tmp/renamed"),
        ).resolves.toMatchObject({
            project: { name: "Renamed", rootPath: "/tmp/renamed" },
            touchedRootPaths: ["/tmp/renamed"],
        });
        await expect(
            gateway.getProjectAppDataSummary("project-1"),
        ).resolves.toEqual(nativeAppDataSummary());
        await expect(
            gateway.clearProjectAppData("project-1"),
        ).resolves.toMatchObject({
            cleared: { chatSessionCount: 2 },
            state: { projects: [{ id: "project-1" }] },
        });

        expect(requestMock).toHaveBeenCalledWith("project_list");
    });
});

describe("native project adapters", () => {
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
});

describe("createNativeProjectRegistryStore", () => {
    it("hydrates from native state and mutates through native commands", async () => {
        const requestMock = vi.fn(
            (command: string, args?: Record<string, unknown>) => {
                if (command === "project_add") {
                    expect(args).toEqual({
                        ownerWindowId: null,
                        projectPaths: ["/tmp/project"],
                    });
                    return Promise.resolve(nativeAddResult());
                }

                if (command === "project_sync_worktrees") {
                    expect(args).toEqual({
                        projectId: "project-1",
                        worktrees: [
                            {
                                branchName: "feature",
                                headSha: "abc123",
                                rootPath: "/tmp/project-wt",
                            },
                        ],
                    });
                    return Promise.resolve([
                        nativeWorktree({
                            branchName: "feature",
                            headSha: "abc123",
                            id: "worktree-1",
                            isPrimary: false,
                            rootPath: "/tmp/project-wt",
                        }),
                    ]);
                }

                if (command === "project_remove") {
                    return Promise.resolve({ state: emptyNativeState() });
                }

                if (command === "project_relocate") {
                    return Promise.resolve({
                        project: nativeProject({
                            name: "Renamed",
                            rootPath: "/tmp/renamed",
                        }),
                        state: nativeState({
                            name: "Renamed",
                            rootPath: "/tmp/renamed",
                        }),
                        touchedRootPaths: ["/tmp/renamed"],
                    });
                }

                if (command === "project_get_app_data_summary") {
                    return Promise.resolve(nativeAppDataSummary());
                }

                if (command === "project_clear_app_data") {
                    return Promise.resolve({
                        cleared: nativeAppDataSummary({ workspaceTabCount: 4 }),
                        state: nativeState(),
                    });
                }

                return Promise.resolve(nativeState());
            },
        );
        const request: NativeBackendRequester["request"] = async (...args) =>
            (await requestMock(...args)) as never;
        const store = await createNativeProjectRegistryStore({
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
        await expect(
            store.syncProjectWorktrees("project-1", [
                {
                    branchName: "feature",
                    headSha: "abc123",
                    rootPath: "/tmp/project-wt",
                },
            ]),
        ).resolves.toEqual([
            expect.objectContaining({
                id: "worktree-1",
                rootPath: "/tmp/project-wt",
            }),
        ]);
        await expect(
            store.relocateProject("project-1", "/tmp/renamed"),
        ).resolves.toEqual(
            expect.objectContaining({ name: "Renamed", rootPath: "/tmp/renamed" }),
        );
        await expect(
            store.getProjectAppDataSummary("project-1"),
        ).resolves.toEqual({
            chatSessionCount: 1,
            durableWorkspaceCount: 1,
            projectSettingsCount: 1,
            recentProjectCount: 1,
            recoveryLayoutCount: 1,
            workspaceLayoutCount: 1,
            workspaceSessionCount: 1,
            workspaceTabCount: 1,
        });
        await expect(store.clearProjectAppData("project-1")).resolves.toEqual({
            chatSessionCount: 1,
            durableWorkspaceCount: 1,
            projectSettingsCount: 1,
            recentProjectCount: 1,
            recoveryLayoutCount: 1,
            workspaceLayoutCount: 1,
            workspaceSessionCount: 1,
            workspaceTabCount: 4,
        });
        await expect(store.removeProject("project-1")).resolves.toBeUndefined();
        expect(store.listProjects()).toEqual([]);
    });

    it("uses native worktree sync results as the final project worktree source", async () => {
        const syncedWorktrees = [
            nativeWorktree({
                id: "project-1:primary",
                isPrimary: true,
                rootPath: "/tmp/project",
            }),
            nativeWorktree({
                branchName: "feature/final",
                headSha: "def456",
                id: "worktree-final",
                isPrimary: false,
                rootPath: "/tmp/project-feature",
            }),
        ];
        const requestMock = vi.fn(
            (command: string, args?: Record<string, unknown>) => {
                if (command === "project_sync_worktrees") {
                    expect(args).toEqual({
                        projectId: "project-1",
                        worktrees: [
                            {
                                branchName: null,
                                headSha: "abc123",
                                rootPath: "/tmp/project",
                            },
                            {
                                branchName: "feature/final",
                                headSha: "def456",
                                rootPath: "/tmp/project-feature",
                            },
                        ],
                    });
                    return Promise.resolve(syncedWorktrees);
                }

                return Promise.resolve(nativeState());
            },
        );
        const request: NativeBackendRequester["request"] = async (...args) =>
            (await Promise.resolve(requestMock(...args))) as never;
        const store = await createNativeProjectRegistryStore({
            nativeClient: { request },
        });

        await expect(
            store.syncProjectWorktrees("project-1", [
                {
                    branchName: null,
                    headSha: "abc123",
                    rootPath: "/tmp/project",
                },
                {
                    branchName: "feature/final",
                    headSha: "def456",
                    rootPath: "/tmp/project-feature",
                },
            ]),
        ).resolves.toEqual([
            expect.objectContaining({
                id: "project-1:primary",
                isPrimary: true,
                rootPath: "/tmp/project",
            }),
            expect.objectContaining({
                branchName: "feature/final",
                id: "worktree-final",
                isPrimary: false,
                rootPath: "/tmp/project-feature",
            }),
        ]);
        expect(store.listProjectWorktrees("project-1")).toEqual([
            expect.objectContaining({ id: "project-1:primary" }),
            expect.objectContaining({ id: "worktree-final" }),
        ]);
    });
});

function nativeAddResult() {
    return {
        projectIdsToOpen: ["project-1"],
        projects: [nativeProject()],
        state: nativeState(),
        touchedRootPaths: ["/tmp/project"],
    };
}

function nativeState(projectOverrides: Partial<ReturnType<typeof nativeProject>> = {}) {
    return {
        projects: [nativeProject(projectOverrides)],
        worktrees: [nativeWorktree({ rootPath: projectOverrides.rootPath })],
    };
}

function emptyNativeState() {
    return {
        projects: [],
        worktrees: [],
    };
}

type NativeProjectFixture = {
    readonly canonicalRootPath: string | null;
    readonly createdAt: string;
    readonly id: string;
    readonly lastOpenedAt: string | null;
    readonly name: string;
    readonly rootPath: string;
    readonly updatedAt: string;
};

type NativeWorktreeFixture = {
    readonly branchName: string | null;
    readonly headSha: string | null;
    readonly id: string;
    readonly isPrimary: boolean;
    readonly projectId: string;
    readonly rootPath: string;
    readonly updatedAt: string;
};

type NativeAppDataSummaryFixture = {
    readonly chatSessionCount: number;
    readonly durableWorkspaceCount: number;
    readonly projectSettingsCount: number;
    readonly recentProjectCount: number;
    readonly recoveryLayoutCount: number;
    readonly workspaceLayoutCount: number;
    readonly workspaceSessionCount: number;
    readonly workspaceTabCount: number;
};

function nativeProject(
    overrides: Partial<NativeProjectFixture> = {},
): NativeProjectFixture {
    const rootPath = overrides.rootPath ?? "/tmp/project";
    return {
        canonicalRootPath: overrides.canonicalRootPath ?? rootPath,
        createdAt: overrides.createdAt ?? "2026-06-20T00:00:00.000Z",
        id: overrides.id ?? "project-1",
        lastOpenedAt: overrides.lastOpenedAt ?? "2026-06-20T00:00:00.000Z",
        name: overrides.name ?? "Project",
        rootPath,
        updatedAt: overrides.updatedAt ?? "2026-06-20T00:00:00.000Z",
    };
}

function nativeWorktree(
    overrides: Partial<NativeWorktreeFixture> = {},
): NativeWorktreeFixture {
    const rootPath = overrides.rootPath ?? "/tmp/project";
    return {
        branchName: overrides.branchName ?? null,
        headSha: overrides.headSha ?? null,
        id: overrides.id ?? "project-1:primary",
        isPrimary: overrides.isPrimary ?? true,
        projectId: overrides.projectId ?? "project-1",
        rootPath,
        updatedAt: overrides.updatedAt ?? "2026-06-20T00:00:00.000Z",
    };
}

function nativeAppDataSummary(
    overrides: Partial<NativeAppDataSummaryFixture> = {},
): NativeAppDataSummaryFixture {
    return {
        chatSessionCount: overrides.chatSessionCount ?? 1,
        durableWorkspaceCount: overrides.durableWorkspaceCount ?? 1,
        projectSettingsCount: overrides.projectSettingsCount ?? 1,
        recentProjectCount: overrides.recentProjectCount ?? 1,
        recoveryLayoutCount: overrides.recoveryLayoutCount ?? 1,
        workspaceLayoutCount: overrides.workspaceLayoutCount ?? 1,
        workspaceSessionCount: overrides.workspaceSessionCount ?? 1,
        workspaceTabCount: overrides.workspaceTabCount ?? 1,
    };
}
