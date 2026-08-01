import { describe, expect, it } from "vitest";

import {
    isWorkspaceViewInteractive,
    resolveWorkspaceViewLifecycles,
    shouldMountWorkspaceHeavyView,
} from "./view-lifecycle";

describe("workspace view lifecycle", () => {
    it("keeps heavy DOM exclusive to the focused pane's active tab", () => {
        const snapshot = resolveWorkspaceViewLifecycles({
            focusedPaneId: "left",
            panes: [
                {
                    activeTabId: "chat-left",
                    id: "left",
                    tabIds: ["chat-left", "file-left"],
                    visible: true,
                },
                {
                    activeTabId: "diff-right",
                    id: "right",
                    tabIds: ["diff-right"],
                    visible: true,
                },
            ],
            recentTabIds: ["file-left"],
        });

        expect(snapshot.lifecycleByTabId.get("chat-left")).toBe("active");
        expect(snapshot.lifecycleByTabId.get("diff-right")).toBe("active");
        expect(snapshot.lifecycleByTabId.get("file-left")).toBe("warm");
        expect(shouldMountWorkspaceHeavyView("active")).toBe(true);
        expect(shouldMountWorkspaceHeavyView("warm")).toBe(false);
        expect(isWorkspaceViewInteractive("warm")).toBe(false);
    });

    it("parks every heavy view while the whole surface is suspended", () => {
        const snapshot = resolveWorkspaceViewLifecycles({
            focusedPaneId: "__suspended__",
            panes: [
                {
                    activeTabId: "chat-left",
                    id: "left",
                    tabIds: ["chat-left"],
                    visible: false,
                },
                {
                    activeTabId: "terminal-right",
                    id: "right",
                    tabIds: ["terminal-right"],
                    visible: false,
                },
            ],
            recentTabIds: [],
        });

        expect(snapshot.lifecycleByTabId.get("chat-left")).toBe("warm");
        expect(snapshot.lifecycleByTabId.get("terminal-right")).toBe("warm");
        expect(
            [...snapshot.lifecycleByTabId.values()].some(
                shouldMountWorkspaceHeavyView,
            ),
        ).toBe(false);
    });
});
