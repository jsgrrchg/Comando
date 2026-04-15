import type { AiPlan } from "@shared/ipc";

export function hasActivePlanEntries(plan: AiPlan | null): boolean {
    if (!plan || plan.entries.length === 0) {
        return false;
    }

    return plan.entries.some((entry) => entry.status !== "completed");
}

export function shouldShowPlanBanner(
    plan: AiPlan | null,
    dismissedPlanUpdatedAt: string | null,
): plan is AiPlan {
    if (plan == null || !hasActivePlanEntries(plan)) {
        return false;
    }

    return plan.updatedAt !== dismissedPlanUpdatedAt;
}
