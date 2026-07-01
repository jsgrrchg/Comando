import { describe, expect, it } from "vitest";

import {
    buildRceditExecutableMetadataArgs,
    buildReadWindowsExecutableMetadataPowerShellArgs,
    createWindowsExecutableMetadataSpec,
    parseWindowsExecutableMetadataJson,
    shouldRequireWindowsExecutableSignature,
    verifyWindowsExecutableMetadataSnapshot,
} from "./windows-executable-metadata.mjs";

describe("Windows executable metadata", () => {
    it("creates the expected VERSIONINFO metadata spec", () => {
        expect(
            createWindowsExecutableMetadataSpec({
                productName: "Comando",
                version: "1.2.3",
            }),
        ).toEqual({
            fileDescription: "Comando",
            fileVersion: "1.2.3",
            productName: "Comando",
            productVersion: "1.2.3",
        });
    });

    it("builds rcedit arguments for icon and version metadata", () => {
        expect(
            buildRceditExecutableMetadataArgs({
                executablePath: "dist/win-unpacked/Comando.exe",
                iconPath: "resources/icons/windows.ico",
                metadata: createWindowsExecutableMetadataSpec({
                    productName: "Comando",
                    version: "1.2.3",
                }),
            }),
        ).toEqual([
            "dist/win-unpacked/Comando.exe",
            "--set-version-string",
            "FileDescription",
            "Comando",
            "--set-version-string",
            "ProductName",
            "Comando",
            "--set-file-version",
            "1.2.3",
            "--set-product-version",
            "1.2.3",
            "--set-icon",
            "resources/icons/windows.ico",
        ]);
    });

    it("builds a PowerShell metadata inspection command", () => {
        const args = buildReadWindowsExecutableMetadataPowerShellArgs(
            "dist/win-unpacked/Comando.exe",
        );

        expect(args.slice(0, 6)).toEqual([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
        ]);
        expect(args[6]).toContain("Get-AuthenticodeSignature");
        expect(args[6]).toContain("ExtractAssociatedIcon");
        expect(args[6]).toContain("$result = [pscustomobject]@{\n");
        expect(args[6]).not.toContain("@{;");
        expect(args.at(-1)).toBe("dist/win-unpacked/Comando.exe");
    });

    it("parses PowerShell metadata JSON", () => {
        expect(
            parseWindowsExecutableMetadataJson(
                JSON.stringify({
                    FileDescription: " Comando ",
                    FileVersion: "1.2.3.0",
                    IconHeight: 256,
                    IconWidth: 256,
                    ProductName: "Comando",
                    ProductVersion: "1.2.3",
                    SignatureStatus: "Valid",
                    SignatureSubject: "CN=Comando",
                }),
            ),
        ).toEqual({
            fileDescription: "Comando",
            fileVersion: "1.2.3.0",
            iconHeight: 256,
            iconWidth: 256,
            productName: "Comando",
            productVersion: "1.2.3",
            signatureStatus: "Valid",
            signatureSubject: "CN=Comando",
        });
    });

    it("accepts matching metadata and an extracted icon", () => {
        expect(() =>
            verifyWindowsExecutableMetadataSnapshot({
                executablePath: "Comando.exe",
                expected: createWindowsExecutableMetadataSpec({
                    productName: "Comando",
                    version: "1.2.3",
                }),
                metadata: {
                    fileDescription: "Comando",
                    fileVersion: "1.2.3.0",
                    iconHeight: 256,
                    iconWidth: 256,
                    productName: "Comando",
                    productVersion: "1.2.3",
                    signatureStatus: "NotSigned",
                    signatureSubject: "",
                },
            }),
        ).not.toThrow();
    });

    it("rejects missing icon and mismatched metadata", () => {
        expect(() =>
            verifyWindowsExecutableMetadataSnapshot({
                executablePath: "Comando.exe",
                expected: createWindowsExecutableMetadataSpec({
                    productName: "Comando",
                    version: "1.2.3",
                }),
                metadata: {
                    fileDescription: "Electron",
                    fileVersion: "42.0.0",
                    iconHeight: 0,
                    iconWidth: 0,
                    productName: "Electron",
                    productVersion: "42.0.0",
                    signatureStatus: "NotSigned",
                    signatureSubject: "",
                },
            }),
        ).toThrow(/ProductName/u);
    });

    it("requires a valid signature only when signing is configured", () => {
        expect(
            shouldRequireWindowsExecutableSignature({
                CSC_LINK: "certificate",
            }),
        ).toBe(true);
        expect(
            shouldRequireWindowsExecutableSignature({
                WINDOWS_SIGNING_REQUIRED: "false",
            }),
        ).toBe(false);

        expect(() =>
            verifyWindowsExecutableMetadataSnapshot({
                executablePath: "Comando.exe",
                expected: createWindowsExecutableMetadataSpec({
                    productName: "Comando",
                    version: "1.2.3",
                }),
                metadata: {
                    fileDescription: "Comando",
                    fileVersion: "1.2.3.0",
                    iconHeight: 256,
                    iconWidth: 256,
                    productName: "Comando",
                    productVersion: "1.2.3",
                    signatureStatus: "NotSigned",
                    signatureSubject: "",
                },
                requireSignature: true,
            }),
        ).toThrow(/SignatureStatus/u);
    });
});
