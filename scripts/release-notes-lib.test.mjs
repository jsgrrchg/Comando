import { describe, expect, it } from "vitest";

import {
    buildManualDownloadRows,
    buildReleaseBody,
    getChangelogEntry,
    normalizeReleaseVersion,
    parseChangelogEntries,
} from "./release-notes-lib.mjs";

const packageJson = {
    build: {
        productName: "Comando",
    },
    name: "comando",
};

describe("release notes metadata", () => {
    it("normalizes strict release tags and versions", () => {
        expect(normalizeReleaseVersion("0.1.0")).toBe("0.1.0");
        expect(normalizeReleaseVersion("v0.1.0")).toBe("0.1.0");
        expect(() => normalizeReleaseVersion("0.1")).toThrow(
            /Expected X\.Y\.Z/u,
        );
    });

    it("extracts changelog entries by release heading", () => {
        const changelog = [
            "# Changelog",
            "",
            "## [0.2.0] - 2026-06-29",
            "",
            "### Added",
            "",
            "- Added release body generation.",
            "",
            "## [0.1.0] - 2026-04-19",
            "",
            "Public launch.",
            "",
        ].join("\n");

        expect(parseChangelogEntries(changelog)).toHaveLength(2);
        expect(getChangelogEntry(changelog, "v0.2.0")).toEqual({
            notes: [
                "### Added",
                "",
                "- Added release body generation.",
            ].join("\n"),
            version: "0.2.0",
        });
    });

    it("builds manual download rows that match release artifact names", () => {
        expect(
            buildManualDownloadRows({
                packageJson,
                version: "0.1.0",
            }).map((row) => row.assetName),
        ).toEqual([
            "Comando-0.1.0-universal.dmg",
            "Comando-0.1.0-win-x64.exe",
            "Comando-0.1.0-win-arm64.exe",
            "Comando-0.1.0-linux-x64.deb",
            "Comando-0.1.0-linux-arm64.deb",
            "Comando-0.1.0-linux-x64.rpm",
            "Comando-0.1.0-linux-arm64.rpm",
            "Comando-0.1.0-linux-x64.AppImage",
            "Comando-0.1.0-linux-arm64.AppImage",
        ]);
    });

    it("renders release notes after installer guidance", () => {
        expect(
            buildReleaseBody({
                notes: "Public launch.",
                packageJson,
                version: "v0.1.0",
            }),
        ).toContain(["## Release notes", "", "Public launch."].join("\n"));
    });

    it("renders APT repository setup instructions", () => {
        const body = buildReleaseBody({
            notes: "Public launch.",
            packageJson,
            version: "v0.1.0",
        });

        expect(body).toContain("sudo apt install comando");
        expect(body).toContain(
            "https://jsgrrchg.github.io/Comando/apt/comando-archive-keyring.asc",
        );
        expect(body).toContain(
            "https://github.com/jsgrrchg/Comando/releases/latest/download",
        );
        expect(body).not.toContain("APT and DNF repositories are not configured");
    });

    it("renders DNF repository setup instructions", () => {
        const body = buildReleaseBody({
            notes: "Public launch.",
            packageJson,
            version: "v0.1.0",
        });

        expect(body).toContain("sudo tee /etc/yum.repos.d/comando.repo");
        expect(body).toContain("repo_gpgcheck=1");
        expect(body).toContain("sudo dnf install comando");
        expect(body).toContain(
            "https://jsgrrchg.github.io/Comando/dnf/comando-archive-keyring.asc",
        );
        expect(body).toContain(
            "For Fedora/RHEL, use the `.rpm` package directly or configure the Comando DNF repository",
        );
    });
});
