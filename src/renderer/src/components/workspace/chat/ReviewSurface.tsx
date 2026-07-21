import { memo, type ComponentProps } from "react";

import { EditedFilesBufferPanel } from "./EditedFilesBufferPanel";

type ReviewSurfaceProps = Omit<
    ComponentProps<typeof EditedFilesBufferPanel>,
    "defaultCollapsed"
>;

// Keeps the expensive review surface isolated from streaming transcript updates.
export const ReviewSurface = memo(function ReviewSurface(props: ReviewSurfaceProps) {
    return <EditedFilesBufferPanel {...props} defaultCollapsed />;
});
