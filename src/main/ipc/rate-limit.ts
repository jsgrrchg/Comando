// Small in-flight limiter for IPC handlers that are costly enough that a
// buggy renderer loop could saturate the main process or a worker pool. The
// IDE is single-user with no adversary model, so this is defensive hardening
// against accidental fan-out rather than abuse protection.
//
// Originally the limiter rejected excess requests with `IpcRateLimitError`.
// In practice legitimate flows (workspace restore with many folders expanded,
// initial project tree hydration) burst far above any sane concurrency cap,
// so rejection surfaced as a user-facing error for a fully valid action.
// The limiter now *queues* excess requests: they wait for an in-flight slot
// instead of failing. Throughput is still capped (the original goal) and
// a buggy loop simply serializes through the gate rather than hammering
// the worker pool.

export class IpcRateLimitError extends Error {
    // Preserved for backwards-compat with any out-of-tree callers that
    // imported the type; the queueing limiter below never throws it.
    constructor(channel: string, limit: number) {
        super(
            `IPC "${channel}" rejected: ${limit} concurrent requests already in flight.`,
        );
        this.name = "IpcRateLimitError";
    }
}

export function createIpcInFlightLimiter(
    _channel: string,
    maxInFlight: number,
): <T>(run: () => Promise<T>) => Promise<T> {
    let inFlight = 0;
    const waiters: Array<() => void> = [];

    const acquire = (): Promise<void> => {
        if (inFlight < maxInFlight) {
            inFlight += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            waiters.push(() => {
                inFlight += 1;
                resolve();
            });
        });
    };

    const release = (): void => {
        inFlight -= 1;
        const next = waiters.shift();
        if (next) {
            next();
        }
    };

    return async (run) => {
        await acquire();
        try {
            return await run();
        } finally {
            release();
        }
    };
}
