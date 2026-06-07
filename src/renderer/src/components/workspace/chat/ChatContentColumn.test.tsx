import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
    CHAT_CONTENT_MAX_WIDTH_PX,
    ChatContentColumn,
} from "./ChatContentColumn";

describe("ChatContentColumn", () => {
    it("centers chat content under the shared max width", () => {
        const markup = renderToStaticMarkup(
            createElement(
                ChatContentColumn,
                { className: "min-w-0" },
                "content",
            ),
        );

        expect(markup).toContain("margin-inline:auto");
        expect(markup).toContain(`max-width:${CHAT_CONTENT_MAX_WIDTH_PX}px`);
        expect(markup).toContain("width:100%");
        expect(markup).toContain("min-w-0");
    });
});
