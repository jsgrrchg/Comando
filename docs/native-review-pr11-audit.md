# Native Review Ownership

Review baseline capture, tracked-file reconciliation, keep/reject file, and
keep/reject hunk mutations are owned by the Rust sidecar.

Electron main keeps review projection and renderer notification logic. It must
not keep a canonical TypeScript review state or mutate review files through a
retired worker path.
