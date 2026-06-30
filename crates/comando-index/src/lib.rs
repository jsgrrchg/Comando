pub mod builder;
pub mod cancellation;
pub mod content;
pub mod entry;
pub mod error;
pub mod incremental;
pub mod policy;
pub mod query;
pub mod ranking;
pub mod service;
pub mod stats;

#[cfg(test)]
pub mod test_support;

pub use builder::{IndexBuildOptions, build_project_index};
pub use cancellation::{CancellationRegistry, CancellationToken};
pub use content::search_project_content;
pub use entry::{IndexEntryKind, IndexedProjectEntry};
pub use error::{IndexError, IndexResult};
pub use incremental::{IndexUpdate, IndexUpdateKind};
pub use policy::{IndexPolicy, IndexPolicyState};
pub use query::{ProjectSearchQuery, normalize_project_search_query};
pub use ranking::{SearchMatch, search_entries};
pub use service::{
    IndexEvent, IndexService, ProjectSearchOperation, ProjectSearchResult, ProjectSearchSnapshot,
    search_project_entries_snapshot,
};
pub use stats::{IndexBuildStats, IndexStatus, IndexStatusSnapshot};
