import type { GitRemoteSummary } from "@shared/ipc";

const avatarMap = new Map<string, string>();
const resolvedRepos = new Set<string>();
let listeners: Array<() => void> = [];

function parseNoReplyAvatar(email: string): string | null {
    const normalized = email.trim().toLowerCase();
    const idMatch = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/.exec(
        normalized,
    );
    if (idMatch?.[1]) {
        return `https://avatars.githubusercontent.com/u/${idMatch[1]}?s=64`;
    }
    const usernameMatch = /^([^@]+)@users\.noreply\.github\.com$/.exec(
        normalized,
    );
    if (usernameMatch?.[1]) {
        return `https://github.com/${usernameMatch[1]}.png?size=64`;
    }
    return null;
}

export function getGitHubAvatarUrl(email: string): string | null {
    const noreply = parseNoReplyAvatar(email);
    if (noreply) return noreply;
    return avatarMap.get(email.trim().toLowerCase()) ?? null;
}

export function subscribeGitHubAvatars(listener: () => void): () => void {
    listeners.push(listener);
    return () => {
        listeners = listeners.filter((l) => l !== listener);
    };
}

function notifyListeners(): void {
    for (const listener of listeners) listener();
}

function parseGitHubRemote(
    rawUrl: string,
): { owner: string; repo: string } | null {
    const httpsMatch =
        /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(
            rawUrl.trim(),
        );
    if (httpsMatch?.[1] && httpsMatch[2]) {
        return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }
    const sshMatch =
        /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(
            rawUrl.trim(),
        );
    if (sshMatch?.[1] && sshMatch[2]) {
        return { owner: sshMatch[1], repo: sshMatch[2] };
    }
    return null;
}

export async function resolveGitHubAvatars(
    remotes: readonly GitRemoteSummary[],
): Promise<void> {
    const remote = remotes.find((r) => r.isDefault) ?? remotes[0];
    if (!remote) return;

    const rawUrl = remote.fetchUrl ?? remote.pushUrl;
    if (!rawUrl) return;

    const parsed = parseGitHubRemote(rawUrl);
    if (!parsed) return;

    const repoKey = `${parsed.owner}/${parsed.repo}`;
    if (resolvedRepos.has(repoKey)) return;
    resolvedRepos.add(repoKey);

    try {
        const response = await fetch(
            `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits?per_page=100`,
            { headers: { Accept: "application/vnd.github.v3+json" } },
        );
        if (!response.ok) return;

        const commits: ReadonlyArray<{
            author?: { avatar_url?: string } | null;
            commit?: { author?: { email?: string } | null } | null;
        }> = await response.json();

        let added = false;
        for (const commit of commits) {
            const email = commit.commit?.author?.email;
            const avatarUrl = commit.author?.avatar_url;
            if (email && avatarUrl) {
                const normalized = email.trim().toLowerCase();
                if (!avatarMap.has(normalized)) {
                    avatarMap.set(normalized, avatarUrl);
                    added = true;
                }
            }
        }
        if (added) notifyListeners();
    } catch {
        // Fall back to Gravatar/initials
    }
}
