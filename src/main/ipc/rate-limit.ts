// Small in-flight limiter for IPC handlers that are costly enough that a
// buggy renderer loop could saturate the main process or a worker pool. The
// IDE is single-user with no adversary model, so this is defensive hardening
// against accidental fan-out rather than abuse protection.

export class IpcRateLimitError extends Error {
    constructor(channel: string, limit: number) {
        super(
            `IPC "${channel}" rejected: ${limit} concurrent requests already in flight.`,
        );
        this.name = "IpcRateLimitError";
    }
}

export function createIpcInFlightLimiter(
    channel: string,
    maxInFlight: number,
): <T>(run: () => Promise<T>) => Promise<T> {
    let inFlight = 0;
    return async (run) => {
        if (inFlight >= maxInFlight) {
            throw new IpcRateLimitError(channel, maxInFlight);
        }
        inFlight += 1;
        try {
            return await run();
        } finally {
            inFlight -= 1;
        }
    };
}
