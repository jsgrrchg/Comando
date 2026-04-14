import { GitEmptyState } from "./GitUi";
import { GitTreeView } from "./GitTreeView";
import type { GitFilesViewProps } from "./types";

export function GitFilesView({
    className,
    emptyState,
    ...treeProps
}: GitFilesViewProps) {
    if (treeProps.nodes.length === 0) {
        return (
            <GitEmptyState className={className}>
                {emptyState ?? "No files to show."}
            </GitEmptyState>
        );
    }

    return (
        <div
            className={[
                "min-h-0 flex-1 overflow-y-auto px-2 py-2",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            <GitTreeView {...treeProps} />
        </div>
    );
}
