import { Component, type ErrorInfo, type ReactNode } from "react";

import { recordProbeLifecycleEvent } from "@renderer/app/debug/renderProbe";

interface ChatPresentationErrorBoundaryProps {
    readonly children: ReactNode;
    readonly fallbackKind: "chat" | "row";
    readonly identity: string;
}

interface ChatPresentationErrorBoundaryState {
    readonly error: Error | null;
    readonly generation: number;
}

export class ChatPresentationErrorBoundary extends Component<
    ChatPresentationErrorBoundaryProps,
    ChatPresentationErrorBoundaryState
> {
    state: ChatPresentationErrorBoundaryState = {
        error: null,
        generation: 0,
    };

    static getDerivedStateFromError(error: Error): Partial<ChatPresentationErrorBoundaryState> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        // Keep the original exception available in production consoles; the
        // fallback must isolate a broken view without making it opaque.
        console.error("[comando] Chat presentation failed to render.", error, {
            componentStack: info.componentStack,
            fallbackKind: this.props.fallbackKind,
            identity: this.props.identity,
        });
        recordProbeLifecycleEvent("ChatPresentationError", "mount", {
            errorMessage: error.message.slice(0, 240),
            errorName: error.name,
            fallbackKind: this.props.fallbackKind,
            hasComponentStack: Boolean(info.componentStack),
        });
    }

    componentDidUpdate(previousProps: ChatPresentationErrorBoundaryProps): void {
        if (
            this.state.error &&
            previousProps.identity !== this.props.identity
        ) {
            this.setState((state) => ({
                error: null,
                generation: state.generation + 1,
            }));
        }
    }

    private retry = (): void => {
        this.setState((state) => ({
            error: null,
            generation: state.generation + 1,
        }));
    };

    render(): ReactNode {
        if (!this.state.error) {
            return <div key={this.state.generation} className="contents">{this.props.children}</div>;
        }

        const isChat = this.props.fallbackKind === "chat";
        return (
            <div
                className={
                    isChat
                        ? "flex h-full min-h-0 items-center justify-center p-6"
                        : "rounded-md border border-danger/30 bg-danger/5 p-3"
                }
                data-chat-presentation-fallback={this.props.fallbackKind}
                role="alert"
            >
                <div className="flex max-w-md flex-col items-start gap-2">
                    <p className="text-sm font-medium text-foreground">
                        {isChat
                            ? "Chat view failed to render"
                            : "This activity could not be displayed"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        Your session is still running. Retry only rebuilds the presentation.
                    </p>
                    <button
                        className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
                        onClick={this.retry}
                        type="button"
                    >
                        Retry view
                    </button>
                </div>
            </div>
        );
    }
}
