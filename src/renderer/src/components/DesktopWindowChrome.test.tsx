import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DesktopWindowChrome } from "./DesktopWindowChrome";

describe("DesktopWindowChrome", () => {
    it("keeps the center empty and exposes only the two shell controls", () => {
        const markup = renderToStaticMarkup(
            <DesktopWindowChrome
                inspectorControlsId="workspace-inspector"
                inspectorExpanded={false}
                navigatorControlsId="workspace-navigator"
                navigatorExpanded
                onToggleInspector={vi.fn()}
                onToggleNavigator={vi.fn()}
                platform="darwin"
            />,
        );

        expect(markup).toContain("app-drag desktop-titlebar");
        expect(markup).toContain('data-window-chrome-reserved="true"');
        expect(markup).toContain('data-chrome-control="navigator"');
        expect(markup).toContain('data-chrome-control="inspector"');
        expect(markup).toContain('aria-controls="workspace-navigator"');
        expect(markup).toContain('aria-controls="workspace-inspector"');
        expect(markup).toContain('aria-expanded="true"');
        expect(markup).toContain('aria-expanded="false"');
        expect(markup).not.toContain('role="tablist"');
        expect(markup).not.toContain("breadcrumb");
    });
});
