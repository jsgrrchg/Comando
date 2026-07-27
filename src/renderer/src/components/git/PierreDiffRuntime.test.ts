/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Pierre runtime integration", () => {
    it("registers the custom element and attaches its official stylesheet", async () => {
        const replaceSync = vi.fn();

        class TestStyleSheet {
            replaceSync = replaceSync;
        }

        vi.stubGlobal("CSSStyleSheet", TestStyleSheet);

        await import("@pierre/diffs/react");

        expect(customElements.get("diffs-container")).toBeTypeOf("function");

        const container = document.createElement("diffs-container");
        expect(container.shadowRoot).not.toBeNull();
        expect(replaceSync).toHaveBeenCalledOnce();
    });
});
