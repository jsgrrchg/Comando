import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
    execFile: execFileMock,
}));

import { getGitFileDiff, getGitFileText } from "./diff";

beforeEach(() => {
    execFileMock.mockReset();
});

describe("getGitFileDiff", () => {
    it("times out and reports a clear error for hung untracked no-index diffs", async () => {
        vi.useFakeTimers();
        const rootPath = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-git-diff-test-"),
        );

        try {
            execFileMock.mockImplementation(
                (
                    _command: string,
                    _args: readonly string[],
                    options: { readonly timeout?: number },
                    callback: (
                        error: Error & {
                            code?: number | string | null;
                            killed?: boolean;
                            signal?: NodeJS.Signals | null;
                        },
                        stdout: string,
                        stderr: string,
                    ) => void,
                ) => {
                    setTimeout(() => {
                        const error = new Error(
                            "Command failed: git diff --no-index",
                        ) as Error & {
                            code: string | null;
                            killed: boolean;
                            signal: NodeJS.Signals;
                        };
                        error.code = null;
                        error.killed = true;
                        error.signal = "SIGTERM";
                        callback(error, "", "");
                    }, options.timeout);
                },
            );

            const diffPromise = getGitFileDiff(rootPath, "new-file.txt", {
                kind: "untracked",
                scope: "untracked",
            });
            const assertion = expect(diffPromise).rejects.toThrow(
                "Git diff timed out while reading the untracked file.",
            );

            await vi.advanceTimersByTimeAsync(30_000);

            await assertion;
            expect(execFileMock).toHaveBeenCalledWith(
                "git",
                expect.arrayContaining(["diff", "--no-index"]),
                expect.objectContaining({
                    killSignal: "SIGTERM",
                    timeout: 30_000,
                }),
                expect.any(Function),
            );
        } finally {
            vi.useRealTimers();
            fs.rmSync(rootPath, { force: true, recursive: true });
        }
    });
});

describe("getGitFileText", () => {
    it("reads a text-converted blob with a bounded git show call", async () => {
        execFileMock.mockImplementation(
            (
                _command: string,
                _args: readonly string[],
                _options: unknown,
                callback: (
                    error: Error | null,
                    stdout: string,
                    stderr: string,
                ) => void,
            ) => {
                callback(null, "const value = 1;\n", "");
            },
        );

        await expect(
            getGitFileText("/workspace/repo", "src/app.ts", "index"),
        ).resolves.toBe("const value = 1;\n");

        expect(execFileMock).toHaveBeenCalledWith(
            "git",
            ["show", "--textconv", ":src/app.ts"],
            expect.objectContaining({
                cwd: "/workspace/repo",
                encoding: "utf8",
                killSignal: "SIGTERM",
                maxBuffer: 5 * 1024 * 1024,
                timeout: 10_000,
            }),
            expect.any(Function),
        );
    });

    it("returns null when the requested blob cannot be read", async () => {
        execFileMock.mockImplementation(
            (
                _command: string,
                _args: readonly string[],
                _options: unknown,
                callback: (
                    error: Error | null,
                    stdout: string,
                    stderr: string,
                ) => void,
            ) => {
                callback(new Error("not found"), "", "");
            },
        );

        await expect(
            getGitFileText("/workspace/repo", "src/missing.ts", "head"),
        ).resolves.toBeNull();
    });
});
