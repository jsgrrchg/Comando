import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AiPlan } from "@shared/ipc";

import { PlanMessage } from "./PlanMessage";

function createPlan(overrides: Partial<AiPlan> = {}): AiPlan {
    return {
        entries: [
            {
                content: "Inspect current behavior",
                priority: "medium",
                status: "completed",
            },
            {
                content: "Adjust banner visibility",
                priority: "medium",
                status: "in_progress",
            },
        ],
        title: null,
        updatedAt: "2026-04-15T12:00:00.000Z",
        ...overrides,
    };
}

describe("PlanMessage", () => {
    it("renders a dismiss button when the banner can be closed", () => {
        const markup = renderToStaticMarkup(
            createElement(PlanMessage, {
                onDismiss: () => {},
                plan: createPlan(),
            }),
        );

        expect(markup).toContain("Dismiss plan banner");
        expect(markup).toContain("Adjust banner visibility");
    });

    it("renders the plan title when one is available", () => {
        const markup = renderToStaticMarkup(
            createElement(PlanMessage, {
                plan: createPlan({
                    title: "Restore ACP event bridge",
                }),
            }),
        );

        expect(markup).toContain("Restore ACP event bridge");
    });

    it("does not render dismiss controls when no dismiss handler is provided", () => {
        const markup = renderToStaticMarkup(
            createElement(PlanMessage, {
                plan: createPlan(),
            }),
        );

        expect(markup).not.toContain("Dismiss plan banner");
    });

    it("hides plan entries when controlled as collapsed", () => {
        const markup = renderToStaticMarkup(
            createElement(PlanMessage, {
                expanded: false,
                plan: createPlan(),
            }),
        );

        expect(markup).not.toContain("Inspect current behavior");
        expect(markup).toContain('aria-expanded="false"');
    });
});
