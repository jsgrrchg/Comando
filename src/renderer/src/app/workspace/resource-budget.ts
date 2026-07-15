export const MAX_RENDERER_CACHED_ARTIFACTS = 12;

export interface RendererArtifactCacheStats {
    readonly estimatedBytes: number;
    readonly evictions: number;
    readonly hits: number;
    readonly misses: number;
    readonly size: number;
}

interface CachedArtifact {
    readonly scope: string;
    readonly value: unknown;
}

/**
 * Renderer-wide LRU for recoverable presentation artifacts. State owned by a
 * workspace store is never placed here; only derived geometry/models that can
 * be rebuilt after eviction are eligible.
 */
export class RendererArtifactCache {
    private readonly artifacts = new Map<string, CachedArtifact>();
    private estimatedBytes = 0;
    private evictions = 0;
    private hits = 0;
    private misses = 0;

    delete(scope: string, key: string): void {
        this.deleteArtifact(this.toArtifactKey(scope, key));
    }

    deleteScope(scope: string): void {
        for (const [artifactKey, artifact] of this.artifacts) {
            if (artifact.scope === scope) {
                this.deleteArtifact(artifactKey);
            }
        }
    }

    get<T>(scope: string, key: string): T | null {
        const artifactKey = this.toArtifactKey(scope, key);
        const artifact = this.artifacts.get(artifactKey);
        if (!artifact) {
            this.misses += 1;
            return null;
        }
        this.hits += 1;
        this.artifacts.delete(artifactKey);
        this.artifacts.set(artifactKey, artifact);
        return artifact.value as T;
    }

    set<T>(scope: string, key: string, value: T): void {
        const artifactKey = this.toArtifactKey(scope, key);
        this.deleteArtifact(artifactKey);
        this.artifacts.set(artifactKey, { scope, value });
        this.estimatedBytes += estimateArtifactBytes(value);

        while (this.artifacts.size > MAX_RENDERER_CACHED_ARTIFACTS) {
            const oldestKey = this.artifacts.keys().next().value;
            if (oldestKey === undefined) {
                return;
            }
            this.evictions += 1;
            this.deleteArtifact(oldestKey);
        }
    }

    getStats(): RendererArtifactCacheStats {
        return {
            estimatedBytes: this.estimatedBytes,
            evictions: this.evictions,
            hits: this.hits,
            misses: this.misses,
            size: this.artifacts.size,
        };
    }

    sizeForTests(): number {
        return this.artifacts.size;
    }

    private toArtifactKey(scope: string, key: string): string {
        return `${scope}\u0000${key}`;
    }

    private deleteArtifact(artifactKey: string): void {
        const artifact = this.artifacts.get(artifactKey);
        if (!artifact) return;
        this.estimatedBytes = Math.max(
            0,
            this.estimatedBytes - estimateArtifactBytes(artifact.value),
        );
        this.artifacts.delete(artifactKey);
    }
}

function estimateArtifactBytes(value: unknown): number {
    if (typeof value !== "object" || value === null) return 16;
    if (Array.isArray(value)) return 24 + value.length * 16;
    return 64 + Object.keys(value).length * 24;
}

export const rendererArtifactCache = new RendererArtifactCache();
