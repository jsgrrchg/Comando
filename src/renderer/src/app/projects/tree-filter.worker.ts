import type { ProjectTreeNode } from "@shared/ipc";

import { filterProjectEntriesForTreeFilter, type ProjectEntriesFilterStrategy } from "./tree-filter";

self.onmessage = ({
    data,
}: MessageEvent<{
    readonly entries: readonly ProjectTreeNode[];
    readonly id: number;
    readonly query: string;
    readonly strategy: ProjectEntriesFilterStrategy;
}>) => {
    self.postMessage({
        id: data.id,
        matches: filterProjectEntriesForTreeFilter(
            data.entries,
            data.query,
            data.strategy,
        ),
    });
};
