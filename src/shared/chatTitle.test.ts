import { describe, expect, it } from "vitest";

import {
    CHAT_TITLE_STORED_MAX_CHARS,
    inferChatTitleFromPrompt,
    isDefaultChatTitle,
    truncateChatTitle,
} from "./chatTitle";

const PILL_OPEN = "\u200B\u00AB";
const PILL_CLOSE = "\u00BB\u200B";

function pill(label: string): string {
    return `${PILL_OPEN}${label}${PILL_CLOSE}`;
}

describe("isDefaultChatTitle", () => {
    it("matches the runtime-generated defaults", () => {
        expect(isDefaultChatTitle("Claude 1")).toBe(true);
        expect(isDefaultChatTitle("Grok 1")).toBe(true);
        expect(isDefaultChatTitle("Codex 3")).toBe(true);
        expect(isDefaultChatTitle("Kilo 4")).toBe(true);
        expect(isDefaultChatTitle("OpenCode 5")).toBe(true);
        expect(isDefaultChatTitle("Agent 9")).toBe(true);
    });

    it("rejects renamed titles", () => {
        expect(isDefaultChatTitle("Claude review")).toBe(false);
        expect(isDefaultChatTitle("My chat 1")).toBe(false);
        expect(isDefaultChatTitle("Claude")).toBe(false);
        expect(isDefaultChatTitle("")).toBe(false);
    });
});

describe("truncateChatTitle", () => {
    it("returns the string untouched when it fits", () => {
        expect(truncateChatTitle("Short title", 20)).toBe("Short title");
    });

    it("cuts at the last whitespace when there is room", () => {
        const result = truncateChatTitle("Revisa el bug de login en session", 20);
        expect(result).toBe("Revisa el bug de\u2026");
    });

    it("falls back to a hard cut for a single long token", () => {
        const result = truncateChatTitle(
            "supercalifragilisticexpialidocious",
            10,
        );
        expect(result).toBe("supercali\u2026");
    });

    it("trims trailing whitespace before the ellipsis", () => {
        expect(truncateChatTitle("one two   three four", 14)).toBe(
            "one two\u2026",
        );
    });

    it("does not split emoji surrogate pairs at the cut boundary", () => {
        // "A😀B😀C😀D" — each emoji occupies 2 UTF-16 code units. Budget 6
        // under the old impl would slice mid-surrogate (U+FFFD).
        const result = truncateChatTitle("A\u{1F600}B\u{1F600}C\u{1F600}D", 6);
        expect(result).not.toContain("\uFFFD");
        expect(result.endsWith("\u2026")).toBe(true);
    });
});

describe("inferChatTitleFromPrompt", () => {
    it("strips pill markers but keeps the label", () => {
        const input = `Revisa el bug de login en ${pill("@auth/session.ts")}`;
        expect(inferChatTitleFromPrompt(input)).toBe(
            "Revisa el bug de login en session.ts",
        );
    });

    it("drops @fetch and /plan tokens", () => {
        const input = `${pill("@fetch")} Analiza el repo ${pill("/plan")}`;
        expect(inferChatTitleFromPrompt(input)).toBe("Analiza el repo");
    });

    it("drops attachment icons but keeps the label", () => {
        const input = `Revisa ${pill("\u{1F4CE}screenshot.png")}`;
        expect(inferChatTitleFromPrompt(input)).toBe("Revisa screenshot.png");
    });

    it("collapses whitespace and newlines", () => {
        expect(inferChatTitleFromPrompt("hola\n\n   mundo   cruel")).toBe(
            "hola mundo cruel",
        );
    });

    it("keeps at most twelve words", () => {
        const many = Array.from({ length: 20 }, (_, i) => `w${i + 1}`).join(" ");
        expect(inferChatTitleFromPrompt(many).split(" ")).toHaveLength(12);
    });

    it("returns empty string when the prompt has no textual content", () => {
        expect(inferChatTitleFromPrompt("")).toBe("");
        expect(inferChatTitleFromPrompt("   \n\t")).toBe("");
        expect(inferChatTitleFromPrompt(pill("@fetch"))).toBe("");
    });

    it("enforces the stored length budget", () => {
        const long = "palabra ".repeat(40);
        const result = inferChatTitleFromPrompt(long);
        expect(result.length).toBeLessThanOrEqual(CHAT_TITLE_STORED_MAX_CHARS);
    });

    it("leaves emails untouched", () => {
        const input = "Contacta a user@example.com sobre esto";
        expect(inferChatTitleFromPrompt(input)).toBe(
            "Contacta a user@example.com sobre esto",
        );
    });
});
