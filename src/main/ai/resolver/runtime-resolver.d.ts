import type { AiRuntimeStatus, CodexRuntimeSettings } from "@shared/ipc";
export interface RuntimeCommandSpec {
    readonly args: readonly string[];
    readonly command: string;
    readonly executable: string;
}
export interface ResolvedRuntimeCommand {
    readonly args: readonly string[];
    readonly command: string;
    readonly executable: string;
    readonly status: AiRuntimeStatus;
}
export declare function resolveCodexRuntime(settings: CodexRuntimeSettings): ResolvedRuntimeCommand;
