use std::fs;
use std::path::{Path, PathBuf};

use comando_types::git::NativeGitWorktreeSummary;
use comando_types::ids::{ProjectId, WorktreeId};
use sha2::{Digest, Sha256};

use crate::error::GitResult;
use crate::runner::{GitRunOptions, GitRunner};

pub fn list_worktrees(
    runner: &GitRunner,
    root_path: impl AsRef<Path>,
    project_id: ProjectId,
    current_root_path: impl AsRef<Path>,
    primary_root_path: impl AsRef<Path>,
    updated_at: impl Into<String>,
) -> GitResult<Vec<NativeGitWorktreeSummary>> {
    let output = runner.run(
        root_path,
        &["worktree", "list", "--porcelain"],
        GitRunOptions::read_only(),
    )?;
    let current_key = path_key(current_root_path);
    let primary_key = path_key(primary_root_path);
    let updated_at = updated_at.into();
    let mut worktrees = parse_worktree_porcelain(
        &output.stdout,
        &project_id,
        &current_key,
        &primary_key,
        &updated_at,
    );

    worktrees.sort_by(|left, right| {
        if left.is_current != right.is_current {
            return left.is_current.cmp(&right.is_current).reverse();
        }
        if left.is_primary != right.is_primary {
            return left.is_primary.cmp(&right.is_primary).reverse();
        }
        left.canonical_path.cmp(&right.canonical_path)
    });
    Ok(worktrees)
}

pub fn parse_worktree_porcelain(
    output: &str,
    project_id: &ProjectId,
    current_key: &str,
    primary_key: &str,
    updated_at: &str,
) -> Vec<NativeGitWorktreeSummary> {
    output
        .split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .filter_map(|block| {
            parse_worktree_block(block, project_id, current_key, primary_key, updated_at)
        })
        .collect()
}

fn parse_worktree_block(
    block: &str,
    project_id: &ProjectId,
    current_key: &str,
    primary_key: &str,
    updated_at: &str,
) -> Option<NativeGitWorktreeSummary> {
    let mut path = None::<String>;
    let mut head_commit = None::<String>;
    let mut branch_ref = None::<String>;
    let mut detached = false;
    let mut locked = false;
    let mut lock_reason = None::<String>;
    let mut prunable = false;

    for line in block.lines() {
        if let Some(value) = line.strip_prefix("worktree ") {
            path = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("HEAD ") {
            head_commit = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch_ref = Some(value.trim().to_string());
        } else if line == "detached" {
            detached = true;
        } else if let Some(value) = line.strip_prefix("locked") {
            locked = true;
            let value = value.trim();
            if !value.is_empty() {
                lock_reason = Some(value.to_string());
            }
        } else if line.starts_with("prunable") {
            prunable = true;
        }
    }

    let root_path = path?;
    let canonical_path = canonical_path_string(&root_path);
    let key = normalize_path_key(&canonical_path);
    let is_primary = key == primary_key;
    let is_current = key == current_key;

    Some(NativeGitWorktreeSummary {
        id: worktree_id(project_id, &canonical_path, is_primary),
        project_id: project_id.clone(),
        root_path,
        canonical_path,
        branch_name: branch_ref.as_deref().map(normalize_branch_name),
        branch_ref,
        commit_sha: head_commit,
        detached,
        is_primary,
        is_current,
        locked,
        lock_reason,
        prunable,
        updated_at: updated_at.to_string(),
    })
}

fn normalize_branch_name(ref_name: &str) -> String {
    ref_name
        .strip_prefix("refs/heads/")
        .or_else(|| ref_name.strip_prefix("refs/remotes/"))
        .unwrap_or(ref_name)
        .to_string()
}

fn worktree_id(project_id: &ProjectId, canonical_path: &str, is_primary: bool) -> WorktreeId {
    if is_primary {
        return WorktreeId(format!("{}:primary", project_id.0));
    }

    let mut hasher = Sha256::new();
    hasher.update(canonical_path.as_bytes());
    let digest = hasher.finalize();
    WorktreeId(format!(
        "{}:worktree:{}",
        project_id.0,
        hex_prefix(&digest, 12)
    ))
}

fn path_key(path: impl AsRef<Path>) -> String {
    normalize_path_key(&canonical_path_string(path))
}

fn canonical_path_string(path: impl AsRef<Path>) -> String {
    fs::canonicalize(path.as_ref())
        .unwrap_or_else(|_| PathBuf::from(path.as_ref()))
        .to_string_lossy()
        .to_string()
}

fn normalize_path_key(path: &str) -> String {
    path.replace('\\', "/")
}

fn hex_prefix(bytes: &[u8], chars: usize) -> String {
    bytes
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .take(chars)
        .map(|nibble| char::from_digit(nibble.into(), 16).expect("hex digit"))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use comando_types::ids::ProjectId;

    use crate::runner::GitRunner;
    use crate::test_support::run_git_fixture;

    use super::{list_worktrees, parse_worktree_porcelain};

    #[test]
    fn parses_worktree_porcelain_blocks() {
        let output = "\
worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-feature
HEAD 2222222222222222222222222222222222222222
detached
locked testing
prunable gitdir file points to non-existent location
";

        let worktrees = parse_worktree_porcelain(
            output,
            &ProjectId("project_1".to_string()),
            "/repo-feature",
            "/repo",
            "2026-06-20T00:00:00.000Z",
        );

        assert_eq!(worktrees.len(), 2);
        assert!(worktrees[0].is_primary);
        assert_eq!(worktrees[0].branch_name.as_deref(), Some("main"));
        assert!(worktrees[1].detached);
        assert!(worktrees[1].locked);
        assert_eq!(worktrees[1].lock_reason.as_deref(), Some("testing"));
    }

    #[test]
    fn lists_multiple_worktrees_from_git() {
        let temp = TempDir::new().expect("temp");
        let sibling = TempDir::new().expect("sibling");
        let linked_path = sibling.path().join("linked");
        init_repo(&temp);
        run_git_fixture(
            temp.path(),
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                linked_path.to_str().expect("linked path"),
            ],
        );

        let worktrees = list_worktrees(
            &GitRunner::new(),
            temp.path(),
            ProjectId("project_1".to_string()),
            linked_path.as_path(),
            temp.path(),
            "2026-06-20T00:00:00.000Z",
        )
        .expect("worktrees");

        assert_eq!(worktrees.len(), 2);
        assert!(worktrees[0].is_current);
        assert_eq!(worktrees[0].branch_name.as_deref(), Some("feature"));
        assert!(worktrees[1].is_primary);
    }

    fn init_repo(temp: &TempDir) {
        run_git_fixture(temp.path(), &["init", "-b", "main"]);
        run_git_fixture(temp.path(), &["config", "user.name", "Test User"]);
        run_git_fixture(
            temp.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        fs::write(temp.path().join("tracked.txt"), "base\n").expect("base");
        run_git_fixture(temp.path(), &["add", "tracked.txt"]);
        run_git_fixture(temp.path(), &["commit", "-m", "initial"]);
    }
}
