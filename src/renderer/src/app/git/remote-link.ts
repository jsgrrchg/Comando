import type { GitHubRepositoryRef, GitRemoteSummary } from "@shared/ipc";

export interface GitRemoteCommitLink {
    readonly label: string;
    readonly url: string;
}

export function buildGitRemoteCommitLink(
    remotes: readonly GitRemoteSummary[],
    commitSha: string,
): GitRemoteCommitLink | null {
    const remote =
        remotes.find((candidate) => candidate.isDefault) ?? remotes[0] ?? null;
    if (!remote) {
        return null;
    }

    const rawUrl = remote.fetchUrl ?? remote.pushUrl;
    if (!rawUrl) {
        return null;
    }

    const parsed = parseGitRemoteUrl(rawUrl);
    if (!parsed) {
        return null;
    }

    const { baseUrl, host, owner, repo } = parsed;

    if (host.includes("github")) {
        return {
            label: "View on GitHub",
            url: `${baseUrl}/${owner}/${repo}/commit/${commitSha}`,
        };
    }

    if (host.includes("gitlab")) {
        return {
            label: "View on GitLab",
            url: `${baseUrl}/${owner}/${repo}/-/commit/${commitSha}`,
        };
    }

    if (host.includes("bitbucket")) {
        return {
            label: "View on Bitbucket",
            url: `${baseUrl}/${owner}/${repo}/commits/${commitSha}`,
        };
    }

    return {
        label: "View on Remote",
        url: `${baseUrl}/${owner}/${repo}/commit/${commitSha}`,
    };
}

export function resolveGitHubRepositoryRef(
    remotes: readonly GitRemoteSummary[],
): GitHubRepositoryRef | null {
    const defaultRemote = remotes.find((candidate) => candidate.isDefault);
    const candidates = defaultRemote
        ? [
              defaultRemote,
              ...remotes.filter((candidate) => candidate !== defaultRemote),
          ]
        : remotes;

    for (const remote of candidates) {
        const ref = parseGitHubRepositoryRef(remote);
        if (ref) {
            return ref;
        }
    }

    return null;
}

function parseGitHubRepositoryRef(
    remote: GitRemoteSummary,
): GitHubRepositoryRef | null {
    const rawUrl = remote.fetchUrl ?? remote.pushUrl;
    if (!rawUrl) {
        return null;
    }

    const parsed = parseGitRemoteUrl(rawUrl);
    if (!parsed || !parsed.host.toLowerCase().includes("github")) {
        return null;
    }

    return {
        host: parsed.host.toLowerCase(),
        owner: parsed.owner,
        repo: parsed.repo,
    };
}

function parseGitRemoteUrl(rawUrl: string): {
    readonly baseUrl: string;
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
} | null {
    const httpsMatch =
        /^(https?):\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(rawUrl.trim());
    if (httpsMatch) {
        const protocol = httpsMatch[1];
        const host = httpsMatch[2];
        const repoPath = httpsMatch[3];
        const [owner, ...repoParts] = repoPath.split("/").filter(Boolean);
        if (!owner || repoParts.length === 0) {
            return null;
        }

        return {
            baseUrl: `${protocol}://${host}`,
            host,
            owner,
            repo: repoParts.join("/"),
        };
    }

    const sshMatch =
        /^(?:ssh:\/\/)?git@([^:/]+)[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(
            rawUrl.trim(),
        );
    if (!sshMatch) {
        return null;
    }

    const host = sshMatch[1];
    const owner = sshMatch[2];
    const repo = sshMatch[3];
    if (!host || !owner || !repo) {
        return null;
    }

    return {
        baseUrl: `https://${host}`,
        host,
        owner,
        repo,
    };
}
