import { describe, expect, it } from "vitest";

import { classifyShellWord, isLikelyShellPathToken } from "./monacoShell";

describe("monacoShell", () => {
    it("classifies modern runtimes and subcommands for highlighting", () => {
        expect(classifyShellWord("pnpm")).toBe("builtin");
        expect(classifyShellWord("bun")).toBe("builtin");
        expect(classifyShellWord("yarn")).toBe("builtin");
        expect(classifyShellWord("dev")).toBe("subcommand");
        expect(classifyShellWord("install")).toBe("subcommand");
        expect(classifyShellWord("export")).toBe("keyword");
        expect(classifyShellWord("comando")).toBe("identifier");
    });

    it("detects shell-style path tokens with common prefixes", () => {
        expect(
            isLikelyShellPathToken(
                "/Users/test/workspace/comando",
            ),
        ).toBe(true);
        expect(isLikelyShellPathToken("./scripts/dev.sh")).toBe(true);
        expect(isLikelyShellPathToken("../packages/app")).toBe(true);
        expect(isLikelyShellPathToken("~/work/comando")).toBe(true);
        expect(isLikelyShellPathToken("pnpm")).toBe(false);
    });
});
