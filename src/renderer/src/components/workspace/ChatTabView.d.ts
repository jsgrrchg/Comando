import type { RuntimeWorkspaceChatTab } from "@renderer/app/workspace/tree";
interface ChatTabViewProps {
    readonly onDraftChange: (draft: string) => void;
    readonly onOpenFile: (projectId: string, relativePath: string) => Promise<void>;
    readonly onOpenReview: () => Promise<void>;
    readonly tab: RuntimeWorkspaceChatTab;
}
export declare function ChatTabView({ onDraftChange, onOpenFile, onOpenReview, tab, }: ChatTabViewProps): import("react/jsx-runtime").JSX.Element;
export {};
