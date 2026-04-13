import type { RuntimeWorkspaceReviewTab } from "@renderer/app/workspace/tree";
interface ReviewTabViewProps {
    readonly onOpenFile: (projectId: string, relativePath: string) => Promise<void>;
    readonly tab: RuntimeWorkspaceReviewTab;
}
export declare function ReviewTabView({ onOpenFile, tab }: ReviewTabViewProps): import("react/jsx-runtime").JSX.Element;
export {};
