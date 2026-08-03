import type { WorkspaceScopeKey } from "./workspace-context";

export type WorkspaceSurfaceLifecycleState =
    | "active"
    | "cold"
    | "disposing"
    | "error"
    | "suspending"
    | "warm"
    | "warming";

export type WorkspaceActivationState =
    | WorkspaceActivationIdleState
    | WorkspaceActivationWarmingState
    | WorkspaceActivationReadyState
    | WorkspaceActivationFailedState;

interface WorkspaceActivationBaseState {
    readonly committedScopeKey: WorkspaceScopeKey | null;
    readonly generation: number;
}

export interface WorkspaceActivationIdleState
    extends WorkspaceActivationBaseState {
    readonly phase: "idle";
    readonly targetScopeKey: null;
}

export interface WorkspaceActivationWarmingState
    extends WorkspaceActivationBaseState {
    readonly phase: "warming";
    readonly targetScopeKey: WorkspaceScopeKey;
}

export interface WorkspaceActivationReadyState
    extends WorkspaceActivationBaseState {
    readonly phase: "ready";
    readonly targetScopeKey: WorkspaceScopeKey;
}

export interface WorkspaceActivationFailedState
    extends WorkspaceActivationBaseState {
    readonly errorCode: string;
    readonly phase: "failed";
    readonly targetScopeKey: WorkspaceScopeKey;
}

export type WorkspaceActivationEvent =
    | {
          readonly generation: number;
          readonly targetScopeKey: WorkspaceScopeKey;
          readonly type: "begin";
      }
    | {
          readonly generation: number;
          readonly targetScopeKey: WorkspaceScopeKey;
          readonly type: "surface-ready";
      }
    | {
          readonly generation: number;
          readonly targetScopeKey: WorkspaceScopeKey;
          readonly type: "commit";
      }
    | {
          readonly errorCode: string;
          readonly generation: number;
          readonly targetScopeKey: WorkspaceScopeKey;
          readonly type: "fail";
      }
    | { readonly type: "clear-failure" };

const SURFACE_TRANSITIONS = {
    active: ["warm", "error", "disposing"],
    cold: ["warming", "error", "disposing"],
    disposing: [],
    error: ["warming", "cold", "disposing"],
    suspending: ["cold", "warm", "error", "disposing"],
    warm: ["active", "suspending", "error", "disposing"],
    warming: ["active", "error", "disposing"],
} as const satisfies Record<
    WorkspaceSurfaceLifecycleState,
    readonly WorkspaceSurfaceLifecycleState[]
>;

export function createWorkspaceActivationState(
    committedScopeKey: WorkspaceScopeKey | null,
): WorkspaceActivationIdleState {
    return {
        committedScopeKey,
        generation: 0,
        phase: "idle",
        targetScopeKey: null,
    };
}

export function reduceWorkspaceActivation(
    state: WorkspaceActivationState,
    event: WorkspaceActivationEvent,
): WorkspaceActivationState {
    if (event.type === "clear-failure") {
        return state.phase === "failed"
            ? {
                  committedScopeKey: state.committedScopeKey,
                  generation: state.generation,
                  phase: "idle",
                  targetScopeKey: null,
              }
            : state;
    }

    if (event.type === "begin") {
        if (event.generation <= state.generation) {
            return state;
        }
        return {
            committedScopeKey: state.committedScopeKey,
            generation: event.generation,
            phase: "warming",
            targetScopeKey: event.targetScopeKey,
        };
    }

    if (!matchesPendingActivation(state, event)) {
        return state;
    }

    if (event.type === "surface-ready" && state.phase === "warming") {
        return { ...state, phase: "ready" };
    }

    if (event.type === "commit" && state.phase === "ready") {
        return {
            committedScopeKey: event.targetScopeKey,
            generation: event.generation,
            phase: "idle",
            targetScopeKey: null,
        };
    }

    if (
        event.type === "fail" &&
        (state.phase === "warming" || state.phase === "ready")
    ) {
        return {
            committedScopeKey: state.committedScopeKey,
            errorCode: event.errorCode,
            generation: event.generation,
            phase: "failed",
            targetScopeKey: event.targetScopeKey,
        };
    }

    return state;
}

export function isWorkspaceSurfaceTransitionAllowed(
    from: WorkspaceSurfaceLifecycleState,
    to: WorkspaceSurfaceLifecycleState,
): boolean {
    return (SURFACE_TRANSITIONS[from] as readonly WorkspaceSurfaceLifecycleState[])
        .includes(to);
}

function matchesPendingActivation(
    state: WorkspaceActivationState,
    event: Exclude<WorkspaceActivationEvent, { readonly type: "begin" | "clear-failure" }>,
): boolean {
    return (
        state.phase !== "idle" &&
        event.generation === state.generation &&
        event.targetScopeKey === state.targetScopeKey
    );
}
