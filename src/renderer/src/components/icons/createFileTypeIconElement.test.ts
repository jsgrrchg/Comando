/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { createFileTypeIconElement } from "./createFileTypeIconElement";

describe("createFileTypeIconElement", () => {
    it("creates a themed Catppuccin SVG for composer mentions", () => {
        const icon = createFileTypeIconElement("src/thread.rs", 13);

        expect(icon?.dataset.composerFileIcon).toBe("true");
        expect(icon?.getAttribute("height")).toBe("13");
        expect(icon?.innerHTML).toContain("var(--catppuccin-icon-");
    });
});
