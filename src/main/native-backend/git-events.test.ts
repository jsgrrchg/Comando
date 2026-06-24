import { describe, expect, it } from "vitest";

import type { NativeBackendEvent } from "./protocol";
import { nativeGitEventToIpcInvalidation } from "./git-events";

describe("nativeGitEventToIpcInvalidation", () => {
    it("adapts repository invalidation events to IPC payloads", () => {
        const event: NativeBackendEvent = {
            eventName: "git://repository-invalidated",
            payload: {
                occurredAt: "2026-06-24T12:00:00.000Z",
                projectId: "project_1",
                reason: "branch",
                rootPath: "/tmp/project",
                worktreeId: "project_1:primary",
            },
            type: "event",
        };

        expect(nativeGitEventToIpcInvalidation(event)).toEqual({
            occurredAt: "2026-06-24T12:00:00.000Z",
            projectId: "project_1",
            reason: "branch",
            rootPath: "/tmp/project",
            worktreeId: "project_1:primary",
        });
    });

    it("ignores non Git invalidation events", () => {
        expect(
            nativeGitEventToIpcInvalidation({
                eventName: "backend://ready",
                payload: {},
                type: "event",
            }),
        ).toBeNull();
    });
});
