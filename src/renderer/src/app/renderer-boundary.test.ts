import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("renderer entry boundaries", () => {
    it("keeps surface-only workspace modules out of static host imports", () => {
        const hostSource = readFileSync(
            path.join(process.cwd(), "src/renderer/src/App.tsx"),
            "utf8",
        );

        expect(hostSource).not.toMatch(
            /^import .*WorkspaceView.*from .*WorkspaceView/m,
        );
        expect(hostSource).not.toMatch(
            /^import .*WorkspaceTerminalHost.*from .*WorkspaceTerminalHost/m,
        );
    });
});
