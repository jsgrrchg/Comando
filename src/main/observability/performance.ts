import type { AiSessionUpdate } from "@shared/ipc";

export type PerformanceOperationName =
    | "db.ai.deleteSession"
    | "db.ai.listSessionHistory"
    | "db.ai.loadSessionTranscriptPage"
    | "db.ai.loadSessionSnapshot"
    | "db.ai.saveSessionSnapshot"
    | "db.ai.setSessionPinned"
    | "db.projects.listProjects"
    | "db.workspace.loadSnapshot"
    | "db.workspace.saveSnapshot"
    | "git.discardPaths"
    | "git.getRepositorySnapshot"
    | "projects.buildSearchIndex"
    | "projects.listProjectTreeChildren"
    | "workers.ai.rpc"
    | "workers.db.rpc"
    | "workers.git.rpc"
    | "workers.projects.rpc";

export interface OperationMetadata {
    readonly [key: string]: boolean | number | string | null | undefined;
}

class MainProcessPerformanceMonitor {
    startEventLoopMonitor(): void {
        return;
    }

    markAppWhenReady(): void {
        return;
    }

    markFirstMainWindowReady(): void {
        return;
    }

    measureSync<T>(
        operation: PerformanceOperationName,
        work: () => T,
        metadata?: OperationMetadata,
    ): T {
        void operation;
        void metadata;
        return work();
    }

    async measureAsync<T>(
        operation: PerformanceOperationName,
        work: () => Promise<T>,
        metadata?: OperationMetadata,
    ): Promise<T> {
        void operation;
        void metadata;
        return await work();
    }

    recordAiSessionUpdate(payload: AiSessionUpdate): void {
        void payload;
        return;
    }

    flush(): void {
        return;
    }

    stop(): void {
        return;
    }
}

export const mainProcessPerformance = new MainProcessPerformanceMonitor();
