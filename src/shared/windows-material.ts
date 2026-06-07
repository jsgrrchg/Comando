export const WINDOWS_11_BUILD_NUMBER = 22000;

export function supportsWindowsAcrylicMaterial(
    platform: string,
    osRelease: string,
): boolean {
    if (platform !== "win32") {
        return false;
    }

    const buildNumber = Number(osRelease.split(".")[2]);
    return (
        Number.isFinite(buildNumber) &&
        buildNumber >= WINDOWS_11_BUILD_NUMBER
    );
}
