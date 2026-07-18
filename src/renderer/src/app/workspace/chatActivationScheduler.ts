import type { TranscriptSemanticAnchor } from "@renderer/components/workspace/chat/transcriptBlockVirtualization";

export type ChatActivationPhase =
    | "shell"
    | "window"
    | "visible-payloads"
    | "prefetch";

export interface ChatTabPresentationState {
    readonly anchor: TranscriptSemanticAnchor | null;
    readonly expandedRailIds: ReadonlySet<string>;
    readonly followingLiveTail: boolean;
    readonly protectedBlockIds: ReadonlySet<string>;
}

export class ChatActivationScheduler {
    private readonly generations = new Map<string, number>();
    private readonly presentationByTab = new Map<string, ChatTabPresentationState>();

    activate(
        tabId: string,
        runPhase: (phase: ChatActivationPhase) => void | Promise<void>,
    ): () => void {
        const generation = (this.generations.get(tabId) ?? 0) + 1;
        this.generations.set(tabId, generation);
        void this.run(tabId, generation, runPhase);
        return () => {
            if (this.generations.get(tabId) === generation) {
                this.generations.set(tabId, generation + 1);
            }
        };
    }

    save(tabId: string, state: ChatTabPresentationState): void {
        this.presentationByTab.set(tabId, state);
    }

    restore(tabId: string): ChatTabPresentationState | null {
        return this.presentationByTab.get(tabId) ?? null;
    }

    private async run(
        tabId: string,
        generation: number,
        runPhase: (phase: ChatActivationPhase) => void | Promise<void>,
    ): Promise<void> {
        const phases: readonly ChatActivationPhase[] = [
            "shell",
            "window",
            "visible-payloads",
            "prefetch",
        ];
        for (const phase of phases) {
            if (this.generations.get(tabId) !== generation) return;
            await runPhase(phase);
        }
    }
}

export const chatActivationScheduler = new ChatActivationScheduler();
