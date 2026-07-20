export const MAX_RENDERER_CACHED_ARTIFACTS = 12;
export const MAX_RENDERER_CACHED_ARTIFACT_BYTES = 32 * 1024 * 1024;

export interface RendererArtifactCacheStats {
    readonly estimatedBytes: number;
    readonly evictions: number;
    readonly hits: number;
    readonly misses: number;
    readonly size: number;
}

interface CachedArtifact {
    readonly estimatedBytes: number;
    readonly priority: number;
    readonly protected: boolean;
    readonly scope: string;
    readonly value: unknown;
}

export interface RendererArtifactOptions {
    readonly estimatedBytes?: number;
    readonly priority?: number;
    readonly protected?: boolean;
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

    constructor(
        private maxItems = MAX_RENDERER_CACHED_ARTIFACTS,
        private maxBytes = MAX_RENDERER_CACHED_ARTIFACT_BYTES,
    ) {}

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

    set<T>(
        scope: string,
        key: string,
        value: T,
        options: RendererArtifactOptions = {},
    ): void {
        const artifactKey = this.toArtifactKey(scope, key);
        this.deleteArtifact(artifactKey);
        const estimatedBytes =
            options.estimatedBytes ?? estimateArtifactBytes(value);
        this.artifacts.set(artifactKey, {
            estimatedBytes,
            priority: options.priority ?? 0,
            protected: options.protected ?? false,
            scope,
            value,
        });
        this.estimatedBytes += estimatedBytes;

        while (
            this.artifacts.size > this.maxItems ||
            this.estimatedBytes > this.maxBytes
        ) {
            const oldestKey = [...this.artifacts.entries()]
                .filter(([, artifact]) => !artifact.protected)
                .sort(([, left], [, right]) => left.priority - right.priority)[0]?.[0];
            if (oldestKey === undefined) {
                return;
            }
            this.evictions += 1;
            this.deleteArtifact(oldestKey);
        }
    }

    applyMemoryPressure(factor = 0.5): void {
        this.maxBytes = Math.max(1024 * 1024, Math.floor(this.maxBytes * factor));
        while (this.estimatedBytes > this.maxBytes) {
            const candidate = [...this.artifacts.entries()].find(
                ([, artifact]) => !artifact.protected,
            )?.[0];
            if (!candidate) return;
            this.evictions += 1;
            this.deleteArtifact(candidate);
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
            this.estimatedBytes - artifact.estimatedBytes,
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
