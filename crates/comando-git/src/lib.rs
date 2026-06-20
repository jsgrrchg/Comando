pub mod branches;
pub mod env;
pub mod error;
pub mod remotes;
pub mod repository;
pub mod runner;
pub mod snapshot;
pub mod status;
pub mod worktrees;

#[cfg(test)]
pub mod test_support;

pub use branches::{GitBranchListScope, list_branches};
pub use env::GitEnvironment;
pub use error::{GitError, GitResult};
pub use remotes::list_remotes;
pub use repository::{GitRepositoryContext, resolve_repository};
pub use runner::{GitCommandKind, GitOutput, GitRunOptions, GitRunner};
pub use snapshot::get_repository_snapshot;
pub use status::{get_status, parse_status_porcelain};
pub use worktrees::{list_worktrees, parse_worktree_porcelain};
