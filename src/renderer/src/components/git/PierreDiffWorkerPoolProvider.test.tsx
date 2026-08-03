import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PierreDiffWorkerPoolProvider } from "./PierreDiffWorkerPoolProvider";

describe("PierreDiffWorkerPoolProvider", () => {
    it("is safe to render when browser workers are unavailable", () => {
        const markup = renderToStaticMarkup(
            <PierreDiffWorkerPoolProvider>
                <div>Git diff</div>
            </PierreDiffWorkerPoolProvider>,
        );

        expect(markup).toContain("Git diff");
    });
});
