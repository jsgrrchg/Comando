#!/usr/bin/env node

import { createInterface } from "node:readline";
import process from "node:process";

const sessions = new Map();
const pendingPermissionPrompts = new Map();
const pendingCancelledPrompts = new Map();

const send = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const respond = (request, result) => {
    send({ id: request.id, jsonrpc: "2.0", result });
};

const update = (sessionId, sessionUpdate) => {
    send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: sessionUpdate },
    });
};

const finishPrompt = (request, stopReason = "end_turn") => {
    respond(request, { stopReason });
};

const emitStorm = (sessionId, request) => {
    for (let index = 0; index < 1000; index += 1) {
        update(sessionId, {
            content: { text: `delta-${index};`, type: "text" },
            messageId: "fixture-storm-message",
            sessionUpdate: "agent_message_chunk",
        });
    }
    for (let index = 0; index < 500; index += 1) {
        const toolCallId = `fixture-storm-tool-${index}`;
        update(sessionId, {
            kind: "execute",
            rawInput: { command: `echo ${index}` },
            sessionUpdate: "tool_call",
            status: "pending",
            title: `Storm tool ${index}`,
            toolCallId,
        });
        update(sessionId, {
            rawOutput: { output: `tool-${index}` },
            sessionUpdate: "tool_call_update",
            status: "completed",
            toolCallId,
        });
    }
    const permissionId = `fixture-storm-permission-${request.id}`;
    pendingPermissionPrompts.set(permissionId, request);
    send({
        id: permissionId,
        jsonrpc: "2.0",
        method: "session/request_permission",
        params: {
            options: [
                {
                    kind: "allow_once",
                    name: "Finish storm",
                    optionId: "allow",
                },
            ],
            sessionId,
        },
    });
};

const handlePrompt = (request) => {
    const { prompt, sessionId } = request.params;
    const session = sessions.get(sessionId);
    if (!session) {
        send({
            error: { code: -32602, message: "Unknown fixture session" },
            id: request.id,
            jsonrpc: "2.0",
        });
        return;
    }

    const text = prompt
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ");
    if (text.includes("wait for cancellation")) {
        pendingCancelledPrompts.set(sessionId, request);
        return;
    }
    if (text.includes("phase6:storm")) {
        emitStorm(sessionId, request);
        return;
    }

    const receivedImage = prompt.some((block) => block.type === "image");
    update(sessionId, {
        availableCommands: [
            {
                description: "Inspect the fixture workspace",
                name: "inspect",
            },
        ],
        sessionUpdate: "available_commands_update",
    });
    update(sessionId, {
        content: {
            text: `fixture roots: ${session.additionalDirectories.join(",")}; image: ${receivedImage}`,
            type: "text",
        },
        messageId: "fixture-message",
        sessionUpdate: "agent_message_chunk",
    });
    update(sessionId, {
        kind: "read",
        rawInput: { path: "README.md" },
        sessionUpdate: "tool_call",
        status: "pending",
        title: "Read fixture file",
        toolCallId: "fixture-tool",
    });
    update(sessionId, {
        content: [
            {
                content: { text: "fixture output", type: "text" },
                type: "content",
            },
        ],
        rawOutput: { content: "fixture output" },
        sessionUpdate: "tool_call_update",
        status: "completed",
        toolCallId: "fixture-tool",
    });
    update(sessionId, {
        sessionUpdate: "usage_update",
        size: 4096,
        used: 20,
    });

    const permissionId = `fixture-permission-${request.id}`;
    pendingPermissionPrompts.set(permissionId, request);
    send({
        id: permissionId,
        jsonrpc: "2.0",
        method: "session/request_permission",
        params: {
            options: [
                {
                    kind: "allow_once",
                    name: "Allow fixture",
                    optionId: "allow",
                },
                {
                    kind: "reject_once",
                    name: "Reject fixture",
                    optionId: "reject",
                },
            ],
            sessionId,
            toolCall: {
                kind: "edit",
                sessionUpdate: "tool_call",
                status: "pending",
                title: "Fixture permission",
                toolCallId: "fixture-permission-tool",
            },
        },
    });
};

createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
        const pending = pendingPermissionPrompts.get(String(message.id));
        if (pending) {
            pendingPermissionPrompts.delete(String(message.id));
            update(pending.params.sessionId, {
                content: { text: " permission handled", type: "text" },
                messageId: "fixture-message",
                sessionUpdate: "agent_message_chunk",
            });
            finishPrompt(pending);
        }
        return;
    }

    switch (message.method) {
        case "initialize":
            respond(message, {
                agentCapabilities: {
                    loadSession: true,
                    promptCapabilities: {
                        audio: false,
                        embeddedContext: false,
                        image: true,
                    },
                    sessionCapabilities: {
                        additionalDirectories: {},
                        resume: {},
                    },
                },
                agentInfo: {
                    name: "comando-custom-acp-fixture",
                    version: "1.0.0",
                },
                protocolVersion: message.params.protocolVersion,
            });
            break;
        case "session/new": {
            const sessionId = `fixture-session-${message.id}`;
            sessions.set(sessionId, {
                additionalDirectories:
                    message.params.additionalDirectories ?? [],
            });
            respond(message, {
                configOptions: [
                    {
                        category: "model",
                        currentValue: "fixture-model",
                        id: "model",
                        name: "Model",
                        options: [
                            {
                                name: "Fixture model",
                                value: "fixture-model",
                            },
                        ],
                        type: "select",
                    },
                    {
                        category: "mode",
                        currentValue: "fixture-mode",
                        id: "mode",
                        name: "Mode",
                        options: [
                            {
                                name: "Fixture mode",
                                value: "fixture-mode",
                            },
                        ],
                        type: "select",
                    },
                ],
                sessionId,
            });
            break;
        }
        case "session/prompt":
            handlePrompt(message);
            break;
        case "session/cancel": {
            const pending = pendingCancelledPrompts.get(
                message.params.sessionId,
            );
            if (pending) {
                pendingCancelledPrompts.delete(message.params.sessionId);
                finishPrompt(pending, "cancelled");
            }
            break;
        }
        default:
            if (Object.hasOwn(message, "id")) {
                respond(message, {});
            }
    }
});
