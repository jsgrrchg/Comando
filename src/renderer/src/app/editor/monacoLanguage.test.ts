import { describe, expect, it } from "vitest";

import {
    isTypeScriptWorkerLanguageId,
    resolveMonacoLanguageId,
} from "./monacoLanguage";

describe("resolveMonacoLanguageId", () => {
    it("maps TSX to the dedicated Monaco TypeScript React id", () => {
        expect(resolveMonacoLanguageId("tsx")).toBe("typescriptreact");
    });

    it("maps JSX to the dedicated Monaco JavaScript React id", () => {
        expect(resolveMonacoLanguageId("jsx")).toBe("javascriptreact");
    });

    it("keeps canonical Monaco ids unchanged", () => {
        expect(resolveMonacoLanguageId("typescript")).toBe("typescript");
        expect(resolveMonacoLanguageId("typescriptreact")).toBe(
            "typescriptreact",
        );
        expect(resolveMonacoLanguageId("javascript")).toBe("javascript");
        expect(resolveMonacoLanguageId("javascriptreact")).toBe(
            "javascriptreact",
        );
    });
});

describe("isTypeScriptWorkerLanguageId", () => {
    it("routes TS, TSX, JS, and JSX Monaco ids to the TypeScript worker", () => {
        expect(isTypeScriptWorkerLanguageId("typescript")).toBe(true);
        expect(isTypeScriptWorkerLanguageId("typescriptreact")).toBe(true);
        expect(isTypeScriptWorkerLanguageId("javascript")).toBe(true);
        expect(isTypeScriptWorkerLanguageId("javascriptreact")).toBe(true);
        expect(isTypeScriptWorkerLanguageId("json")).toBe(false);
    });
});
