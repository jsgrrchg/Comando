import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const styles = readFileSync(
    join(process.cwd(), "src/renderer/src/styles.css"),
    "utf8",
);

describe("shell accessibility styles", () => {
    it("keeps secondary shell text at WCAG AA contrast in both themes", () => {
        expect(contrastRatio("#6f6f6f", "#f5f5f5")).toBeGreaterThanOrEqual(
            4.5,
        );
        expect(contrastRatio("#909090", "#252525")).toBeGreaterThanOrEqual(
            4.5,
        );
        expect(contrastRatio("#5f62e8", "#ffffff")).toBeGreaterThanOrEqual(
            4.5,
        );
        expect(contrastRatio("#818cf8", "#1c1c1c")).toBeGreaterThanOrEqual(
            4.5,
        );
        expect(styles).toContain("--color-text-secondary: #6f6f6f");
        expect(styles).toContain("--color-text-secondary: #909090");
    });

    it("removes nonessential shell motion and blur when requested", () => {
        expect(styles).toMatch(
            /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.shell-responsive-grid[\s\S]*?transition: none !important/,
        );
        expect(styles).toMatch(
            /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.shell-drawer[\s\S]*?animation: none !important/,
        );
        expect(styles).toMatch(
            /data-transparency-enabled="false"\] \.shell-drawer-backdrop[\s\S]*?backdrop-filter: none/,
        );
        expect(styles).toMatch(
            /data-transparency-enabled="false"\] \.shell-modal-backdrop[\s\S]*?backdrop-filter: none !important/,
        );
    });
});

function contrastRatio(foreground: string, background: string): number {
    const foregroundLuminance = relativeLuminance(foreground);
    const backgroundLuminance = relativeLuminance(background);
    return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
    );
}

function relativeLuminance(hex: string): number {
    const channels = [1, 3, 5].map((offset) => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (
        (channels[0] ?? 0) * 0.2126 +
        (channels[1] ?? 0) * 0.7152 +
        (channels[2] ?? 0) * 0.0722
    );
}
