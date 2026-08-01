export function collectInitialInternalNavigationUrls(
    argv: readonly string[],
): string[] {
    return argv.filter((argument) => argument.startsWith("comando://"));
}
