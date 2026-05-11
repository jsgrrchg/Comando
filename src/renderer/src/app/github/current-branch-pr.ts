import type {
    GitHubPullRequestSummary,
    GitHubRepositoryRef,
} from "@shared/ipc";

export function isPullRequestForCurrentBranch(
    pullRequest: GitHubPullRequestSummary,
    currentBranchName: string | null,
    repository: GitHubRepositoryRef,
): boolean {
    if (
        !currentBranchName ||
        pullRequest.state !== "open" ||
        pullRequest.head.ref !== currentBranchName
    ) {
        return false;
    }

    return repositoriesMatch(pullRequest.head.repository, repository);
}

export function countCurrentBranchPullRequests(
    pullRequests: readonly GitHubPullRequestSummary[],
    currentBranchName: string | null,
    repository: GitHubRepositoryRef,
): number {
    return pullRequests.filter((pullRequest) =>
        isPullRequestForCurrentBranch(
            pullRequest,
            currentBranchName,
            repository,
        ),
    ).length;
}

export function sortPullRequestsNewestFirst(
    pullRequests: readonly GitHubPullRequestSummary[],
): readonly GitHubPullRequestSummary[] {
    return [...pullRequests].sort((first, second) => {
        return (
            new Date(second.createdAt).getTime() -
            new Date(first.createdAt).getTime()
        );
    });
}

function repositoriesMatch(
    first: GitHubRepositoryRef,
    second: GitHubRepositoryRef,
): boolean {
    return (
        first.host.toLowerCase() === second.host.toLowerCase() &&
        first.owner.toLowerCase() === second.owner.toLowerCase() &&
        first.repo.toLowerCase() === second.repo.toLowerCase()
    );
}
