export interface ChatPerformanceClock {
    now: () => number;
}

export interface ChatPerformanceCounter {
    count: (name: string, amount?: number) => void;
    snapshot: () => Readonly<Record<string, number>>;
}

export interface ChatPerformanceMeasurement<T> {
    readonly durationMs: number;
    readonly name: string;
    readonly result: T;
    readonly work: Readonly<Record<string, number>>;
}

export function createChatPerformanceCounter(): ChatPerformanceCounter {
    const work = new Map<string, number>();

    return {
        count(name, amount = 1) {
            work.set(name, (work.get(name) ?? 0) + amount);
        },
        snapshot() {
            return Object.freeze(Object.fromEntries(work));
        },
    };
}

export function measureChatPerformanceWork<T>(
    name: string,
    operation: (counter: ChatPerformanceCounter) => T,
    clock: ChatPerformanceClock = defaultChatPerformanceClock,
): ChatPerformanceMeasurement<T> {
    const counter = createChatPerformanceCounter();
    const startedAt = clock.now();
    const result = operation(counter);
    const durationMs = Math.max(0, clock.now() - startedAt);

    return {
        durationMs,
        name,
        result,
        work: counter.snapshot(),
    };
}

const defaultChatPerformanceClock: ChatPerformanceClock = {
    now: () =>
        typeof performance !== "undefined" ? performance.now() : Date.now(),
};
