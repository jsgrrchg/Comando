import { describe, expect, it } from "vitest";

import { resolveMonacoLanguageId } from "./monacoLanguage";

describe("resolveMonacoLanguageId", () => {
    it("maps TSX to the canonical Monaco TypeScript id", () => {
        expect(resolveMonacoLanguageId("tsx")).toBe("typescript");
    });

    it("maps JSX to the canonical Monaco JavaScript id", () => {
        expect(resolveMonacoLanguageId("jsx")).toBe("javascript");
    });

    it("keeps canonical Monaco ids unchanged", () => {
        expect(resolveMonacoLanguageId("typescript")).toBe("typescript");
        expect(resolveMonacoLanguageId("javascript")).toBe("javascript");
    });
});
