import { describe, expect, it } from "vitest";

import { resolveLinuxRepoGpgPassphrase } from "./linux-repo-signing-env.mjs";

describe("Linux repository signing environment", () => {
    it("prefers the neutral Linux repository passphrase name", () => {
        expect(
            resolveLinuxRepoGpgPassphrase({
                APT_REPO_GPG_PASSPHRASE: "legacy-passphrase",
                LINUX_REPO_GPG_PASSPHRASE: "linux-passphrase",
            }),
        ).toBe("linux-passphrase");
    });

    it("falls back to the legacy APT repository passphrase name", () => {
        expect(
            resolveLinuxRepoGpgPassphrase({
                APT_REPO_GPG_PASSPHRASE: "legacy-passphrase",
            }),
        ).toBe("legacy-passphrase");
    });

    it("falls back when the neutral Linux repository passphrase is empty", () => {
        expect(
            resolveLinuxRepoGpgPassphrase({
                APT_REPO_GPG_PASSPHRASE: "legacy-passphrase",
                LINUX_REPO_GPG_PASSPHRASE: "",
            }),
        ).toBe("legacy-passphrase");
    });

    it("returns an empty passphrase when no signing passphrase is configured", () => {
        expect(resolveLinuxRepoGpgPassphrase({})).toBe("");
    });
});
