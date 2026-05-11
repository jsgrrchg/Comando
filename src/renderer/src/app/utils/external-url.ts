export function openExternalUrl(url: string): void {
    const normalizedUrl = url.trim();
    if (!normalizedUrl) {
        return;
    }

    if (window.comando?.openExternalUrl) {
        void window.comando.openExternalUrl(normalizedUrl).catch(() => undefined);
        return;
    }

    if (/^https?:\/\//i.test(normalizedUrl)) {
        window.open(normalizedUrl, "_blank", "noopener,noreferrer");
    }
}
