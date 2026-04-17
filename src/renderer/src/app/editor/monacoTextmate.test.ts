import { describe, expect, it } from "vitest";

import {
    getTextMateLanguageIds,
    getTextMateScopeName,
    isTextMateLanguageSupported,
} from "./monacoTextmate";

describe("monacoTextmate", () => {
    it("exposes the initial TextMate language set", () => {
        expect(getTextMateLanguageIds()).toEqual([
            "cmake",
            "dockerfile",
            "hcl",
            "python",
            "ruby",
            "rust",
            "shell",
        ]);
    });

    it("maps supported language ids to their TextMate scopes", () => {
        expect(getTextMateScopeName("rust")).toBe("source.rust");
        expect(getTextMateScopeName("rs")).toBe("source.rust");
        expect(getTextMateScopeName("python")).toBe("source.python");
        expect(getTextMateScopeName("py")).toBe("source.python");
        expect(getTextMateScopeName("shell")).toBe("source.shell");
        expect(getTextMateScopeName("bash")).toBe("source.shell");
        expect(getTextMateScopeName("dockerfile")).toBe("source.dockerfile");
        expect(getTextMateScopeName("docker")).toBe("source.dockerfile");
        expect(getTextMateScopeName("cmake")).toBe("source.cmake");
        expect(getTextMateScopeName("hcl")).toBe("source.hcl");
        expect(getTextMateScopeName("terraform")).toBe("source.hcl");
        expect(getTextMateScopeName("ruby")).toBe("source.ruby");
        expect(getTextMateScopeName("rb")).toBe("source.ruby");
    });

    it("reports unsupported ids cleanly", () => {
        expect(isTextMateLanguageSupported("rust")).toBe(true);
        expect(isTextMateLanguageSupported("typescript")).toBe(false);
        expect(getTextMateScopeName("typescript")).toBeNull();
    });
});
