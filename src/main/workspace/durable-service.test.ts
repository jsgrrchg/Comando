import { describe, expect, it, vi } from "vitest";

import {
    DurableWorkspaceService,
    type DurableWorkspaceRepositoryGateway,
} from "./service";

describe("DurableWorkspaceService", () => {
    it("normalizes primary worktree identity before creating a workspace", async () => {
        const { mocks, repository } = repositoryFixture();
        const service = new DurableWorkspaceService(repository);

        await service.create(
            {
                projectId: "project-a",
                worktreeId: "project-a:primary",
            },
            { tabs: [] },
        );

        expect(mocks.createDurableWorkspace).toHaveBeenCalledWith({
            layoutSnapshot: { tabs: [] },
            lifecycle: "active",
            projectId: "project-a",
            scopeKey: "project-a::__primary__",
            worktreeId: null,
        });
    });

    it("passes the loaded revision to every CAS mutation", async () => {
        const { mocks, repository } = repositoryFixture();
        const service = new DurableWorkspaceService(repository);
        const workspace = {
            revision: 7,
            scopeKey: "project-a::worktree-a",
        };

        await service.save(workspace, { tabs: ["chat-a"] });
        await service.archive(workspace);
        await service.reset(workspace, { tabs: [] });
        await service.purge(workspace);
        await service.activate(
            { revision: 9 },
            {
                projectId: "project-a",
                worktreeId: "worktree-a",
            },
        );
        await service.saveShell({ revision: 10 }, { leftCollapsed: true });

        expect(mocks.saveDurableWorkspace).toHaveBeenCalledWith({
            expectedRevision: 7,
            layoutSnapshot: { tabs: ["chat-a"] },
            scopeKey: "project-a::worktree-a",
        });
        expect(mocks.archiveDurableWorkspace).toHaveBeenCalledWith({
            expectedRevision: 7,
            scopeKey: "project-a::worktree-a",
        });
        expect(mocks.resetDurableWorkspace).toHaveBeenCalledWith({
            expectedRevision: 7,
            layoutSnapshot: { tabs: [] },
            scopeKey: "project-a::worktree-a",
        });
        expect(mocks.purgeDurableWorkspace).toHaveBeenCalledWith({
            expectedRevision: 7,
            scopeKey: "project-a::worktree-a",
        });
        expect(mocks.setActiveWorkspace).toHaveBeenCalledWith({
            activeScopeKey: "project-a::worktree-a",
            expectedRevision: 9,
        });
        expect(mocks.saveWorkspaceShell).toHaveBeenCalledWith({
            expectedRevision: 10,
            shellSnapshot: { leftCollapsed: true },
        });
    });
});

function repositoryFixture(): {
    readonly mocks: Record<
        keyof DurableWorkspaceRepositoryGateway,
        ReturnType<typeof vi.fn>
    >;
    readonly repository: DurableWorkspaceRepositoryGateway;
} {
    const workspace = {
        createdAt: "now",
        lastActivatedAt: null,
        layoutSnapshot: {},
        lifecycle: "active" as const,
        projectId: "project-a",
        revision: 0,
        runtimeOwnerId: "runtime-a",
        scopeKey: "project-a::__primary__",
        updatedAt: "now",
        worktreeId: null,
    };
    const navigation = {
        activeScopeKey: null,
        recentScopeKeys: [],
        revision: 0,
        shellSnapshot: {},
        updatedAt: "now",
    };
    const mocks = {
        archiveDurableWorkspace: vi.fn(() => Promise.resolve(workspace)),
        createDurableWorkspace: vi.fn(() => Promise.resolve(workspace)),
        getWorkspaceNavigation: vi.fn(() => Promise.resolve(navigation)),
        listDurableWorkspaces: vi.fn(() => Promise.resolve([])),
        loadDurableWorkspace: vi.fn(() => Promise.resolve(workspace)),
        purgeDurableWorkspace: vi.fn(() =>
            Promise.resolve({
                navigation,
                purgedScopeKey: workspace.scopeKey,
            }),
        ),
        resetDurableWorkspace: vi.fn(() => Promise.resolve(workspace)),
        saveDurableWorkspace: vi.fn(() => Promise.resolve(workspace)),
        saveWorkspaceShell: vi.fn(() => Promise.resolve(navigation)),
        setActiveWorkspace: vi.fn(() => Promise.resolve(navigation)),
    };
    return {
        mocks,
        repository: mocks,
    };
}
