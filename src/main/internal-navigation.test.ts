import { describe, expect, it } from "vitest";

import { collectInitialInternalNavigationUrls } from "./internal-navigation";

describe("initial internal navigation", () => {
    it("retains protocol URLs from the first process invocation", () => {
        expect(
            collectInitialInternalNavigationUrls([
                "/Applications/Comando",
                "--flag",
                "comando://workspace/project-a",
            ]),
        ).toEqual(["comando://workspace/project-a"]);
    });
});
