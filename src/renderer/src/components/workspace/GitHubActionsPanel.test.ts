import { describe, expect, it } from "vitest";

import { getChecksSummaryPresentation } from "./GitHubActionsPanel";

describe("getChecksSummaryPresentation", () => {
    it("summarizes successful checks before exposing workflow details", () => {
        expect(getChecksSummaryPresentation("success", 13)).toEqual({
            detail: "13 successful checks",
            title: "All checks have passed",
            tone: "success",
        });
    });

    it("gives failures and pending checks distinct readable summaries", () => {
        expect(getChecksSummaryPresentation("failure", 8)).toEqual({
            detail: "8 checks",
            title: "Some checks have failed",
            tone: "failure",
        });
        expect(getChecksSummaryPresentation("pending", 1)).toEqual({
            detail: "1 check",
            title: "Checks are still running",
            tone: "pending",
        });
    });
});
