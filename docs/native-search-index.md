# Native Search And Index

Project entry listing, path search, content search, index rebuilds, index
updates, project drops, status reads, and cancellation route through the Rust
sidecar.

Electron main keeps `NativeSearchGateway` as a DTO adapter. Search cancellation
contexts are scoped by caller so quick-open, tree listing, and other consumers
do not cancel each other accidentally.
