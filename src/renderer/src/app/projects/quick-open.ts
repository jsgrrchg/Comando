import type { ProjectTreeNode } from "@shared/ipc";
import {
    compactProjectSearchValue,
    getProjectSearchDepth,
    normalizeProjectSearchQuery,
    scoreProjectSearchCandidate,
} from "@shared/project-search";

export interface ProjectQuickOpenFile {
    readonly compactPath: string;
    readonly depth: number;
    readonly extension: string | null;
    readonly lowerName: string;
    readonly lowerPath: string;
    readonly name: string;
    readonly relativePath: string;
}

export interface ProjectQuickOpenMatch extends ProjectQuickOpenFile {
    readonly score: number;
}

export function collectProjectQuickOpenFiles(
    nodesByParent: Record<string, readonly ProjectTreeNode[]>,
): readonly ProjectQuickOpenFile[] {
    return collectProjectQuickOpenFilesFromEntries(
        Object.values(nodesByParent).flat(),
    );
}

export function collectProjectQuickOpenFilesFromEntries(
    entries: readonly ProjectTreeNode[],
): readonly ProjectQuickOpenFile[] {
    const files = new Map<string, ProjectQuickOpenFile>();

    for (const node of entries) {
        if (node.kind !== "file" || files.has(node.relativePath)) {
            continue;
        }

        files.set(node.relativePath, {
            compactPath: compactProjectSearchValue(node.relativePath),
            depth: getProjectSearchDepth(node.relativePath),
            extension: node.extension,
            lowerName: node.name.toLowerCase(),
            lowerPath: node.relativePath.toLowerCase(),
            name: node.name,
            relativePath: node.relativePath,
        });
    }

    return [...files.values()].sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
    );
}

export function searchProjectQuickOpenEntries(
    entries: readonly ProjectTreeNode[],
    query: string,
    limit = 80,
): readonly ProjectQuickOpenMatch[] {
    return searchProjectQuickOpenFiles(
        collectProjectQuickOpenFilesFromEntries(entries),
        query,
        limit,
    );
}

export function searchProjectQuickOpenFiles(
    files: readonly ProjectQuickOpenFile[],
    query: string,
    limit = 80,
): readonly ProjectQuickOpenMatch[] {
    const normalizedQuery = normalizeProjectSearchQuery(query);

    if (!normalizedQuery) {
        return files.slice(0, limit).map((file) => ({
            ...file,
            score: 0,
        }));
    }

    const matches: ProjectQuickOpenMatch[] = [];

    for (const file of files) {
        const score = scoreProjectSearchCandidate(file, normalizedQuery);
        if (score < 0) {
            continue;
        }

        matches.push({
            ...file,
            score,
        });
    }

    matches.sort((left, right) => {
        if (right.score !== left.score) {
            return right.score - left.score;
        }

        const nameComparison = left.name.localeCompare(right.name);
        if (nameComparison !== 0) {
            return nameComparison;
        }

        return left.relativePath.localeCompare(right.relativePath);
    });

    return matches.slice(0, limit);
}
