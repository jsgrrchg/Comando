import { Component, type ReactNode } from "react";

interface PierreGitDiffErrorBoundaryProps {
    readonly children: ReactNode;
    readonly fallback: ReactNode;
    readonly fileId: string;
}

interface PierreGitDiffErrorBoundaryState {
    readonly error: Error | null;
}

export class PierreGitDiffErrorBoundary extends Component<
    PierreGitDiffErrorBoundaryProps,
    PierreGitDiffErrorBoundaryState
> {
    state: PierreGitDiffErrorBoundaryState = { error: null };

    static getDerivedStateFromError(
        error: Error,
    ): PierreGitDiffErrorBoundaryState {
        return { error };
    }

    componentDidUpdate(previousProps: PierreGitDiffErrorBoundaryProps): void {
        if (this.state.error && previousProps.fileId !== this.props.fileId) {
            // A new file gets a fresh renderer attempt instead of inheriting a prior failure.
            this.setState({ error: null });
        }
    }

    render(): ReactNode {
        return this.state.error ? this.props.fallback : this.props.children;
    }
}
