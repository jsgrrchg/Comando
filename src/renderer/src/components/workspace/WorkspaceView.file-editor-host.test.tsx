/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";

import type {
    AiTrackedFile,
    GitFileDiff,
    GitOriginalFile,
    GitRepositorySnapshot,
    ProjectFileDocument,
} from "@shared/ipc";
import type { RuntimeWorkspaceFileTab } from "@renderer/app/workspace/tree";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const mockWorkspaceStoreState = vi.hoisted(() => ({
    current: {
        updateFileMarkdownViewMode: vi.fn(),
        updateFilePendingOpenLocation: vi.fn(),
        updateFileViewState: vi.fn(),
    },
}));

const mockAiStoreState = vi.hoisted(() => ({
    current: {
        keepTrackedFile: vi.fn(),
        keepTrackedFileHunks: vi.fn(),
        rejectTrackedFile: vi.fn(),
        rejectTrackedFileHunks: vi.fn(),
        sessions: {},
    },
}));

const mockGitStoreState = vi.hoisted(() => {
    const snapshots: Record<string, GitRepositorySnapshot> = {};

    return {
        current: {
            snapshots,
        },
    };
});

const mockProjectsStoreState = vi.hoisted(() => ({
    current: {
        projects: [
            {
                id: "project-1",
                name: "Comando",
            },
        ],
    },
}));

const mockEditorRuntime = vi.hoisted(() => ({
    applyMonacoThemeFromDom: vi.fn(),
    applyProjectTypeScriptConfigForPath: vi.fn(() => Promise.resolve()),
    ensureMonacoTextMateForLanguage: vi.fn(() => Promise.resolve()),
    installMonacoTokenDebugAction: vi.fn(() => ({
        dispose: vi.fn(),
    })),
}));

const monacoHarness = vi.hoisted(() => {
    type FakeUri = {
        readonly value: string;
        readonly toString: () => string;
    };

    type Disposable = {
        readonly dispose: () => void;
    };

    type FakeDecorationRange = {
        readonly endColumn: number;
        readonly endLineNumber: number;
        readonly startColumn: number;
        readonly startLineNumber: number;
    };

    type FakeDeltaDecoration = {
        readonly options: unknown;
        readonly range: FakeDecorationRange;
    };

    type FakeModel = {
        readonly dispose: () => void;
        readonly decorations: Map<string, FakeDeltaDecoration>;
        readonly getDecorationRange: (id: string) => FakeDecorationRange | null;
        readonly getFullModelRange: () => {
            readonly endColumn: number;
            readonly endLineNumber: number;
            readonly startColumn: number;
            readonly startLineNumber: number;
        };
        readonly getLineCount: () => number;
        readonly getLineMaxColumn: (lineNumber: number) => number;
        readonly getOffsetAt: (position: {
            readonly column: number;
            readonly lineNumber: number;
        }) => number;
        readonly getOptions: () => { readonly tabSize: number };
        readonly getPositionAt: (offset: number) => {
            readonly column: number;
            readonly lineNumber: number;
        };
        readonly getValue: () => string;
        readonly isDisposed: () => boolean;
        readonly setValue: (value: string) => void;
        disposed: boolean;
        language: string;
        readonly uri: string;
        value: string;
    };

    type FakeCodeEditor = {
        readonly createDecorationsCollection: (
            decorations?: readonly unknown[],
        ) => {
            readonly clear: () => void;
            readonly initialDecorations: readonly unknown[];
            readonly set: (decorations: readonly unknown[]) => void;
        };
        readonly deltaDecorations: (
            oldDecorations: readonly string[],
            newDecorations: readonly FakeDeltaDecoration[],
        ) => string[];
        readonly dispose: () => void;
        readonly getContribution: () => null;
        readonly getDomNode: () => HTMLElement;
        readonly getModel: () => FakeModel | null;
        readonly getPosition: () => { column: number; lineNumber: number };
        readonly getScrollLeft: () => number;
        readonly getScrollTop: () => number;
        readonly getSelection: () => null;
        readonly getSelections: () => readonly unknown[];
        readonly hasTextFocus: () => boolean;
        readonly hasWidgetFocus: () => boolean;
        readonly layout: () => void;
        readonly onDidChangeCursorSelection: (
            listener: () => void,
        ) => Disposable;
        readonly onDidChangeHiddenAreas: () => Disposable;
        readonly onDidChangeModel: (listener: () => void) => Disposable;
        readonly onDidDispose: (listener: () => void) => Disposable;
        readonly onDidLayoutChange: () => Disposable;
        readonly onDidScrollChange: (listener: () => void) => Disposable;
        readonly onWillChangeModel: (listener: () => void) => Disposable;
        readonly onMouseLeave: () => Disposable;
        readonly onMouseMove: () => Disposable;
        readonly pushUndoStop: () => void;
        readonly revealLineInCenter: (lineNumber: number) => void;
        readonly revealRangeInCenter: (range: {
            readonly endColumn: number;
            readonly endLineNumber: number;
            readonly startColumn: number;
            readonly startLineNumber: number;
        }) => void;
        readonly restoreViewState: (viewState: unknown) => void;
        readonly saveViewState: () => {
            readonly contributionsState: readonly unknown[];
            readonly cursorState: readonly unknown[];
            readonly viewState: {
                readonly editorName: string;
                readonly modelUri: string | null;
            };
        };
        readonly setModel: (model: FakeModel | null) => void;
        readonly setPosition: (position: {
            readonly column: number;
            readonly lineNumber: number;
        }) => void;
        readonly setSelection: (selection: {
            readonly endColumn: number;
            readonly endLineNumber: number;
            readonly selectionStartColumn: number;
            readonly selectionStartLineNumber: number;
            readonly startColumn: number;
            readonly startLineNumber: number;
        }) => void;
        readonly setScrollLeft: (scrollLeft: number) => void;
        readonly setScrollTop: (scrollTop: number) => void;
        readonly updateOptions: (options: unknown) => void;
        disposed: boolean;
        model: FakeModel | null;
        readonly name: string;
        position: { column: number; lineNumber: number };
        scrollLeft: number;
        scrollTop: number;
    };

    type FakeDiffEditor = {
        readonly dispose: () => void;
        readonly getContainerDomNode: () => HTMLElement;
        readonly getModel: () => {
            readonly modified: FakeModel | null;
            readonly original: FakeModel | null;
        } | null;
        readonly getModifiedEditor: () => FakeCodeEditor;
        readonly getOriginalEditor: () => FakeCodeEditor;
        readonly layout: () => void;
        readonly onDidDispose: (listener: () => void) => Disposable;
        readonly setModel: (
            modelsInput: {
                readonly modified: FakeModel;
                readonly original: FakeModel;
            } | null,
        ) => void;
        disposed: boolean;
        modifiedModel: FakeModel | null;
        originalModel: FakeModel | null;
    };

    const models = new Map<string, FakeModel>();
    const createdModels: FakeModel[] = [];
    const codeEditors: FakeCodeEditor[] = [];
    const decorationCollections: Array<{
        readonly clear: ReturnType<typeof vi.fn>;
        readonly initialDecorations: readonly unknown[];
        readonly set: ReturnType<typeof vi.fn>;
    }> = [];
    const diffEditors: FakeDiffEditor[] = [];
    const editorPropSnapshots: Array<{
        readonly defaultValue: string | undefined;
        readonly path: string | undefined;
        readonly value: string | undefined;
    }> = [];
    let editorCounter = 0;
    let diffEditorCounter = 0;
    let decorationCounter = 0;

    const toLines = (value: string) => value.split("\n");

    const createDisposable = (): Disposable => ({
        dispose: vi.fn(),
    });

    const createModel = (
        value: string,
        language: string,
        uri: FakeUri,
    ): FakeModel => {
        const model: FakeModel = {
            decorations: new Map(),
            dispose: vi.fn(() => {
                model.disposed = true;
                models.delete(uri.toString());
            }),
            getDecorationRange: (id) => model.decorations.get(id)?.range ?? null,
            disposed: false,
            getFullModelRange: () => ({
                endColumn: toLines(model.value).at(-1)!.length + 1,
                endLineNumber: model.getLineCount(),
                startColumn: 1,
                startLineNumber: 1,
            }),
            getLineCount: () => toLines(model.value).length,
            getLineMaxColumn: (lineNumber) =>
                (toLines(model.value)[lineNumber - 1] ?? "").length + 1,
            getOffsetAt: ({ column, lineNumber }) => {
                const previousLines = toLines(model.value).slice(
                    0,
                    Math.max(lineNumber - 1, 0),
                );
                return (
                    previousLines.reduce(
                        (total, line) => total + line.length + 1,
                        0,
                    ) +
                    column -
                    1
                );
            },
            getOptions: () => ({ tabSize: 4 }),
            getPositionAt: (offset) => {
                const lines = toLines(model.value);
                let remaining = offset;
                for (let index = 0; index < lines.length; index += 1) {
                    const lineLengthWithBreak = lines[index].length + 1;
                    if (remaining < lineLengthWithBreak) {
                        return {
                            column: remaining + 1,
                            lineNumber: index + 1,
                        };
                    }
                    remaining -= lineLengthWithBreak;
                }
                return {
                    column: lines.at(-1)!.length + 1,
                    lineNumber: lines.length,
                };
            },
            getValue: () => model.value,
            isDisposed: () => model.disposed,
            language,
            setValue: vi.fn((nextValue: string) => {
                model.value = nextValue;
            }),
            uri: uri.toString(),
            value,
        };
        models.set(uri.toString(), model);
        createdModels.push(model);
        return model;
    };

    const monaco = {
        Uri: {
            parse: (value: string): FakeUri => ({
                toString: () => value,
                value,
            }),
        },
        editor: {
            createModel: vi.fn(createModel),
            getModel: vi.fn((uri: FakeUri) => models.get(uri.toString()) ?? null),
            setModelLanguage: vi.fn((model: FakeModel, language: string) => {
                model.language = language;
            }),
        },
    };

    const createCodeEditor = (name = `editor-${++editorCounter}`) => {
        const domNode = document.createElement("div");
        const disposeListeners = new Set<() => void>();
        const modelChangeListeners = new Set<() => void>();
        const modelWillChangeListeners = new Set<() => void>();
        const cursorSelectionListeners = new Set<() => void>();
        const scrollListeners = new Set<() => void>();
        const editor: FakeCodeEditor = {
            createDecorationsCollection: vi.fn(
                (decorations: readonly unknown[] = []) => {
                    const collection = {
                        clear: vi.fn(),
                        initialDecorations: decorations,
                        set: vi.fn(),
                    };
                    decorationCollections.push(collection);
                    return collection;
                },
            ),
            deltaDecorations: vi.fn(
                (
                    oldDecorations: readonly string[],
                    newDecorations: readonly FakeDeltaDecoration[],
                ): string[] => {
                    const model = editor.model;
                    if (!model) {
                        return [];
                    }

                    for (const decorationId of oldDecorations) {
                        model.decorations.delete(decorationId);
                    }

                    return newDecorations.map((decoration) => {
                        const id = `${editor.name}-decoration-${++decorationCounter}`;
                        model.decorations.set(id, {
                            options: decoration.options,
                            range: { ...decoration.range },
                        });
                        return id;
                    });
                },
            ),
            dispose: () => {
                if (editor.disposed) {
                    return;
                }
                editor.disposed = true;
                for (const listener of disposeListeners) {
                    listener();
                }
                disposeListeners.clear();
            },
            disposed: false,
            getContribution: () => null,
            getDomNode: () => domNode,
            getModel: () => editor.model,
            getPosition: () => editor.position,
            getScrollLeft: () => editor.scrollLeft,
            getScrollTop: () => editor.scrollTop,
            getSelection: () => null,
            getSelections: () => [],
            hasTextFocus: () => true,
            hasWidgetFocus: () => false,
            layout: vi.fn(),
            model: null,
            name,
            onDidChangeCursorSelection: (listener) => {
                cursorSelectionListeners.add(listener);
                return {
                    dispose: () => {
                        cursorSelectionListeners.delete(listener);
                    },
                };
            },
            onDidChangeHiddenAreas: () => createDisposable(),
            onDidChangeModel: (listener) => {
                modelChangeListeners.add(listener);
                return {
                    dispose: () => {
                        modelChangeListeners.delete(listener);
                    },
                };
            },
            onDidDispose: (listener) => {
                disposeListeners.add(listener);
                return {
                    dispose: () => {
                        disposeListeners.delete(listener);
                    },
                };
            },
            onDidLayoutChange: () => createDisposable(),
            onDidScrollChange: (listener) => {
                scrollListeners.add(listener);
                return {
                    dispose: () => {
                        scrollListeners.delete(listener);
                    },
                };
            },
            onWillChangeModel: (listener) => {
                modelWillChangeListeners.add(listener);
                return {
                    dispose: () => {
                        modelWillChangeListeners.delete(listener);
                    },
                };
            },
            onMouseLeave: () => createDisposable(),
            onMouseMove: () => createDisposable(),
            pushUndoStop: vi.fn(),
            revealLineInCenter: vi.fn(),
            revealRangeInCenter: vi.fn(),
            restoreViewState: vi.fn(),
            saveViewState: vi.fn(() => ({
                contributionsState: [],
                cursorState: [],
                viewState: {
                    editorName: editor.name,
                    modelUri: editor.model?.uri ?? null,
                },
            })),
            position: { column: 1, lineNumber: 1 },
            scrollLeft: 0,
            scrollTop: 0,
            setModel: (model: FakeModel | null) => {
                const previousModel = editor.model;
                if (previousModel !== model) {
                    for (const listener of modelWillChangeListeners) {
                        listener();
                    }
                }
                editor.model = model;
                if (previousModel !== model) {
                    for (const listener of modelChangeListeners) {
                        listener();
                    }
                }
            },
            setPosition: vi.fn(
                (position: {
                    readonly column: number;
                    readonly lineNumber: number;
                }) => {
                    editor.position = position;
                    for (const listener of cursorSelectionListeners) {
                        listener();
                    }
                },
            ),
            setSelection: vi.fn(),
            setScrollLeft: vi.fn((scrollLeft: number) => {
                editor.scrollLeft = scrollLeft;
                for (const listener of scrollListeners) {
                    listener();
                }
            }),
            setScrollTop: vi.fn((scrollTop: number) => {
                editor.scrollTop = scrollTop;
                for (const listener of scrollListeners) {
                    listener();
                }
            }),
            updateOptions: vi.fn(),
        };
        codeEditors.push(editor);
        return editor;
    };

    const createDiffEditor = () => {
        const originalEditor = createCodeEditor(
            `diff-original-${++diffEditorCounter}`,
        );
        const modifiedEditor = createCodeEditor(
            `diff-modified-${diffEditorCounter}`,
        );
        const container = document.createElement("div");
        const disposeListeners = new Set<() => void>();
        const diffEditor: FakeDiffEditor = {
            dispose: () => {
                if (diffEditor.disposed) {
                    return;
                }
                diffEditor.disposed = true;
                for (const listener of disposeListeners) {
                    listener();
                }
                disposeListeners.clear();
                originalEditor.dispose();
                modifiedEditor.dispose();
            },
            disposed: false,
            getContainerDomNode: () => container,
            getModel: () => ({
                modified: diffEditor.modifiedModel,
                original: diffEditor.originalModel,
            }),
            getModifiedEditor: () => modifiedEditor,
            getOriginalEditor: () => originalEditor,
            layout: vi.fn(),
            modifiedModel: null,
            onDidDispose: (listener) => {
                disposeListeners.add(listener);
                return {
                    dispose: () => {
                        disposeListeners.delete(listener);
                    },
                };
            },
            originalModel: null,
            setModel: (modelsInput) => {
                diffEditor.modifiedModel = modelsInput?.modified ?? null;
                diffEditor.originalModel = modelsInput?.original ?? null;
                modifiedEditor.setModel(diffEditor.modifiedModel);
                originalEditor.setModel(diffEditor.originalModel);
            },
        };
        diffEditors.push(diffEditor);
        return diffEditor;
    };

    return {
        codeEditors,
        createdModels,
        createCodeEditor,
        createDiffEditor,
        decorationCollections,
        diffEditors,
        editorPropSnapshots,
        models,
        monaco,
        reset: () => {
            models.clear();
            createdModels.length = 0;
            codeEditors.length = 0;
            decorationCollections.length = 0;
            diffEditors.length = 0;
            editorPropSnapshots.length = 0;
            editorCounter = 0;
            diffEditorCounter = 0;
            decorationCounter = 0;
            monaco.editor.createModel.mockClear();
            monaco.editor.getModel.mockClear();
            monaco.editor.setModelLanguage.mockClear();
        },
    };
});

vi.mock("@renderer/app/hooks/use-resolved-editor-settings", () => ({
    useResolvedEditorSettings: () => ({
        autoSaveDelayMs: 1000,
        fontFamily: "system",
        fontSize: 14,
        lineHeight: 1.5,
        minimapEnabled: false,
        relativeLineNumbersEnabled: false,
        suggestionsEnabled: true,
        vimModeEnabled: false,
    }),
}));

vi.mock("@renderer/app/settings/client", () => ({
    loadAppEditorSettings: vi.fn(() =>
        Promise.resolve({
            fontFamily: "system",
            fontSize: 14,
        }),
    ),
    saveAppEditorSettings: vi.fn(() => Promise.resolve()),
}));

vi.mock("@renderer/app/editor/monaco", () => mockEditorRuntime);

vi.mock("@renderer/app/store/workspace-store", () => ({
    getBestMatchingChatTabId: vi.fn(() => null),
    useWorkspaceStore: (selector: (state: unknown) => unknown) =>
        selector(mockWorkspaceStoreState.current),
}));

vi.mock("@renderer/app/store/ai-store", () => ({
    useAiStore: (selector: (state: unknown) => unknown) =>
        selector(mockAiStoreState.current),
}));

vi.mock("@renderer/app/store/git-store", () => ({
    useGitStore: (selector: (state: unknown) => unknown) =>
        selector(mockGitStoreState.current),
}));

vi.mock("@renderer/app/store/github-store", () => ({
    getGitHubRepoKey: vi.fn(() => "repo"),
    useGitHubStore: (selector: (state: unknown) => unknown) =>
        selector({
            repositoriesByProjectId: {},
        }),
}));

vi.mock("@renderer/app/store/projects-store", () => ({
    useProjectsStore: (selector: (state: unknown) => unknown) =>
        selector(mockProjectsStoreState.current),
}));

vi.mock("@renderer/features/terminal/WorkspaceTerminalView", () => ({
    WorkspaceTerminalView: () => null,
}));

vi.mock("@monaco-editor/react", async () => {
    const React = await import("react");

    const MockEditor = ({
        beforeMount,
        defaultValue,
        language,
        onMount,
        options,
        path,
        value,
    }: {
        readonly beforeMount?: () => void;
        readonly defaultValue?: string;
        readonly language?: string;
        readonly onMount?: (editor: unknown, monaco: unknown) => void;
        readonly options?: unknown;
        readonly path?: string;
        readonly value?: string;
    }) => {
        const editorRef = React.useRef<ReturnType<
            typeof monacoHarness.createCodeEditor
        > | null>(null);
        const mountPropsRef = React.useRef({
            beforeMount,
            defaultValue,
            language,
            onMount,
            options,
            path,
            value,
        });
        monacoHarness.editorPropSnapshots.push({
            defaultValue,
            path,
            value,
        });

        React.useEffect(() => {
            const mountProps = mountPropsRef.current;
            mountProps.beforeMount?.();
            const editor = monacoHarness.createCodeEditor();
            const modelPath =
                mountProps.path ?? `inmemory://model-${Date.now()}`;
            const uri = monacoHarness.monaco.Uri.parse(modelPath);
            const model =
                monacoHarness.monaco.editor.getModel(uri) ??
                monacoHarness.monaco.editor.createModel(
                    mountProps.defaultValue ?? mountProps.value ?? "",
                    mountProps.language ?? "plaintext",
                    uri,
            );
            editor.setModel(model);
            if (mountProps.options) {
                editor.updateOptions(mountProps.options);
            }
            editorRef.current = editor;
            mountProps.onMount?.(editor, monacoHarness.monaco);

            return () => {
                editor.dispose();
                editorRef.current = null;
            };
        }, []);

        React.useEffect(() => {
            const editor = editorRef.current;
            if (!editor || value === undefined) {
                return;
            }

            const model = editor.getModel();
            if (model && model.getValue() !== value) {
                model.setValue(value);
            }
        }, [value]);

        React.useEffect(() => {
            const editor = editorRef.current;
            if (!editor || !options) {
                return;
            }

            editor.updateOptions(options);
        }, [options]);

        return React.createElement("div", {
            "data-mock-editor": path ?? "",
        });
    };

    const MockDiffEditor = ({
        beforeMount,
        language,
        modified,
        modifiedModelPath,
        onMount,
        original,
        originalModelPath,
    }: {
        readonly beforeMount?: () => void;
        readonly language?: string;
        readonly modified?: string;
        readonly modifiedModelPath?: string;
        readonly onMount?: (editor: unknown, monaco: unknown) => void;
        readonly original?: string;
        readonly originalModelPath?: string;
    }) => {
        const mountPropsRef = React.useRef({
            beforeMount,
            language,
            modified,
            modifiedModelPath,
            onMount,
            original,
            originalModelPath,
        });

        React.useEffect(() => {
            const mountProps = mountPropsRef.current;
            mountProps.beforeMount?.();
            const diffEditor = monacoHarness.createDiffEditor();
            const originalUri = monacoHarness.monaco.Uri.parse(
                mountProps.originalModelPath ??
                    `inmemory://original-${Date.now()}`,
            );
            const modifiedUri = monacoHarness.monaco.Uri.parse(
                mountProps.modifiedModelPath ??
                    `inmemory://modified-${Date.now()}`,
            );
            const originalModel =
                monacoHarness.monaco.editor.getModel(originalUri) ??
                monacoHarness.monaco.editor.createModel(
                    mountProps.original ?? "",
                    mountProps.language ?? "plaintext",
                    originalUri,
                );
            const modifiedModel =
                monacoHarness.monaco.editor.getModel(modifiedUri) ??
                monacoHarness.monaco.editor.createModel(
                    mountProps.modified ?? "",
                    mountProps.language ?? "plaintext",
                    modifiedUri,
                );
            diffEditor.setModel({
                modified: modifiedModel,
                original: originalModel,
            });
            mountProps.onMount?.(diffEditor, monacoHarness.monaco);

            return () => {
                diffEditor.dispose();
            };
        }, []);

        return React.createElement("div", {
            "data-mock-diff-editor": modifiedModelPath ?? "",
        });
    };

    return {
        DiffEditor: MockDiffEditor,
        default: MockEditor,
    };
});

import { WorkspaceFileEditorHost } from "./WorkspaceView";

function createDocument(
    relativePath: string,
    content: string,
): ProjectFileDocument {
    const isMarkdown =
        relativePath.endsWith(".md") || relativePath.endsWith(".markdown");

    return {
        absolutePath: `/workspace/comando/${relativePath}`,
        content,
        imageDataBase64: null,
        isBinary: false,
        isTooLarge: false,
        kind: "text",
        languageId: isMarkdown ? "markdown" : "typescript",
        languageLabel: isMarkdown ? "Markdown" : "TypeScript",
        mimeType: isMarkdown ? "text/markdown" : "text/typescript",
        modifiedAtMs: 1,
        name: relativePath.split("/").at(-1) ?? relativePath,
        projectId: "project-1",
        relativePath,
        sizeBytes: content.length,
    };
}

function createFileTab(
    id: string,
    relativePath = "src/app.ts",
    content = "const value = 1;\n",
): RuntimeWorkspaceFileTab {
    const document = createDocument(relativePath, content);

    return {
        createdAt: "2026-06-05T00:00:00.000Z",
        document,
        draftContent: content,
        hasExternalChange: false,
        id,
        isDirty: false,
        isLoading: false,
        isSaving: false,
        kind: "file",
        loadError: null,
        projectId: "project-1",
        relativePath,
        reviewContext: null,
        saveError: null,
        savedContent: content,
        title: document.name,
        viewState: null,
        worktreeId: null,
    };
}

function createTrackedFile(): AiTrackedFile {
    return {
        hunks: [
            {
                id: "hunk-1",
                lines: [],
                newCount: 1,
                newStart: 1,
                oldCount: 1,
                oldStart: 1,
            },
        ],
        identityKey: "tracked:src/app.ts",
        isText: true,
        kind: "update",
        newText: "const value = 2;\n",
        oldText: "const value = 1;\n",
        path: "src/app.ts",
        previousPath: null,
        reversible: true,
        reviewState: "pending",
        sessionId: "session-1",
        toolCallId: null,
        updatedAt: "2026-06-05T00:01:00.000Z",
        version: 2,
    };
}

function createTrackedFileUpdate(): AiTrackedFile {
    return {
        ...createTrackedFile(),
        newText: [
            "const value = 2;",
            "const nextValue = 3;",
            "const finalValue = 4;",
            "",
        ].join("\n"),
        updatedAt: "2026-06-05T00:02:00.000Z",
        version: 3,
    };
}

function createGitDiff(path = "src/app.ts", newStart = 1): GitFileDiff {
    return {
        hunks: [
            {
                id: "git-hunk-1",
                lines: [
                    {
                        id: "git-line-1",
                        text: "const value = 1;",
                        type: "remove",
                    },
                    {
                        id: "git-line-2",
                        text: "const value = 2;",
                        type: "add",
                    },
                ],
                newCount: 1,
                newStart,
                oldCount: 1,
                oldStart: newStart,
            },
        ],
        isText: true,
        kind: "update",
        newText: null,
        oldText: null,
        path,
        previousPath: null,
        reversible: true,
    };
}

function createGitOriginalFile(
    path = "src/app.ts",
    baseText = "const value = 1;\n",
): GitOriginalFile {
    return {
        baseText,
        isText: true,
        kind: "modified",
        path,
        previousPath: null,
        scope: "unstaged",
    };
}

function createGitSnapshot(
    changedPaths: readonly string[] = ["src/app.ts"],
): GitRepositorySnapshot {
    return {
        aheadBy: 0,
        behindBy: 0,
        branch: null,
        branches: [],
        canonicalRootPath: "/workspace/comando",
        changedPaths,
        changes: changedPaths.map((path) => ({
            additions: 1,
            deletions: 1,
            hasChildren: false,
            isBinary: false,
            isConflicted: false,
            isRenamed: false,
            kind: "modified",
            path,
            previousPath: null,
            scope: "unstaged",
            worktreeId: null,
        })),
        currentWorktreeId: null,
        defaultTreeViewMode: "tree",
        headSha: "abc123",
        projectId: "project-1",
        remotes: [],
        repositoryState: "ready",
        rootPath: "/workspace/comando",
        selectedRemoteName: null,
        status: {
            changedCount: changedPaths.length,
            conflictedCount: 0,
            stagedCount: 0,
            unstagedCount: changedPaths.length,
            untrackedCount: 0,
        },
        syncStatus: "in_sync",
        updatedAt: "2026-06-05T00:02:00.000Z",
        worktrees: [],
    };
}

function renderHost({
    activeFileTab,
    fileTabs,
    onDraftChange = vi.fn(),
    recentActiveTabIds = [],
}: {
    readonly activeFileTab: RuntimeWorkspaceFileTab | null;
    readonly fileTabs: readonly RuntimeWorkspaceFileTab[];
    readonly onDraftChange?: (tabId: string, draft: string) => void;
    readonly recentActiveTabIds?: readonly string[];
}): ReactNode {
    return (
        <WorkspaceFileEditorHost
            activeFileTab={activeFileTab}
            fileTabs={fileTabs}
            isActivePane={true}
            onAttachLineFragment={vi.fn()}
            onDraftChange={onDraftChange}
            onReload={vi.fn(() => Promise.resolve())}
            onSave={vi.fn(() => Promise.resolve())}
            recentActiveTabIds={recentActiveTabIds}
        />
    );
}

class MemoryStorage implements Storage {
    private readonly values = new Map<string, string>();

    get length() {
        return this.values.size;
    }

    clear() {
        this.values.clear();
    }

    getItem(key: string) {
        return this.values.get(key) ?? null;
    }

    key(index: number) {
        return [...this.values.keys()][index] ?? null;
    }

    removeItem(key: string) {
        this.values.delete(key);
    }

    setItem(key: string, value: string) {
        this.values.set(key, value);
    }
}

async function flushEffects() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

async function waitForGitGutterLiveDiff() {
    await act(async () => {
        await new Promise((resolve) => {
            window.setTimeout(resolve, 250);
        });
    });
}

function findButtonByText(container: HTMLElement, label: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
        (entry): entry is HTMLButtonElement =>
            entry.textContent?.trim() === label,
    );
    if (!button) {
        throw new Error(`Expected button "${label}" to be rendered.`);
    }
    return button;
}

describe("WorkspaceFileEditorHost", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
        });
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
            window.setTimeout(() => callback(performance.now()), 0),
        );
        vi.stubGlobal("cancelAnimationFrame", (id: number) => {
            window.clearTimeout(id);
        });
        monacoHarness.reset();
        mockEditorRuntime.applyMonacoThemeFromDom.mockClear();
        mockEditorRuntime.applyProjectTypeScriptConfigForPath.mockClear();
        mockEditorRuntime.ensureMonacoTextMateForLanguage.mockClear();
        mockEditorRuntime.installMonacoTokenDebugAction.mockClear();
        mockWorkspaceStoreState.current.updateFileMarkdownViewMode.mockClear();
        mockWorkspaceStoreState.current.updateFilePendingOpenLocation.mockClear();
        mockWorkspaceStoreState.current.updateFileViewState.mockClear();
        mockAiStoreState.current.keepTrackedFile.mockClear();
        mockAiStoreState.current.keepTrackedFileHunks.mockClear();
        mockAiStoreState.current.rejectTrackedFile.mockClear();
        mockAiStoreState.current.rejectTrackedFileHunks.mockClear();
        mockAiStoreState.current.sessions = {};
        mockGitStoreState.current.snapshots = {};
    });

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        container.remove();
        vi.unstubAllGlobals();
    });

    it("keeps one Monaco editor mounted while switching duplicate file tabs and saves the previous tab view state", async () => {
        const firstTab = createFileTab("file-1");
        const secondTab = createFileTab("file-2");

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: firstTab,
                    fileTabs: [firstTab, secondTab],
                }),
            );
        });
        await flushEffects();

        expect(monacoHarness.codeEditors).toHaveLength(1);
        expect(monacoHarness.createdModels).toHaveLength(1);
        expect(monacoHarness.createdModels[0]?.uri).toBe(
            "/workspace/comando/src/app.ts",
        );

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: secondTab,
                    fileTabs: [firstTab, secondTab],
                    recentActiveTabIds: ["file-1"],
                }),
            );
        });
        await flushEffects();

        expect(monacoHarness.codeEditors).toHaveLength(1);
        expect(monacoHarness.createdModels).toHaveLength(1);
        expect(monacoHarness.codeEditors[0]?.disposed).toBe(false);
        const persistedFirstTabViewState =
            mockWorkspaceStoreState.current.updateFileViewState.mock.calls.find(
                ([tabId]) => tabId === "file-1",
            )?.[1] as
                | {
                      readonly viewState?: {
                          readonly modelUri?: string | null;
                      };
                  }
                | undefined;
        expect(persistedFirstTabViewState?.viewState?.modelUri).toBe(
            "/workspace/comando/src/app.ts",
        );

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: null,
                    fileTabs: [firstTab, secondTab],
                    recentActiveTabIds: ["file-2"],
                }),
            );
        });
        await flushEffects();

        expect(monacoHarness.codeEditors).toHaveLength(1);
        expect(monacoHarness.codeEditors[0]?.disposed).toBe(false);
        expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
    });

    it("renders the Markdown view switch for .md and .markdown file tabs", async () => {
        const markdownTab = createFileTab("file-1", "README.md", "# Readme\n");
        const longMarkdownTab = createFileTab(
            "file-2",
            "notes/project.markdown",
            "# Notes\n",
        );

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: markdownTab,
                    fileTabs: [markdownTab],
                }),
            );
        });
        await flushEffects();

        expect(
            container.querySelector('[aria-label="Markdown view mode"]'),
        ).not.toBeNull();
        expect(findButtonByText(container, "Edit").getAttribute("aria-pressed"))
            .toBe("true");
        expect(
            findButtonByText(container, "Preview").getAttribute("aria-pressed"),
        ).toBe("false");

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: longMarkdownTab,
                    fileTabs: [longMarkdownTab],
                }),
            );
        });
        await flushEffects();

        expect(
            container.querySelector('[aria-label="Markdown view mode"]'),
        ).not.toBeNull();
    });

    it("does not render the Markdown view switch for non-Markdown file tabs", async () => {
        const tab = createFileTab("file-1", "src/app.ts");

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: tab,
                    fileTabs: [tab],
                }),
            );
        });
        await flushEffects();

        expect(
            container.querySelector('[aria-label="Markdown view mode"]'),
        ).toBeNull();
    });

    it("renders Markdown preview from the current editor model content", async () => {
        const onDraftChange = vi.fn();
        const tab = createFileTab("file-1", "README.md", "# Saved\n");
        const currentContent = "# Current\n\n- From editor\n";

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: tab,
                    fileTabs: [tab],
                    onDraftChange,
                }),
            );
        });
        await flushEffects();

        const editor = monacoHarness.codeEditors[0];
        if (!editor?.model) {
            throw new Error("Expected Monaco editor to mount.");
        }
        editor.model.setValue(currentContent);

        act(() => {
            findButtonByText(container, "Preview").click();
        });

        expect(onDraftChange).toHaveBeenCalledWith("file-1", currentContent);
        expect(
            mockWorkspaceStoreState.current.updateFileMarkdownViewMode,
        ).toHaveBeenCalledWith("file-1", "preview");

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: {
                        ...tab,
                        draftContent: currentContent,
                        markdownViewMode: "preview",
                    },
                    fileTabs: [
                        {
                            ...tab,
                            draftContent: currentContent,
                            markdownViewMode: "preview",
                        },
                    ],
                    onDraftChange,
                }),
            );
        });
        await flushEffects();

        expect(container.querySelector(".markdown-file-preview")).not.toBeNull();
        expect(container.innerHTML).toContain("<h1>Current</h1>");
        expect(container.innerHTML).toContain("<li>From editor</li>");
        expect(monacoHarness.codeEditors).toHaveLength(1);
        expect(monacoHarness.codeEditors[0]?.disposed).toBe(false);
    });

    it("returns from Markdown preview without remounting the Monaco editor", async () => {
        const previewTab = {
            ...createFileTab("file-1", "README.md", "# Preview\n"),
            markdownViewMode: "preview" as const,
        };

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: previewTab,
                    fileTabs: [previewTab],
                }),
            );
        });
        await flushEffects();

        const editor = monacoHarness.codeEditors[0];
        if (!editor) {
            throw new Error("Expected Monaco editor to mount.");
        }
        editor.setPosition({ column: 3, lineNumber: 1 });

        act(() => {
            findButtonByText(container, "Edit").click();
        });

        expect(
            mockWorkspaceStoreState.current.updateFileMarkdownViewMode,
        ).toHaveBeenCalledWith("file-1", "edit");

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: {
                        ...previewTab,
                        markdownViewMode: "edit",
                    },
                    fileTabs: [
                        {
                            ...previewTab,
                            markdownViewMode: "edit",
                        },
                    ],
                }),
            );
        });
        await flushEffects();

        expect(monacoHarness.codeEditors).toHaveLength(1);
        expect(monacoHarness.codeEditors[0]).toBe(editor);
        expect(editor.disposed).toBe(false);
        expect(editor.getPosition()).toEqual({ column: 3, lineNumber: 1 });
    });

    it("preserves the latest Markdown draft across quick edit and preview toggles", async () => {
        const onDraftChange = vi.fn();
        const tab = createFileTab("file-1", "README.md", "# Saved\n");
        const firstDraft = "# First draft\n\nBody A\n";
        const secondDraft = "# Second draft\n\nBody B\n";

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: tab,
                    fileTabs: [tab],
                    onDraftChange,
                }),
            );
        });
        await flushEffects();

        const editor = monacoHarness.codeEditors[0];
        if (!editor?.model) {
            throw new Error("Expected Monaco editor to mount.");
        }
        editor.model.setValue(firstDraft);

        act(() => {
            findButtonByText(container, "Preview").click();
        });

        expect(onDraftChange).toHaveBeenLastCalledWith("file-1", firstDraft);
        expect(
            mockWorkspaceStoreState.current.updateFileMarkdownViewMode,
        ).toHaveBeenLastCalledWith("file-1", "preview");

        const previewTab = {
            ...tab,
            draftContent: firstDraft,
            markdownViewMode: "preview" as const,
        };
        act(() => {
            root.render(
                renderHost({
                    activeFileTab: previewTab,
                    fileTabs: [previewTab],
                    onDraftChange,
                }),
            );
        });
        await flushEffects();

        act(() => {
            findButtonByText(container, "Edit").click();
        });

        expect(
            mockWorkspaceStoreState.current.updateFileMarkdownViewMode,
        ).toHaveBeenLastCalledWith("file-1", "edit");

        const editTab = {
            ...previewTab,
            markdownViewMode: "edit" as const,
        };
        act(() => {
            root.render(
                renderHost({
                    activeFileTab: editTab,
                    fileTabs: [editTab],
                    onDraftChange,
                }),
            );
        });
        await flushEffects();

        expect(monacoHarness.codeEditors[0]).toBe(editor);
        expect(editor.disposed).toBe(false);

        editor.model.setValue(secondDraft);

        act(() => {
            findButtonByText(container, "Preview").click();
        });

        expect(onDraftChange).toHaveBeenLastCalledWith("file-1", secondDraft);
        expect(
            mockWorkspaceStoreState.current.updateFileMarkdownViewMode,
        ).toHaveBeenLastCalledWith("file-1", "preview");
    });

    it("keeps the git gutter decoration collection stable while typing", async () => {
        const tab = createFileTab("file-1");
        const getGitDiff = vi.fn(() => Promise.resolve(createGitDiff()));
        const getGitOriginalFile = vi.fn(() =>
            Promise.resolve(createGitOriginalFile()),
        );
        vi.stubGlobal("comando", { getGitDiff, getGitOriginalFile });
        mockGitStoreState.current.snapshots = {
            "project-1::primary": createGitSnapshot(),
        };

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: tab,
                    fileTabs: [tab],
                }),
            );
        });
        await flushEffects();
        await flushEffects();

        const editor = monacoHarness.codeEditors[0];
        expect(editor).toBeDefined();
        if (!editor) {
            throw new Error("Expected Monaco editor to mount.");
        }
        expect(editor?.updateOptions).toHaveBeenCalledWith(
            expect.objectContaining({
                lineDecorationsWidth: 10,
                lineNumbersMinChars: 4,
            }),
        );
        expect(getGitDiff).toHaveBeenCalledWith({
            path: "src/app.ts",
            projectId: "project-1",
            worktreeId: null,
        });
        expect(getGitOriginalFile).toHaveBeenCalledWith({
            path: "src/app.ts",
            projectId: "project-1",
            worktreeId: null,
        });
        expect(monacoHarness.editorPropSnapshots.at(-1)).toEqual(
            expect.objectContaining({
                defaultValue: tab.draftContent,
                value: undefined,
            }),
        );

        expect(editor?.createDecorationsCollection).not.toHaveBeenCalled();
        expect(editor?.deltaDecorations).toHaveBeenCalledWith([], [
            {
                options: {
                    description: "git-gutter-decoration",
                    isWholeLine: true,
                    linesDecorationsClassName:
                        "git-diff-glyph git-diff-modified",
                },
                range: {
                    endColumn: 1,
                    endLineNumber: 1,
                    startColumn: 1,
                    startLineNumber: 1,
                },
            },
        ]);

        vi.mocked(editor.deltaDecorations).mockClear();
        const typedTab = {
            ...tab,
            draftContent: "const value = 2;\nfunction selectedName() {}\n",
            isDirty: true,
        } satisfies RuntimeWorkspaceFileTab;
        const model = editor?.getModel();
        const setValueMock = model ? vi.mocked(model.setValue) : null;
        setValueMock?.mockClear();
        vi.mocked(editor.updateOptions).mockClear();

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: typedTab,
                    fileTabs: [typedTab],
                }),
            );
        });
        await flushEffects();

        expect(monacoHarness.editorPropSnapshots.at(-1)).toEqual(
            expect.objectContaining({
                defaultValue: typedTab.draftContent,
                value: undefined,
            }),
        );
        expect(setValueMock).not.toHaveBeenCalled();
        expect(editor?.updateOptions).not.toHaveBeenCalled();
        expect(editor?.createDecorationsCollection).not.toHaveBeenCalled();
        expect(editor?.deltaDecorations).not.toHaveBeenCalled();

        await waitForGitGutterLiveDiff();

        expect(setValueMock).not.toHaveBeenCalled();
        expect(editor?.updateOptions).not.toHaveBeenCalled();
        expect(editor?.createDecorationsCollection).not.toHaveBeenCalled();
        expect(editor?.deltaDecorations).toHaveBeenCalledTimes(1);
        expect(editor?.deltaDecorations).toHaveBeenCalledWith([], [
            {
                options: {
                    description: "git-gutter-decoration",
                    isWholeLine: true,
                    linesDecorationsClassName: "git-diff-glyph git-diff-added",
                },
                range: {
                    endColumn: 1,
                    endLineNumber: 2,
                    startColumn: 1,
                    startLineNumber: 2,
                },
            },
        ]);
        expect(editor?.getModel()?.decorations.size).toBe(2);

        getGitDiff.mockClear();
        getGitOriginalFile.mockClear();
        mockGitStoreState.current.snapshots = {
            "project-1::primary": {
                ...createGitSnapshot(),
                updatedAt: "2026-06-05T00:03:00.000Z",
            },
        };

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: typedTab,
                    fileTabs: [typedTab],
                }),
            );
        });
        await flushEffects();

        expect(getGitDiff).not.toHaveBeenCalled();
        expect(getGitOriginalFile).not.toHaveBeenCalled();
    });

    it("clears git gutter decorations when switching to a clean file in the same editor", async () => {
        const changedTab = createFileTab("file-1", "src/app.ts");
        const cleanTab = createFileTab("file-2", "src/clean.ts");
        const getGitDiff = vi.fn(() => Promise.resolve(createGitDiff()));
        const getGitOriginalFile = vi.fn(() =>
            Promise.resolve(createGitOriginalFile()),
        );
        vi.stubGlobal("comando", { getGitDiff, getGitOriginalFile });
        mockGitStoreState.current.snapshots = {
            "project-1::primary": createGitSnapshot(["src/app.ts"]),
        };

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: changedTab,
                    fileTabs: [changedTab, cleanTab],
                }),
            );
        });
        await flushEffects();
        await flushEffects();

        const editor = monacoHarness.codeEditors[0];
        expect(editor).toBeDefined();
        if (!editor) {
            throw new Error("Expected Monaco editor to mount.");
        }
        const changedModel = editor.getModel();
        expect(changedModel?.decorations.size).toBe(1);
        const initialDecorationIds = [...(changedModel?.decorations.keys() ?? [])];

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: cleanTab,
                    fileTabs: [changedTab, cleanTab],
                }),
            );
        });
        await flushEffects();

        expect(editor.deltaDecorations).toHaveBeenCalledWith(
            initialDecorationIds,
            [],
        );
        expect(changedModel?.decorations.size).toBe(0);
    });

    it("clears stale git gutter decorations before applying the next file diff", async () => {
        const firstTab = createFileTab("file-1", "src/app.ts");
        const secondTab = createFileTab(
            "file-2",
            "src/other.ts",
            ["one", "two", "three", "four", ""].join("\n"),
        );
        const getGitDiff = vi.fn(
            ({ path }: { readonly path: string }) =>
                Promise.resolve(
                    path === "src/other.ts"
                        ? createGitDiff("src/other.ts", 3)
                        : createGitDiff("src/app.ts", 1),
                ),
        );
        const getGitOriginalFile = vi.fn(
            ({ path }: { readonly path: string }) =>
                Promise.resolve(
                    path === "src/other.ts"
                        ? createGitOriginalFile(
                              "src/other.ts",
                              ["one", "two", "old", "four", ""].join("\n"),
                          )
                        : createGitOriginalFile("src/app.ts"),
                ),
        );
        vi.stubGlobal("comando", { getGitDiff, getGitOriginalFile });
        mockGitStoreState.current.snapshots = {
            "project-1::primary": createGitSnapshot([
                "src/app.ts",
                "src/other.ts",
            ]),
        };

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: firstTab,
                    fileTabs: [firstTab, secondTab],
                }),
            );
        });
        await flushEffects();
        await flushEffects();

        const editor = monacoHarness.codeEditors[0];
        expect(editor).toBeDefined();
        if (!editor) {
            throw new Error("Expected Monaco editor to mount.");
        }
        const firstModel = editor.getModel();
        expect(firstModel?.decorations.size).toBe(1);
        const firstDecorationIds = [...(firstModel?.decorations.keys() ?? [])];

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: secondTab,
                    fileTabs: [firstTab, secondTab],
                }),
            );
        });
        await flushEffects();
        await flushEffects();

        expect(editor.deltaDecorations).toHaveBeenCalledWith(
            firstDecorationIds,
            [],
        );
        expect(firstModel?.decorations.size).toBe(0);
        expect(editor.getModel()?.decorations.size).toBe(1);
        expect([...(editor.getModel()?.decorations.values() ?? [])]).toEqual([
            expect.objectContaining({
                range: {
                    endColumn: 1,
                    endLineNumber: 3,
                    startColumn: 1,
                    startLineNumber: 3,
                },
            }),
        ]);
    });

    it("applies a pending file open line before restoring saved view state", async () => {
        const tab = {
            ...createFileTab(
                "file-1",
                "src/app.ts",
                ["one", "two", "three", ""].join("\n"),
            ),
            pendingOpenLocation: {
                endLine: null,
                startLine: 99,
            },
            viewState: {
                contributionsState: {},
                cursorState: [],
                viewState: {
                    firstPosition: {
                        column: 1,
                        lineNumber: 1,
                    },
                    firstPositionDeltaTop: 0,
                    scrollLeft: 0,
                },
            },
        } satisfies RuntimeWorkspaceFileTab;

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: tab,
                    fileTabs: [tab],
                }),
            );
        });
        await flushEffects();

        const editor = monacoHarness.codeEditors[0];
        expect(editor?.setPosition).toHaveBeenCalledWith({
            column: 1,
            lineNumber: 4,
        });
        expect(editor?.revealLineInCenter).toHaveBeenCalledWith(4);
        expect(editor?.restoreViewState).not.toHaveBeenCalled();
        expect(
            mockWorkspaceStoreState.current.updateFilePendingOpenLocation,
        ).toHaveBeenCalledWith("file-1", null);
    });

    it("selects and reveals a pending file open range", async () => {
        const tab = {
            ...createFileTab(
                "file-1",
                "src/app.ts",
                ["alpha", "beta", "gamma", ""].join("\n"),
            ),
            pendingOpenLocation: {
                endLine: 3,
                startLine: 2,
            },
        } satisfies RuntimeWorkspaceFileTab;

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: tab,
                    fileTabs: [tab],
                }),
            );
        });
        await flushEffects();

        const expectedSelection = {
            endColumn: 6,
            endLineNumber: 3,
            selectionStartColumn: 1,
            selectionStartLineNumber: 2,
            startColumn: 1,
            startLineNumber: 2,
        };
        const editor = monacoHarness.codeEditors[0];
        expect(editor?.setSelection).toHaveBeenCalledWith(expectedSelection);
        expect(editor?.revealRangeInCenter).toHaveBeenCalledWith(
            expectedSelection,
        );
        expect(
            mockWorkspaceStoreState.current.updateFilePendingOpenLocation,
        ).toHaveBeenCalledWith("file-1", null);
    });

    it("applies a pending file open location that arrives after mount", async () => {
        const tab = createFileTab(
            "file-1",
            "src/app.ts",
            ["one", "two", "three", ""].join("\n"),
        );

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: tab,
                    fileTabs: [tab],
                }),
            );
        });
        await flushEffects();

        const editor = monacoHarness.codeEditors[0];
        expect(editor?.setPosition).not.toHaveBeenCalledWith({
            column: 1,
            lineNumber: 3,
        });
        mockWorkspaceStoreState.current.updateFilePendingOpenLocation.mockClear();

        const tabWithPendingLocation = {
            ...tab,
            pendingOpenLocation: {
                endLine: null,
                startLine: 3,
            },
        } satisfies RuntimeWorkspaceFileTab;

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: tabWithPendingLocation,
                    fileTabs: [tabWithPendingLocation],
                }),
            );
        });
        await flushEffects();

        expect(editor?.setPosition).toHaveBeenCalledWith({
            column: 1,
            lineNumber: 3,
        });
        expect(editor?.revealLineInCenter).toHaveBeenCalledWith(3);
        expect(
            mockWorkspaceStoreState.current.updateFilePendingOpenLocation,
        ).toHaveBeenCalledWith("file-1", null);
    });

    it("applies a pending file open range to the inline review modified editor", async () => {
        const tab = {
            ...createFileTab("file-1"),
            pendingOpenLocation: {
                endLine: 3,
                startLine: 2,
            },
        } satisfies RuntimeWorkspaceFileTab;
        mockAiStoreState.current.sessions = {
            "session-1": {
                snapshot: {
                    trackedFiles: [createTrackedFileUpdate()],
                },
            },
        };

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: tab,
                    fileTabs: [tab],
                }),
            );
        });
        await flushEffects();

        const normalEditor = monacoHarness.codeEditors.find((editor) =>
            editor.name.startsWith("editor-"),
        );
        const diffEditor = monacoHarness.diffEditors[0];
        expect(diffEditor).toBeDefined();
        if (!diffEditor) {
            throw new Error("Expected inline review diff editor to mount.");
        }

        const modifiedEditor = diffEditor.getModifiedEditor();
        const expectedSelection = {
            endColumn: modifiedEditor.getModel()?.getLineMaxColumn(3) ?? 1,
            endLineNumber: 3,
            selectionStartColumn: 1,
            selectionStartLineNumber: 2,
            startColumn: 1,
            startLineNumber: 2,
        };
        expect(modifiedEditor.setSelection).toHaveBeenCalledWith(
            expectedSelection,
        );
        expect(modifiedEditor.revealRangeInCenter).toHaveBeenCalledWith(
            expectedSelection,
        );
        expect(normalEditor?.setSelection).not.toHaveBeenCalled();
        expect(
            mockWorkspaceStoreState.current.updateFilePendingOpenLocation,
        ).toHaveBeenCalledWith("file-1", null);
    });

    it("preserves the normal editor viewport when new inline review changes arrive", async () => {
        const content = [
            "const first = 1;",
            "const second = 2;",
            "const third = 3;",
            "const fourth = 4;",
            "",
        ].join("\n");
        const updatedContent = [
            "const first = 1;",
            "const second = 22;",
            "const third = 3;",
            "const fourth = 4;",
            "",
        ].join("\n");
        const fileTab = createFileTab("file-1", "src/app.ts", content);

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: fileTab,
                    fileTabs: [fileTab],
                }),
            );
        });
        await flushEffects();

        const normalEditor = monacoHarness.codeEditors.find((editor) =>
            editor.name.startsWith("editor-"),
        );
        expect(normalEditor).toBeDefined();
        if (!normalEditor) {
            throw new Error("Expected normal file editor to mount.");
        }

        normalEditor.setPosition({ column: 7, lineNumber: 3 });
        normalEditor.setScrollLeft(13);
        normalEditor.setScrollTop(360);

        mockAiStoreState.current.sessions = {
            "session-1": {
                snapshot: {
                    trackedFiles: [
                        {
                            ...createTrackedFile(),
                            newText: updatedContent,
                            oldText: content,
                        },
                    ],
                },
            },
        };

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: fileTab,
                    fileTabs: [fileTab],
                }),
            );
        });
        await flushEffects();

        const diffEditor = monacoHarness.diffEditors[0];
        expect(diffEditor).toBeDefined();
        if (!diffEditor) {
            throw new Error("Expected inline review diff editor to mount.");
        }

        const modifiedEditor = diffEditor.getModifiedEditor();
        expect(modifiedEditor.getPosition()).toEqual({
            column: 7,
            lineNumber: 3,
        });
        expect(modifiedEditor.getScrollLeft()).toBe(13);
        expect(modifiedEditor.getScrollTop()).toBe(360);
        expect(diffEditor.getOriginalEditor().getScrollLeft()).toBe(13);
        expect(diffEditor.getOriginalEditor().getScrollTop()).toBe(360);
    });

    it("applies a pending file open range that arrives after inline review mounts", async () => {
        const tab = createFileTab("file-1");
        mockAiStoreState.current.sessions = {
            "session-1": {
                snapshot: {
                    trackedFiles: [createTrackedFileUpdate()],
                },
            },
        };

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: tab,
                    fileTabs: [tab],
                }),
            );
        });
        await flushEffects();

        const diffEditor = monacoHarness.diffEditors[0];
        expect(diffEditor).toBeDefined();
        if (!diffEditor) {
            throw new Error("Expected inline review diff editor to mount.");
        }
        const modifiedEditor = diffEditor.getModifiedEditor();
        vi.mocked(modifiedEditor.setSelection).mockClear();
        vi.mocked(modifiedEditor.revealRangeInCenter).mockClear();
        mockWorkspaceStoreState.current.updateFilePendingOpenLocation.mockClear();

        const tabWithPendingLocation = {
            ...tab,
            pendingOpenLocation: {
                endLine: 3,
                startLine: 2,
            },
        } satisfies RuntimeWorkspaceFileTab;

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: tabWithPendingLocation,
                    fileTabs: [tabWithPendingLocation],
                }),
            );
        });
        await flushEffects();

        const expectedSelection = {
            endColumn: modifiedEditor.getModel()?.getLineMaxColumn(3) ?? 1,
            endLineNumber: 3,
            selectionStartColumn: 1,
            selectionStartLineNumber: 2,
            startColumn: 1,
            startLineNumber: 2,
        };
        expect(modifiedEditor.setSelection).toHaveBeenCalledWith(
            expectedSelection,
        );
        expect(modifiedEditor.revealRangeInCenter).toHaveBeenCalledWith(
            expectedSelection,
        );
        expect(
            mockWorkspaceStoreState.current.updateFilePendingOpenLocation,
        ).toHaveBeenCalledWith("file-1", null);
    });

    it("mounts inline review diff models without unmounting the normal file editor", async () => {
        const fileTab = createFileTab("file-1");
        mockAiStoreState.current.sessions = {
            "session-1": {
                snapshot: {
                    trackedFiles: [createTrackedFile()],
                },
            },
        };

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: fileTab,
                    fileTabs: [fileTab],
                }),
            );
        });
        await flushEffects();

        const normalEditor = monacoHarness.codeEditors.find((editor) =>
            editor.name.startsWith("editor-"),
        );
        const diffEditor = monacoHarness.diffEditors[0];
        expect(normalEditor).toBeDefined();
        expect(diffEditor).toBeDefined();
        expect(diffEditor?.originalModel?.getValue()).toBe(
            "const value = 1;\n",
        );
        expect(diffEditor?.modifiedModel?.getValue()).toBe(
            "const value = 2;\n",
        );

        mockAiStoreState.current.sessions = {};
        act(() => {
            root.render(
                renderHost({
                    activeFileTab: fileTab,
                    fileTabs: [fileTab],
                }),
            );
        });
        await flushEffects();

        expect(normalEditor?.disposed).toBe(false);
        expect(diffEditor?.disposed).toBe(true);
    });

    it("sends inline review file targets with identity and version", async () => {
        const fileTab = createFileTab("file-1");
        const trackedFile = createTrackedFile();
        mockAiStoreState.current.sessions = {
            "session-1": {
                snapshot: {
                    trackedFiles: [trackedFile],
                },
            },
        };

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: fileTab,
                    fileTabs: [fileTab],
                }),
            );
        });
        await flushEffects();

        const keepButton = [...container.querySelectorAll("button")].find(
            (button) => button.textContent?.includes("keep all"),
        );
        expect(keepButton).toBeDefined();
        act(() => {
            keepButton?.dispatchEvent(
                new MouseEvent("click", { bubbles: true }),
            );
        });

        expect(mockAiStoreState.current.keepTrackedFile).toHaveBeenCalledWith({
            expectedVersion: 2,
            path: "src/app.ts",
            sessionId: "session-1",
            trackedFileId: "tracked:src/app.ts",
        });
    });

    it("reinstalls inline review models when a hidden file tab resumes with shell models", async () => {
        const fileTab = createFileTab("file-1");
        mockAiStoreState.current.sessions = {
            "session-1": {
                snapshot: {
                    trackedFiles: [createTrackedFile()],
                },
            },
        };

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: fileTab,
                    fileTabs: [fileTab],
                }),
            );
        });
        await flushEffects();

        const diffEditor = monacoHarness.diffEditors[0];
        expect(diffEditor).toBeDefined();
        if (!diffEditor) {
            throw new Error("Expected inline review diff editor to mount.");
        }

        expect(diffEditor.originalModel?.getValue()).toBe("const value = 1;\n");
        expect(diffEditor.modifiedModel?.getValue()).toBe("const value = 2;\n");

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: null,
                    fileTabs: [fileTab],
                    recentActiveTabIds: ["file-1"],
                }),
            );
        });
        await flushEffects();

        const shellOriginalModel = monacoHarness.monaco.editor.createModel(
            "",
            "typescript",
            monacoHarness.monaco.Uri.parse(
                "inmemory://inline-review-shell-original",
            ),
        );
        const shellModifiedModel = monacoHarness.monaco.editor.createModel(
            "",
            "typescript",
            monacoHarness.monaco.Uri.parse(
                "inmemory://inline-review-shell-modified",
            ),
        );
        diffEditor.setModel({
            modified: shellModifiedModel,
            original: shellOriginalModel,
        });

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: fileTab,
                    fileTabs: [fileTab],
                    recentActiveTabIds: ["file-1"],
                }),
            );
        });
        await flushEffects();

        expect(diffEditor.disposed).toBe(false);
        expect(diffEditor.originalModel?.getValue()).toBe("const value = 1;\n");
        expect(diffEditor.modifiedModel?.getValue()).toBe("const value = 2;\n");
    });

    it("preserves inline review viewport when the agent updates the same file", async () => {
        const fileTab = createFileTab("file-1");
        mockAiStoreState.current.sessions = {
            "session-1": {
                snapshot: {
                    trackedFiles: [createTrackedFile()],
                },
            },
        };

        act(() => {
            root.render(
                renderHost({
                    activeFileTab: fileTab,
                    fileTabs: [fileTab],
                }),
            );
        });
        await flushEffects();

        const diffEditor = monacoHarness.diffEditors[0];
        expect(diffEditor).toBeDefined();
        if (!diffEditor) {
            throw new Error("Expected inline review diff editor to mount.");
        }

        const modifiedEditor = diffEditor.getModifiedEditor();
        modifiedEditor.setPosition({ column: 7, lineNumber: 2 });
        modifiedEditor.setScrollLeft(11);
        modifiedEditor.setScrollTop(240);
        diffEditor.getOriginalEditor().setScrollLeft(5);
        diffEditor.getOriginalEditor().setScrollTop(200);

        mockAiStoreState.current.sessions = {
            "session-1": {
                snapshot: {
                    trackedFiles: [createTrackedFileUpdate()],
                },
            },
        };
        act(() => {
            root.render(
                renderHost({
                    activeFileTab: fileTab,
                    fileTabs: [fileTab],
                }),
            );
        });
        await flushEffects();

        expect(diffEditor.disposed).toBe(false);
        expect(diffEditor.modifiedModel?.getValue()).toBe(
            "const value = 2;\nconst nextValue = 3;\nconst finalValue = 4;\n",
        );
        expect(modifiedEditor.getPosition()).toEqual({
            column: 7,
            lineNumber: 2,
        });
        expect(modifiedEditor.getScrollLeft()).toBe(11);
        expect(modifiedEditor.getScrollTop()).toBe(240);
        expect(diffEditor.getOriginalEditor().getScrollLeft()).toBe(11);
        expect(diffEditor.getOriginalEditor().getScrollTop()).toBe(240);
    });
});
