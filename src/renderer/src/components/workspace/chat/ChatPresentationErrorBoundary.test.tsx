/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { ChatPresentationErrorBoundary } from "./ChatPresentationErrorBoundary";

vi.mock("@renderer/app/debug/renderProbe", () => ({
    recordProbeLifecycleEvent: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

function BrokenRow(): never {
    throw new Error("fixture render failure");
}

describe("ChatPresentationErrorBoundary", () => {
    it("isolates a row failure and offers presentation-only retry", () => {
        const container = document.createElement("div");
        const root = createRoot(container);

        act(() => {
            root.render(
                <ChatPresentationErrorBoundary fallbackKind="row" identity="row-1">
                    <BrokenRow />
                </ChatPresentationErrorBoundary>,
            );
        });

        expect(container.textContent).toContain(
            "This activity could not be displayed",
        );
        expect(container.querySelector('[role="alert"]')).not.toBeNull();
        act(() => root.unmount());
    });
});
