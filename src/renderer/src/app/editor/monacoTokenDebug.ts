import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

import { MONACO_TYPESCRIPT_SEMANTIC_TOKEN_AUDIT } from "./monacoSemanticTokens";

interface SyntaxTokenDebugToken {
    readonly containsCursor: boolean;
    readonly endColumn: number;
    readonly index: number;
    readonly language: string;
    readonly startColumn: number;
    readonly text: string;
    readonly type: string;
}

interface SyntaxTokenDebugSnapshot {
    readonly column: number;
    readonly languageId: string;
    readonly lineContent: string;
    readonly lineNumber: number;
    readonly tokens: readonly SyntaxTokenDebugToken[];
}

interface SyntaxTokenDebugStore {
    readonly snapshots: SyntaxTokenDebugSnapshot[];
}

type Disposable = {
    dispose(): void;
};

type MonacoToken = {
    readonly language: string;
    readonly offset: number;
    readonly type: string;
};

function isSyntaxTokenDebugAvailable(): boolean {
    return import.meta.env.DEV && typeof window !== "undefined";
}

function getSyntaxTokenDebugStore(): SyntaxTokenDebugStore {
    const root = globalThis as typeof globalThis & {
        __COMANDO_SYNTAX_TOKEN_DEBUG__?: SyntaxTokenDebugStore;
        __comandoSyntaxTokenDebugDump?: () => SyntaxTokenDebugStore;
        __comandoSyntaxTokenDebugReset?: () => void;
        __comandoSemanticTokenAuditDump?: () => typeof MONACO_TYPESCRIPT_SEMANTIC_TOKEN_AUDIT;
    };

    if (!root.__COMANDO_SYNTAX_TOKEN_DEBUG__) {
        root.__COMANDO_SYNTAX_TOKEN_DEBUG__ = {
            snapshots: [],
        };
        root.__comandoSyntaxTokenDebugDump = () =>
            root.__COMANDO_SYNTAX_TOKEN_DEBUG__!;
        root.__comandoSyntaxTokenDebugReset = () => {
            if (!root.__COMANDO_SYNTAX_TOKEN_DEBUG__) {
                return;
            }

            root.__COMANDO_SYNTAX_TOKEN_DEBUG__.snapshots.length = 0;
        };
        root.__comandoSemanticTokenAuditDump = () =>
            MONACO_TYPESCRIPT_SEMANTIC_TOKEN_AUDIT;
    }

    return root.__COMANDO_SYNTAX_TOKEN_DEBUG__;
}

function buildSyntaxTokenDebugSnapshot(
    editor: MonacoEditor.IStandaloneCodeEditor,
): SyntaxTokenDebugSnapshot | null {
    const model = editor.getModel();
    const position = editor.getPosition();

    if (!model || !position) {
        return null;
    }

    const lineContent = model.getLineContent(position.lineNumber);
    const languageId = model.getLanguageId();
    const cursorOffset = Math.max(0, position.column - 1);
    const tokens = (monaco.editor.tokenize(lineContent, languageId)[0] ??
        []) as readonly MonacoToken[];

    return {
        column: position.column,
        languageId,
        lineContent,
        lineNumber: position.lineNumber,
        tokens: tokens.map((token, index) => {
            const nextToken = tokens[index + 1];
            const endOffset = nextToken?.offset ?? lineContent.length;
            const startColumn = token.offset + 1;
            const endColumn = endOffset + 1;

            return {
                containsCursor:
                    token.offset <= cursorOffset && cursorOffset < endOffset,
                endColumn,
                index,
                language: token.language,
                startColumn,
                text: lineContent.slice(token.offset, endOffset),
                type: token.type,
            };
        }),
    };
}

function publishSyntaxTokenDebugSnapshot(snapshot: SyntaxTokenDebugSnapshot) {
    const store = getSyntaxTokenDebugStore();

    store.snapshots.push(snapshot);
    if (store.snapshots.length > 100) {
        store.snapshots.splice(0, store.snapshots.length - 100);
    }

    console.groupCollapsed(
        `[syntax-token-debug] ${snapshot.languageId}:${snapshot.lineNumber}:${snapshot.column}`,
    );
    console.log(snapshot.lineContent);
    console.table(snapshot.tokens);
    console.groupEnd();
}

export function inspectMonacoTokensAtCursor(
    editor: MonacoEditor.IStandaloneCodeEditor,
): SyntaxTokenDebugSnapshot | null {
    return buildSyntaxTokenDebugSnapshot(editor);
}

export function installMonacoTokenDebugAction(
    editor: MonacoEditor.IStandaloneCodeEditor,
): Disposable | null {
    if (!isSyntaxTokenDebugAvailable()) {
        return null;
    }

    const syntaxTokenAction = editor.addAction({
        id: "comando.debugSyntaxTokensAtCursor",
        keybindings: [
            monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyT,
        ],
        label: "Comando: Debug Syntax Tokens At Cursor",
        run: () => {
            const snapshot = buildSyntaxTokenDebugSnapshot(editor);

            if (snapshot) {
                publishSyntaxTokenDebugSnapshot(snapshot);
            }
        },
    });
    const semanticAuditAction = editor.addAction({
        id: "comando.debugSemanticTokenAudit",
        label: "Comando: Debug Semantic Token Audit",
        run: () => {
            console.groupCollapsed("[semantic-token-audit]");
            console.log(MONACO_TYPESCRIPT_SEMANTIC_TOKEN_AUDIT);
            console.groupEnd();
        },
    });

    return {
        dispose() {
            syntaxTokenAction.dispose();
            semanticAuditAction.dispose();
        },
    };
}
