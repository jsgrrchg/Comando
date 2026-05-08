export const COMPOSER_PROJECT_ENTRY_MIME =
    "application/x-comando-composer-project-entry";
export const COMPOSER_PROJECT_ENTRY_LIST_MIME =
    "application/x-comando-composer-project-entry-list";
export const WORKSPACE_TAB_COMPOSER_DRAG_EVENT =
    "comando:workspace-tab-composer-drag";

const FILE_EXTENSION_MIME_MAP: Record<string, string> = {
    csv: "text/csv",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    md: "text/markdown",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    toml: "text/toml",
    txt: "text/plain",
    webp: "image/webp",
    xml: "application/xml",
    yaml: "text/yaml",
    yml: "text/yaml",
};

interface FileWithSystemPath extends File {
    readonly path?: string;
}

type DataTransferItemWithEntry = DataTransferItem & {
    readonly webkitGetAsEntry?: () => FileSystemEntry | null;
};

export interface ComposerProjectEntryDragData {
    readonly kind: "directory" | "file";
    readonly name: string;
    readonly relativePath: string;
}

export interface ComposerProjectEntryListDragData {
    readonly entries: readonly ComposerProjectEntryDragData[];
}

export type ExternalComposerDropItem =
    | {
          readonly kind: "file_attachment";
          readonly filePath: string;
          readonly label: string;
          readonly mimeType: string;
      }
    | {
          readonly kind: "folder_mention";
          readonly folderPath: string;
          readonly label: string;
      };

export type WorkspaceTabComposerDragItem = {
    readonly kind: "file_mention";
    readonly label: string;
    readonly relativePath: string;
} | {
    readonly kind: "git_commit_mention";
    readonly commitSha: string;
    readonly label: string;
} | {
    readonly host: string;
    readonly kind: "github_issue_mention";
    readonly label: string;
    readonly number: number;
    readonly owner: string;
    readonly repo: string;
    readonly title: string;
    readonly url: string;
} | {
    readonly host: string;
    readonly kind: "github_pull_request_mention";
    readonly label: string;
    readonly number: number;
    readonly owner: string;
    readonly repo: string;
    readonly title: string;
    readonly url: string;
};

export type WorkspaceTabComposerDragPhase = "start" | "move" | "end" | "cancel";

export interface WorkspaceTabComposerDragDetail {
    readonly phase: WorkspaceTabComposerDragPhase;
    readonly x: number;
    readonly y: number;
    readonly item: WorkspaceTabComposerDragItem | null;
}

export function serializeComposerProjectEntryDragData(
    data: ComposerProjectEntryDragData,
): string {
    return JSON.stringify(data);
}

export function serializeComposerProjectEntryListDragData(
    data: ComposerProjectEntryListDragData,
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
        const parsed = JSON.parse(
            value,
        ) as Partial<ComposerProjectEntryDragData>;
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

export function parseComposerProjectEntryListDragData(
    value: string,
): ComposerProjectEntryListDragData | null {
    if (!value) {
        return null;
    }

    try {
        const parsed = JSON.parse(value) as Partial<ComposerProjectEntryListDragData>;
        if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
            return null;
        }

        const entries = parsed.entries
            .map((entry) =>
                parseComposerProjectEntryDragData(JSON.stringify(entry)),
            )
            .filter(
                (entry): entry is ComposerProjectEntryDragData =>
                    entry !== null,
            );

        if (entries.length !== parsed.entries.length) {
            return null;
        }

        return { entries };
    } catch {
        return null;
    }
}

export function emitWorkspaceTabComposerDrag(
    detail: WorkspaceTabComposerDragDetail,
): void {
    window.dispatchEvent(
        new CustomEvent<WorkspaceTabComposerDragDetail>(
            WORKSPACE_TAB_COMPOSER_DRAG_EVENT,
            {
                detail,
            },
        ),
    );
}

export function isPointOverComposerDropZone(
    clientX: number,
    clientY: number,
): boolean {
    const dropZones = document.querySelectorAll<HTMLElement>(
        '[data-ai-composer-drop-zone="true"]',
    );

    for (const zone of dropZones) {
        const rect = zone.getBoundingClientRect();
        if (
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom
        ) {
            return true;
        }
    }

    return false;
}

export function getExternalComposerDropItems(
    dataTransfer: DataTransfer,
): ExternalComposerDropItem[] {
    const items: ExternalComposerDropItem[] = [];
    const seenPaths = new Set<string>();

    const pushItem = (item: ExternalComposerDropItem) => {
        const itemPath =
            item.kind === "folder_mention" ? item.folderPath : item.filePath;
        const normalizedKey = itemPath.replaceAll("\\", "/");
        if (!normalizedKey || seenPaths.has(normalizedKey)) {
            return;
        }
        seenPaths.add(normalizedKey);
        items.push(item);
    };

    const dragItems = Array.from(dataTransfer.items);
    if (dragItems.length > 0) {
        for (const item of dragItems) {
            if (item.kind !== "file") {
                continue;
            }

            const file = item.getAsFile();
            const itemPath = getDroppedFilePath(file);
            if (!itemPath) {
                continue;
            }

            const entry =
                (item as DataTransferItemWithEntry).webkitGetAsEntry?.() ??
                null;
            const label = getPathBaseName(itemPath);

            if (entry?.isDirectory || isLikelyDirectoryDrop(itemPath, file)) {
                pushItem({
                    folderPath: itemPath,
                    kind: "folder_mention",
                    label,
                });
                continue;
            }

            pushItem({
                filePath: itemPath,
                kind: "file_attachment",
                label,
                mimeType: file?.type || inferMimeTypeFromPath(itemPath),
            });
        }

        if (items.length > 0) {
            return items;
        }
    }

    for (const file of Array.from(dataTransfer.files)) {
        const itemPath = getDroppedFilePath(file);
        if (!itemPath) {
            continue;
        }

        pushItem({
            filePath: itemPath,
            kind: "file_attachment",
            label: getPathBaseName(itemPath),
            mimeType: file.type || inferMimeTypeFromPath(itemPath),
        });
    }

    return items;
}

export function inferMimeTypeFromPath(filePath: string): string {
    const fileName = getPathBaseName(filePath);
    const dotIndex = fileName.lastIndexOf(".");
    if (dotIndex < 0 || dotIndex === fileName.length - 1) {
        return "application/octet-stream";
    }

    const extension = fileName.slice(dotIndex + 1).toLowerCase();
    return FILE_EXTENSION_MIME_MAP[extension] ?? "application/octet-stream";
}

function getDroppedFilePath(file: File | null): string | null {
    const candidate =
        (file as FileWithSystemPath | null)?.path ??
        resolveDroppedFilePathFromBridge(file);
    if (typeof candidate !== "string") {
        return null;
    }

    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveDroppedFilePathFromBridge(file: File | null): string | null {
    if (!file || typeof window === "undefined" || !("comando" in window)) {
        return null;
    }

    try {
        return window.comando.resolveDroppedFilePath(file);
    } catch {
        return null;
    }
}

function getPathBaseName(candidatePath: string): string {
    const normalized = candidatePath.replace(/[\\/]+$/, "");
    const slashIndex = Math.max(
        normalized.lastIndexOf("/"),
        normalized.lastIndexOf("\\"),
    );
    return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function isLikelyDirectoryDrop(
    candidatePath: string,
    file: File | null,
): boolean {
    const fileName = getPathBaseName(candidatePath);
    return Boolean(
        fileName &&
        !fileName.includes(".") &&
        file?.type === "" &&
        file?.size === 0,
    );
}
