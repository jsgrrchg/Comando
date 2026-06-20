pub mod copy;
pub mod error;
pub mod mutations;
pub mod origin;
pub mod path;
pub mod policy;
pub mod read;
pub mod registry;
pub mod tree;
pub mod watcher;
pub mod write;

#[cfg(test)]
pub mod test_support;

use std::time::{SystemTime, UNIX_EPOCH};

pub use copy::{copy_entries, copy_external_entries};
pub use error::FsError;
pub use mutations::{
    create_directory, create_file, delete_entry, mutation_result_for_path, rename_entry,
};
pub use origin::WriteTracker;
pub use read::read_file;
pub use registry::{ProjectFsService, ProjectRoot, ProjectRootRegistry};
pub use tree::{list_entries, list_tree_children};
pub use watcher::{WatcherDrain, WatcherRegistry};
pub use write::write_file;

pub fn system_time_to_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
