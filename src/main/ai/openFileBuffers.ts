// Tracks the latest in-editor buffer content for files the user has opened
// in a workspace tab. The AI diff resolver prefers this over disk when
// available so pending agent edits are splice'd onto what the user actually
// sees, not the stale on-disk text.

const buffersByAbsolutePath = new Map<string, string>();

export function recordOpenFileBuffer(
    absolutePath: string,
    content: string,
): void {
    buffersByAbsolutePath.set(absolutePath, content);
}

export function forgetOpenFileBuffer(absolutePath: string): void {
    buffersByAbsolutePath.delete(absolutePath);
}

export function readOpenFileBuffer(absolutePath: string): string | null {
    return buffersByAbsolutePath.get(absolutePath) ?? null;
}

export function listOpenFileBuffers(): readonly {
    readonly absolutePath: string;
    readonly content: string;
}[] {
    return [...buffersByAbsolutePath.entries()].map(
        ([absolutePath, content]) => ({
            absolutePath,
            content,
        }),
    );
}
