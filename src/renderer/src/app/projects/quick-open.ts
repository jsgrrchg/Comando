import type { ProjectTreeNode } from "@shared/ipc";

const PATH_SEPARATOR_PATTERN = /[/_.\-\s]+/g;

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
    const files = new Map<string, ProjectQuickOpenFile>();

    for (const nodes of Object.values(nodesByParent)) {
        for (const node of nodes) {
            if (node.kind !== "file" || files.has(node.relativePath)) {
                continue;
            }

            files.set(node.relativePath, {
                compactPath: compactSearchValue(node.relativePath),
                depth: getPathDepth(node.relativePath),
                extension: node.extension,
                lowerName: node.name.toLowerCase(),
                lowerPath: node.relativePath.toLowerCase(),
                name: node.name,
                relativePath: node.relativePath,
            });
        }
    }

    return [...files.values()].sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
    );
}

export function searchProjectQuickOpenFiles(
    files: readonly ProjectQuickOpenFile[],
    query: string,
    limit = 80,
): readonly ProjectQuickOpenMatch[] {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
        return files.slice(0, limit).map((file) => ({
            ...file,
            score: 0,
        }));
    }

    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
    const matches: ProjectQuickOpenMatch[] = [];

    for (const file of files) {
        let totalScore = 0;
        let isMatch = true;

        for (const token of tokens) {
            const tokenScore = scoreToken(file, token);
            if (tokenScore < 0) {
                isMatch = false;
                break;
            }

            totalScore += tokenScore;
        }

        if (!isMatch) {
            continue;
        }

        matches.push({
            ...file,
            score:
                totalScore -
                file.depth * 4 -
                Math.min(file.relativePath.length, 160) * 0.02,
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

function scoreToken(file: ProjectQuickOpenFile, token: string): number {
    let score = 0;
    const compactToken = compactSearchValue(token);

    if (file.lowerName === token) {
        score += 420;
    }

    if (file.lowerPath === token) {
        score += 390;
    }

    if (file.lowerName.startsWith(token)) {
        score += 220;
    }

    if (file.lowerPath.startsWith(token)) {
        score += 150;
    }

    const nameIndex = file.lowerName.indexOf(token);
    if (nameIndex >= 0) {
        score += 190 - Math.min(nameIndex * 8, 80);
    }

    const pathIndex = file.lowerPath.indexOf(token);
    if (pathIndex >= 0) {
        score += 120 - Math.min(pathIndex * 2, 70);
    }

    if (compactToken && isSubsequence(compactToken, file.compactPath)) {
        score +=
            70 - Math.min(file.compactPath.length - compactToken.length, 28);
    }

    return score > 0 ? score : -1;
}

function getPathDepth(relativePath: string): number {
    return relativePath.split("/").length - 1;
}

function compactSearchValue(value: string): string {
    return value.toLowerCase().replace(PATH_SEPARATOR_PATTERN, "");
}

function isSubsequence(query: string, target: string): boolean {
    if (!query) {
        return true;
    }

    let queryIndex = 0;

    for (let index = 0; index < target.length; index += 1) {
        if (target[index] === query[queryIndex]) {
            queryIndex += 1;
            if (queryIndex === query.length) {
                return true;
            }
        }
    }

    return false;
}
