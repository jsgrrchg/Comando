export interface TranscriptPayloadLoader<T> {
    load(payloadRef: string): Promise<T>;
}

interface CachedPayload<T> {
    readonly estimatedBytes: number;
    readonly payload: T;
    protected: boolean;
}

interface TranscriptPayloadLoadOptions {
    readonly protect?: boolean;
}

export class TranscriptPayloadCache<T> {
    // Map insertion order provides the LRU queues without sorting on eviction.
    private readonly protectedPayloadRefs = new Map<string, undefined>();
    private readonly payloads = new Map<string, CachedPayload<T>>();
    private readonly pending = new Map<string, Promise<T>>();
    private readonly evictedPayloadRefs = new Set<string>();
    private readonly recoverablePayloadRefs = new Map<string, undefined>();
    private residentByteCount = 0;

    constructor(
        private readonly loader: TranscriptPayloadLoader<T>,
        private readonly maxBytes: number,
        private readonly estimateBytes: (payload: T) => number,
    ) {}

    load(
        payloadRef: string,
        options: TranscriptPayloadLoadOptions = {},
    ): Promise<T> {
        const cached = this.payloads.get(payloadRef);
        if (cached) {
            if (options.protect && !cached.protected) {
                cached.protected = true;
            }
            this.touch(payloadRef, cached.protected);
            return Promise.resolve(cached.payload);
        }
        const pending = this.pending.get(payloadRef);
        if (pending) return pending;
        const request = this.loader
            .load(payloadRef)
            .then((payload) => {
                const cached: CachedPayload<T> = {
                    estimatedBytes: this.estimateBytes(payload),
                    payload,
                    protected: options.protect ?? false,
                };
                this.payloads.set(payloadRef, cached);
                this.residentByteCount += cached.estimatedBytes;
                this.touch(payloadRef, cached.protected);
                this.evict();
                return payload;
            })
            .finally(() => this.pending.delete(payloadRef));
        this.pending.set(payloadRef, request);
        return request;
    }

    release(payloadRef: string): void {
        const cached = this.payloads.get(payloadRef);
        if (cached) {
            cached.protected = false;
            this.touch(payloadRef, false);
        }
        this.evict();
    }

    protect(payloadRef: string): void {
        const cached = this.payloads.get(payloadRef);
        if (cached) {
            cached.protected = true;
            this.touch(payloadRef, true);
        }
    }

    has(payloadRef: string): boolean {
        return this.payloads.has(payloadRef);
    }

    takeEvictedPayloadRefs(): readonly string[] {
        const payloadRefs = [...this.evictedPayloadRefs];
        this.evictedPayloadRefs.clear();
        return payloadRefs;
    }

    get residentBytes(): number {
        return this.residentByteCount;
    }

    applyMemoryPressure(factor = 0.5): void {
        const targetBytes = Math.max(0, Math.floor(this.maxBytes * factor));
        this.evictTo(targetBytes);
    }

    private evict(): void {
        this.evictTo(this.maxBytes);
    }

    private evictTo(targetBytes: number): void {
        while (this.residentByteCount > targetBytes) {
            // Protection is a retention preference, never permission to exceed
            // the cache budget when no recoverable payload remains.
            const payloadRef = this.recoverablePayloadRefs.keys().next().value ??
                this.protectedPayloadRefs.keys().next().value;
            if (payloadRef === undefined) return;
            const payload = this.payloads.get(payloadRef);
            if (!payload) return;
            this.payloads.delete(payloadRef);
            this.recoverablePayloadRefs.delete(payloadRef);
            this.protectedPayloadRefs.delete(payloadRef);
            this.residentByteCount -= payload.estimatedBytes;
            this.evictedPayloadRefs.add(payloadRef);
        }
    }

    private touch(payloadRef: string, isProtected: boolean): void {
        const target = isProtected
            ? this.protectedPayloadRefs
            : this.recoverablePayloadRefs;
        const other = isProtected
            ? this.recoverablePayloadRefs
            : this.protectedPayloadRefs;
        other.delete(payloadRef);
        target.delete(payloadRef);
        target.set(payloadRef, undefined);
    }
}
