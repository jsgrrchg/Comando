use std::path::Path;

use serde::{Deserialize, Serialize};

const DEFAULT_MAX_ENTRIES: usize = 50_000;
const DEFAULT_HUGE_BURST_THRESHOLD: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexPolicyState {
    Indexed,
    ExcludedByPolicy,
    Noisy,
    Special,
    TooLarge,
    PermissionDenied,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexPolicy {
    noisy_directory_names: Vec<String>,
    special_directory_names: Vec<String>,
    pub include_dotfiles: bool,
    pub include_hidden: bool,
    pub max_entries: usize,
    pub max_depth: Option<usize>,
    pub huge_burst_threshold: usize,
    pub follow_symlinks: bool,
}

impl Default for IndexPolicy {
    fn default() -> Self {
        Self {
            noisy_directory_names: vec![
                "node_modules".to_string(),
                "target".to_string(),
                "dist".to_string(),
                "build".to_string(),
                "coverage".to_string(),
                "out".to_string(),
                ".next".to_string(),
                ".turbo".to_string(),
                ".cache".to_string(),
            ],
            special_directory_names: vec![".git".to_string()],
            include_dotfiles: true,
            include_hidden: true,
            max_entries: DEFAULT_MAX_ENTRIES,
            max_depth: None,
            huge_burst_threshold: DEFAULT_HUGE_BURST_THRESHOLD,
            follow_symlinks: false,
        }
    }
}

impl IndexPolicy {
    pub fn with_max_entries(mut self, max_entries: usize) -> Self {
        self.max_entries = max_entries.max(1);
        self
    }

    pub fn with_max_depth(mut self, max_depth: Option<usize>) -> Self {
        self.max_depth = max_depth;
        self
    }

    pub fn with_follow_symlinks(mut self, follow_symlinks: bool) -> Self {
        self.follow_symlinks = follow_symlinks;
        self
    }

    pub fn state_for_entry(&self, name: &str, is_directory: bool) -> IndexPolicyState {
        if is_directory && self.is_special_directory_name(name) {
            return IndexPolicyState::Special;
        }

        if is_directory && self.is_noisy_directory_name(name) {
            return IndexPolicyState::Noisy;
        }

        if !self.include_dotfiles && name.starts_with('.') {
            return IndexPolicyState::ExcludedByPolicy;
        }

        IndexPolicyState::Indexed
    }

    pub fn should_index_entry(&self, name: &str, is_directory: bool) -> bool {
        matches!(
            self.state_for_entry(name, is_directory),
            IndexPolicyState::Indexed
        )
    }

    pub fn should_descend_directory(&self, name: &str, depth: usize) -> bool {
        if self.max_depth.is_some_and(|max_depth| depth >= max_depth) {
            return false;
        }

        self.should_index_entry(name, true)
    }

    pub fn should_follow_symlink(&self, path: &Path) -> bool {
        self.follow_symlinks && path.is_dir()
    }

    pub fn is_huge_burst(&self, relative_path_count: usize) -> bool {
        relative_path_count > self.huge_burst_threshold
    }

    fn is_noisy_directory_name(&self, name: &str) -> bool {
        let lower = name.to_lowercase();
        self.noisy_directory_names
            .iter()
            .any(|entry| entry == &lower)
    }

    fn is_special_directory_name(&self, name: &str) -> bool {
        let lower = name.to_lowercase();
        self.special_directory_names
            .iter()
            .any(|entry| entry == &lower)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_dotfiles_and_config_files_indexable() {
        let policy = IndexPolicy::default();

        assert!(policy.should_index_entry(".env", false));
        assert!(policy.should_index_entry("Cargo.toml", false));
    }

    #[test]
    fn excludes_git_and_noisy_dirs_by_explicit_policy() {
        let policy = IndexPolicy::default();

        assert_eq!(
            policy.state_for_entry(".git", true),
            IndexPolicyState::Special
        );
        assert_eq!(
            policy.state_for_entry("node_modules", true),
            IndexPolicyState::Noisy
        );
        assert!(!policy.should_descend_directory(".git", 0));
        assert!(!policy.should_descend_directory("node_modules", 0));
    }

    #[test]
    fn does_not_follow_symlinks_by_default() {
        let policy = IndexPolicy::default();

        assert!(!policy.follow_symlinks);
    }
}
