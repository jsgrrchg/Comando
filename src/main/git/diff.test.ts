import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
    execFile: execFileMock,
}));

import { getGitFileDiff } from "./diff";

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
