use std::path::PathBuf;

use comando_types::git::{
    NativeGitBranchSummary, NativeGitRepositoryScope, NativeGitRepositorySnapshot,
};

use crate::branches::{GitBranchListScope, list_branches};
use crate::error::GitResult;
use crate::remotes::list_remotes;
use crate::repository::{repository_id, resolve_repository};
use crate::runner::GitRunner;
use crate::status::{empty_status_snapshot, get_status};
use crate::worktrees::list_worktrees;

pub fn get_repository_snapshot(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
) -> GitResult<NativeGitRepositorySnapshot> {
    let resolution = resolve_repository(runner, &scope.root_path)?;
    let updated_at = now_rfc3339();
    let root_path = resolution
        .canonical_root_path
        .clone()
        .unwrap_or_else(|| scope.root_path.clone());
    let repository_id = repository_id(&root_path);

    if resolution.state != "ready" {
        let status = empty_status_snapshot(None);
        return Ok(NativeGitRepositorySnapshot {
            repository_id,
            project_id: scope.project_id.clone(),
            current_worktree_id: scope.worktree_id.clone(),
            repository_state: resolution.state.clone(),
            root_path: scope.root_path.clone(),
            canonical_root_path: root_path,
            resolution,
            branch: None,
            branches: Vec::new(),
            remotes: Vec::new(),
            changes: Vec::new(),
            status,
            worktrees: Vec::new(),
            updated_at,
        });
    }

    let status = get_status(runner, &root_path, scope.worktree_id.clone())?;
    let sync = status.sync.as_ref();
    let branches = list_branches(runner, &root_path, GitBranchListScope::All, sync)?;
    let remotes = list_remotes(
        runner,
        &root_path,
        sync.and_then(|sync| sync.tracking_branch_name.as_deref()),
        sync.map(|sync| sync.ahead).unwrap_or(0),
        sync.map(|sync| sync.behind).unwrap_or(0),
    );
    let worktrees = list_worktrees(
        runner,
        &root_path,
        scope.project_id.clone(),
        &scope.root_path,
        primary_worktree_path(runner, &root_path).unwrap_or_else(|| PathBuf::from(&root_path)),
        updated_at.clone(),
    )
    .unwrap_or_default();
    let branch = current_branch(&branches);

    Ok(NativeGitRepositorySnapshot {
        repository_id,
        project_id: scope.project_id.clone(),
        current_worktree_id: scope.worktree_id.clone(),
        repository_state: resolution.state.clone(),
        root_path: scope.root_path.clone(),
        canonical_root_path: root_path,
        resolution,
        branch,
        branches,
        remotes,
        changes: status.entries.clone(),
        status,
        worktrees,
        updated_at,
    })
}

fn current_branch(branches: &[NativeGitBranchSummary]) -> Option<NativeGitBranchSummary> {
    branches.iter().find(|branch| branch.is_current).cloned()
}

fn primary_worktree_path(runner: &GitRunner, root_path: &str) -> Option<PathBuf> {
    let output = runner
        .run(
            root_path,
            &["worktree", "list", "--porcelain"],
            crate::runner::GitRunOptions::read_only(),
        )
        .ok()?;
    output
        .stdout
        .lines()
        .find_map(|line| line.strip_prefix("worktree "))
        .map(PathBuf::from)
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use comando_types::git::NativeGitRepositoryScope;
    use comando_types::ids::ProjectId;

    use crate::runner::GitRunner;
    use crate::test_support::run_git_fixture;

    use super::get_repository_snapshot;

    #[test]
    fn builds_ready_repository_snapshot() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        fs::write(temp.path().join("tracked.txt"), "changed\n").expect("change");

        let snapshot =
            get_repository_snapshot(&GitRunner::new(), &scope(temp.path())).expect("snapshot");

        assert_eq!(snapshot.repository_state, "ready");
        assert_eq!(snapshot.project_id.0, "project_1");
        assert_eq!(snapshot.status.summary.changed_count, 1);
        assert_eq!(snapshot.changes.len(), 1);
        assert_eq!(
            snapshot.branch.as_ref().map(|branch| branch.name.as_str()),
            Some("main")
        );
        assert_eq!(snapshot.worktrees.len(), 1);
    }

    #[test]
    fn builds_not_repo_snapshot() {
        let temp = TempDir::new().expect("temp");

        let snapshot =
            get_repository_snapshot(&GitRunner::new(), &scope(temp.path())).expect("snapshot");

        assert_eq!(snapshot.repository_state, "not_repo");
        assert!(snapshot.status.is_clean);
        assert!(snapshot.branches.is_empty());
    }

    #[test]
    fn builds_bare_snapshot_without_worktree_data() {
        let temp = TempDir::new().expect("temp");
        run_git_fixture(temp.path(), &["init", "--bare"]);

        let snapshot =
            get_repository_snapshot(&GitRunner::new(), &scope(temp.path())).expect("snapshot");

        assert_eq!(snapshot.repository_state, "bare");
        assert!(snapshot.worktrees.is_empty());
    }

    fn scope(path: &std::path::Path) -> NativeGitRepositoryScope {
        NativeGitRepositoryScope {
            project_id: ProjectId("project_1".to_string()),
            worktree_id: None,
            root_path: path.to_string_lossy().to_string(),
        }
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
