use std::path::Path;

use comando_types::fs::NativeFsVisibilityPolicy;

const NOISY_DIRECTORY_NAMES: &[&str] =
    &["node_modules", "dist", "target", "build", "coverage", "out"];

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

pub fn git_watch_invalidation_reason(relative_path: &str) -> Option<&'static str> {
    let normalized = relative_path.replace('\\', "/").to_lowercase();
    let path = normalized.as_str();

    if !path.starts_with(".git/") {
        return None;
    }

    match path {
        ".git/head" | ".git/packed-refs" => Some("branch"),
        ".git/orig_head" | ".git/merge_head" | ".git/cherry_pick_head" | ".git/rebase_head" => {
            Some("status")
        }
        _ if path.starts_with(".git/refs/") => Some("branch"),
        _ if path == ".git/logs/head" || path.starts_with(".git/logs/refs/") => Some("branch"),
        _ if path.starts_with(".git/rebase-merge/") || path.starts_with(".git/rebase-apply/") => {
            Some("status")
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{git_watch_invalidation_reason, should_ignore_watch_path};

    #[test]
    fn ignores_noisy_git_index_paths() {
        assert!(should_ignore_watch_path(".git/index"));
        assert!(should_ignore_watch_path(".git/index.lock"));
    }

    #[test]
    fn keeps_git_metadata_paths_that_invalidate_repository_state() {
        assert_eq!(git_watch_invalidation_reason(".git/HEAD"), Some("branch"));
        assert_eq!(
            git_watch_invalidation_reason(".git/refs/heads/main"),
            Some("branch"),
        );
        assert_eq!(
            git_watch_invalidation_reason(".git/packed-refs"),
            Some("branch"),
        );
        assert_eq!(
            git_watch_invalidation_reason(".git/MERGE_HEAD"),
            Some("status"),
        );

        assert!(!should_ignore_watch_path(".git/HEAD"));
        assert!(!should_ignore_watch_path(".git/refs/heads/main"));
    }

    #[test]
    fn ignores_unclassified_git_internals() {
        assert!(should_ignore_watch_path(".git/objects/00/example"));
    }
}
