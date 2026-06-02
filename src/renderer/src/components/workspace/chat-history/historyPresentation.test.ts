import { describe, expect, it } from "vitest";

import { getHistoryRuntimeLabel } from "./historyPresentation";

describe("getHistoryRuntimeLabel", () => {
    it("returns the Grok runtime label", () => {
        expect(getHistoryRuntimeLabel("grok")).toBe("Grok");
    });
});
