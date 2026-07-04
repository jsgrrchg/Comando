import path from "node:path";

import { resolveLinuxReleaseArtifacts } from "./linux-release-metadata.mjs";
import { resolveMacReleaseArtifacts } from "./mac-release-metadata.mjs";
import { resolveWindowsReleaseArtifacts } from "./windows-release-metadata.mjs";

export const RELEASE_TARGETS = Object.freeze([
    {
        artifactName: "release-assets-macos-universal",
        id: "darwin-universal",
        platform: "darwin",
    },
    {
        artifactName: "release-assets-windows-x64",
        id: "win-x64",
        platform: "win32",
        targetArch: "x64",
    },
    {
        artifactName: "release-assets-windows-arm64",
        id: "win-arm64",
        platform: "win32",
        targetArch: "arm64",
    },
    {
        artifactName: "release-assets-linux-x64",
        id: "linux-x64",
        platform: "linux",
        targetArch: "x64",
    },
    {
        artifactName: "release-assets-linux-arm64",
        id: "linux-arm64",
        platform: "linux",
        targetArch: "arm64",
    },
]);

export function normalizeReleaseVersion(versionOrTag) {
    const version = String(versionOrTag ?? "").replace(/^v/u, "");
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)) {
        throw new Error(
            `Expected release version X.Y.Z or vX.Y.Z, got ${versionOrTag}.`,
        );
    }
    return version;
}

export function resolveReleaseTargetArtifacts({
    distDir,
    packageJson,
    target,
    version,
}) {
    const productName = packageJson.build?.productName ?? packageJson.name;
    const normalizedVersion = normalizeReleaseVersion(version);

    if (target.platform === "darwin") {
        const artifacts = resolveMacReleaseArtifacts({
            distDir,
            productName,
            version: normalizedVersion,
        });

        return {
            artifactName: target.artifactName,
            files: [
                artifacts.dmgPath,
                artifacts.zipPath,
                artifacts.metadataPath,
            ],
            id: target.id,
            metadataPath: artifacts.metadataPath,
            primaryArtifactName: artifacts.zipFileName,
        };
    }

    if (target.platform === "win32") {
        const artifacts = resolveWindowsReleaseArtifacts({
            distDir,
            productName,
            targetArch: target.targetArch,
            version: normalizedVersion,
        });

        return {
            artifactName: target.artifactName,
            files: [
                artifacts.installerPath,
                artifacts.blockmapPath,
                artifacts.metadataPath,
            ],
            id: target.id,
            metadataPath: artifacts.metadataPath,
            primaryArtifactName: artifacts.installerFileName,
        };
    }

    if (target.platform === "linux") {
        const artifacts = resolveLinuxReleaseArtifacts({
            distDir,
            productName,
            targetArch: target.targetArch,
            version: normalizedVersion,
        });

        return {
            artifactName: target.artifactName,
            files: [
                artifacts.appImagePath,
                artifacts.debPath,
                artifacts.rpmPath,
                artifacts.metadataPath,
            ],
            id: target.id,
            metadataPath: artifacts.metadataPath,
            primaryArtifactName: path.basename(artifacts.appImagePath),
        };
    }

    throw new Error(`Unsupported release target platform: ${target.platform}.`);
}
