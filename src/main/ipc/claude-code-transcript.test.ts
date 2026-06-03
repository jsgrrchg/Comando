import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    encodeClaudeCodeProjectPath,
    parseClaudeCodeTranscriptJsonl,
    readClaudeCodeTranscript,
} from "./claude-code-transcript";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("Claude Code transcript IPC helpers", () => {
    it("encodes cwd like Claude Code project transcript directories", () => {
        expect(encodeClaudeCodeProjectPath("/Users/example/Project A")).toBe(
            "-Users-example-Project-A",
        );
    });

    it("parses user title and latest assistant preview from JSONL", () => {
        const parsed = parseClaudeCodeTranscriptJsonl(
            [
                "not-json",
                JSON.stringify({ isMeta: true, type: "user", message: "meta" }),
                JSON.stringify({
                    type: "user",
                    message: { content: "  Build   this feature\nplease " },
                }),
                JSON.stringify({
                    message: {
                        content: [{ text: "First answer" }],
                        role: "assistant",
                    },
                }),
                JSON.stringify({
                    isSidechain: true,
                    message: { content: "skip", role: "assistant" },
                }),
                JSON.stringify({
                    message: {
                        content: [{ text: "Latest" }, { text: " answer" }],
                        role: "assistant",
                    },
                }),
            ].join("\n"),
        );

        expect(parsed).toEqual({
            preview: "Latest answer",
            title: "Build this feature please",
        });
    });

    it("rejects non-UUID session ids before touching transcript paths", async () => {
        await expect(
            readClaudeCodeTranscript({
                cwd: "/workspace",
                sessionId: "../../secret",
            }),
        ).rejects.toThrow(/session UUID/);
    });

    it("reads only the derived Claude Code transcript path and honors mtime cache", async () => {
        const tempHome = await fs.mkdtemp(
            path.join(os.tmpdir(), "comando-claude-transcript-"),
        );
        vi.spyOn(os, "homedir").mockReturnValue(tempHome);
        const sessionId = "11111111-1111-4111-8111-111111111111";
        const transcriptDir = path.join(
            tempHome,
            ".claude",
            "projects",
            encodeClaudeCodeProjectPath("/workspace"),
        );
        await fs.mkdir(transcriptDir, { recursive: true });
        const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
        await fs.writeFile(
            transcriptPath,
            JSON.stringify({
                type: "user",
                message: { content: "Hello Claude Code" },
            }),
        );

        const first = await readClaudeCodeTranscript({
            cwd: "/workspace",
            sessionId,
        });
        const second = await readClaudeCodeTranscript({
            cwd: "/workspace",
            sessionId,
            sinceMtimeMs: first.mtimeMs,
        });

        expect(first).toMatchObject({
            changed: true,
            found: true,
            preview: null,
            title: "Hello Claude Code",
        });
        expect(second).toEqual({
            changed: false,
            found: true,
            mtimeMs: first.mtimeMs,
            preview: null,
            title: null,
        });
    });
});
