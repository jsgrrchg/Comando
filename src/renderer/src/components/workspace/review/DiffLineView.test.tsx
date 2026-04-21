import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DiffLineView } from "./DiffLineView";

describe("DiffLineView", () => {
    it("renders exact lines with both line-number columns", () => {
        const markup = renderToStaticMarkup(
            <DiffLineView
                line={{
                    exact: true,
                    newLineNumber: 11,
                    oldLineNumber: 10,
                    prefix: "- ",
                    text: "const before = true;",
                    type: "remove",
                }}
            />,
        );

        expect(markup).toContain('data-line-exact="true"');
        expect(markup).toContain('data-line-type="remove"');
        expect(markup).toContain("10");
        expect(markup).toContain("11");
        expect(markup).toContain("const before = true;");
    });

    it("renders compact/separator rows with the shared diff attributes", () => {
        const compactMarkup = renderToStaticMarkup(
            <DiffLineView
                compactLineNumbers
                line={{
                    newLineNumber: 22,
                    oldLineNumber: null,
                    prefix: "+ ",
                    text: "const after = true;",
                    type: "add",
                }}
            />,
        );
        const separatorMarkup = renderToStaticMarkup(
            <DiffLineView
                line={{
                    exact: true,
                    prefix: "",
                    text: "···",
                    type: "separator",
                }}
            />,
        );

        expect(compactMarkup).toContain('data-line-type="add"');
        expect(compactMarkup).toContain("border-left:none");
        expect(compactMarkup).toContain(
            "border-left:2px solid color-mix(in srgb, var(--diff-add) 45%, transparent)",
        );
        expect(compactMarkup).toContain("22");
        expect(compactMarkup).toContain("const after = true;");
        expect(separatorMarkup).toContain('data-line-type="separator"');
        expect(separatorMarkup).toContain("···");
    });
});
