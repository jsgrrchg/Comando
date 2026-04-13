import { type AppBootstrapSnapshot } from "@shared/ipc";
import type { AiService } from "@main/ai/service";
import type { ProjectService } from "@main/projects/service";
import type { PersistenceService } from "@main/persistence/service";
import type { SettingsService } from "@main/settings/service";
import type { TerminalService } from "@main/terminals/service";
import type { WorkspaceService } from "@main/workspace/service";
interface RegisterIpcHandlersOptions {
    readonly aiService: AiService;
    readonly getSnapshot: () => AppBootstrapSnapshot;
    readonly persistenceService: PersistenceService;
    readonly projectService: ProjectService;
    readonly settingsService: SettingsService;
    readonly terminalService: TerminalService;
    readonly workspaceService: WorkspaceService;
}
export declare function registerIpcHandlers(options: RegisterIpcHandlersOptions): void;
export {};
