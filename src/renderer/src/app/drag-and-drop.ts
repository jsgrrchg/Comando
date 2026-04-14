export const COMPOSER_PROJECT_ENTRY_MIME =
    "application/x-comando-composer-project-entry";

export interface ComposerProjectEntryDragData {
    readonly kind: "directory" | "file";
    readonly name: string;
    readonly relativePath: string;
}

export function serializeComposerProjectEntryDragData(
    data: ComposerProjectEntryDragData,
): string {
    return JSON.stringify(data);
}

export function parseComposerProjectEntryDragData(
    value: string,
): ComposerProjectEntryDragData | null {
    if (!value) {
        return null;
    }

    try {
        const parsed = JSON.parse(value) as Partial<ComposerProjectEntryDragData>;
        if (
            (parsed.kind === "file" || parsed.kind === "directory") &&
            typeof parsed.name === "string" &&
            parsed.name.length > 0 &&
            typeof parsed.relativePath === "string" &&
            parsed.relativePath.length > 0
        ) {
            return {
                kind: parsed.kind,
                name: parsed.name,
                relativePath: parsed.relativePath,
            };
        }
    } catch {
        return null;
    }

    return null;
}
