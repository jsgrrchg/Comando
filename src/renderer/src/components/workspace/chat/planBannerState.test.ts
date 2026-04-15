import { describe, expect, it } from "vitest";

import type { AiPlan } from "@shared/ipc";

import { hasActivePlanEntries, shouldShowPlanBanner } from "./planBannerState";

function createPlan(overrides: Partial<AiPlan> = {}): AiPlan {
    return {
        entries: [
            {
                content: "Inspect current behavior",
                priority: "medium",
                status: "in_progress",
            },
        ],
        updatedAt: "2026-04-15T12:00:00.000Z",
        ...overrides,
    };
}

describe("planBannerState", () => {
    it("treats incomplete plans as active", () => {
        expect(hasActivePlanEntries(createPlan())).toBe(true);
    });

    it("hides banners for completed plans", () => {
        const plan = createPlan({
            entries: [
                {
                    content: "Done",
                    priority: "medium",
                    status: "completed",
                },
            ],
        });

        expect(hasActivePlanEntries(plan)).toBe(false);
        expect(shouldShowPlanBanner(plan, null)).toBe(false);
    });

    it("hides banners for empty plans", () => {
        expect(shouldShowPlanBanner(createPlan({ entries: [] }), null)).toBe(
            false,
        );
    });

    it("keeps the current plan hidden after dismissal until it changes", () => {
        const plan = createPlan();

        expect(shouldShowPlanBanner(plan, plan.updatedAt)).toBe(false);
        expect(
            shouldShowPlanBanner(plan, "2026-04-15T11:59:59.000Z"),
        ).toBe(true);
    });
});
