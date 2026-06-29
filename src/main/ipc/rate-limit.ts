// Small in-flight limiter for IPC handlers that are costly enough that a
// buggy renderer loop could saturate the main process or a worker pool. The
// IDE is single-user with no adversary model, so this is defensive hardening
// against accidental fan-out rather than abuse protection.
// Excess requests queue until an in-flight slot opens. Throughput stays capped
// while legitimate bursty flows, such as workspace restore and project tree
// hydration, avoid user-facing failures.

export function createIpcInFlightLimiter(
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
