import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

describe("privacy access helpers", () => {
    it("recognizes macOS permission denied error codes", async () => {
        vi.resetModules();
        const module = await import("./privacy-access");

        const eaccesError = Object.assign(new Error("denied"), {
            code: "EACCES",
        });
        const epermError = Object.assign(new Error("denied"), {
            code: "EPERM",
        });

        expect(module.isMacOsPrivacyPermissionDeniedError(eaccesError)).toBe(
            true,
        );
        expect(module.isMacOsPrivacyPermissionDeniedError(epermError)).toBe(
            true,
        );
        expect(
            module.isMacOsPrivacyPermissionDeniedError(
                Object.assign(new Error("other"), {
                    code: "ENOENT",
                }),
            ),
        ).toBe(false);
    });

    it("matches protected home directories on macOS", async () => {
        vi.resetModules();
        const platformSpy = vi
            .spyOn(process, "platform", "get")
            .mockReturnValue("darwin");
        const module = await import("./privacy-access");
        const homeDirectory = os.homedir();

        expect(
            module.isLikelyProtectedMacOsPath(
                path.join(homeDirectory, "Documents", "Comando"),
            ),
        ).toBe(true);
        expect(
            module.isLikelyProtectedMacOsPath(
                path.join(homeDirectory, "Desktop", "notes.txt"),
            ),
        ).toBe(true);
        expect(
            module.isLikelyProtectedMacOsPath(
                path.join(homeDirectory, "code", "repo"),
            ),
        ).toBe(false);

        platformSpy.mockRestore();
    });
});
