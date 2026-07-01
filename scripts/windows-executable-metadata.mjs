export function createWindowsExecutableMetadataSpec({
    productName,
    version,
}) {
    return {
        fileDescription: productName,
        fileVersion: version,
        productName,
        productVersion: version,
    };
}

export function buildRceditExecutableMetadataArgs({
    executablePath,
    iconPath,
    metadata,
}) {
    return [
        executablePath,
        "--set-version-string",
        "FileDescription",
        metadata.fileDescription,
        "--set-version-string",
        "ProductName",
        metadata.productName,
        "--set-file-version",
        metadata.fileVersion,
        "--set-product-version",
        metadata.productVersion,
        "--set-icon",
        iconPath,
    ];
}

export function buildReadWindowsExecutableMetadataPowerShellArgs(executablePath) {
    return [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        [
            "$ErrorActionPreference = 'Stop'",
            "$exePath = $args[0]",
            "$versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exePath)",
            "Add-Type -AssemblyName System.Drawing",
            "$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath)",
            "$iconWidth = 0",
            "$iconHeight = 0",
            "if ($null -ne $icon) { $iconWidth = $icon.Width; $iconHeight = $icon.Height }",
            "$signature = Get-AuthenticodeSignature -FilePath $exePath",
            "$signatureSubject = $null",
            "if ($null -ne $signature.SignerCertificate) { $signatureSubject = $signature.SignerCertificate.Subject }",
            "$result = [pscustomobject]@{",
            "  ProductName = $versionInfo.ProductName",
            "  FileDescription = $versionInfo.FileDescription",
            "  FileVersion = $versionInfo.FileVersion",
            "  ProductVersion = $versionInfo.ProductVersion",
            "  IconWidth = $iconWidth",
            "  IconHeight = $iconHeight",
            "  SignatureStatus = $signature.Status.ToString()",
            "  SignatureSubject = $signatureSubject",
            "}",
            "$result | ConvertTo-Json -Compress",
        ].join("\n"),
        executablePath,
    ];
}

export function parseWindowsExecutableMetadataJson(output) {
    const trimmedOutput = output.trim();
    if (!trimmedOutput) {
        throw new Error("Windows executable metadata inspection returned no output.");
    }

    const parsed = JSON.parse(trimmedOutput);

    return {
        fileDescription: normalizeString(parsed.FileDescription),
        fileVersion: normalizeString(parsed.FileVersion),
        iconHeight: normalizeNumber(parsed.IconHeight),
        iconWidth: normalizeNumber(parsed.IconWidth),
        productName: normalizeString(parsed.ProductName),
        productVersion: normalizeString(parsed.ProductVersion),
        signatureStatus: normalizeString(parsed.SignatureStatus),
        signatureSubject: normalizeString(parsed.SignatureSubject),
    };
}

export function shouldRequireWindowsExecutableSignature(env = process.env) {
    return [
        "CSC_LINK",
        "WIN_CSC_LINK",
        "WINDOWS_CSC_LINK",
        "AZURE_TENANT_ID",
        "AZURE_CLIENT_ID",
        "AZURE_KEY_VAULT_URI",
        "WINDOWS_SIGNING_REQUIRED",
    ].some((name) => isTruthyEnvValue(env[name]));
}

export function verifyWindowsExecutableMetadataSnapshot({
    executablePath,
    expected,
    metadata,
    relativePath = defaultRelativePath,
    requireSignature = false,
}) {
    const errors = [];
    const executableLabel = relativePath(executablePath);

    assertEqual(errors, "ProductName", metadata.productName, expected.productName);
    assertEqual(
        errors,
        "FileDescription",
        metadata.fileDescription,
        expected.fileDescription,
    );
    assertVersionContains(
        errors,
        "FileVersion",
        metadata.fileVersion,
        expected.fileVersion,
    );
    assertVersionContains(
        errors,
        "ProductVersion",
        metadata.productVersion,
        expected.productVersion,
    );

    if (!metadata.iconWidth || !metadata.iconHeight) {
        errors.push("Icon resource could not be extracted.");
    }

    if (requireSignature && metadata.signatureStatus !== "Valid") {
        errors.push(
            `SignatureStatus expected Valid but received ${formatValue(metadata.signatureStatus)}.`,
        );
    }

    if (errors.length > 0) {
        throw new Error(
            `Windows executable metadata verification failed for ${executableLabel}: ${errors.join(" ")}`,
        );
    }
}

function assertEqual(errors, label, actual, expected) {
    if (actual !== expected) {
        errors.push(
            `${label} expected ${formatValue(expected)} but received ${formatValue(actual)}.`,
        );
    }
}

function assertVersionContains(errors, label, actual, expected) {
    if (!actual || !actual.includes(expected)) {
        errors.push(
            `${label} expected to include ${formatValue(expected)} but received ${formatValue(actual)}.`,
        );
    }
}

function normalizeString(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value.trim();
}

function normalizeNumber(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : 0;
}

function isTruthyEnvValue(value) {
    if (!value) {
        return false;
    }

    return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function formatValue(value) {
    return JSON.stringify(value ?? "");
}

function defaultRelativePath(filePath) {
    return filePath;
}
