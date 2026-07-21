export interface TranscriptPayloadLoader<T> {
    load(payloadRef: string): Promise<T>;
    loadMany?(payloadRefs: readonly string[]): Promise<ReadonlyMap<string, T>>;
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
                this.cache(payloadRef, payload, options.protect ?? false);
                return payload;
            })
            .finally(() => this.pending.delete(payloadRef));
        this.pending.set(payloadRef, request);
        return request;
    }

    loadMany(
        payloadRefs: readonly string[],
        options: TranscriptPayloadLoadOptions = {},
    ): Promise<ReadonlyMap<string, T>> {
        const uniquePayloadRefs = [...new Set(payloadRefs)];
        const resolved = new Map<string, T>();
        const pending: Promise<void>[] = [];
        const missing: string[] = [];

        for (const payloadRef of uniquePayloadRefs) {
            const cached = this.payloads.get(payloadRef);
            if (cached) {
                if (options.protect && !cached.protected) {
                    cached.protected = true;
                }
                this.touch(payloadRef, cached.protected);
                resolved.set(payloadRef, cached.payload);
                continue;
            }
            const activeRequest = this.pending.get(payloadRef);
            if (activeRequest) {
                pending.push(
                    activeRequest.then((payload) => {
                        resolved.set(payloadRef, payload);
                    }),
                );
                continue;
            }
            missing.push(payloadRef);
        }

        const loadMissing = this.loader.loadMany && missing.length > 1
            ? this.loadBatch(missing, options).then((payloads) => {
                  for (const [payloadRef, payload] of payloads) {
                      resolved.set(payloadRef, payload);
                  }
              })
            : Promise.all(
                  missing.map((payloadRef) =>
                      this.load(payloadRef, options).then((payload) => {
                          resolved.set(payloadRef, payload);
                      }),
                  ),
              ).then(() => undefined);

        return Promise.all([...pending, loadMissing]).then(() => resolved);
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

    private cache(
        payloadRef: string,
        payload: T,
        protect: boolean,
    ): void {
        const previous = this.payloads.get(payloadRef);
        if (previous) {
            // Replacing a payload must not count the same key twice.
            this.residentByteCount -= previous.estimatedBytes;
        }
        const cached: CachedPayload<T> = {
            estimatedBytes: this.estimateBytes(payload),
            payload,
            protected: protect,
        };
        this.payloads.set(payloadRef, cached);
        this.residentByteCount += cached.estimatedBytes;
        this.evictedPayloadRefs.delete(payloadRef);
        this.touch(payloadRef, cached.protected);
        this.evict();
    }

    private loadBatch(
        payloadRefs: readonly string[],
        options: TranscriptPayloadLoadOptions,
    ): Promise<ReadonlyMap<string, T>> {
        if (!this.loader.loadMany) {
            return Promise.resolve(new Map());
        }

        const batch = this.loader.loadMany(payloadRefs);
        const requests = new Map<string, Promise<T>>();

        for (const payloadRef of payloadRefs) {
            const request = batch
                .then((payloads) => {
                    const payload = payloads.get(payloadRef);
                    if (!payload) {
                        throw new Error(`The transcript payload ${payloadRef} could not be found.`);
                    }
                    this.cache(payloadRef, payload, options.protect ?? false);
                    return payload;
                })
                .finally(() => {
                    if (this.pending.get(payloadRef) === request) {
                        this.pending.delete(payloadRef);
                    }
                });
            // Batch refs share the same in-flight registry as single loads.
            this.pending.set(payloadRef, request);
            requests.set(payloadRef, request);
        }

        return Promise.all(
            payloadRefs.map(async (payloadRef) => [
                payloadRef,
                await requests.get(payloadRef)!,
            ] as const),
        ).then((payloads) => new Map(payloads));
    }
}
