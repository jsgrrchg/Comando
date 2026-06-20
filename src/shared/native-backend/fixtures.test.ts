import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    NATIVE_COMMANDS,
    NATIVE_EVENTS,
    nativeAiEventToIpc,
    nativeAiRuntimeStatusToIpc,
    nativeGitInvalidationToIpc,
    nativeProjectSummaryToIpc,
    nativeTerminalDataEventToIpc,
    parseNativeBackendCapabilitiesOutput,
    parseNativeBackendOutput,
} from ".";
import type { NativeAiRuntimeStatus } from "./ai";
import type { NativeGitRepositorySnapshot } from "./git";
import type { NativeProjectSummary, NativeProjectTreeEntry } from "./projects";
import type { NativeTerminalDataEvent } from "./terminal";

const fixtureRoot = path.join(process.cwd(), "fixtures", "native-backend");

describe("native backend fixtures", () => {
    it("parses protocol envelope fixtures", () => {
        const request = fixture<Record<string, unknown>>(
            "protocol/request.backend_ping.json",
        );
        expect(request).toMatchObject({
            command: "backend_ping",
            id: "req_1",
            meta: { protocolVersion: 1 },
        });

        expect(
            parseNativeBackendOutput(
                fixture("protocol/response.backend_ping.json"),
            ),
        ).toMatchObject({
            id: "req_1",
            ok: true,
            type: "response",
        });

        expect(
            parseNativeBackendOutput(
                fixture("protocol/response.error.unknown_command.json"),
            ),
        ).toMatchObject({
            error: { code: "unknown_command", retryable: false },
            ok: false,
            type: "response",
        });

        expect(
            parseNativeBackendOutput(fixture("protocol/event.backend_test.json")),
        ).toMatchObject({
            eventName: "backend://test-event",
            type: "event",
        });
    });

    it("keeps TS registries aligned with shared fixtures", () => {
        expect([...NATIVE_COMMANDS]).toEqual(
            fixture("protocol/registry.commands.json"),
        );
        expect([...NATIVE_EVENTS]).toEqual(fixture("protocol/registry.events.json"));
    });

    it("parses capabilities v1", () => {
        const capabilities = parseNativeBackendCapabilitiesOutput(
            fixture("protocol/capabilities.v1.json"),
        );

        expect(capabilities.protocolVersion).toBe(1);
        expect(capabilities.capabilities.commands).toContain("backend_handshake");
        expect(capabilities.capabilities.events).toContain("ai://message-delta");
    });

    it("accepts AI fixtures and adapts small event payloads", () => {
        const messageEvent = parseNativeBackendOutput(
            fixture("ai/event.message_delta.json"),
        );
        expect(messageEvent.type).toBe("event");
        if (messageEvent.type !== "event") {
            throw new Error("expected event");
        }

        expect(nativeAiEventToIpc(messageEvent)).toMatchObject({
            content: "Hello",
            kind: "message-delta",
            messageId: "message_1",
        });

        const toolEvent = parseNativeBackendOutput(
            fixture("ai/event.tool_activity.json"),
        );
        expect(toolEvent.type).toBe("event");
        if (toolEvent.type !== "event") {
            throw new Error("expected event");
        }

        expect(nativeAiEventToIpc(toolEvent)).toMatchObject({
            activity: {
                id: "tool_1",
                status: "completed",
                title: "Read file",
            },
            kind: "tool-activity",
        });
    });

    it("adapts native runtime status to current IPC status shape", () => {
        const status: NativeAiRuntimeStatus = {
            authMethod: "chatgpt",
            authMethods: [{ description: "ChatGPT login", id: "chatgpt", name: "ChatGPT" }],
            authReady: true,
            checkedAt: "2026-06-20T00:00:00.000Z",
            command: "codex",
            hasCustomBinaryPath: false,
            hasGatewayConfig: false,
            hasGatewayUrl: false,
            message: null,
            onboardingRequired: false,
            runtimeId: "codex",
            source: "bundled",
            state: "ready",
        };

        expect(nativeAiRuntimeStatusToIpc(status)).toMatchObject({
            authReady: true,
            runtimeId: "codex",
            state: "ready",
        });
    });

    it("accepts project and git fixtures", () => {
        const project = fixture<NativeProjectSummary>(
            "projects/project.summary.json",
        );
        expect(nativeProjectSummaryToIpc(project)).toMatchObject({
            id: "project_1",
            rootPath: "/tmp/comando-project",
        });

        const treeEntry = fixture<NativeProjectTreeEntry>(
            "projects/project.tree_entry.json",
        );
        expect(treeEntry).toMatchObject({
            kind: "file",
            relativePath: "src/main.ts",
        });

        const snapshot = fixture<NativeGitRepositorySnapshot>(
            "git/repository.snapshot.json",
        );
        expect(snapshot.status.changedCount).toBe(1);

        expect(
            nativeGitInvalidationToIpc({
                occurredAt: "2026-06-20T00:00:00.000Z",
                projectId: "project_1",
                reason: "status",
                rootPath: "/tmp/comando-project",
                worktreeId: "worktree_1",
            }),
        ).toMatchObject({ reason: "status", worktreeId: "worktree_1" });
    });

    it("accepts terminal fixtures and adapters", () => {
        const event = fixture<NativeTerminalDataEvent>(
            "terminal/terminal.data_event.json",
        );

        expect(nativeTerminalDataEventToIpc(event)).toEqual({
            data: "ready\n",
            sessionId: "terminal_1",
        });
    });
});

function fixture<T = unknown>(relativePath: string): T {
    return JSON.parse(
        readFileSync(path.join(fixtureRoot, relativePath), "utf8"),
    ) as T;
}
