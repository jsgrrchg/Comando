export type ContextMenuEntry = {
    readonly type?: "item";
    readonly label: string;
    readonly action?: () => void;
    readonly danger?: boolean;
    readonly disabled?: boolean;
} | {
    readonly type: "separator";
};
export interface ContextMenuState<T = void> {
    readonly x: number;
    readonly y: number;
    readonly payload: T;
}
export declare function ContextMenu<T>({ entries, menu, minWidth, onClose, zIndex, }: {
    readonly entries: readonly ContextMenuEntry[];
    readonly menu: ContextMenuState<T>;
    readonly minWidth?: number;
    readonly onClose: () => void;
    readonly zIndex?: number;
}): import("react").ReactPortal;
