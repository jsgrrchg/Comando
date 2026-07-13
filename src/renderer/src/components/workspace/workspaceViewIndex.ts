import type { RuntimeWorkspaceTab } from "@renderer/app/workspace/tree";
import type { WorkspaceNode } from "@shared/ipc";

interface WorkspaceViewIndex {
    readonly nodesById: ReadonlyMap<string, WorkspaceNode>;
    readonly paneCount: number;
}

const indexesByRoot = new WeakMap<WorkspaceNode, WorkspaceViewIndex>();
const hasChatByTabs = new WeakMap<
    Readonly<Record<string, RuntimeWorkspaceTab>>,
    boolean
>();

function buildWorkspaceViewIndex(rootNode: WorkspaceNode): WorkspaceViewIndex {
    const nodesById = new Map<string, WorkspaceNode>();
    const pendingNodes = [rootNode];
    let paneCount = 0;

    while (pendingNodes.length > 0) {
        const node = pendingNodes.pop();
        if (!node) {
            continue;
        }

        nodesById.set(node.id, node);
        if (node.type === "pane") {
            paneCount += 1;
            continue;
        }

        for (let index = node.children.length - 1; index >= 0; index -= 1) {
            pendingNodes.push(node.children[index]);
        }
    }

    return { nodesById, paneCount };
}

function getWorkspaceViewIndex(rootNode: WorkspaceNode): WorkspaceViewIndex {
    const cached = indexesByRoot.get(rootNode);
    if (cached) {
        return cached;
    }

    const index = buildWorkspaceViewIndex(rootNode);
    indexesByRoot.set(rootNode, index);
    return index;
}

export function getIndexedWorkspaceNode(
    rootNode: WorkspaceNode,
    nodeId: string,
): WorkspaceNode | null {
    return getWorkspaceViewIndex(rootNode).nodesById.get(nodeId) ?? null;
}

export function getIndexedWorkspacePaneCount(rootNode: WorkspaceNode): number {
    return getWorkspaceViewIndex(rootNode).paneCount;
}

export function getIndexedWorkspaceHasChat(
    tabsById: Readonly<Record<string, RuntimeWorkspaceTab>>,
): boolean {
    const cached = hasChatByTabs.get(tabsById);
    if (cached !== undefined) {
        return cached;
    }

    const hasChat = Object.values(tabsById).some((tab) => tab.kind === "chat");
    hasChatByTabs.set(tabsById, hasChat);
    return hasChat;
}
