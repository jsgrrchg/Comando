use std::path::Path;

use comando_types::git::{NativeGitBranchSummary, NativeGitSyncStatus};

use crate::error::GitResult;
use crate::runner::{GitRunOptions, GitRunner};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitBranchListScope {
    All,
    Local,
}

pub fn list_branches(
    runner: &GitRunner,
    root_path: impl AsRef<Path>,
    scope: GitBranchListScope,
    sync: Option<&NativeGitSyncStatus>,
) -> GitResult<Vec<NativeGitBranchSummary>> {
    let refs = match scope {
        GitBranchListScope::All => vec!["refs/heads", "refs/remotes"],
        GitBranchListScope::Local => vec!["refs/heads"],
    };
    let mut args = vec![
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(worktreepath)",
    ];
    args.extend(refs);

    let output = runner.run(root_path, &args, GitRunOptions::read_only())?;
    let mut branches = parse_branch_rows(&output.stdout, sync);

    if branches.iter().all(|branch| !branch.is_current)
        && let Some(detached) = detached_branch(sync)
    {
        branches.push(detached);
    }

    branches.sort_by(|left, right| {
        if left.is_current != right.is_current {
            return left.is_current.cmp(&right.is_current).reverse();
        }
        if left.linked_work_tree != right.linked_work_tree {
            return left.linked_work_tree.cmp(&right.linked_work_tree).reverse();
        }
        if left.is_remote != right.is_remote {
            return left.is_remote.cmp(&right.is_remote);
        }
        left.name.cmp(&right.name)
    });
    Ok(branches)
}

pub fn parse_branch_rows(
    output: &str,
    sync: Option<&NativeGitSyncStatus>,
) -> Vec<NativeGitBranchSummary> {
    output
        .lines()
        .filter_map(|line| parse_branch_row(line, sync))
        .collect()
}

fn parse_branch_row(
    line: &str,
    sync: Option<&NativeGitSyncStatus>,
) -> Option<NativeGitBranchSummary> {
    let fields = line.split('\0').collect::<Vec<_>>();
    let [
        ref_name,
        commit_sha,
        head_marker,
        upstream_name,
        worktree_path,
    ] = fields.as_slice()
    else {
        return None;
    };
    let (name, is_remote) = normalize_ref_name(ref_name)?;
    if is_remote && name.ends_with("/HEAD") {
        return None;
    }
    let is_current = *head_marker == "*";
    let linked_work_tree = !worktree_path.is_empty();
    let upstream = (!upstream_name.is_empty()).then(|| (*upstream_name).to_string());

    Some(NativeGitBranchSummary {
        ahead_by: current_sync_value(is_current, sync, |sync| sync.ahead),
        behind_by: current_sync_value(is_current, sync, |sync| sync.behind),
        commit_sha: (!commit_sha.is_empty()).then(|| (*commit_sha).to_string()),
        is_current,
        is_detached: false,
        is_remote,
        label: Some(name.clone()),
        linked_work_tree,
        name,
        upstream_name: upstream,
        worktree_path: linked_work_tree.then(|| (*worktree_path).to_string()),
    })
}

fn normalize_ref_name(ref_name: &str) -> Option<(String, bool)> {
    if let Some(name) = ref_name.strip_prefix("refs/heads/") {
        return Some((name.to_string(), false));
    }

    if let Some(name) = ref_name.strip_prefix("refs/remotes/") {
        return Some((name.to_string(), true));
    }

    None
}

fn detached_branch(sync: Option<&NativeGitSyncStatus>) -> Option<NativeGitBranchSummary> {
    let sync = sync.filter(|sync| sync.detached)?;
    Some(NativeGitBranchSummary {
        ahead_by: sync.ahead,
        behind_by: sync.behind,
        commit_sha: sync.commit.clone(),
        is_current: true,
        is_detached: true,
        is_remote: false,
        label: sync.branch_name.clone(),
        linked_work_tree: false,
        name: sync
            .branch_name
            .clone()
            .unwrap_or_else(|| "HEAD".to_string()),
        upstream_name: sync.tracking_branch_name.clone(),
        worktree_path: None,
    })
}

fn current_sync_value(
    is_current: bool,
    sync: Option<&NativeGitSyncStatus>,
    read: impl Fn(&NativeGitSyncStatus) -> i64,
) -> i64 {
    if is_current {
        sync.map(read).unwrap_or(0)
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use comando_types::git::NativeGitSyncStatus;

    use crate::runner::GitRunner;
    use crate::test_support::run_git_fixture;

    use super::{GitBranchListScope, list_branches, parse_branch_rows};

    #[test]
    fn parses_branch_rows() {
        let sync = NativeGitSyncStatus {
            ahead: 2,
            behind: 1,
            branch_name: Some("main".to_string()),
            commit: Some("abc".to_string()),
            detached: false,
            tracking_branch_name: Some("origin/main".to_string()),
        };
        let rows = "refs/heads/main\0abc\0*\0origin/main\0/tmp/repo\nrefs/remotes/origin/main\0def\0 \0\0\n";

        let branches = parse_branch_rows(rows, Some(&sync));

        assert_eq!(branches.len(), 2);
        assert_eq!(branches[0].name, "main");
        assert_eq!(branches[0].ahead_by, 2);
        assert_eq!(branches[1].name, "origin/main");
        assert!(branches[1].is_remote);
    }

    #[test]
    fn lists_current_branch_before_remote_branch() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        run_git_fixture(temp.path(), &["branch", "feature"]);

        let branches = list_branches(
            &GitRunner::new(),
            temp.path(),
            GitBranchListScope::All,
            None,
        )
        .expect("branches");

        assert_eq!(branches[0].name, "main");
        assert!(branches.iter().any(|branch| branch.name == "feature"));
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
