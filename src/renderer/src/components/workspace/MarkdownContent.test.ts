/** @vitest-environment jsdom */
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    serializeComposerDisplayFileMention,
    serializeComposerDisplayFolderMention,
    serializeComposerDisplaySelectionMention,
} from "@shared/composer-display-markers";
import {
    readChatPerformanceCounters,
    resetChatPerformanceCounters,
} from "@renderer/app/debug/chatPerformanceCounters";

import {
    MarkdownContent,
    parseMarkdownBlocksProgressively,
} from "./MarkdownContent";
import { resolveProjectFileReference } from "./projectFileReferences";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLDivElement[] = [];

afterEach(() => {
    resetChatPerformanceCounters();
    for (const root of mountedRoots.splice(0)) {
        act(() => {
            root.unmount();
        });
    }

    for (const container of mountedContainers.splice(0)) {
        container.remove();
    }
});

function renderInteractiveMarkdownContent(
    props: Parameters<typeof MarkdownContent>[0],
): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const root = createRoot(container);
    mountedRoots.push(root);
    mountedContainers.push(container);

    act(() => {
        root.render(createElement(MarkdownContent, props));
    });

    return container;
}

describe("MarkdownContent", () => {
    it("distinguishes full Markdown parses from mutable suffix parses", () => {
        resetChatPerformanceCounters();
        const first = parseMarkdownBlocksProgressively(
            null,
            "Stable paragraph.\n\nMutable",
        );
        parseMarkdownBlocksProgressively(
            first,
            "Stable paragraph.\n\nMutable suffix",
        );

        expect(readChatPerformanceCounters()).toMatchObject({
            markdown_full_parses: 1,
            markdown_suffix_parses: 1,
        });
    });

    it("reuses a stable plain-text prefix without changing the parsed blocks", () => {
        const initial = "First paragraph.\n\nSecond paragraph";
        const next = `${initial} grows safely`;
        const progressive = parseMarkdownBlocksProgressively(
            parseMarkdownBlocksProgressively(null, initial),
            next,
        );
        const complete = parseMarkdownBlocksProgressively(null, next);

        expect(progressive.blocks).toEqual(complete.blocks);
        expect(progressive.stableContentLength).toBe(
            "First paragraph.\n\n".length,
        );
    });

    it.each([
        "```ts\nconst value = 1;",
        "- incomplete list item",
        "name | value\n--- | ---\npartial | row",
    ])("falls back to complete parsing for ambiguous live Markdown", (content) => {
        const next = `${content}\nmore streamed content`;
        const previous = parseMarkdownBlocksProgressively(null, content);
        const parsed = parseMarkdownBlocksProgressively(previous, next);

        expect(parsed.stableContentLength).toBe(0);
        expect(parsed.blocks).toEqual(
            parseMarkdownBlocksProgressively(null, next).blocks,
        );
    });

    it("seals a completed list without revisiting its stable prefix", () => {
        const initial = "Introduction.\n\n- first item\n- second item\n\n";
        const first = parseMarkdownBlocksProgressively(null, initial);
        const completed = parseMarkdownBlocksProgressively(
            first,
            `${initial}Follow-up paragraph.`,
        );
        const next = parseMarkdownBlocksProgressively(
            completed,
            `${initial}Follow-up paragraph. grows.`,
        );

        expect(first.stableBlocks[0]).toBe(completed.stableBlocks[0]);
        expect(completed.stableContentLength).toBe(initial.length);
        expect(completed.stableBlocks.at(-1)?.content).toContain(
            "second item",
        );
        expect(next.stableBlocks).toEqual(completed.stableBlocks);
        expect(next.stableBlocks.at(-1)).toBe(completed.stableBlocks.at(-1));
    });

    it("keeps an indented list continuation mutable across a blank line", () => {
        const projection = parseMarkdownBlocksProgressively(
            null,
            "- parent item\n\n  continuation that can still belong to the list",
        );

        expect(projection.stableContentLength).toBe(0);
        expect(projection.blocks).toHaveLength(1);
        expect(projection.blocks[0]?.isMutable).toBe(true);
    });

    it("preserves the existing list rendering across a sealed boundary", () => {
        const content = "- first item\n\n- second item\n\nParagraph after the list.";
        const staticMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, { content }),
        );
        const liveMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, { content, live: true }),
        );

        expect(liveMarkup.match(/<ul/g)?.length).toBe(
            staticMarkup.match(/<ul/g)?.length,
        );
        expect(liveMarkup).toContain("Paragraph after the list.");
    });

    it("seals a completed table before the following paragraph", () => {
        const initial = "Heading.\n\nname | value\n--- | ---\nfirst | 1\n\n";
        const first = parseMarkdownBlocksProgressively(null, initial);
        const completed = parseMarkdownBlocksProgressively(
            first,
            `${initial}Paragraph after the table.`,
        );
        const next = parseMarkdownBlocksProgressively(
            completed,
            `${initial}Paragraph after the table. grows.`,
        );

        expect(completed.stableContentLength).toBe(initial.length);
        expect(completed.stableBlocks.at(-1)?.content).toContain("first | 1");
        expect(next.stableBlocks.at(-1)).toBe(completed.stableBlocks.at(-1));
    });

    it("seals a closed fence and defers highlighting only while it is open", () => {
        const openFence = "Before the fence.\n\n```ts\nconst answer = 42;";
        const streamingMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: openFence,
                live: true,
            }),
        );
        const closedFence = `${openFence}\n\`\`\`\n\nAfter the fence.`;
        const first = parseMarkdownBlocksProgressively(null, openFence);
        const completed = parseMarkdownBlocksProgressively(first, closedFence);
        const next = parseMarkdownBlocksProgressively(
            completed,
            `${closedFence} More text.`,
        );
        const completedFence = completed.stableBlocks.find(
            (block) => block.type === "code",
        );

        expect(streamingMarkup).toContain(
            'data-code-highlight-deferred="true"',
        );
        expect(completedFence?.isMutable).toBe(false);
        expect(next.stableBlocks.find((block) => block.type === "code")).toBe(
            completedFence,
        );
    });

    it("does not close a fence with four leading spaces", () => {
        const content = [
            "```ts",
            "const value = true;",
            "    ```",
            "still part of the code fence",
        ].join("\n");
        const projection = parseMarkdownBlocksProgressively(null, content);
        const codeBlock = projection.blocks.find(
            (block) => block.type === "code",
        );

        expect(codeBlock?.isMutable).toBe(true);
        expect(codeBlock?.content).toContain("    ```");
        expect(codeBlock?.content).toContain("still part of the code fence");
    });

    it("preserves terminal whitespace for static Markdown and avoids a split gap", () => {
        const staticMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, { content: "Last line\n" }),
        );
        const liveMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "First block.\n\nSecond block.",
                live: true,
            }),
        );

        expect(staticMarkup).toContain("height:8px");
        expect(liveMarkup.match(/height:8px/g)).toHaveLength(1);
    });

    it("keeps sealed blocks referentially stable across 1,000 live deltas", () => {
        let projection = parseMarkdownBlocksProgressively(
            null,
            "Stable introduction.\n\n```ts\nconst stable = true;\n```\n\nLive",
        );
        const sealedBlocks = projection.stableBlocks;

        for (let index = 0; index < 1_000; index++) {
            projection = parseMarkdownBlocksProgressively(
                projection,
                `${projection.content} ${index}`,
            );
        }

        expect(projection.stableBlocks).toEqual(sealedBlocks);
        expect(projection.stableBlocks[0]).toBe(sealedBlocks[0]);
        expect(projection.stableBlocks[1]).toBe(sealedBlocks[1]);
        expect(projection.blocks.at(-1)?.isMutable).toBe(true);
    });

    it("renders the published live revision without scheduling another frame", () => {
        const requestAnimationFrame = vi.fn(() => 1);
        const cancelAnimationFrame = vi.fn();
        vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
        vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);
        mountedContainers.push(container);

        act(() => {
            root.render(
                createElement(MarkdownContent, {
                    content: "First revision.",
                    live: true,
                }),
            );
        });
        act(() => {
            root.render(
                createElement(MarkdownContent, {
                    content: "Second revision is visible immediately.",
                    live: true,
                }),
            );
        });

        const content = container.querySelector("[data-markdown-live='true']");
        expect(content?.getAttribute("data-markdown-content-chars")).toBe(
            String("Second revision is visible immediately.".length),
        );
        expect(content?.getAttribute("data-markdown-rendered-chars")).toBe(
            String("Second revision is visible immediately.".length),
        );
        expect(content?.textContent).toContain("Second revision is visible immediately.");
        expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it("keeps simultaneous live panels on their current Markdown revision", () => {
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);
        mountedContainers.push(container);

        const renderPanels = (content: string) =>
            createElement(
                "div",
                null,
                createElement(MarkdownContent, { content, live: true }),
                createElement(MarkdownContent, { content, live: true }),
            );

        act(() => {
            root.render(renderPanels("Initial revision."));
        });
        act(() => {
            root.render(renderPanels("Current revision in both panels."));
        });

        const panels = [
            ...container.querySelectorAll<HTMLElement>(
                "[data-markdown-live='true']",
            ),
        ];
        expect(panels).toHaveLength(2);
        expect(panels.map((panel) => panel.dataset.markdownRenderedChars)).toEqual(
            Array(2).fill(String("Current revision in both panels.".length)),
        );
        expect(panels.map((panel) => panel.textContent)).toEqual(
            Array(2).fill("Current revision in both panels."),
        );
    });

    it("renders serialized folder mentions as Catppuccin links", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: serializeComposerDisplayFolderMention({
                    folderPath: "src/components",
                    label: "components",
                }),
            }),
        );

        expect(markup).toContain("@components");
        expect(markup).toContain("src/components");
        expect(markup).toContain("<svg");
    });

    it("renders diff blocks with DiffLineView", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "```diff\n@@ -1,2 +1,2 @@\n alpha\n-bravo\n+beta\n```",
            }),
        );

        expect(markup).toContain("markdown-diff-block");
        expect(markup).toContain('data-diff-line="true"');
        expect(markup).toContain('data-line-type="remove"');
        expect(markup).toContain('data-line-type="add"');
        expect(markup).toContain(">Diff<");
        expect(markup).toContain("markdown-code-frame");
        expect(markup).toContain("markdown-code-header");
    });

    it("keeps normal rendering for non-diff code blocks", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "```ts\nconst value = 1;\n```",
            }),
        );

        expect(markup).toContain(">TypeScript<");
        expect(markup).toContain("markdown-code-block");
        expect(markup).toContain("cm-static-code");
        expect(markup).not.toContain("markdown-diff-block");
    });

    it("uses the shared preview chrome for text fences", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "```text\nprepare root\n```",
            }),
        );

        expect(markup).toContain("markdown-code-frame");
        expect(markup).toContain("markdown-code-header");
        expect(markup).toContain(">Text</span>");
        expect(markup).toContain('aria-label="Copy code block"');
        expect(markup).toContain("prepare root");
    });

    it("renders tilde fenced code blocks", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "~~~python\nprint('hello')\n~~~",
            }),
        );

        expect(markup).toContain(">Python<");
        expect(markup).toContain("cm-static-code");
        expect(markup).toContain("print");
    });

    it("renders unclosed fenced code blocks while content is streaming", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "```zig\nconst value: i32 = 1;",
            }),
        );

        expect(markup).toContain(">Zig<");
        expect(markup).toContain("cm-static-code");
        expect(markup).toContain("value");
    });

    it("keeps highlighting for TOML and GraphQL", () => {
        const tomlMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: '```toml\n[package]\nname = "comando"\n```',
            }),
        );
        const graphqlMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "```graphql\nquery Viewer { viewer { login } }\n```",
            }),
        );

        expect(tomlMarkup).toContain(">Toml<");
        expect(tomlMarkup).toContain("cm-static-code");
        expect(graphqlMarkup).toContain(">GraphQL<");
        expect(graphqlMarkup).toContain("cm-static-code");
    });

    it("closes a parent list before unindented text after a nested list", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "5. Bumps de SDK",
                    "",
                    "   - @agentclientprotocol/sdk: 0.24.0 -> 0.25.0",
                    "   - @anthropic-ai/sdk dev: 0.100.1 -> 0.103.0",
                    "Impacto En Comando",
                    "Lo nuevo no se activa automaticamente del todo.",
                ].join("\n"),
            }),
        );
        const listCloseIndex = markup.indexOf("</ol>");
        const nextHeadingIndex = markup.indexOf("Impacto En Comando");

        expect(markup).toContain('start="5"');
        expect(listCloseIndex).toBeGreaterThan(-1);
        expect(nextHeadingIndex).toBeGreaterThan(-1);
        expect(listCloseIndex).toBeLessThan(nextHeadingIndex);
    });

    it("renders inline selection pills from serialized composer markers", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content:
                    "\u200B\u00AB(8:14) - Si ves que un\u00BB\u200B expande",
            }),
        );

        expect(markup).toContain("(8:14) - Si ves que un");
        expect(markup).toContain("expande");
    });

    it("renders serialized user file mentions as openable icon links", () => {
        const relativePath = "vendor/codex-acp/src/thread.rs";
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content: serializeComposerDisplayFileMention({
                    label: "thread.rs",
                    relativePath,
                }),
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup).toContain(">@thread.rs<");
        expect(markup).toContain(`title="${relativePath}"`);
        expect(markup).toContain("catppuccin-icon");
    });

    it("modernizes legacy user file mentions when the file is unambiguous", () => {
        const fileName = "@02-pr-code-mode-host-packaging-por-commits.md";
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content: `\u200B\u00AB${fileName}\u00BB\u200B create this`,
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, { projectRoots: [] }),
            }),
        );

        expect(markup).toContain(`>${fileName}<`);
        expect(markup).toContain(
            'title="02-pr-code-mode-host-packaging-por-commits.md"',
        );
        expect(markup).toContain("catppuccin-icon");
        expect(markup).toContain("background:transparent");
    });

    it("renders serialized selections as links to their exact line range", () => {
        const relativePath = "src/elicitation.ts";
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content: serializeComposerDisplaySelectionMention({
                    endLine: 14,
                    label: "(8:14) - selected code",
                    path: relativePath,
                    startLine: 8,
                }),
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup).toContain(
            ">elicitation.ts (lines 8–14)<",
        );
        expect(markup).not.toContain("selected code</span>");
        expect(markup).toContain('title="src/elicitation.ts:8-14"');
        expect(markup).toContain("catppuccin-icon");
    });

    it("keeps unresolved legacy user file mentions in the new icon link style", () => {
        const fileName = "@03-pr-turntime-activities-deduplicacion-por-commits.md";
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: `\u200B\u00AB${fileName}\u00BB\u200B create a branch`,
            }),
        );

        expect(markup).toContain(`>${fileName}<`);
        expect(markup).toContain("catppuccin-icon");
        expect(markup).toContain("background:transparent");
    });

    it("keeps trusted composer selections styled while the file index loads", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => false,
                content: serializeComposerDisplaySelectionMention({
                    endLine: 3,
                    label: "(1:3) - interesting",
                    path: "archive-2.txt",
                    startLine: 1,
                }),
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, { projectRoots: [] }),
            }),
        );

        expect(markup).toContain(">archive-2.txt (lines 1–3)<");
        expect(markup).toContain('title="archive-2.txt:1-3"');
        expect(markup).toContain("catppuccin-icon");
        expect(markup).toContain("background:transparent");
    });

    it("renders long inline file reference pills without shortening the label", () => {
        const longPath =
            "src/renderer/src/components/workspace/chat/ExtraordinarilyLongFileNameForPillRendering.tsx";
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content: `Review \`${longPath}\` please`,
                onOpenFile: () => undefined,
                resolveFileReference: () => ({
                    endLine: null,
                    isAbsolute: false,
                    path: longPath,
                    relativePath: longPath,
                    startLine: null,
                }),
            }),
        );

        expect(markup).toContain(longPath);
        expect(markup).toContain("white-space:normal");
        expect(markup).not.toContain("ExtraordinarilyLong...");
        expect(markup).not.toContain("text-overflow:ellipsis");
    });

    it("keeps slash tokens as text unless they are strong file references", () => {
        const content = [
            "Läuft euer S/4 in der Public Cloud?",
            "Viele Schaltanlagenbauer /EVU-Partner gehen in unsere Richtung.",
            "TCP/IP ist der Standard.",
            "Zielquartal ist 2024/Q1.",
            "Inline code: `S/4`, `TCP/IP`, `2024/Q1`, `/LinkedIn`.",
            "Real file: `src/renderer/src/components/workspace/MarkdownContent.tsx`.",
        ].join("\n");
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content,
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: [
                            "/Users/test/workspace/comando",
                            "/Users/test/workspace/comando/.git/..",
                        ],
                    }),
            }),
        );

        expect(markup).toContain("S/4");
        expect(markup).toContain("/EVU-Partner");
        expect(markup).toContain("TCP/IP");
        expect(markup).toContain("2024/Q1");
        expect(markup).toContain("/LinkedIn");
        expect(markup).not.toContain('title="S/4"');
        expect(markup).not.toContain('title="TCP/IP"');
        expect(markup).not.toContain('title="2024/Q1"');
        expect(markup).not.toContain('title="/LinkedIn"');
        expect(markup.match(/class="chat-inline-code"/g)?.length).toBe(4);
        expect(markup).toContain(
            'title="src/renderer/src/components/workspace/MarkdownContent.tsx"',
        );
    });

    it("renders raw diagnostic file references as interactive pills", () => {
        const content = [
            "Errors at src/app.ts:12 and src/app.ts:12:5.",
            "Also ./src/app.ts:12.",
            "Absolute /Users/test/workspace/comando/src/app.ts:42.",
            "File URL file:///Users/test/workspace/comando/src/app.ts#L9-L14.",
        ].join(" ");
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content,
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup.match(/<button/g)?.length).toBe(5);
        expect(markup).toContain(">app.ts:12<");
        expect(markup).toContain(">app.ts:12:5<");
        expect(markup).toContain(">app.ts:9-14<");
        expect(markup).toContain('title="src/app.ts:12"');
        expect(markup).toContain('title="src/app.ts:12:5"');
        expect(markup).toContain('title="./src/app.ts:12"');
        expect(markup).toContain(
            'title="/Users/test/workspace/comando/src/app.ts:42"',
        );
        expect(markup).toContain(
            'title="file:///Users/test/workspace/comando/src/app.ts#L9-L14"',
        );
    });

    it("renders natural line references with Catppuccin file icons", () => {
        const content =
            "See manage_profiles_modal.rs (line 790) and src/profile_selector.rs (lines 177-184).";
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content,
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup.match(/<button/g)?.length).toBe(2);
        expect(markup).toContain("manage_profiles_modal.rs (line 790)");
        expect(markup).toContain("profile_selector.rs (lines 177-184)");
        expect(markup).toContain("transform:translateY(2px)");
        expect(markup.match(/catppuccin-icon/g)?.length).toBeGreaterThanOrEqual(
            2,
        );
    });

    it("opens raw diagnostic file reference pills with parsed line ranges", () => {
        const onOpenFile = vi.fn();
        const container = renderInteractiveMarkdownContent({
            canRenderFileReference: () => true,
            content: "Errors at src/app.ts:12-18.",
            onOpenFile,
            resolveFileReference: (reference) =>
                resolveProjectFileReference(reference, {
                    projectRoots: ["/Users/test/workspace/comando"],
                }),
        });
        const pillButton = container.querySelector<HTMLButtonElement>(
            'button[title="src/app.ts:12-18"]',
        );
        expect(pillButton).not.toBeNull();

        act(() => {
            pillButton?.click();
        });

        expect(onOpenFile).toHaveBeenCalledWith({
            endLine: 18,
            isAbsolute: false,
            path: "src/app.ts",
            relativePath: "src/app.ts",
            startLine: 12,
        });
    });

    it("renders markdown project file links as interactive pills", () => {
        const target = "src/renderer/src/components/workspace/MarkdownContent.tsx";
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content: `Open [workspace markdown](${target}).`,
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup.match(/<button/g)?.length).toBe(1);
        expect(markup).toContain(">workspace markdown<");
        expect(markup).toContain(`title="${target}"`);
        expect(markup).not.toContain(`href="${target}"`);
    });

    it("does not pillify markdown file links the index cannot confirm", () => {
        const target = "/Users/test/workspace/comando/src/App.tsx";
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => false,
                content: `Open [App.tsx](${target}).`,
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        // An unconfirmed file link must not become a clickable pill.
        expect(markup.match(/<button/g)?.length ?? 0).toBe(0);
        expect(markup).not.toContain(`title="${target}"`);
        expect(markup).toContain(">App.tsx<");
    });

    it("requires existence confirmation for inline-code file references", () => {
        const target = "src/renderer/src/components/workspace/MarkdownContent.tsx";
        const content = `Edit \`${target}\` first.`;
        const resolveFileReference = (reference: string) =>
            resolveProjectFileReference(reference, {
                projectRoots: ["/Users/test/workspace/comando"],
            });

        const withoutConfirmation = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => false,
                content,
                onOpenFile: () => undefined,
                resolveFileReference,
            }),
        );
        expect(withoutConfirmation.match(/<button/g)?.length ?? 0).toBe(0);
        expect(withoutConfirmation).not.toContain(`title="${target}"`);

        const withConfirmation = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content,
                onOpenFile: () => undefined,
                resolveFileReference,
            }),
        );
        expect(withConfirmation.match(/<button/g)?.length).toBe(1);
        expect(withConfirmation).toContain(`title="${target}"`);
    });

    it("keeps external markdown links as anchors", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content: "Read [the docs](https://example.com/docs).",
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup).toContain('href="https://example.com/docs"');
        expect(markup).toContain(">the docs<");
        expect(markup.match(/<button/g)?.length ?? 0).toBe(0);
    });

    it("renders markdown file links with parenthesized angle targets", () => {
        const target = "src/components/Foo(test).tsx";
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content: `Review [test component](<${target}>).`,
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup.match(/<button/g)?.length).toBe(1);
        expect(markup).toContain(">test component<");
        expect(markup).toContain(`title="&lt;${target}&gt;"`);
    });

    it("renders raw confirmed file paths without line references", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content: "Touch src/app.ts before committing.",
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup.match(/<button/g)?.length).toBe(1);
        expect(markup).toContain(">app.ts<");
        expect(markup).toContain('title="src/app.ts"');
    });

    it("keeps incomplete streaming markdown links intact", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content: "Streaming [app](src/app.ts",
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup).toContain("Streaming [app](src/app.ts");
        expect(markup.match(/<button/g)?.length ?? 0).toBe(0);
        expect(markup).not.toContain('title="src/app.ts"');
    });

    it("does not pillify dubious markdown path-like links", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content: "Check [SAP](S/4) and [quarter](2024/Q1).",
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup.match(/<button/g)?.length ?? 0).toBe(0);
        expect(markup).toContain('href="S/4"');
        expect(markup).toContain('href="2024/Q1"');
    });

    it("keeps URLs intact when they contain path-like diagnostic text", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => true,
                content:
                    "See https://example.com/src/app.ts:12 before src/app.ts:12.",
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup).toContain('href="https://example.com/src/app.ts:12"');
        expect(markup).not.toContain(
            'title="https://example.com/src/app.ts:12"',
        );
        expect(markup.match(/<button/g)?.length).toBe(1);
        expect(markup).toContain('title="src/app.ts:12"');
    });

    it("keeps raw diagnostic references as text when the project cannot confirm them", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderFileReference: () => false,
                content: "Example path src/app.ts:12 should not be clickable.",
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup).toContain("src/app.ts:12");
        expect(markup).not.toContain('title="src/app.ts:12"');
        expect(markup.match(/<button/g)?.length ?? 0).toBe(0);
    });

    it("renders conservative git and structured symbol pills", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "Fixed in commit abcdef1234567890.",
                    "Mention abcdef1 alone stays text.",
                    "\u200B\u00ABsymbol: WorkspaceView.openFileTab\u00BB\u200B",
                    "\u200B\u00ABcommit: 123456789abc\u00BB\u200B",
                ].join("\n"),
            }),
        );

        expect(markup).toContain('title="abcdef1234567890"');
        expect(markup).toContain(">abcdef123456<");
        expect(markup).toContain("Mention abcdef1 alone stays text.");
        expect(markup).toContain("WorkspaceView.openFileTab");
        expect(markup).not.toContain(">symbol: WorkspaceView.openFileTab<");
        expect(markup).toContain("commit: 123456789abc");
    });

    it("keeps ordered items grouped when they contain paragraphs and nested bullets", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "1. Plan principal",
                    "Mientras esperas, mantienes el contexto.",
                    "   - Recuperas el hilo",
                    "   - Sigues con una salida decente",
                    "",
                    "1. Objetivo",
                    "Primero estabilizar el flujo.",
                    "   - Luego refinar detalles",
                ].join("\n"),
            }),
        );

        expect(markup).toContain("<ol");
        expect(markup).toContain("<li");
        expect(markup.match(/<ol/g)?.length).toBe(1);
        expect(markup).toContain("<ul");
        expect(markup).toContain("Mientras esperas, mantienes el contexto.");
        expect(markup).toContain("Luego refinar detalles");
    });

    it("closes ordered lists before top-level headings", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "1. Tradeoff a tener presente",
                    "Re-pintado: cuando cambia el composerFontSize reconstruye todo.",
                    "## Orden sugerido si lo avanzas",
                    "1. Helper createIconSvg.",
                ].join("\n"),
            }),
        );
        const listEnd = markup.indexOf("</ol>");
        const headingStart = markup.indexOf("Orden sugerido si lo avanzas");

        expect(listEnd).toBeGreaterThan(-1);
        expect(headingStart).toBeGreaterThan(listEnd);
        expect(markup).not.toContain("## Orden sugerido");
    });

    it("closes bullet lists before top-level headings after a blank line", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "- folder_mention: usar FolderTypeIcon.",
                    "- git_commit_mention: icono git.",
                    "",
                    "## Orden sugerido si lo avanzas",
                    "1. Helper createIconSvg.",
                ].join("\n"),
            }),
        );
        const listEnd = markup.indexOf("</ul>");
        const headingStart = markup.indexOf("Orden sugerido si lo avanzas");

        expect(listEnd).toBeGreaterThan(-1);
        expect(headingStart).toBeGreaterThan(listEnd);
        expect(markup).not.toContain("## Orden sugerido");
    });

    it("closes lists before top-level blockquotes and tables", () => {
        const blockquoteMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: ["1. First point", "> quoted follow-up"].join("\n"),
            }),
        );
        const tableMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "- First point",
                    "| File | Status |",
                    "| --- | --- |",
                    "| app.ts | ok |",
                ].join("\n"),
            }),
        );

        const blockquoteListEnd = blockquoteMarkup.indexOf("</ol>");
        const blockquoteStart = blockquoteMarkup.indexOf("<blockquote");
        const tableListEnd = tableMarkup.indexOf("</ul>");
        const tableStart = tableMarkup.indexOf("<table");

        expect(blockquoteListEnd).toBeGreaterThan(-1);
        expect(blockquoteStart).toBeGreaterThan(blockquoteListEnd);
        expect(tableListEnd).toBeGreaterThan(-1);
        expect(tableStart).toBeGreaterThan(tableListEnd);
    });

    it("renders isolated bullet-like lines as a single-item list", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "- O sea: las adaptaciones especiales no viven en el vendor.",
                    "Comando Claude setup",
                    "Comando Claude process",
                ].join("\n"),
            }),
        );

        expect(markup).toContain("<ul");
        expect(markup).toContain(
            "O sea: las adaptaciones especiales no viven en el vendor.",
        );
        expect(markup).toContain("Comando Claude setup");
    });

    it("renders isolated ordered-like lines as a single-item list", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "1. Actualizacion conservadora primero.",
                    "Luego validas login, prompt y cierre.",
                ].join("\n"),
            }),
        );

        expect(markup).toContain("<ol");
        expect(markup).toContain("Actualizacion conservadora primero.");
        expect(markup).toContain("Luego validas login, prompt y cierre.");
    });

    it("respects the starting number of ordered lists", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "3. Third item\n4. Fourth item",
            }),
        );

        expect(markup).toContain('<ol start="3"');
        expect(markup).toContain("Third item");
        expect(markup).toContain("Fourth item");
    });
});
