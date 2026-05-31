import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalSession } from "@shared/ipc";
import type { RuntimeWorkspaceTerminalTab } from "@renderer/app/workspace/tree";

import {
    createTerminalSessionView,
    resetTerminalRuntimeStoreForTests,
    useTerminalRuntimeStore,
} from "./terminalRuntimeStore";
import type { TerminalOutputCommand } from "./terminalTypes";

const createTerminalSessionMock = vi.fn<
    (input: Record<string, unknown>) => Promise<TerminalSession>
>();
const writeTerminalInputMock = vi.fn(async () => {});
const resizeTerminalSessionMock = vi.fn(async () => {});
const closeTerminalSessionMock = vi.fn(async () => {});

function createTerminalTab(
    overrides: Partial<RuntimeWorkspaceTerminalTab> = {},
): RuntimeWorkspaceTerminalTab {
    return {
        createdAt: "2026-05-31T00:00:00.000Z",
        exitCode: null,
        id: "tab-1",
        isReady: false,
        kind: "terminal",
        launchError: null,
        output: "",
        projectId: "project-1",
        session: null,
        sessionId: "terminal-1",
        signalCode: null,
        terminalId: "terminal-1",
        title: "Terminal 1",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

function createSession(
    sessionId: string,
    overrides: Partial<TerminalSession> = {},
): TerminalSession {
    return {
        cols: 120,
        cwd: "/workspace",
        projectId: "project-1",
        rows: 24,
        sessionId,
        status: "running",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe("terminalRuntimeStore", () => {
    beforeEach(() => {
        resetTerminalRuntimeStoreForTests();
        createTerminalSessionMock.mockReset();
        writeTerminalInputMock.mockClear();
        resizeTerminalSessionMock.mockClear();
        closeTerminalSessionMock.mockClear();

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    closeTerminalSession: closeTerminalSessionMock,
                    createTerminalSession: createTerminalSessionMock,
                    resizeTerminalSession: resizeTerminalSessionMock,
                    writeTerminalInput: writeTerminalInputMock,
                },
            },
            writable: true,
        });
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: {
                getItem: vi.fn(() => null),
                removeItem: vi.fn(),
                setItem: vi.fn(),
            },
            writable: true,
        });
    });

    it("creates a session with project context and pipes input through the live session id", async () => {
        createTerminalSessionMock.mockResolvedValueOnce(
            createSession("live-session-1"),
        );

        useTerminalRuntimeStore.getState().ensureTerminal(createTerminalTab());
        await flushPromises();

        expect(createTerminalSessionMock).toHaveBeenCalledWith({
            cols: 120,
            extraEnv: undefined,
            projectId: "project-1",
            rows: 24,
            terminalId: "terminal-1",
            worktreeId: "worktree-1",
        });

        await useTerminalRuntimeStore
            .getState()
            .writeInput("terminal-1", "pwd\r");

        expect(writeTerminalInputMock).toHaveBeenCalledWith({
            data: "pwd\r",
            sessionId: "live-session-1",
        });
    });

    it("buffers output that arrives before the runtime attaches the session id", async () => {
        let resolveCreate: (session: TerminalSession) => void = () => undefined;
        createTerminalSessionMock.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveCreate = resolve;
            }),
        );

        useTerminalRuntimeStore.getState().ensureTerminal(createTerminalTab());
        useTerminalRuntimeStore.getState().handleTerminalOutput({
            chunk: "early output\n",
            sessionId: "live-session-1",
        });
        resolveCreate(createSession("live-session-1"));
        await flushPromises();

        const runtime =
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"];
        const commands: TerminalOutputCommand[] = [];
        createTerminalSessionView(runtime).subscribeOutput((command) => {
            commands.push(command);
        });

        expect(commands).toEqual([
            { data: "early output\n", type: "write" },
        ]);
        expect(runtime.hasOutput).toBe(true);
    });

    it("applies an exit that arrives before the runtime attaches the session id", async () => {
        let resolveCreate: (session: TerminalSession) => void = () => undefined;
        createTerminalSessionMock.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveCreate = resolve;
            }),
        );

        useTerminalRuntimeStore.getState().ensureTerminal(createTerminalTab());
        useTerminalRuntimeStore.getState().handleTerminalExited({
            exitCode: 127,
            sessionId: "live-session-1",
        });
        resolveCreate(createSession("live-session-1"));
        await flushPromises();

        expect(
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"]
                .snapshot,
        ).toMatchObject({
            exitCode: 127,
            sessionId: "live-session-1",
            status: "exited",
        });
    });

    it("deduplicates identical resize requests while one is pending", async () => {
        createTerminalSessionMock.mockResolvedValueOnce(
            createSession("live-session-1"),
        );

        useTerminalRuntimeStore.getState().ensureTerminal(createTerminalTab());
        await flushPromises();

        let resolveResize: () => void = () => undefined;
        resizeTerminalSessionMock.mockReturnValueOnce(
            new Promise<void>((resolve) => {
                resolveResize = resolve;
            }),
        );

        const firstResize = useTerminalRuntimeStore
            .getState()
            .resize("terminal-1", 140, 40);
        const duplicateResize = useTerminalRuntimeStore
            .getState()
            .resize("terminal-1", 140, 40);

        expect(resizeTerminalSessionMock).toHaveBeenCalledTimes(1);
        resolveResize();
        await Promise.all([firstResize, duplicateResize]);

        expect(
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"]
                .snapshot,
        ).toMatchObject({ cols: 140, rows: 40 });
    });

    it("ignores a stale create-session failure after a newer session starts", async () => {
        let rejectFirstCreate: (error: Error) => void = () => undefined;
        createTerminalSessionMock
            .mockReturnValueOnce(
                new Promise((_resolve, reject) => {
                    rejectFirstCreate = reject;
                }),
            )
            .mockResolvedValueOnce(createSession("live-session-2"));

        useTerminalRuntimeStore.getState().ensureTerminal(createTerminalTab());
        await useTerminalRuntimeStore.getState().restart("terminal-1");
        rejectFirstCreate(new Error("late failure"));
        await flushPromises();

        expect(
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"]
                .snapshot,
        ).toMatchObject({
            sessionId: "live-session-2",
            status: "running",
        });
    });

    it("keeps the latest resize when resize responses resolve out of order", async () => {
        createTerminalSessionMock.mockResolvedValueOnce(
            createSession("live-session-1"),
        );

        useTerminalRuntimeStore.getState().ensureTerminal(createTerminalTab());
        await flushPromises();

        let resolveFirstResize: () => void = () => undefined;
        let resolveSecondResize: () => void = () => undefined;
        resizeTerminalSessionMock
            .mockReturnValueOnce(
                new Promise<void>((resolve) => {
                    resolveFirstResize = resolve;
                }),
            )
            .mockReturnValueOnce(
                new Promise<void>((resolve) => {
                    resolveSecondResize = resolve;
                }),
            );

        const firstResize = useTerminalRuntimeStore
            .getState()
            .resize("terminal-1", 130, 35);
        const secondResize = useTerminalRuntimeStore
            .getState()
            .resize("terminal-1", 150, 45);

        resolveSecondResize();
        await secondResize;
        resolveFirstResize();
        await firstResize;

        expect(
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"]
                .snapshot,
        ).toMatchObject({ cols: 150, rows: 45 });
    });

    it("bounds pre-attach output by keeping the newest pending bytes", async () => {
        let resolveCreate: (session: TerminalSession) => void = () => undefined;
        createTerminalSessionMock.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveCreate = resolve;
            }),
        );

        useTerminalRuntimeStore.getState().ensureTerminal(createTerminalTab());
        useTerminalRuntimeStore.getState().handleTerminalOutput({
            chunk: "a".repeat(260_000),
            sessionId: "live-session-1",
        });
        useTerminalRuntimeStore.getState().handleTerminalOutput({
            chunk: "tail",
            sessionId: "live-session-1",
        });
        resolveCreate(createSession("live-session-1"));
        await flushPromises();

        const runtime =
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"];
        const commands: TerminalOutputCommand[] = [];
        createTerminalSessionView(runtime).subscribeOutput((command) => {
            commands.push(command);
        });

        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({ type: "write" });
        if (commands[0]?.type !== "write") {
            throw new Error("Expected write command");
        }
        expect(commands[0].data).toHaveLength(256_000);
        expect(commands[0].data.endsWith("tail")).toBe(true);
    });

    it("restarts without mixing old output into the new viewport", async () => {
        createTerminalSessionMock
            .mockResolvedValueOnce(createSession("live-session-1"))
            .mockResolvedValueOnce(createSession("live-session-2"));

        useTerminalRuntimeStore.getState().ensureTerminal(createTerminalTab());
        await flushPromises();

        const runtime =
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"];
        const commands: TerminalOutputCommand[] = [];
        createTerminalSessionView(runtime).subscribeOutput((command) => {
            commands.push(command);
        });

        await useTerminalRuntimeStore.getState().restart("terminal-1");
        useTerminalRuntimeStore.getState().handleTerminalOutput({
            chunk: "late old output",
            sessionId: "live-session-1",
        });
        useTerminalRuntimeStore.getState().handleTerminalOutput({
            chunk: "fresh output",
            sessionId: "live-session-2",
        });

        expect(closeTerminalSessionMock).toHaveBeenCalledWith(
            "live-session-1",
        );
        expect(commands).toEqual([
            { type: "clear" },
            { data: "fresh output", type: "write" },
        ]);
    });

    it("does not replay a snapshot after a new session generation starts", async () => {
        createTerminalSessionMock
            .mockResolvedValueOnce(createSession("live-session-1"))
            .mockResolvedValueOnce(createSession("live-session-2"));

        useTerminalRuntimeStore.getState().ensureTerminal(createTerminalTab());
        await flushPromises();

        let runtime =
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"];
        createTerminalSessionView(runtime).saveReplaySnapshot("old screen");
        expect(createTerminalSessionView(runtime).getReplaySnapshot()).toEqual({
            serialized: "old screen",
            sessionId: "live-session-1",
        });

        await useTerminalRuntimeStore.getState().restart("terminal-1");
        runtime =
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"];

        expect(createTerminalSessionView(runtime).getReplaySnapshot()).toBeNull();
    });
});
