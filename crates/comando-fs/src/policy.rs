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
