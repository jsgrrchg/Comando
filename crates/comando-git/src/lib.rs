pub mod branches;
pub mod diff;
pub mod env;
pub mod error;
pub mod history;
pub mod mutations;
pub mod original_file;
pub mod remotes;
pub mod repository;
pub mod runner;
pub mod snapshot;
pub mod status;
pub mod worktree_diff;
pub mod worktrees;

#[cfg(test)]
pub mod test_support;

pub use branches::{GitBranchListScope, list_branches};
pub use diff::{GitFileDiffRequest, get_diff_stats, get_file_diff, parse_unified_diff};
pub use env::GitEnvironment;
pub use error::{GitError, GitResult};
pub use history::{get_commit_detail, list_history};
pub use mutations::{
    checkout_branch, commit, create_branch, create_worktree, delete_local_branch,
    delete_remote_branch, discard_paths, fetch, init_repository, pull, push, remove_worktree,
    stage_paths, unstage_paths,
};
pub use original_file::{GitFileTextReference, get_file_text, get_original_file};
pub use remotes::list_remotes;
pub use repository::{GitRepositoryContext, resolve_repository};
pub use runner::{GitCommandKind, GitOutput, GitRunOptions, GitRunner};
pub use snapshot::get_repository_snapshot;
pub use status::{get_status, parse_status_porcelain};
pub use worktree_diff::list_worktree_diff;
pub use worktrees::{list_worktrees, parse_worktree_porcelain};
