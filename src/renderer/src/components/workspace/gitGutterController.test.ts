import { describe, expect, it, vi } from "vitest";

import {
    GitGutterController,
    type GitGutterDiffSource,
} from "./gitGutterController";

describe("GitGutterController", () => {
    it("keeps the previous source while the current Git revision reloads", async () => {
        const onSourceChange = vi.fn();
        const controller = new GitGutterController({ onSourceChange });
        const first = deferredSource();
        const second = deferredSource();

        controller.update({
            key: "project\u0000primary\u0000src/app.ts",
            load: () => first.promise,
            revision: "git-1",
            shouldLoad: true,
        });
        first.resolve(source("first"));
        await settle();

        controller.update({
            key: "project\u0000primary\u0000src/app.ts",
            load: () => second.promise,
            revision: "git-2",
            shouldLoad: true,
        });

        expect(onSourceChange).toHaveBeenCalledTimes(1);
        second.resolve(source("second"));
        await settle();

        expect(onSourceChange).toHaveBeenLastCalledWith({
            ...source("second"),
            key: "project\u0000primary\u0000src/app.ts",
        });
    });

    it("discards a response from an older Git revision", async () => {
        const onSourceChange = vi.fn();
        const controller = new GitGutterController({ onSourceChange });
        const stale = deferredSource();
        const current = deferredSource();

        controller.update({
            key: "project\u0000primary\u0000src/app.ts",
            load: () => stale.promise,
            revision: "git-1",
            shouldLoad: true,
        });
        controller.update({
            key: "project\u0000primary\u0000src/app.ts",
            load: () => current.promise,
            revision: "git-2",
            shouldLoad: true,
        });

        stale.resolve(source("stale"));
        current.resolve(source("current"));
        await settle();

        expect(onSourceChange).toHaveBeenCalledTimes(1);
        expect(onSourceChange).toHaveBeenLastCalledWith({
            ...source("current"),
            key: "project\u0000primary\u0000src/app.ts",
        });
    });

    it("clears only when the file becomes clean or the context changes", async () => {
        const onSourceChange = vi.fn();
        const controller = new GitGutterController({ onSourceChange });
        const pending = deferredSource();

        controller.update({
            key: "project\u0000primary\u0000src/app.ts",
            load: () => pending.promise,
            revision: "git-1",
            shouldLoad: true,
        });
        pending.resolve(source("ready"));
        await settle();
        onSourceChange.mockClear();

        controller.update({
            key: "project\u0000primary\u0000src/app.ts",
            load: () => Promise.resolve(source("unused")),
            revision: null,
            shouldLoad: false,
        });

        expect(onSourceChange).toHaveBeenCalledWith(null);
    });

    it("clears before loading a different file context", async () => {
        const onSourceChange = vi.fn();
        const controller = new GitGutterController({ onSourceChange });

        controller.update({
            key: "project\u0000primary\u0000src/app.ts",
            load: () => Promise.resolve(source("ready")),
            revision: "git-1",
            shouldLoad: true,
        });
        await settle();
        onSourceChange.mockClear();

        controller.update({
            key: "project\u0000worktree-a\u0000src/app.ts",
            load: () => Promise.resolve(source("other-worktree")),
            revision: "git-1",
            shouldLoad: true,
        });

        expect(onSourceChange.mock.calls[0]).toEqual([null]);
        await settle();
        expect(onSourceChange).toHaveBeenLastCalledWith({
            ...source("other-worktree"),
            key: "project\u0000worktree-a\u0000src/app.ts",
        });
    });

    it("keeps a valid source when a transient Git read returns no diff", async () => {
        const onSourceChange = vi.fn();
        const controller = new GitGutterController({ onSourceChange });

        controller.update({
            key: "project\u0000primary\u0000src/app.ts",
            load: () => Promise.resolve(source("ready")),
            revision: "git-1",
            shouldLoad: true,
        });
        await settle();
        onSourceChange.mockClear();

        controller.update({
            key: "project\u0000primary\u0000src/app.ts",
            load: () => Promise.resolve({ base: null, diff: null }),
            revision: "git-2",
            shouldLoad: true,
        });
        await settle();

        expect(onSourceChange).not.toHaveBeenCalled();
    });
});

function source(label: string): Omit<GitGutterDiffSource, "key"> {
    return {
        base: {
            baseText: label,
            isText: true,
            kind: "modified",
            path: "src/app.ts",
            previousPath: null,
            scope: "unstaged",
        },
        diff: null,
    };
}

function deferredSource(): {
    readonly promise: Promise<Omit<GitGutterDiffSource, "key">>;
    readonly resolve: (source: Omit<GitGutterDiffSource, "key">) => void;
} {
    let resolve: (source: Omit<GitGutterDiffSource, "key">) => void = () => {};
    const promise = new Promise<Omit<GitGutterDiffSource, "key">>((done) => {
        resolve = done;
    });

    return { promise, resolve };
}

async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}
