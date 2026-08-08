import { describe, expect, it, vi } from "vitest";

import {
    applyPrunedHistorySideEffects,
    HistoryRetentionCoordinator,
} from "./history-retention";

const EMPTY_RESULT = {
    deletedRootIds: [],
    deletedSessionIds: [],
    failedRootIds: [],
    inspectedSessionCount: 0,
    protectedTreeCount: 0,
    invalidMetadataCount: 0,
    invalidTimestampCount: 0,
    policyChanged: false,
} as const;

describe("HistoryRetentionCoordinator", () => {
    it("runs at startup and on the daily schedule when retention is enabled", async () => {
        let scheduled: () => void = () => {
            throw new Error("Expected the retention schedule to be installed.");
        };
        const pruneExpiredHistory = vi.fn().mockResolvedValue(EMPTY_RESULT);
        const coordinator = new HistoryRetentionCoordinator({
            getRetentionDays: () => 7,
            now: () => Date.parse("2026-08-08T12:00:00.000Z"),
            pruneExpiredHistory,
            scheduleEvery: (callback, intervalMs) => {
                expect(intervalMs).toBe(24 * 60 * 60 * 1_000);
                scheduled = callback;
                return vi.fn();
            },
        });

        coordinator.start();
        await vi.waitFor(() => expect(pruneExpiredHistory).toHaveBeenCalledTimes(1));
        expect(pruneExpiredHistory).toHaveBeenLastCalledWith(
            "2026-08-01T12:00:00.000Z",
            7,
        );

        scheduled();
        await vi.waitFor(() => expect(pruneExpiredHistory).toHaveBeenCalledTimes(2));
        coordinator.close();
    });

    it("does not run for Forever or a less restrictive change", async () => {
        const pruneExpiredHistory = vi.fn().mockResolvedValue(EMPTY_RESULT);
        const coordinator = new HistoryRetentionCoordinator({
            getRetentionDays: () => 0,
            pruneExpiredHistory,
            scheduleEvery: () => vi.fn(),
        });

        coordinator.start();
        coordinator.updateRetentionDays(30);
        await vi.waitFor(() => expect(pruneExpiredHistory).toHaveBeenCalledTimes(1));
        coordinator.updateRetentionDays(90);
        coordinator.updateRetentionDays(0);
        await Promise.resolve();

        expect(pruneExpiredHistory).toHaveBeenCalledTimes(1);
        coordinator.close();
    });

    it("runs immediately when the saved policy becomes more restrictive", async () => {
        const onPruned = vi.fn();
        const pruneExpiredHistory = vi.fn().mockResolvedValue({
            ...EMPTY_RESULT,
            deletedRootIds: ["root"],
            deletedSessionIds: ["root", "child"],
            inspectedSessionCount: 2,
        });
        const coordinator = new HistoryRetentionCoordinator({
            getRetentionDays: () => 30,
            now: () => Date.parse("2026-08-08T12:00:00.000Z"),
            onPruned,
            pruneExpiredHistory,
            scheduleEvery: () => vi.fn(),
        });

        coordinator.start();
        await vi.waitFor(() => expect(pruneExpiredHistory).toHaveBeenCalledTimes(1));
        coordinator.updateRetentionDays(7);
        await vi.waitFor(() => expect(pruneExpiredHistory).toHaveBeenCalledTimes(2));

        expect(pruneExpiredHistory).toHaveBeenLastCalledWith(
            "2026-08-01T12:00:00.000Z",
            7,
        );
        expect(onPruned).toHaveBeenLastCalledWith(
            expect.objectContaining({
                deletedSessionIds: ["root", "child"],
                reason: "settings_change",
                retentionDays: 7,
            }),
        );
        coordinator.close();
    });

    it("coalesces concurrent triggers into one follow-up run", async () => {
        let resolveFirst!: (value: typeof EMPTY_RESULT) => void;
        const first = new Promise<typeof EMPTY_RESULT>((resolve) => {
            resolveFirst = resolve;
        });
        const pruneExpiredHistory = vi
            .fn()
            .mockReturnValueOnce(first)
            .mockResolvedValue(EMPTY_RESULT);
        const coordinator = new HistoryRetentionCoordinator({
            getRetentionDays: () => 7,
            pruneExpiredHistory,
            scheduleEvery: () => vi.fn(),
        });

        coordinator.start();
        await vi.waitFor(() => expect(pruneExpiredHistory).toHaveBeenCalledTimes(1));
        void coordinator.trigger("scheduled");
        void coordinator.trigger("scheduled");
        resolveFirst(EMPTY_RESULT);

        await vi.waitFor(() => expect(pruneExpiredHistory).toHaveBeenCalledTimes(2));
        coordinator.close();
    });
});

describe("applyPrunedHistorySideEffects", () => {
    it("broadcasts deleted sessions when durable reference cleanup partially fails", async () => {
        const broadcast = vi.fn();
        const onDiagnostic = vi.fn();
        const forgetSessionReferences = vi.fn((sessionId: string) =>
            sessionId === "child"
                ? Promise.reject(new Error("Injected cleanup failure"))
                : Promise.resolve(1),
        );
        const result = {
            ...EMPTY_RESULT,
            cutoff: "2026-08-01T12:00:00.000Z",
            deletedRootIds: ["root"],
            deletedSessionIds: ["root", "child"],
            reason: "startup" as const,
            retentionDays: 7 as const,
        };

        await applyPrunedHistorySideEffects(result, {
            broadcast,
            forgetSessionReferences,
            onDiagnostic,
        });

        expect(forgetSessionReferences).toHaveBeenCalledTimes(2);
        expect(onDiagnostic).toHaveBeenCalledWith(
            expect.stringContaining("1 durable workspace reference"),
        );
        expect(broadcast).toHaveBeenCalledWith(result);
    });
});
