import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
const monacoGlobal = globalThis;
if (!monacoGlobal.__comandoMonacoConfigured) {
    monacoGlobal.MonacoEnvironment = {
        getWorker: (_moduleId, label) => {
            if (label === "json") {
                return new jsonWorker();
            }
            if (label === "css" || label === "scss" || label === "less") {
                return new cssWorker();
            }
            if (label === "html" || label === "handlebars" || label === "razor") {
                return new htmlWorker();
            }
            if (label === "typescript" || label === "javascript") {
                return new tsWorker();
            }
            return new editorWorker();
        },
    };
    loader.config({ monaco });
    monacoGlobal.__comandoMonacoConfigured = true;
}
