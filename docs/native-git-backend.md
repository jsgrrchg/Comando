# Native Git Backend

Git reads, local mutations, worktree operations, and network operations route
through the Rust sidecar. Electron main keeps only the `GitGateway` contract and
the `NativeGitGateway` DTO adapter.

There is no TypeScript Git worker and no JavaScript Git dependency. If a native
Git operation fails, the error is surfaced to the UI instead of falling back to a
second backend.

High-risk operations such as discard, checkout, worktree removal, and network
commands should stay covered by native gateway tests and Rust crate tests.
