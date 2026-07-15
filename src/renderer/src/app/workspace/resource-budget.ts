export const MAX_WORKSPACE_CACHED_ARTIFACTS = 12;

interface CachedArtifact {
    readonly scope: string;
    readonly value: unknown;
}

/**
 * Renderer-wide LRU for recoverable presentation artifacts. State owned by a
 * workspace store is never placed here; only derived geometry/models that can
 * be rebuilt after eviction are eligible.
 */
export class WorkspaceArtifactBudget {
    private readonly artifacts = new Map<string, CachedArtifact>();

    delete(scope: string, key: string): void {
        this.artifacts.delete(this.toArtifactKey(scope, key));
    }

    deleteScope(scope: string): void {
        for (const [artifactKey, artifact] of this.artifacts) {
            if (artifact.scope === scope) {
                this.artifacts.delete(artifactKey);
            }
        }
    }

    get<T>(scope: string, key: string): T | null {
        const artifactKey = this.toArtifactKey(scope, key);
        const artifact = this.artifacts.get(artifactKey);
        if (!artifact) {
            return null;
        }
        this.artifacts.delete(artifactKey);
        this.artifacts.set(artifactKey, artifact);
        return artifact.value as T;
    }

    set<T>(scope: string, key: string, value: T): void {
        const artifactKey = this.toArtifactKey(scope, key);
        this.artifacts.delete(artifactKey);
        this.artifacts.set(artifactKey, { scope, value });

        while (this.artifacts.size > MAX_WORKSPACE_CACHED_ARTIFACTS) {
            const oldestKey = this.artifacts.keys().next().value;
            if (oldestKey === undefined) {
                return;
            }
            this.artifacts.delete(oldestKey);
        }
    }

    sizeForTests(): number {
        return this.artifacts.size;
    }

    private toArtifactKey(scope: string, key: string): string {
        return `${scope}\u0000${key}`;
    }
}

export const workspaceArtifactBudget = new WorkspaceArtifactBudget();
