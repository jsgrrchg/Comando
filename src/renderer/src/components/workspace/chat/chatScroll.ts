export function isScrollViewportNearBottom(
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    threshold: number,
): boolean {
    return scrollHeight - scrollTop - clientHeight < threshold;
}
