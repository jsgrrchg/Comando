/**
 * Owns review visibility independently from the byte-bounded payload cache.
 * A payload becomes evictable only after its last visible review releases it.
 */
export class TranscriptReviewPayloadRetention {
    private readonly countsByRef = new Map<string, number>();

    retain(payloadRef: string): boolean {
        const count = this.countsByRef.get(payloadRef) ?? 0;
        this.countsByRef.set(payloadRef, count + 1);
        return count === 0;
    }

    release(payloadRef: string): boolean {
        const count = this.countsByRef.get(payloadRef) ?? 0;
        if (count <= 1) {
            this.countsByRef.delete(payloadRef);
            return count > 0;
        }
        this.countsByRef.set(payloadRef, count - 1);
        return false;
    }

    releaseAll(): readonly string[] {
        const payloadRefs = [...this.countsByRef.keys()];
        this.countsByRef.clear();
        return payloadRefs;
    }

    has(payloadRef: string): boolean {
        return this.countsByRef.has(payloadRef);
    }
}
