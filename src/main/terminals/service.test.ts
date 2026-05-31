import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectService } from "@main/projects/service";

import { TerminalService } from "./service";

const ptyMocks = vi.hoisted(() => ({
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    resize: vi.fn(),
    spawn: vi.fn(),
    write: vi.fn(),
}));

vi.mock("node-pty", () => ({
    default: {
        spawn: ptyMocks.spawn,
    },
}));

function createProjectService() {
    return {
        getProjectRootPath: vi.fn(() => "/workspace"),
    } as unknown as ProjectService;
}

describe("TerminalService", () => {
    beforeEach(() => {
        ptyMocks.kill.mockClear();
        ptyMocks.onData.mockClear();
        ptyMocks.onExit.mockClear();
        ptyMocks.resize.mockClear();
        ptyMocks.spawn.mockReset();
        ptyMocks.write.mockClear();
        ptyMocks.spawn.mockReturnValue({
            kill: ptyMocks.kill,
            onData: ptyMocks.onData,
            onExit: ptyMocks.onExit,
            resize: ptyMocks.resize,
            write: ptyMocks.write,
        });
    });

    it("keeps the stored terminal dimensions in sync after resize", () => {
        const service = new TerminalService({
            onData: vi.fn(),
            onExit: vi.fn(),
            projectService: createProjectService(),
        });

        const session = service.createSession(
            {
                cols: 120,
                projectId: "project-1",
                rows: 24,
                terminalId: "terminal-1",
                worktreeId: null,
            },
            "window-1",
        );

        service.resizeSession(session.sessionId, 82, 18);
        const reusedSession = service.createSession(
            {
                cols: 120,
                projectId: "project-1",
                rows: 24,
                terminalId: "terminal-1",
                worktreeId: null,
            },
            "window-1",
        );

        expect(ptyMocks.spawn).toHaveBeenCalledTimes(1);
        expect(ptyMocks.resize).toHaveBeenCalledWith(82, 18);
        expect(reusedSession).toMatchObject({
            cols: 82,
            rows: 18,
            sessionId: session.sessionId,
        });

        service.resizeSession(session.sessionId, 82, 18);
        expect(ptyMocks.resize).toHaveBeenCalledTimes(1);
    });
});
