/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PierreGitDiffErrorBoundary } from "./PierreGitDiffErrorBoundary";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

function BrokenPierreDiff(): never {
    throw new Error("Pierre fixture render failure");
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("PierreGitDiffErrorBoundary", () => {
    it("keeps a safe fallback visible when Pierre fails", () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const container = document.createElement("div");
        const root = createRoot(container);

        act(() => {
            root.render(
                <PierreGitDiffErrorBoundary
                    fallback={<div data-diff-error="true">Diff unavailable</div>}
                    fileId="src/example.ts"
                >
                    <BrokenPierreDiff />
                </PierreGitDiffErrorBoundary>,
            );
        });

        expect(container.textContent).toContain("Diff unavailable");
        expect(container.querySelector("[data-diff-error]")).not.toBeNull();
        act(() => root.unmount());
    });
});
