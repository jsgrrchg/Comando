import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceScrollScope } from "./usePersistedWorkspaceScroll";

const mockPersistedScroll = vi.hoisted(() => {
    const handleScroll = vi.fn();
    const scrollRef = vi.fn();
    const usePersistedWorkspaceScroll = vi.fn(() => ({
        handleScroll,
        scrollRef,
        storageKey: "test-scroll-key",
    }));

    return {
        handleScroll,
        scrollRef,
        usePersistedWorkspaceScroll,
    };
});

vi.mock("./usePersistedWorkspaceScroll", () => ({
    usePersistedWorkspaceScroll:
        mockPersistedScroll.usePersistedWorkspaceScroll,
}));

import {
    GitHubTabShell,
    type GitHubTabShellRenderContext,
} from "./GitHubWorkspacePrimitives";

const SCROLL_SCOPE: WorkspaceScrollScope = {
    entityId: "github.com/octocat/hello-world",
    projectId: "project-1",
    surface: "github_issues",
    worktreeId: null,
};

describe("GitHubTabShell", () => {
    beforeEach(() => {
        mockPersistedScroll.handleScroll.mockClear();
        mockPersistedScroll.scrollRef.mockClear();
        mockPersistedScroll.usePersistedWorkspaceScroll.mockClear();
    });

    it("keeps persisted workspace scroll in the shell while rendering normal children", () => {
        const markup = renderToStaticMarkup(
            <GitHubTabShell
                header={<div>GitHub Header</div>}
                scrollScope={SCROLL_SCOPE}
            >
                <div>Normal child content</div>
            </GitHubTabShell>,
        );

        expect(
            mockPersistedScroll.usePersistedWorkspaceScroll,
        ).toHaveBeenCalledWith(SCROLL_SCOPE);
        expect(markup).toContain("GitHub Header");
        expect(markup).toContain("Normal child content");
    });

    it("passes the shared scroll container ref to render prop children", () => {
        const renderChild = vi.fn(
            (context: GitHubTabShellRenderContext) => {
                return (
                    createElement(
                        "div",
                        {
                            "data-scroll-ref":
                                context.scrollContainerRef.current === null
                                    ? "shared"
                                    : "changed",
                        },
                        "Render prop content",
                    )
                );
            },
        );
        const markup = renderToStaticMarkup(
            <GitHubTabShell
                header={<div>GitHub Header</div>}
                scrollScope={SCROLL_SCOPE}
            >
                {renderChild}
            </GitHubTabShell>,
        );

        expect(renderChild).toHaveBeenCalledTimes(1);
        const receivedContext = renderChild.mock.calls[0]?.[0];
        expect(receivedContext).toBeDefined();
        expect(receivedContext?.scrollContainerRef.current).toBeNull();
        receivedContext?.scrollRef(null);
        expect(mockPersistedScroll.scrollRef).toHaveBeenCalledTimes(1);
        expect(markup).toContain('data-scroll-ref="shared"');
        expect(markup).toContain("Render prop content");
    });
});
