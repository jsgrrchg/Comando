import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import {
    DNF_DEFAULT_BASE_URL,
    DNF_PACKAGE_NAME,
    DNF_PUBLIC_KEY_FILE_NAME,
    DNF_REPO_EXAMPLE_FILE_NAME,
    DNF_SUPPORTED_ARCHITECTURES,
    buildComandoRepoExample,
    buildGitHubReleaseRpmLocationPrefix,
    buildGitHubReleaseRpmUrl,
    buildRpmReleaseAssetName,
    normalizeRpmArchitecture,
} from "./dnf-repo-lib.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const VALIDATE_DNF_REPOSITORY_SCRIPT = path.join(
    SCRIPTS_DIR,
    "validate-dnf-repository.mjs",
);

function withTempDir(callback) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-dnf-test-"));
    try {
        return callback(tempDir);
    } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
    }
}

function writeFixtureDnfRepository(
    rootDir,
    {
        includePackageBinary = false,
        packageLocationBase = "https://github.com/jsgrrchg/Comando/releases/download/v0.1.0",
        repoExample = buildComandoRepoExample(),
        version = "0.1.0",
    } = {},
) {
    const dnfDir = path.join(rootDir, "dnf");
    const repodataDir = path.join(dnfDir, "repodata");
    fs.mkdirSync(repodataDir, { recursive: true });

    const packages = DNF_SUPPORTED_ARCHITECTURES.map((architecture) => {
        const assetName = buildRpmReleaseAssetName(version, architecture);
        return [
            '<package type="rpm">',
            `<name>${DNF_PACKAGE_NAME}</name>`,
            `<arch>${architecture}</arch>`,
            `<version epoch="0" ver="${version}" rel="1"/>`,
            `<location href="${packageLocationBase}/${assetName}"/>`,
            `<rpm:provides><rpm:entry name="${DNF_PACKAGE_NAME}"/></rpm:provides>`,
            '<rpm:requires><rpm:entry name="bash"/></rpm:requires>',
            '<rpm:header-range start="0" end="1"/>',
            "</package>",
        ].join("");
    }).join("");

    fs.writeFileSync(
        path.join(repodataDir, "primary.xml.gz"),
        zlib.gzipSync(`<metadata>${packages}</metadata>`),
    );
    fs.writeFileSync(
        path.join(repodataDir, "filelists.xml.gz"),
        zlib.gzipSync(
            `<filelists><package name="${DNF_PACKAGE_NAME}"><file>/usr/bin/${DNF_PACKAGE_NAME}</file></package></filelists>`,
        ),
    );
    fs.writeFileSync(
        path.join(repodataDir, "repomd.xml"),
        [
            '<repomd xmlns="http://linux.duke.edu/metadata/repo">',
            '<data type="primary">',
            `<checksum type="sha256">${"a".repeat(64)}</checksum>`,
            '<location href="repodata/primary.xml.gz"/>',
            "</data>",
            "</repomd>",
        ].join(""),
    );
    fs.writeFileSync(path.join(repodataDir, "repomd.xml.asc"), "signature");
    fs.writeFileSync(path.join(dnfDir, DNF_REPO_EXAMPLE_FILE_NAME), repoExample);
    fs.writeFileSync(path.join(dnfDir, DNF_PUBLIC_KEY_FILE_NAME), "public-key");

    if (includePackageBinary) {
        fs.writeFileSync(
            path.join(dnfDir, buildRpmReleaseAssetName(version, "x86_64")),
            "rpm",
        );
    }

    return dnfDir;
}

function validateDnfRepository(dnfDir, version = "0.1.0") {
    return childProcess.spawnSync(
        process.execPath,
        [
            VALIDATE_DNF_REPOSITORY_SCRIPT,
            "--dnf-dir",
            dnfDir,
            "--version",
            version,
            "--skip-signature-check",
        ],
        { encoding: "utf8" },
    );
}

describe("DNF repository metadata", () => {
    it("maps RPM architectures to release asset names", () => {
        expect(buildRpmReleaseAssetName("0.1.0", "x86_64")).toBe(
            "Comando-0.1.0-linux-x64.rpm",
        );
        expect(buildRpmReleaseAssetName("0.1.0", "aarch64")).toBe(
            "Comando-0.1.0-linux-arm64.rpm",
        );
    });

    it("normalizes supported RPM architectures only", () => {
        expect(normalizeRpmArchitecture("x86_64")).toBe("x86_64");
        expect(normalizeRpmArchitecture("aarch64")).toBe("aarch64");
        expect(() => normalizeRpmArchitecture("x64")).toThrow(/Unsupported/u);
        expect(() => normalizeRpmArchitecture("amd64")).toThrow(/Unsupported/u);
        expect(() => normalizeRpmArchitecture("arm64")).toThrow(/Unsupported/u);
    });

    it("builds GitHub Release RPM URLs with versioned download paths", () => {
        expect(
            buildGitHubReleaseRpmLocationPrefix("jsgrrchg/Comando", "v0.1.0"),
        ).toBe("https://github.com/jsgrrchg/Comando/releases/download/v0.1.0/");
        expect(
            buildGitHubReleaseRpmUrl(
                "jsgrrchg/Comando",
                "v0.1.0",
                "0.1.0",
                "x86_64",
            ),
        ).toBe(
            "https://github.com/jsgrrchg/Comando/releases/download/v0.1.0/Comando-0.1.0-linux-x64.rpm",
        );
    });

    it("renders the public Comando repo example", () => {
        const example = buildComandoRepoExample();

        expect(example).toContain(`[comando]`);
        expect(example).toContain(`baseurl=${DNF_DEFAULT_BASE_URL}`);
        expect(example).toContain("gpgcheck=1");
        expect(example).toContain("repo_gpgcheck=1");
        expect(example).toContain(
            `gpgkey=${DNF_DEFAULT_BASE_URL}/${DNF_PUBLIC_KEY_FILE_NAME}`,
        );
    });

    it("validates metadata that references GitHub Release RPM assets", () => {
        withTempDir((tempDir) => {
            const dnfDir = writeFixtureDnfRepository(tempDir);
            const result = validateDnfRepository(dnfDir);

            expect(result.stderr).toBe("");
            expect(result.status).toBe(0);
            expect(result.stdout).toContain(
                "DNF repository is valid for version 0.1.0",
            );
        });
    });

    it("rejects package binaries inside the DNF metadata tree", () => {
        withTempDir((tempDir) => {
            const dnfDir = writeFixtureDnfRepository(tempDir, {
                includePackageBinary: true,
            });
            const result = validateDnfRepository(dnfDir);

            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(
                "package binaries on GitHub Releases",
            );
        });
    });

    it("rejects package locations pointing to GitHub Pages", () => {
        withTempDir((tempDir) => {
            const dnfDir = writeFixtureDnfRepository(tempDir, {
                packageLocationBase: "https://jsgrrchg.github.io/Comando/dnf",
            });
            const result = validateDnfRepository(dnfDir);

            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(
                "missing GitHub Release location",
            );
        });
    });

    it("rejects repo examples without repo_gpgcheck", () => {
        withTempDir((tempDir) => {
            const dnfDir = writeFixtureDnfRepository(tempDir, {
                repoExample: buildComandoRepoExample().replace(
                    "repo_gpgcheck=1\n",
                    "",
                ),
            });
            const result = validateDnfRepository(dnfDir);

            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(
                "repo_gpgcheck=1",
            );
        });
    });
});
