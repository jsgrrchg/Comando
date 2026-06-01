import type { GitRemoteSummary } from "@shared/ipc";

const avatarMap = new Map<string, string>();
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

export function resolveGitHubAvatars(
    remotes: readonly GitRemoteSummary[],
): void {
    void remotes;

    // Renderer-side unauthenticated avatar probes produce noisy 404s for private
    // repos and unknown emails. We intentionally rely on deterministic local
    // fallbacks until avatar enrichment can move behind an authenticated
    // background integration.
}
