import type { GitBranchSummary } from "@shared/ipc";

export type BranchCreationSource = "current" | "context-menu" | "search";

export type BranchCreationDraft = {
    readonly baseBranchName: string;
    readonly checkoutAfterCreate: boolean;
    readonly initialName: string;
    readonly source: BranchCreationSource;
};

export type BranchCreationBaseOption = {
    readonly description: string;
    readonly isCurrent: boolean;
    readonly isRemote: boolean;
    readonly name: string;
};

export type BranchNameValidationResult =
    | {
          readonly error: null;
          readonly isValid: true;
          readonly value: string;
      }
    | {
          readonly error: string;
          readonly isValid: false;
          readonly value: string;
      };

export type BranchCreationQueryOffer = {
    readonly branchName: string;
};

export function normalizeBranchNameInput(input: string): string {
    return input.trim();
}

export function getDefaultBranchCreationBase(input: {
    readonly branches: readonly GitBranchSummary[];
    readonly currentBranchName?: string | null;
}): string | null {
    const currentBranchName = input.currentBranchName?.trim() ?? "";
    if (
        currentBranchName &&
        input.branches.some(
            (branch) => !branch.isRemote && branch.name === currentBranchName,
        )
    ) {
        return currentBranchName;
    }

    const currentBranch = input.branches.find(
        (branch) => branch.isCurrent && !branch.isDetached && !branch.isRemote,
    );
    if (currentBranch) {
        return currentBranch.name;
    }

    const firstLocalBranch = input.branches.find(
        (branch) => !branch.isDetached && !branch.isRemote,
    );
    if (firstLocalBranch) {
        return firstLocalBranch.name;
    }

    const firstRemoteBranch = input.branches.find((branch) => branch.isRemote);
    if (firstRemoteBranch) {
        return firstRemoteBranch.name;
    }

    return currentBranchName || null;
}

export function buildBranchCreationBaseOptions(
    branches: readonly GitBranchSummary[],
): readonly BranchCreationBaseOption[] {
    const seenNames = new Set<string>();
    const options: BranchCreationBaseOption[] = [];

    for (const branch of branches) {
        if (!branch.name || branch.isDetached || seenNames.has(branch.name)) {
            continue;
        }

        seenNames.add(branch.name);
        options.push({
            description: getBranchBaseDescription(branch),
            isCurrent: branch.isCurrent,
            isRemote: branch.isRemote,
            name: branch.name,
        });
    }

    return options;
}

export function createBranchCreationDraft(input: {
    readonly baseBranchName: string | null;
    readonly checkoutAfterCreate?: boolean;
    readonly initialName?: string;
    readonly source: BranchCreationSource;
}): BranchCreationDraft | null {
    const baseBranchName = input.baseBranchName?.trim() ?? "";
    if (!baseBranchName) {
        return null;
    }

    return {
        baseBranchName,
        checkoutAfterCreate: input.checkoutAfterCreate ?? true,
        initialName: normalizeBranchNameInput(input.initialName ?? ""),
        source: input.source,
    };
}

export function validateNewBranchName(
    input: string,
    branches: readonly GitBranchSummary[],
): BranchNameValidationResult {
    const value = normalizeBranchNameInput(input);
    if (!value) {
        return invalid(value, "Enter a branch name.");
    }

    if (value.toUpperCase() === "HEAD") {
        return invalid(value, "HEAD is reserved.");
    }

    if (/\s/.test(value)) {
        return invalid(value, "Branch names cannot contain whitespace.");
    }

    if (value.startsWith("/") || value.endsWith("/")) {
        return invalid(value, "Branch names cannot start or end with a slash.");
    }

    if (value.includes("..")) {
        return invalid(value, "Branch names cannot contain '..'.");
    }

    if (branches.some((branch) => !branch.isRemote && branch.name === value)) {
        return invalid(value, "A local branch with this name already exists.");
    }

    if (branches.some((branch) => branch.isRemote && branch.name === value)) {
        return invalid(
            value,
            "A remote branch with this name already exists.",
        );
    }

    return {
        error: null,
        isValid: true,
        value,
    };
}

export function getBranchCreationQueryOffer(
    query: string,
    branches: readonly GitBranchSummary[],
): BranchCreationQueryOffer | null {
    const validation = validateNewBranchName(query, branches);
    if (!validation.isValid) {
        return null;
    }

    return {
        branchName: validation.value,
    };
}

function invalid(value: string, error: string): BranchNameValidationResult {
    return {
        error,
        isValid: false,
        value,
    };
}

function getBranchBaseDescription(branch: GitBranchSummary): string {
    if (branch.isRemote) {
        return "Remote branch";
    }

    if (branch.isCurrent) {
        return "Current branch";
    }

    if (branch.upstreamName) {
        return `Tracks ${branch.upstreamName}`;
    }

    return "Local branch";
}
