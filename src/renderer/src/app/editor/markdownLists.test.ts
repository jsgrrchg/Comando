import { describe, expect, it } from "vitest";

import {
    buildContinuedListPrefix,
    continueMarkdownList,
    indentMarkdownListItems,
    normalizeMarkdownListText,
    outdentMarkdownListItems,
    parseMarkdownListItem,
} from "./markdownLists";

describe("markdownLists", () => {
    it("continues nested bullet items with the same indentation", () => {
        const source = "  - parent";
        const result = continueMarkdownList(source, source.length);

        expect(result).toEqual({
            selectionEnd: "  - parent\n  - ".length,
            selectionOffset: "  - parent\n  - ".length,
            selectionStart: "  - parent\n  - ".length,
            text: "  - parent\n  - ",
        });
    });

    it("continues task items with unchecked brackets", () => {
        const source = "    - [x] done";
        const result = continueMarkdownList(source, source.length);

        expect(result).toEqual({
            selectionEnd: "    - [x] done\n    - [ ] ".length,
            selectionOffset: "    - [x] done\n    - [ ] ".length,
            selectionStart: "    - [x] done\n    - [ ] ".length,
            text: "    - [x] done\n    - [ ] ",
        });
    });

    it("removes an empty task item on enter", () => {
        const source = "- [ ] \nNext";
        const result = continueMarkdownList("- [ ] ", "- [ ] ".length);

        expect(result).toEqual({
            selectionEnd: 0,
            selectionOffset: 0,
            selectionStart: 0,
            text: "",
        });

        expect(continueMarkdownList(source, 6)).toEqual({
            selectionEnd: 0,
            selectionOffset: 0,
            selectionStart: 0,
            text: "Next",
        });
    });

    it("renumbers ordered lists after inserting a sibling item", () => {
        const source = "1. one\n2. two\n3. three";
        const result = continueMarkdownList(source, "1. one\n2. two".length);

        expect(result).toEqual({
            selectionEnd: "1. one\n2. two\n3. ".length,
            selectionOffset: "1. one\n2. two\n3. ".length,
            selectionStart: "1. one\n2. two\n3. ".length,
            text: "1. one\n2. two\n3. \n4. three",
        });
    });

    it("keeps nested ordered lists scoped to their hierarchy", () => {
        const source = "1. parent\n   1. child\n   2. sibling\n2. outside";
        const result = continueMarkdownList(
            source,
            "1. parent\n   1. child\n   2. sibling".length,
        );

        expect(result).toEqual({
            selectionEnd: "1. parent\n   1. child\n   2. sibling\n   3. "
                .length,
            selectionOffset: "1. parent\n   1. child\n   2. sibling\n   3. "
                .length,
            selectionStart: "1. parent\n   1. child\n   2. sibling\n   3. "
                .length,
            text: "1. parent\n   1. child\n   2. sibling\n   3. \n2. outside",
        });
    });

    it("respects ordered list resets after a blank paragraph", () => {
        const source = "1. first\n\n1. second";
        const result = continueMarkdownList(source, source.length);

        expect(result).toEqual({
            selectionEnd: "1. first\n\n1. second\n2. ".length,
            selectionOffset: "1. first\n\n1. second\n2. ".length,
            selectionStart: "1. first\n\n1. second\n2. ".length,
            text: "1. first\n\n1. second\n2. ",
        });
    });

    it("does not renumber ordered lists across blank paragraphs", () => {
        const result = normalizeMarkdownListText("1. first\n\n1. second", 19);

        expect(result).toEqual({
            selectionEnd: 19,
            selectionOffset: 19,
            selectionStart: 19,
            text: "1. first\n\n1. second",
        });
    });

    it("normalizes uppercase task markers and spacing", () => {
        const result = normalizeMarkdownListText("- [X]   Done", 12);

        expect(result).toEqual({
            selectionEnd: 10,
            selectionOffset: 10,
            selectionStart: 10,
            text: "- [x] Done",
        });
    });

    it("indents markdown list items with tab and renumbers nested ordered lists", () => {
        const source = "1. one\n2. two\n3. three";
        const result = indentMarkdownListItems(
            source,
            source.indexOf("2. two"),
            "1. one\n2. two".length,
            2,
        );

        expect(result).toEqual({
            selectionEnd: 16,
            selectionOffset: 16,
            selectionStart: 16,
            text: "1. one\n   1. two\n2. three",
        });
    });

    it("outdents nested task items with shift tab", () => {
        const source = "- [ ] parent\n  - [ ] child\n  - [ ] sibling";
        const selectionStart = source.indexOf("  - [ ] child");
        const selectionEnd = source.length;
        const result = outdentMarkdownListItems(
            source,
            selectionStart,
            selectionEnd,
            2,
        );

        expect(result).toEqual({
            selectionEnd: 38,
            selectionOffset: 38,
            selectionStart: 13,
            text: "- [ ] parent\n- [ ] child\n- [ ] sibling",
        });
    });

    it("parses task items and builds continuation prefixes", () => {
        const item = parseMarkdownListItem("  4) [ ] item");

        expect(item).toBeTruthy();
        expect(buildContinuedListPrefix(item!)).toBe("  5) [ ] ");
    });
});
