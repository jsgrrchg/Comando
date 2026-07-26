use std::path::Path;

use comando_types::git::{NativeGitBranchDiffFile, NativeGitBranchDiffResult, NativeGitFileDiff};
use comando_types::ids::{ProjectId, WorktreeId};

use crate::diff::parse_unified_diff;
use crate::error::GitResult;
use crate::runner::{GitRunOptions, GitRunner};

const NO_BASE_REASON: &str = "No base branch available for comparison.";
const DETACHED_HEAD_REASON: &str = "Branch changes are unavailable in detached HEAD.";
const NO_MERGE_BASE_REASON: &str = "No common ancestor is available for comparison.";

pub fn list_branch_diff(
    runner: &GitRunner,
    root_path: impl AsRef<Path>,
    project_id: ProjectId,
    worktree_id: Option<WorktreeId>,
) -> GitResult<NativeGitBranchDiffResult> {
    let root_path = root_path.as_ref();
    let Some(head_ref) = current_branch(runner, root_path)? else {
        return Ok(unavailable_result(
            project_id,
            worktree_id,
            "HEAD",
            DETACHED_HEAD_REASON,
        ));
    };
    let Some(base_ref) = resolve_base_ref(runner, root_path, &head_ref)? else {
        return Ok(unavailable_result(
            project_id,
            worktree_id,
            &head_ref,
            NO_BASE_REASON,
        ));
    };

    if merge_base(runner, root_path, &base_ref)?.is_none() {
        return Ok(NativeGitBranchDiffResult {
            project_id,
            worktree_id,
            base_ref: Some(base_ref),
            head_ref,
            files: Vec::new(),
            unavailable_reason: Some(NO_MERGE_BASE_REASON.to_string()),
            updated_at: now_rfc3339(),
        });
    }

    let files = list_changed_files(runner, root_path, &base_ref)?
        .into_iter()
        .map(|change| build_branch_diff_file(runner, root_path, &base_ref, change))
        .collect();

    Ok(NativeGitBranchDiffResult {
        project_id,
        worktree_id,
        base_ref: Some(base_ref),
        head_ref,
        files,
        unavailable_reason: None,
        updated_at: now_rfc3339(),
    })
}

fn current_branch(runner: &GitRunner, root_path: &Path) -> GitResult<Option<String>> {
    let output = runner.run(
        root_path,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        GitRunOptions::read_only().allow_exit_code(1),
    )?;
    Ok((output.status_code == Some(0))
        .then(|| output.stdout.trim().to_string())
        .filter(|branch| !branch.is_empty()))
}

fn resolve_base_ref(
    runner: &GitRunner,
    root_path: &Path,
    head_ref: &str,
) -> GitResult<Option<String>> {
    if let Some(configured) = config_value(
        runner,
        root_path,
        &format!("branch.{head_ref}.gh-merge-base"),
    )? {
        // An explicit GitHub merge base is authoritative; never mask a stale
        // configuration by silently comparing against another branch.
        let is_valid = is_valid_base(runner, root_path, head_ref, &configured)?;
        return Ok(is_valid.then_some(configured));
    }

    let remote = primary_remote(runner, root_path, head_ref)?;
    if let Some(remote) = remote.as_deref()
        && let Some(remote_default) = remote_default_branch(runner, root_path, remote)?
    {
        for candidate in [
            remote_default.clone(),
            remote_default
                .strip_prefix(&format!("{remote}/"))
                .unwrap_or(&remote_default)
                .to_string(),
        ] {
            if is_valid_base(runner, root_path, head_ref, &candidate)? {
                return Ok(Some(candidate));
            }
        }
    }

    for candidate in ["main", "master"] {
        if is_valid_base(runner, root_path, head_ref, candidate)? {
            return Ok(Some(candidate.to_string()));
        }
    }

    if let Some(remote) = remote {
        for branch in ["main", "master"] {
            let candidate = format!("{remote}/{branch}");
            if is_valid_base(runner, root_path, head_ref, &candidate)? {
                return Ok(Some(candidate));
            }
        }
    }

    Ok(None)
}

fn config_value(runner: &GitRunner, root_path: &Path, key: &str) -> GitResult<Option<String>> {
    let output = runner.run(
        root_path,
        &["config", "--get", key],
        GitRunOptions::read_only().allow_exit_code(1),
    )?;
    Ok((output.status_code == Some(0))
        .then(|| output.stdout.trim().to_string())
        .filter(|value| !value.is_empty()))
}

fn primary_remote(
    runner: &GitRunner,
    root_path: &Path,
    head_ref: &str,
) -> GitResult<Option<String>> {
    if let Some(remote) = config_value(runner, root_path, &format!("branch.{head_ref}.remote"))?
        && remote != "."
    {
        return Ok(Some(remote));
    }

    let output = runner.run(root_path, &["remote"], GitRunOptions::read_only())?;
    let remotes = output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|remote| !remote.is_empty())
        .collect::<Vec<_>>();
    Ok(remotes
        .iter()
        .find(|remote| **remote == "origin")
        .or_else(|| remotes.first())
        .map(|remote| (*remote).to_string()))
}

fn remote_default_branch(
    runner: &GitRunner,
    root_path: &Path,
    remote: &str,
) -> GitResult<Option<String>> {
    let remote_head = format!("refs/remotes/{remote}/HEAD");
    let output = runner.run(
        root_path,
        &["symbolic-ref", "--quiet", "--short", &remote_head],
        GitRunOptions::read_only().allow_exit_code(1),
    )?;
    Ok((output.status_code == Some(0))
        .then(|| output.stdout.trim().to_string())
        .filter(|value| !value.is_empty()))
}

fn is_valid_base(
    runner: &GitRunner,
    root_path: &Path,
    head_ref: &str,
    candidate: &str,
) -> GitResult<bool> {
    if candidate == head_ref || candidate == format!("refs/heads/{head_ref}") {
        return Ok(false);
    }

    let revision = format!("{candidate}^{{commit}}");
    let output = runner.run(
        root_path,
        &["rev-parse", "--verify", "--quiet", &revision],
        GitRunOptions::read_only().allow_exit_code(1),
    )?;
    Ok(output.status_code == Some(0))
}

fn merge_base(runner: &GitRunner, root_path: &Path, base_ref: &str) -> GitResult<Option<String>> {
    let output = runner.run(
        root_path,
        &["merge-base", base_ref, "HEAD"],
        GitRunOptions::read_only().allow_exit_code(1),
    )?;
    Ok((output.status_code == Some(0))
        .then(|| output.stdout.trim().to_string())
        .filter(|value| !value.is_empty()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BranchChange {
    kind: String,
    path: String,
    previous_path: Option<String>,
}

fn list_changed_files(
    runner: &GitRunner,
    root_path: &Path,
    base_ref: &str,
) -> GitResult<Vec<BranchChange>> {
    let range = format!("{base_ref}...HEAD");
    let output = runner.run(
        root_path,
        &[
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            "--find-copies",
            &range,
        ],
        GitRunOptions::read_only(),
    )?;
    Ok(parse_name_status(&output.stdout))
}

fn parse_name_status(output: &str) -> Vec<BranchChange> {
    let fields = output
        .split('\0')
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>();
    let mut changes = Vec::new();
    let mut index = 0;

    while index < fields.len() {
        let status = fields[index];
        index += 1;
        let status_kind = status.chars().next().unwrap_or('M');
        if matches!(status_kind, 'R' | 'C') {
            let (Some(previous_path), Some(path)) = (fields.get(index), fields.get(index + 1))
            else {
                break;
            };
            changes.push(BranchChange {
                kind: if status_kind == 'R' {
                    "renamed"
                } else {
                    "copied"
                }
                .to_string(),
                path: (*path).to_string(),
                previous_path: Some((*previous_path).to_string()),
            });
            index += 2;
            continue;
        }

        let Some(path) = fields.get(index) else {
            break;
        };
        changes.push(BranchChange {
            kind: match status_kind {
                'A' => "added",
                'D' => "deleted",
                'T' => "typechange",
                _ => "modified",
            }
            .to_string(),
            path: (*path).to_string(),
            previous_path: None,
        });
        index += 1;
    }

    changes
}

fn build_branch_diff_file(
    runner: &GitRunner,
    root_path: &Path,
    base_ref: &str,
    change: BranchChange,
) -> NativeGitBranchDiffFile {
    match load_file_diff(runner, root_path, base_ref, &change) {
        Ok(diff) => NativeGitBranchDiffFile {
            additions: (!diff.is_binary).then_some(diff.summary.insertions),
            deletions: (!diff.is_binary).then_some(diff.summary.deletions),
            is_binary: diff.is_binary,
            diff: Some(diff),
            error: None,
            kind: change.kind,
            path: change.path,
            previous_path: change.previous_path,
        },
        Err(error) => NativeGitBranchDiffFile {
            additions: None,
            deletions: None,
            diff: None,
            error: Some(error.to_string()),
            is_binary: false,
            kind: change.kind,
            path: change.path,
            previous_path: change.previous_path,
        },
    }
}

fn load_file_diff(
    runner: &GitRunner,
    root_path: &Path,
    base_ref: &str,
    change: &BranchChange,
) -> GitResult<NativeGitFileDiff> {
    let range = format!("{base_ref}...HEAD");
    let mut args = vec![
        "diff".to_string(),
        "--find-renames".to_string(),
        "--find-copies".to_string(),
        "--no-color".to_string(),
        "--unified=3".to_string(),
        range,
        "--".to_string(),
    ];
    if let Some(previous_path) = &change.previous_path {
        args.push(previous_path.clone());
    }
    args.push(change.path.clone());

    let output = runner.run(root_path, &args, GitRunOptions::read_only())?;
    let parsed = parse_unified_diff(&output.stdout, &change.path);
    Ok(NativeGitFileDiff {
        path: change.path.clone(),
        previous_path: change.previous_path.clone(),
        kind: match change.kind.as_str() {
            "added" => "create",
            "deleted" => "delete",
            "renamed" => "move",
            _ => "update",
        }
        .to_string(),
        staged: false,
        is_binary: parsed.is_binary,
        is_text: !parsed.is_binary,
        is_too_large: false,
        old_text: None,
        new_text: None,
        raw: output.stdout,
        summary: parsed.summary,
        hunks: parsed.hunks,
    })
}

fn unavailable_result(
    project_id: ProjectId,
    worktree_id: Option<WorktreeId>,
    head_ref: &str,
    reason: &str,
) -> NativeGitBranchDiffResult {
    NativeGitBranchDiffResult {
        project_id,
        worktree_id,
        base_ref: None,
        head_ref: head_ref.to_string(),
        files: Vec::new(),
        unavailable_reason: Some(reason.to_string()),
        updated_at: now_rfc3339(),
    }
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

    use comando_types::ids::ProjectId;

    use crate::runner::GitRunner;
    use crate::test_support::run_git_fixture;

    use super::list_branch_diff;

    #[test]
    fn includes_only_branch_commits_when_main_advances() {
        let temp = initialized_repo();
        run_git_fixture(temp.path(), &["switch", "-c", "feature"]);
        fs::write(temp.path().join("feature.txt"), "feature\n").expect("feature");
        commit_all(&temp, "feature");
        run_git_fixture(temp.path(), &["switch", "main"]);
        fs::write(temp.path().join("main.txt"), "main\n").expect("main");
        commit_all(&temp, "main advances");
        run_git_fixture(temp.path(), &["switch", "feature"]);
        fs::write(temp.path().join("local.txt"), "local\n").expect("local");

        let result = branch_diff(&temp);

        assert_eq!(result.base_ref.as_deref(), Some("main"));
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, "feature.txt");
    }

    #[test]
    fn returns_empty_diff_for_branch_without_commits() {
        let temp = initialized_repo();
        run_git_fixture(temp.path(), &["switch", "-c", "feature"]);

        let result = branch_diff(&temp);

        assert_eq!(result.base_ref.as_deref(), Some("main"));
        assert!(result.files.is_empty());
        assert!(result.unavailable_reason.is_none());
    }

    #[test]
    fn reports_when_the_current_base_branch_has_no_comparison() {
        let temp = initialized_repo();

        let result = branch_diff(&temp);

        assert!(result.base_ref.is_none());
        assert_eq!(
            result.unavailable_reason.as_deref(),
            Some("No base branch available for comparison.")
        );
    }

    #[test]
    fn prefers_explicit_merge_base_configuration() {
        let temp = initialized_repo();
        run_git_fixture(temp.path(), &["branch", "release"]);
        run_git_fixture(temp.path(), &["switch", "-c", "feature"]);
        run_git_fixture(
            temp.path(),
            &["config", "branch.feature.gh-merge-base", "release"],
        );

        let result = branch_diff(&temp);

        assert_eq!(result.base_ref.as_deref(), Some("release"));
    }

    #[test]
    fn does_not_mask_an_invalid_explicit_merge_base() {
        let temp = initialized_repo();
        run_git_fixture(temp.path(), &["switch", "-c", "feature"]);
        run_git_fixture(
            temp.path(),
            &["config", "branch.feature.gh-merge-base", "missing"],
        );

        let result = branch_diff(&temp);

        assert!(result.base_ref.is_none());
        assert_eq!(
            result.unavailable_reason.as_deref(),
            Some("No base branch available for comparison.")
        );
    }

    #[test]
    fn resolves_default_branch_for_a_non_origin_remote() {
        let temp = initialized_repo();
        run_git_fixture(
            temp.path(),
            &["update-ref", "refs/remotes/upstream/trunk", "HEAD"],
        );
        run_git_fixture(
            temp.path(),
            &[
                "symbolic-ref",
                "refs/remotes/upstream/HEAD",
                "refs/remotes/upstream/trunk",
            ],
        );
        run_git_fixture(
            temp.path(),
            &[
                "remote",
                "add",
                "upstream",
                "https://example.invalid/repo.git",
            ],
        );
        run_git_fixture(temp.path(), &["switch", "-c", "feature"]);

        let result = branch_diff(&temp);

        assert_eq!(result.base_ref.as_deref(), Some("upstream/trunk"));
    }

    #[test]
    fn returns_explicit_result_for_detached_head() {
        let temp = initialized_repo();
        run_git_fixture(temp.path(), &["checkout", "--detach", "HEAD"]);

        let result = branch_diff(&temp);

        assert!(result.files.is_empty());
        assert_eq!(
            result.unavailable_reason.as_deref(),
            Some("Branch changes are unavailable in detached HEAD.")
        );
    }

    #[test]
    fn falls_back_to_master_and_handles_renames_and_binary_files() {
        let temp = initialized_repo_with_branch("master");
        run_git_fixture(temp.path(), &["switch", "-c", "feature"]);
        run_git_fixture(temp.path(), &["mv", "tracked.txt", "renamed.txt"]);
        fs::write(temp.path().join("binary.bin"), [0, 159, 146, 150]).expect("binary");
        commit_all(&temp, "rename and binary");

        let result = branch_diff(&temp);

        assert_eq!(result.base_ref.as_deref(), Some("master"));
        assert!(result.files.iter().any(|file| file.kind == "renamed"));
        assert!(result.files.iter().any(|file| file.is_binary));
    }

    fn branch_diff(temp: &TempDir) -> comando_types::git::NativeGitBranchDiffResult {
        list_branch_diff(
            &GitRunner::new(),
            temp.path(),
            ProjectId("project_1".to_string()),
            None,
        )
        .expect("branch diff")
    }

    fn initialized_repo() -> TempDir {
        initialized_repo_with_branch("main")
    }

    fn initialized_repo_with_branch(branch: &str) -> TempDir {
        let temp = TempDir::new().expect("temp");
        run_git_fixture(temp.path(), &["init", "-b", branch]);
        run_git_fixture(temp.path(), &["config", "user.name", "Test User"]);
        run_git_fixture(
            temp.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        fs::write(temp.path().join("tracked.txt"), "base\n").expect("base");
        commit_all(&temp, "initial");
        temp
    }

    fn commit_all(temp: &TempDir, message: &str) {
        run_git_fixture(temp.path(), &["add", "-A"]);
        run_git_fixture(temp.path(), &["commit", "-m", message]);
    }
}
