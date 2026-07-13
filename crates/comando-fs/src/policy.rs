use std::path::Path;

use comando_types::fs::NativeFsVisibilityPolicy;

const NOISY_DIRECTORY_NAMES: &[&str] =
    &["node_modules", "dist", "target", "build", "coverage", "out"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitWatchInvalidationReason {
    Filesystem,
    Status,
    Branch,
    Worktree,
    Remote,
    Unknown,
}

impl GitWatchInvalidationReason {
    pub fn as_native_reason(self) -> &'static str {
        match self {
            Self::Remote => "remote",
            Self::Worktree => "worktree",
            Self::Branch => "branch",
            Self::Status => "status",
            Self::Filesystem => "filesystem",
            Self::Unknown => "unknown",
        }
    }

    pub fn priority(self) -> u8 {
        match self {
            Self::Remote => 5,
            Self::Worktree => 4,
            Self::Branch => 3,
            Self::Status => 2,
            Self::Filesystem => 1,
            Self::Unknown => 0,
        }
    }
}

pub fn tree_visibility_for_entry(name: &str, is_directory: bool) -> NativeFsVisibilityPolicy {
    if is_directory && name == ".git" {
        return NativeFsVisibilityPolicy::Special;
    }

    if is_directory && NOISY_DIRECTORY_NAMES.contains(&name) {
        return NativeFsVisibilityPolicy::Noisy;
    }

    NativeFsVisibilityPolicy::Visible
}

pub fn should_expand_directory_by_default(
    name: &str,
    visibility: NativeFsVisibilityPolicy,
) -> bool {
    !matches!(
        visibility,
        NativeFsVisibilityPolicy::Special | NativeFsVisibilityPolicy::TooLargeToExpand
    ) && name != ".git"
}

pub fn should_ignore_watch_path(relative_path: &str) -> bool {
    let normalized = relative_path.to_lowercase();
    let segments = normalized.split('/').collect::<Vec<_>>();
    let file_name = segments.last().copied().unwrap_or(normalized.as_str());

    if git_watch_invalidation_reason(&normalized).is_some() {
        return false;
    }

    normalized == ".git/index"
        || normalized == ".git/index.lock"
        || segments
            .iter()
            .any(|segment| NOISY_DIRECTORY_NAMES.contains(segment) || *segment == ".git")
        || matches!(file_name, ".ds_store" | "thumbs.db")
        || file_name.ends_with(".tsbuildinfo")
}

pub fn is_special_no_expand_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| name == ".git")
}

pub fn git_watch_invalidation_reason(relative_path: &str) -> Option<GitWatchInvalidationReason> {
    let normalized = relative_path.replace('\\', "/").to_lowercase();
    let path = normalized.as_str();

    if !path.starts_with(".git/") {
        return None;
    }

    match path {
        ".git/index" | ".git/index.lock" => Some(GitWatchInvalidationReason::Status),
        ".git/head" | ".git/packed-refs" => Some(GitWatchInvalidationReason::Branch),
        ".git/orig_head" | ".git/merge_head" | ".git/cherry_pick_head" | ".git/rebase_head" => {
            Some(GitWatchInvalidationReason::Status)
        }
        _ if path.starts_with(".git/refs/") => Some(GitWatchInvalidationReason::Branch),
        _ if path == ".git/logs/head" || path.starts_with(".git/logs/refs/") => {
            Some(GitWatchInvalidationReason::Branch)
        }
        _ if path.starts_with(".git/rebase-merge/") || path.starts_with(".git/rebase-apply/") => {
            Some(GitWatchInvalidationReason::Status)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        GitWatchInvalidationReason, git_watch_invalidation_reason, should_ignore_watch_path,
    };

    #[test]
    fn keeps_git_index_paths_that_invalidate_status() {
        assert_eq!(
            git_watch_invalidation_reason(".git/index"),
            Some(GitWatchInvalidationReason::Status),
        );
        assert_eq!(
            git_watch_invalidation_reason(".git/index.lock"),
            Some(GitWatchInvalidationReason::Status),
        );
        assert!(!should_ignore_watch_path(".git/index"));
        assert!(!should_ignore_watch_path(".git/index.lock"));
    }

    #[test]
    fn keeps_git_metadata_paths_that_invalidate_repository_state() {
        assert_eq!(
            git_watch_invalidation_reason(".git/HEAD"),
            Some(GitWatchInvalidationReason::Branch),
        );
        assert_eq!(
            git_watch_invalidation_reason(".git/refs/heads/main"),
            Some(GitWatchInvalidationReason::Branch),
        );
        assert_eq!(
            git_watch_invalidation_reason(".git/packed-refs"),
            Some(GitWatchInvalidationReason::Branch),
        );
        assert_eq!(
            git_watch_invalidation_reason(".git/MERGE_HEAD"),
            Some(GitWatchInvalidationReason::Status),
        );

        assert!(!should_ignore_watch_path(".git/HEAD"));
        assert!(!should_ignore_watch_path(".git/refs/heads/main"));
    }

    #[test]
    fn ignores_unclassified_git_internals() {
        assert!(should_ignore_watch_path(".git/objects/00/example"));
    }
}
