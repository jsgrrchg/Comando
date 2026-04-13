import type { PropsWithChildren, ReactNode } from "react";
interface PanelCardProps extends PropsWithChildren {
    readonly title: string;
    readonly eyebrow?: string;
    readonly aside?: ReactNode;
    readonly className?: string;
}
export declare function PanelCard({ aside, children, className, eyebrow, title, }: PanelCardProps): import("react/jsx-runtime").JSX.Element;
export {};
