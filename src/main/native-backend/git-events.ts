import type { GitRepositoryInvalidation } from "@shared/ipc";
import {
    nativeGitInvalidationToIpc,
    type NativeGitRepositoryInvalidation,
} from "@shared/native-backend";

import type { NativeBackendEvent } from "./protocol";

export function nativeGitEventToIpcInvalidation(
    event: NativeBackendEvent,
): GitRepositoryInvalidation | null {
    if (event.eventName !== "git://repository-invalidated") {
        return null;
    }

    return nativeGitInvalidationToIpc(
        event.payload as NativeGitRepositoryInvalidation,
    );
}
