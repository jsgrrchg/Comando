import path from "node:path";

import type { FileStatusResult, StatusResult } from "simple-git";

import type {
    GitChangeEntry,
    GitChangeKind,
    GitChangeScope,
    GitChangeScopeCounts,
    GitChangeTreeNode,
    GitStatusSnapshot,
} from "./types";

type MutableGitChangeScopeCounts = {
    -readonly [Key in keyof GitChangeScopeCounts]: GitChangeScopeCounts[Key];
};

export function createEmptyGitScopeCounts(): MutableGitChangeScopeCounts {
    return {
        conflicted: 0,
        staged: 0,
        untracked: 0,
        unstaged: 0,
    };
}

export function buildGitStatusSnapshot(
    status: StatusResult,
): Pick<
    GitStatusSnapshot,
    | "counts"
    | "entries"
    | "hasConflicts"
    | "hasStaged"
    | "hasUnstaged"
    | "hasUntracked"
    | "isClean"
    | "sync"
    | "tree"
> {
    const renameMap = new Map(
        status.renamed.map((rename) => [
            normalizeGitPath(rename.to),
            rename.from,
        ]),
    );
    const entries = new Map<string, GitChangeEntry>();

    for (const file of status.files) {
        const entry = buildGitChangeEntry(
            file,
            renameMap.get(file.path) ?? file.from ?? null,
        );
        const existing = entries.get(entry.relativePath);
        entries.set(
            entry.relativePath,
            existing ? mergeChangeEntries(existing, entry) : entry,
        );
    }

    for (const filePath of status.not_added) {
        const normalizedPath = normalizeGitPath(filePath);
        const existing = entries.get(normalizedPath);
        if (existing) {
            entries.set(normalizedPath, {
                ...existing,
                scopes: mergeScopes(existing.scopes, ["untracked"]),
            });
            continue;
        }

        const name = path.posix.basename(normalizedPath);
        entries.set(normalizedPath, {
            conflicted: false,
            id: buildChangeId(normalizedPath),
            isBinary: false,
            isRenamed: false,
            kind: "untracked",
            name,
            parentRelativePath:
                path.posix.dirname(normalizedPath) === "."
                    ? null
                    : path.posix.dirname(normalizedPath),
            previousPath: null,
            relativePath: normalizedPath,
            scopes: ["untracked"],
            statusIndex: "?",
            statusWorkingDir: "?",
        });
    }

    for (const filePath of status.conflicted) {
        const normalizedPath = normalizeGitPath(filePath);
        const existing = entries.get(normalizedPath);
        if (existing) {
            entries.set(normalizedPath, {
                ...existing,
                conflicted: true,
                kind: "conflicted",
                scopes: mergeScopes(existing.scopes, ["conflicted"]),
            });
            continue;
        }

        const name = path.posix.basename(normalizedPath);
        entries.set(normalizedPath, {
            conflicted: true,
            id: buildChangeId(normalizedPath),
            isBinary: false,
            isRenamed: false,
            kind: "conflicted",
            name,
            parentRelativePath:
                path.posix.dirname(normalizedPath) === "."
                    ? null
                    : path.posix.dirname(normalizedPath),
            previousPath: null,
            relativePath: normalizedPath,
            scopes: ["conflicted"],
            statusIndex: "U",
            statusWorkingDir: "U",
        });
    }

    const entryList = [...entries.values()].sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
    );
    const counts = countScopes(entryList);
    const entryById = new Map(entryList.map((entry) => [entry.id, entry]));
    const tree = buildGitChangeTree(entryList, entryById);

    return {
        counts,
        entries: entryList,
        hasConflicts: counts.conflicted > 0,
        hasStaged: counts.staged > 0,
        hasUnstaged: counts.unstaged > 0,
        hasUntracked: counts.untracked > 0,
        isClean:
            counts.conflicted === 0 &&
            counts.staged === 0 &&
            counts.unstaged === 0 &&
            counts.untracked === 0,
        sync: {
            ahead: status.ahead,
            behind: status.behind,
            branchName: status.current,
            commit: null,
            detached: status.detached,
            trackingBranchName: status.tracking,
        },
        tree,
    };
}

export function buildGitChangeEntry(
    file: FileStatusResult,
    previousPath: string | null,
): GitChangeEntry {
    const normalizedPath = normalizeGitPath(file.path);
    const name = path.posix.basename(normalizedPath);
    const scopes = determineScopes(file.index, file.working_dir);
    const conflicted = scopes.includes("conflicted");
    const isRenamed = previousPath !== null && previousPath !== normalizedPath;

    return {
        conflicted,
        id: buildChangeId(normalizedPath),
        isBinary: false,
        isRenamed,
        kind: determineChangeKind(
            file.index,
            file.working_dir,
            scopes,
            isRenamed,
        ),
        name,
        parentRelativePath:
            path.posix.dirname(normalizedPath) === "."
                ? null
                : path.posix.dirname(normalizedPath),
        previousPath,
        relativePath: normalizedPath,
        scopes,
        statusIndex: file.index,
        statusWorkingDir: file.working_dir,
    };
}

export function buildGitChangeTree(
    entries: readonly GitChangeEntry[],
    entryById: ReadonlyMap<string, GitChangeEntry>,
): readonly GitChangeTreeNode[] {
    const root = {
        children: new Map<string, MutableGitChangeTreeNode>(),
        counts: createEmptyGitScopeCounts(),
    };

    for (const entry of entries) {
        const segments = entry.relativePath.split("/");
        let cursor = root;
        let relativePath = "";

        for (let index = 0; index < segments.length; index += 1) {
            const segment = segments[index];
            relativePath = relativePath
                ? `${relativePath}/${segment}`
                : segment;
            const isLeaf = index === segments.length - 1;
            let child = cursor.children.get(segment);

            if (!child) {
                child = {
                    changeEntryId: null,
                    children: new Map<string, MutableGitChangeTreeNode>(),
                    counts: createEmptyGitScopeCounts(),
                    id: buildTreeNodeId(relativePath),
                    kind: isLeaf ? "file" : "directory",
                    name: segment,
                    parentRelativePath:
                        path.posix.dirname(relativePath) === "."
                            ? null
                            : path.posix.dirname(relativePath),
                    relativePath,
                };
                cursor.children.set(segment, child);
            }

            if (isLeaf) {
                child.kind = "file";
                child.changeEntryId = entry.id;
            }

            cursor = child;
        }
    }

    populateAggregatedCounts(root, entryById);

    return sortTreeNodes([...root.children.values()]);
}

export function resolveGitChangeKind(
    file: FileStatusResult,
    previousPath: string | null,
): GitChangeKind {
    const scopes = determineScopes(file.index, file.working_dir);
    return determineChangeKind(
        file.index,
        file.working_dir,
        scopes,
        previousPath !== null && previousPath !== normalizeGitPath(file.path),
    );
}

function populateAggregatedCounts(
    node: MutableGitChangeTreeRoot | MutableGitChangeTreeNode,
    entryById: ReadonlyMap<string, GitChangeEntry>,
): GitChangeScopeCounts {
    const counts = createEmptyGitScopeCounts();

    if (hasChangeEntryId(node) && node.changeEntryId) {
        const entry = entryById.get(node.changeEntryId);
        if (entry) {
            incrementScopeCounts(counts, entry.scopes);
        }
    }

    for (const child of node.children.values()) {
        const childCounts = populateAggregatedCounts(child, entryById);
        incrementScopeCounts(counts, childCounts);
    }

    node.counts = counts;
    return counts;
}

function sortTreeNodes(
    nodes: readonly MutableGitChangeTreeNode[],
): readonly GitChangeTreeNode[] {
    return [...nodes]
        .sort((left, right) => {
            if (left.kind !== right.kind) {
                return left.kind === "directory" ? -1 : 1;
            }

            return left.name.localeCompare(right.name);
        })
        .map((node) => ({
            changeEntryId: node.changeEntryId,
            children: sortTreeNodes([...node.children.values()]),
            counts: node.counts,
            id: node.id,
            kind: node.kind,
            name: node.name,
            parentRelativePath: node.parentRelativePath,
            relativePath: node.relativePath,
        }));
}

function countScopes(entries: readonly GitChangeEntry[]): GitChangeScopeCounts {
    const counts = createEmptyGitScopeCounts();
    for (const entry of entries) {
        incrementScopeCounts(counts, entry.scopes);
    }
    return counts;
}

function incrementScopeCounts(
    counts: MutableGitChangeScopeCounts,
    scopes: readonly GitChangeScope[] | GitChangeScopeCounts,
): void {
    if (isGitChangeScopeList(scopes)) {
        for (const scope of scopes) {
            incrementScopeCount(counts, scope);
        }
        return;
    }

    counts.conflicted += scopes.conflicted;
    counts.staged += scopes.staged;
    counts.untracked += scopes.untracked;
    counts.unstaged += scopes.unstaged;
}

function isGitChangeScopeList(
    scopes: readonly GitChangeScope[] | GitChangeScopeCounts,
): scopes is readonly GitChangeScope[] {
    return Array.isArray(scopes);
}

function incrementScopeCount(
    counts: MutableGitChangeScopeCounts,
    scope: GitChangeScope,
): void {
    switch (scope) {
        case "conflicted":
            counts.conflicted += 1;
            return;
        case "staged":
            counts.staged += 1;
            return;
        case "untracked":
            counts.untracked += 1;
            return;
        case "unstaged":
            counts.unstaged += 1;
            return;
    }
}

function hasChangeEntryId(
    node: MutableGitChangeTreeRoot | MutableGitChangeTreeNode,
): node is MutableGitChangeTreeNode {
    return "changeEntryId" in node;
}

function mergeChangeEntries(
    first: GitChangeEntry,
    second: GitChangeEntry,
): GitChangeEntry {
    const primary =
        first.kind === "untracked" && second.kind !== "untracked"
            ? second
            : first;

    return {
        ...primary,
        conflicted: first.conflicted || second.conflicted,
        isBinary: first.isBinary || second.isBinary,
        scopes: mergeScopes(first.scopes, second.scopes),
        statusIndex: chooseTrackedStatusCode(
            first.statusIndex,
            second.statusIndex,
        ),
        statusWorkingDir: first.statusWorkingDir.trim()
            ? first.statusWorkingDir
            : second.statusWorkingDir,
    };
}

function mergeScopes(
    first: readonly GitChangeScope[],
    second: readonly GitChangeScope[],
): readonly GitChangeScope[] {
    return [...new Set([...first, ...second])];
}

function chooseTrackedStatusCode(first: string, second: string): string {
    if (first.trim() !== "" && first !== "?") {
        return first;
    }

    return second;
}

function determineScopes(
    index: string,
    workingDir: string,
): readonly GitChangeScope[] {
    if (isConflictCode(index, workingDir)) {
        return ["conflicted"];
    }

    if (index === "?" && workingDir === "?") {
        return ["untracked"];
    }

    const scopes: GitChangeScope[] = [];

    if (index.trim() !== "") {
        scopes.push("staged");
    }

    if (workingDir.trim() !== "") {
        scopes.push("unstaged");
    }

    return scopes.length > 0 ? scopes : ["unstaged"];
}

function determineChangeKind(
    index: string,
    workingDir: string,
    scopes: readonly GitChangeScope[],
    isRenamed: boolean,
): GitChangeKind {
    if (scopes.includes("conflicted")) {
        return "conflicted";
    }

    if (index === "?" && workingDir === "?") {
        return "untracked";
    }

    if (isRenamed || index === "R" || workingDir === "R") {
        return "renamed";
    }

    if (index === "C" || workingDir === "C") {
        return "copied";
    }

    if (index === "T" || workingDir === "T") {
        return "typechanged";
    }

    if (index === "D" || workingDir === "D") {
        return "deleted";
    }

    if (index === "A" || workingDir === "A") {
        return "added";
    }

    if (index.trim() !== "" || workingDir.trim() !== "") {
        return "modified";
    }

    return "unknown";
}

function isConflictCode(index: string, workingDir: string): boolean {
    return (
        index.includes("U") ||
        workingDir.includes("U") ||
        (index === "A" && workingDir === "A") ||
        (index === "D" && workingDir === "D")
    );
}

function buildChangeId(relativePath: string): string {
    return `git-change:${relativePath}`;
}

function buildTreeNodeId(relativePath: string): string {
    return `git-tree:${relativePath}`;
}

function normalizeGitPath(filePath: string): string {
    return filePath.split(path.sep).join("/");
}

interface MutableGitChangeTreeRoot {
    children: Map<string, MutableGitChangeTreeNode>;
    counts: MutableGitChangeScopeCounts;
}

interface MutableGitChangeTreeNode extends MutableGitChangeTreeRoot {
    changeEntryId: string | null;
    id: string;
    kind: "directory" | "file";
    name: string;
    parentRelativePath: string | null;
    relativePath: string;
}
