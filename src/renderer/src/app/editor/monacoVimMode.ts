import type { editor as MonacoEditor } from "monaco-editor";

export type VimModeDisposable = {
    readonly dispose: () => void;
};

export function enableMonacoVimMode(input: {
    readonly editor: MonacoEditor.IStandaloneCodeEditor;
    readonly statusNode: HTMLElement | null;
}): VimModeDisposable {
    const statusNode = input.statusNode;
    if (statusNode) {
        statusNode.textContent = "";
    }

    let disposed = false;
    let vimMode: VimModeDisposable | null = null;

    void import("monaco-vim")
        .then(({ initVimMode }) => {
            if (disposed) {
                return;
            }

            const loadedVimMode = initVimMode(input.editor, statusNode);
            if (disposed) {
                loadedVimMode.dispose();
                return;
            }

            vimMode = loadedVimMode;
        })
        .catch(() => {
            if (statusNode) {
                statusNode.textContent = "";
                statusNode.style.display = "none";
            }
        });

    return {
        dispose: () => {
            disposed = true;
            vimMode?.dispose();
            vimMode = null;
            if (statusNode) {
                statusNode.textContent = "";
                statusNode.style.display = "none";
            }
        },
    };
}
