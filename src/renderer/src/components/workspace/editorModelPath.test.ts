import { describe, expect, it, vi } from "vitest";

import {
    acquireWorkspaceFileModel,
    buildWorkspaceEditorModelPath,
    buildWorkspaceFileEditorModelPath,
    getOrCreateWorkspaceFileModel,
    syncWorkspaceFileModel,
} from "./editorModelPath";

describe("buildWorkspaceEditorModelPath", () => {
    it("creates review model paths for a specific tab and variant", () => {
        expect(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/app.ts",
                "tab-1",
                "review-modified",
            ),
        ).toBe(
            "/workspace/comando/src/app__workspace-tab__tab-1__review-modified.ts",
        );
    });

    it("preserves the real extension for TSX files", () => {
        expect(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/App.tsx",
                "tab-1",
                "review-modified",
            ),
        ).toBe(
            "/workspace/comando/src/App__workspace-tab__tab-1__review-modified.tsx",
        );
    });

    it("preserves compound declaration extensions", () => {
        expect(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/types.d.ts",
                "tab-1",
                "review-modified",
            ),
        ).toBe(
            "/workspace/comando/src/types__workspace-tab__tab-1__review-modified.d.ts",
        );
    });

    it("keeps extensionless paths stable", () => {
        expect(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/Makefile",
                "tab-1",
                "review-modified",
            ),
        ).toBe(
            "/workspace/comando/Makefile__workspace-tab__tab-1__review-modified",
        );
    });

    it("keeps review model paths isolated per duplicate tab", () => {
        expect(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/app.ts",
                "tab-1",
                "review-modified",
            ),
        ).not.toBe(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/app.ts",
                "tab-2",
                "review-modified",
            ),
        );
    });

    it("creates different model paths for review variants", () => {
        expect(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/app.ts",
                "tab-1",
                "review-modified",
            ),
        ).not.toBe(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/app.ts",
                "tab-1",
                "review-original",
            ),
        );
    });
});

describe("buildWorkspaceFileEditorModelPath", () => {
    it("uses the real absolute path as the normal editor model identity", () => {
        expect(
            buildWorkspaceFileEditorModelPath(
                "/workspace/comando/src/app.ts",
            ),
        ).toBe("/workspace/comando/src/app.ts");
    });

    it("shares the normal editor model path across duplicate tabs", () => {
        expect(
            buildWorkspaceFileEditorModelPath(
                "/workspace/comando/src/app.ts",
            ),
        ).toBe(
            buildWorkspaceFileEditorModelPath(
                "/workspace/comando/src/app.ts",
            ),
        );
    });

    it("keeps normal editor models separate from review models", () => {
        expect(
            buildWorkspaceFileEditorModelPath(
                "/workspace/comando/src/app.ts",
            ),
        ).not.toBe(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/app.ts",
                "tab-1",
                "review-modified",
            ),
        );
    });
});

describe("getOrCreateWorkspaceFileModel", () => {
    it("reuses an existing model without resetting matching content", () => {
        const { createdModels, monaco } = createFakeMonaco();
        const firstModel = getOrCreateWorkspaceFileModel({
            absolutePath: "/workspace/comando/src/app.ts",
            language: "typescript",
            monaco,
            value: "const a = 1;",
        });
        const secondModel = getOrCreateWorkspaceFileModel({
            absolutePath: "/workspace/comando/src/app.ts",
            language: "typescript",
            monaco,
            value: "const a = 1;",
        });

        expect(firstModel).toBe(secondModel);
        expect(createdModels).toHaveLength(1);
        expect(createdModels[0]?.setValueCalls).toEqual([]);
        expect(monaco.editor.setModelLanguage).toHaveBeenCalledWith(
            firstModel,
            "typescript",
        );
    });

    it("updates an existing model only when content changes", () => {
        const { createdModels, monaco } = createFakeMonaco();
        getOrCreateWorkspaceFileModel({
            absolutePath: "/workspace/comando/src/app.ts",
            language: "typescript",
            monaco,
            value: "const a = 1;",
        });

        getOrCreateWorkspaceFileModel({
            absolutePath: "/workspace/comando/src/app.ts",
            language: "typescript",
            monaco,
            value: "const a = 2;",
        });

        expect(createdModels[0]?.setValueCalls).toEqual(["const a = 2;"]);
    });
});

describe("syncWorkspaceFileModel", () => {
    it("reports whether synchronizing replaced the model content", () => {
        const { monaco } = createFakeMonaco();
        const initial = syncWorkspaceFileModel({
            absolutePath: "/workspace/comando/src/app.ts",
            language: "typescript",
            monaco,
            value: "const a = 1;",
        });
        const matching = syncWorkspaceFileModel({
            absolutePath: "/workspace/comando/src/app.ts",
            language: "typescript",
            monaco,
            value: "const a = 1;",
        });
        const changed = syncWorkspaceFileModel({
            absolutePath: "/workspace/comando/src/app.ts",
            language: "typescript",
            monaco,
            value: "const a = 2;",
        });

        expect(initial.didChangeContent).toBe(false);
        expect(matching.didChangeContent).toBe(false);
        expect(changed.didChangeContent).toBe(true);
        expect(changed.model).toBe(initial.model);
    });
});

describe("acquireWorkspaceFileModel", () => {
    it("retains a shared file model until the final lease is released", () => {
        const { createdModels, monaco } = createFakeMonaco();
        const firstLease = acquireWorkspaceFileModel({
            absolutePath: "/workspace/comando/src/app.ts",
            language: "typescript",
            monaco,
            value: "const a = 1;",
        });
        const secondLease = acquireWorkspaceFileModel({
            absolutePath: "/workspace/comando/src/app.ts",
            language: "typescript",
            monaco,
            value: "const a = 1;",
        });

        expect(firstLease.model).toBe(secondLease.model);
        expect(createdModels).toHaveLength(1);

        firstLease.release();
        expect(createdModels[0]?.dispose).not.toHaveBeenCalled();

        secondLease.release();
        expect(createdModels[0]?.dispose).toHaveBeenCalledTimes(1);
    });

    it("makes lease release idempotent", () => {
        const { createdModels, monaco } = createFakeMonaco();
        const lease = acquireWorkspaceFileModel({
            absolutePath: "/workspace/comando/src/app.ts",
            language: "typescript",
            monaco,
            value: "const a = 1;",
        });

        lease.release();
        lease.release();

        expect(createdModels[0]?.dispose).toHaveBeenCalledTimes(1);
    });
});

function createFakeMonaco() {
    type FakeUri = {
        readonly value: string;
        readonly toString: () => string;
    };
    type FakeModel = {
        readonly dispose: () => void;
        readonly getValue: () => string;
        readonly isDisposed: () => boolean;
        readonly setValue: (value: string) => void;
        readonly setValueCalls: string[];
        disposed: boolean;
        language: string;
        value: string;
    };

    const models = new Map<string, FakeModel>();
    const createdModels: FakeModel[] = [];
    const monaco = {
        Uri: {
            parse: (value: string): FakeUri => ({
                toString: () => value,
                value,
            }),
        },
        editor: {
            createModel: vi.fn(
                (value: string, language: string, uri: FakeUri) => {
                    const model: FakeModel = {
                        dispose: vi.fn(() => {
                            model.disposed = true;
                            models.delete(uri.toString());
                        }),
                        disposed: false,
                        getValue: () => model.value,
                        isDisposed: () => model.disposed,
                        language,
                        setValue: (nextValue: string) => {
                            model.setValueCalls.push(nextValue);
                            model.value = nextValue;
                        },
                        setValueCalls: [],
                        value,
                    };
                    models.set(uri.toString(), model);
                    createdModels.push(model);
                    return model;
                },
            ),
            getModel: vi.fn((uri: FakeUri) => models.get(uri.toString()) ?? null),
            setModelLanguage: vi.fn(
                (model: FakeModel, language: string) => {
                    model.language = language;
                },
            ),
        },
    };

    return {
        createdModels,
        monaco: monaco as unknown as Parameters<
            typeof getOrCreateWorkspaceFileModel
        >[0]["monaco"],
    };
}
