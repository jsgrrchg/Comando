import { describe, expect, it } from "vitest";

import { supportsWindowsAcrylicMaterial } from "./windows-material";

describe("supportsWindowsAcrylicMaterial", () => {
    it("enables acrylic on Windows 11 builds", () => {
        expect(supportsWindowsAcrylicMaterial("win32", "10.0.22000")).toBe(
            true,
        );
        expect(supportsWindowsAcrylicMaterial("win32", "10.0.26100")).toBe(
            true,
        );
    });

    it("disables acrylic on Windows 10 builds", () => {
        expect(supportsWindowsAcrylicMaterial("win32", "10.0.19045")).toBe(
            false,
        );
    });

    it("does not affect non-Windows platforms", () => {
        expect(supportsWindowsAcrylicMaterial("darwin", "24.0.0")).toBe(
            false,
        );
        expect(supportsWindowsAcrylicMaterial("linux", "6.8.0")).toBe(false);
    });
});
