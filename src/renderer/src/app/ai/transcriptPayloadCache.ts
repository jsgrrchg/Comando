export interface TranscriptPayloadLoader<T> {
    load(payloadRef: string): Promise<T>;
}

interface CachedPayload<T> {
    readonly estimatedBytes: number;
    readonly payload: T;
    protected: boolean;
    touchedAt: number;
}

export class TranscriptPayloadCache<T> {
    private readonly payloads = new Map<string, CachedPayload<T>>();
    private readonly pending = new Map<string, Promise<T>>();

    constructor(
        private readonly loader: TranscriptPayloadLoader<T>,
        private readonly maxBytes: number,
        private readonly estimateBytes: (payload: T) => number,
    ) {}

    load(payloadRef: string): Promise<T> {
        const cached = this.payloads.get(payloadRef);
        if (cached) {
            cached.touchedAt = performance.now();
            return Promise.resolve(cached.payload);
        }
        const pending = this.pending.get(payloadRef);
        if (pending) return pending;
        const request = this.loader.load(payloadRef).then((payload) => {
            this.pending.delete(payloadRef);
            this.payloads.set(payloadRef, {
                estimatedBytes: this.estimateBytes(payload),
                payload,
                protected: false,
                touchedAt: performance.now(),
            });
            this.evict();
            return payload;
        });
        this.pending.set(payloadRef, request);
        return request;
    }

    release(payloadRef: string): void {
        const cached = this.payloads.get(payloadRef);
        if (cached) cached.protected = false;
        this.evict();
    }

    protect(payloadRef: string): void {
        const cached = this.payloads.get(payloadRef);
        if (cached) cached.protected = true;
    }

    get residentBytes(): number {
        return [...this.payloads.values()].reduce(
            (total, payload) => total + payload.estimatedBytes,
            0,
        );
    }

    private evict(): void {
        while (this.residentBytes > this.maxBytes) {
            const candidate = [...this.payloads.entries()]
                .filter(([, payload]) => !payload.protected)
                .sort(([, left], [, right]) => left.touchedAt - right.touchedAt)[0];
            if (!candidate) return;
            this.payloads.delete(candidate[0]);
        }
    }
}
