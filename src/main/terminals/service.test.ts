import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectService } from "@main/projects/service";
import { DEFAULT_APP_TERMINAL_SETTINGS } from "@shared/terminal-settings";
import type { SettingsGateway } from "@main/settings/service";

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

function createSettingsService(
    overrides: Partial<typeof DEFAULT_APP_TERMINAL_SETTINGS> = {},
) {
    return {
        loadAppTerminalSettings: vi.fn(() => ({
            ...DEFAULT_APP_TERMINAL_SETTINGS,
            ...overrides,
        })),
    } as unknown as SettingsGateway;
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
            settingsService: createSettingsService(),
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

        service.resizeSession("window-1", session.sessionId, 82, 18);
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

        service.resizeSession("window-1", session.sessionId, 82, 18);
        expect(ptyMocks.resize).toHaveBeenCalledTimes(1);
    });

    it("ignores terminal mutations from a different owner window", () => {
        const service = new TerminalService({
            onData: vi.fn(),
            onExit: vi.fn(),
            projectService: createProjectService(),
            settingsService: createSettingsService(),
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

        service.writeInput("window-2", session.sessionId, "pwd\r");
        service.resizeSession("window-2", session.sessionId, 82, 18);
        service.closeSessionOrOwnedTerminal("window-2", session.sessionId);

        expect(ptyMocks.write).not.toHaveBeenCalled();
        expect(ptyMocks.resize).not.toHaveBeenCalled();
        expect(ptyMocks.kill).not.toHaveBeenCalled();

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

        expect(reusedSession).toMatchObject({
            cols: 120,
            rows: 24,
            sessionId: session.sessionId,
        });
    });

    it("closes a terminal session id only from its owner window", () => {
        const service = new TerminalService({
            onData: vi.fn(),
            onExit: vi.fn(),
            projectService: createProjectService(),
            settingsService: createSettingsService(),
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

        service.closeSessionOrOwnedTerminal("window-2", session.sessionId);
        expect(ptyMocks.kill).not.toHaveBeenCalled();

        service.closeSessionOrOwnedTerminal("window-1", session.sessionId);
        expect(ptyMocks.kill).toHaveBeenCalledTimes(1);
    });

    it("does not reinterpret a foreign session id as an owned terminal id", () => {
        const service = new TerminalService({
            onData: vi.fn(),
            onExit: vi.fn(),
            projectService: createProjectService(),
            settingsService: createSettingsService(),
        });

        service.createSession(
            {
                cols: 120,
                preferredSessionId: "shared-id",
                projectId: "project-1",
                rows: 24,
                terminalId: "terminal-1",
                worktreeId: null,
            },
            "window-1",
        );
        const ownedSession = service.createSession(
            {
                cols: 120,
                projectId: "project-1",
                rows: 24,
                terminalId: "shared-id",
                worktreeId: null,
            },
            "window-2",
        );

        service.closeSessionOrOwnedTerminal("window-2", "shared-id");
        expect(ptyMocks.kill).not.toHaveBeenCalled();

        const reusedSession = service.createSession(
            {
                cols: 120,
                projectId: "project-1",
                rows: 24,
                terminalId: "shared-id",
                worktreeId: null,
            },
            "window-2",
        );

        expect(reusedSession.sessionId).toBe(ownedSession.sessionId);
    });

});
