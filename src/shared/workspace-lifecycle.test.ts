import { describe, expect, it } from "vitest";

import {
    createWorkspaceActivationState,
    isWorkspaceSurfaceTransitionAllowed,
    reduceWorkspaceActivation,
} from "./workspace-lifecycle";

describe("workspace activation contract", () => {
    it("keeps the previous scope committed until the target is ready", () => {
        const idle = createWorkspaceActivationState("project-a::__primary__");
        const warming = reduceWorkspaceActivation(idle, {
            generation: 1,
            targetScopeKey: "project-a::feature",
            type: "begin",
        });
        const ready = reduceWorkspaceActivation(warming, {
            generation: 1,
            targetScopeKey: "project-a::feature",
            type: "surface-ready",
        });

        expect(warming).toMatchObject({
            committedScopeKey: "project-a::__primary__",
            phase: "warming",
        });
        expect(ready).toMatchObject({
            committedScopeKey: "project-a::__primary__",
            phase: "ready",
        });
        expect(
            reduceWorkspaceActivation(ready, {
                generation: 1,
                targetScopeKey: "project-a::feature",
                type: "commit",
            }),
        ).toEqual({
            committedScopeKey: "project-a::feature",
            generation: 1,
            phase: "idle",
            targetScopeKey: null,
        });
    });

    it("rejects stale readiness and failures without changing the committed scope", () => {
        const first = reduceWorkspaceActivation(
            createWorkspaceActivationState("project-a::__primary__"),
            {
                generation: 1,
                targetScopeKey: "project-a::feature-a",
                type: "begin",
            },
        );
        const second = reduceWorkspaceActivation(first, {
            generation: 2,
            targetScopeKey: "project-a::feature-b",
            type: "begin",
        });

        expect(
            reduceWorkspaceActivation(second, {
                generation: 1,
                targetScopeKey: "project-a::feature-a",
                type: "surface-ready",
            }),
        ).toBe(second);
        expect(
            reduceWorkspaceActivation(second, {
                errorCode: "stale-error",
                generation: 1,
                targetScopeKey: "project-a::feature-a",
                type: "fail",
            }),
        ).toBe(second);
    });

    it("rolls a failed activation back to the previous committed scope", () => {
        const warming = reduceWorkspaceActivation(
            createWorkspaceActivationState("project-a::__primary__"),
            {
                generation: 3,
                targetScopeKey: "project-a::feature",
                type: "begin",
            },
        );
        const failed = reduceWorkspaceActivation(warming, {
            errorCode: "surface-load-failed",
            generation: 3,
            targetScopeKey: "project-a::feature",
            type: "fail",
        });

        expect(failed).toMatchObject({
            committedScopeKey: "project-a::__primary__",
            errorCode: "surface-load-failed",
            phase: "failed",
        });
        expect(
            reduceWorkspaceActivation(failed, { type: "clear-failure" }),
        ).toMatchObject({
            committedScopeKey: "project-a::__primary__",
            phase: "idle",
        });
    });
});

describe("workspace surface lifecycle contract", () => {
    it("allows the normal warm and cold lifecycle", () => {
        expect(isWorkspaceSurfaceTransitionAllowed("cold", "warming")).toBe(true);
        expect(isWorkspaceSurfaceTransitionAllowed("warming", "active")).toBe(true);
        expect(isWorkspaceSurfaceTransitionAllowed("active", "warm")).toBe(true);
        expect(isWorkspaceSurfaceTransitionAllowed("warm", "active")).toBe(true);
        expect(isWorkspaceSurfaceTransitionAllowed("warm", "suspending")).toBe(true);
        expect(isWorkspaceSurfaceTransitionAllowed("suspending", "cold")).toBe(true);
    });

    it("allows rollback after a blocked hibernation and forbids unsafe shortcuts", () => {
        expect(isWorkspaceSurfaceTransitionAllowed("suspending", "warm")).toBe(true);
        expect(isWorkspaceSurfaceTransitionAllowed("active", "cold")).toBe(false);
        expect(isWorkspaceSurfaceTransitionAllowed("warm", "cold")).toBe(false);
        expect(isWorkspaceSurfaceTransitionAllowed("disposing", "active")).toBe(false);
    });
});
