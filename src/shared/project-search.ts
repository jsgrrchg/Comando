const PATH_SEPARATOR_PATTERN = /[/_.\-\s]+/g;

export interface ProjectSearchCandidate {
    readonly compactPath: string;
    readonly depth: number;
    readonly lowerName: string;
    readonly lowerPath: string;
}

export function compactProjectSearchValue(value: string): string {
    return value.toLowerCase().replace(PATH_SEPARATOR_PATTERN, "");
}

export function getProjectSearchDepth(relativePath: string): number {
    return relativePath.split("/").length - 1;
}

export function normalizeProjectSearchQuery(query: string): string {
    return query.trim().toLowerCase();
}

export function scoreProjectSearchCandidate(
    candidate: ProjectSearchCandidate,
    query: string,
): number {
    const normalizedQuery = normalizeProjectSearchQuery(query);
    if (!normalizedQuery) {
        return 0;
    }

    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
    let totalScore = 0;

    for (const token of tokens) {
        const tokenScore = scoreProjectSearchToken(candidate, token);
        if (tokenScore < 0) {
            return -1;
        }

        totalScore += tokenScore;
    }

    return (
        totalScore -
        candidate.depth * 4 -
        Math.min(candidate.lowerPath.length, 160) * 0.02
    );
}

const MAX_PROJECT_SEARCH_TOKEN_LENGTH = 200;

function scoreProjectSearchToken(
    candidate: ProjectSearchCandidate,
    token: string,
): number {
    // Pathological queries (e.g. a pasted file dump) must not degrade ranking
    // with O(token * path) substring scans across thousands of candidates.
    if (token.length > MAX_PROJECT_SEARCH_TOKEN_LENGTH) {
        return -1;
    }

    let score = 0;
    const compactToken = compactProjectSearchValue(token);

    if (candidate.lowerName === token) {
        score += 420;
    }

    if (candidate.lowerPath === token) {
        score += 390;
    }

    if (candidate.lowerName.startsWith(token)) {
        score += 220;
    }

    if (candidate.lowerPath.startsWith(token)) {
        score += 150;
    }

    const nameIndex = candidate.lowerName.indexOf(token);
    if (nameIndex >= 0) {
        score += 190 - Math.min(nameIndex * 8, 80);
    }

    const pathIndex = candidate.lowerPath.indexOf(token);
    if (pathIndex >= 0) {
        score += 120 - Math.min(pathIndex * 2, 70);
    }

    if (
        compactToken &&
        isCompactSubsequence(compactToken, candidate.compactPath)
    ) {
        score +=
            70 -
            Math.min(candidate.compactPath.length - compactToken.length, 28);
    }

    return score > 0 ? score : -1;
}

function isCompactSubsequence(query: string, target: string): boolean {
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
