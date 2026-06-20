use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use comando_types::git::{NativeGitOperationResult, NativeGitRepositoryScope};

use crate::error::{GitError, GitResult};
use crate::runner::{GitRunOptions, GitRunner};
use crate::snapshot::get_repository_snapshot;
use crate::status::get_status;

const MUTATION_TIMEOUT: Duration = Duration::from_secs(30);

pub fn init_repository(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
) -> GitResult<NativeGitOperationResult> {
    runner.run(&scope.root_path, &["init"], mutation_options())?;
    runner.run(
        &scope.root_path,
        &["symbolic-ref", "HEAD", "refs/heads/main"],
        mutation_options(),
    )?;
    operation_result(runner, scope, None, None)
}

pub fn stage_paths(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
    paths: &[String],
) -> GitResult<NativeGitOperationResult> {
    run_path_mutation(runner, scope, "add", paths)
}

pub fn unstage_paths(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
    paths: &[String],
) -> GitResult<NativeGitOperationResult> {
    let paths = validate_paths(paths)?;
    if paths.is_empty() {
        return operation_result(runner, scope, None, None);
    }

    let mut args = vec![
        "restore".to_string(),
        "--staged".to_string(),
        "--".to_string(),
    ];
    args.extend(paths);
    runner.run(&scope.root_path, &args, mutation_options())?;
    operation_result(runner, scope, None, None)
}

pub fn discard_paths(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
    paths: &[String],
) -> GitResult<NativeGitOperationResult> {
    let paths = validate_paths(paths)?;
    if paths.is_empty() {
        return operation_result(runner, scope, None, None);
    }

    for relative_path in paths {
        if is_untracked_path(runner, &scope.root_path, &relative_path)? {
            remove_untracked_path(&scope.root_path, &relative_path)?;
            continue;
        }

        unstage_path_for_discard(runner, &scope.root_path, &relative_path)?;
        if is_untracked_path(runner, &scope.root_path, &relative_path)? {
            remove_untracked_path(&scope.root_path, &relative_path)?;
            continue;
        }

        restore_worktree_path(runner, &scope.root_path, &relative_path)?;
    }

    operation_result(runner, scope, None, None)
}

pub fn commit(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
    message: &str,
    amend: bool,
    no_verify: bool,
) -> GitResult<NativeGitOperationResult> {
    let trimmed_message = message.trim();
    if trimmed_message.is_empty() {
        return Err(GitError::InvalidOperation(
            "Write a commit message before committing.".to_string(),
        ));
    }

    let status = get_status(runner, &scope.root_path, scope.worktree_id.clone())?;
    if status.has_conflicts {
        return Err(GitError::Conflict);
    }

    if !status.has_staged {
        return Err(GitError::InvalidOperation(
            "Stage at least one change before committing.".to_string(),
        ));
    }

    if read_git_config(runner, &scope.root_path, "user.name")?.is_none()
        || read_git_config(runner, &scope.root_path, "user.email")?.is_none()
    {
        return Err(GitError::InvalidOperation(
            "Git identity is not configured. Set user.name and user.email before committing."
                .to_string(),
        ));
    }

    let mut args = vec![
        "commit".to_string(),
        "-m".to_string(),
        trimmed_message.to_string(),
    ];
    if amend {
        args.push("--amend".to_string());
    }
    if no_verify {
        args.push("--no-verify".to_string());
    }

    runner.run(&scope.root_path, &args, mutation_options())?;
    let commit_sha = runner
        .run(
            &scope.root_path,
            &["rev-parse", "HEAD"],
            GitRunOptions::read_only(),
        )?
        .stdout
        .trim()
        .to_string();
    operation_result(runner, scope, Some(commit_sha), None)
}

pub fn checkout_branch(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
    branch_name: &str,
    force: bool,
    new_branch_name: Option<&str>,
    start_point: Option<&str>,
) -> GitResult<NativeGitOperationResult> {
    let mut args = vec!["checkout".to_string()];
    if force {
        args.push("--force".to_string());
    }

    if let Some(new_branch_name) = new_branch_name {
        args.push("-b".to_string());
        args.push(new_branch_name.to_string());
        args.push(start_point.unwrap_or(branch_name).to_string());
    } else {
        args.push(branch_name.to_string());
    }

    runner.run(&scope.root_path, &args, mutation_options())?;
    operation_result(runner, scope, None, None)
}

pub fn create_branch(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
    branch_name: &str,
    start_point: Option<&str>,
) -> GitResult<NativeGitOperationResult> {
    let mut args = vec!["branch".to_string(), branch_name.to_string()];
    if let Some(start_point) = start_point {
        args.push(start_point.to_string());
    }

    runner.run(&scope.root_path, &args, mutation_options())?;
    operation_result(runner, scope, None, None)
}

pub fn delete_local_branch(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
    branch_name: &str,
    force: bool,
) -> GitResult<NativeGitOperationResult> {
    runner.run(
        &scope.root_path,
        &[
            "branch".to_string(),
            if force { "-D" } else { "-d" }.to_string(),
            branch_name.to_string(),
        ],
        mutation_options(),
    )?;
    operation_result(runner, scope, None, None)
}

pub fn create_worktree(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
    branch_name: &str,
    force: bool,
    worktree_path: &str,
    start_point: Option<&str>,
) -> GitResult<NativeGitOperationResult> {
    let mut args = vec!["worktree".to_string(), "add".to_string()];
    if force {
        args.push("--force".to_string());
    }

    if let Some(start_point) = start_point {
        args.push("-b".to_string());
        args.push(branch_name.to_string());
        args.push(worktree_path.to_string());
        args.push(start_point.to_string());
    } else {
        args.push(worktree_path.to_string());
        args.push(branch_name.to_string());
    }

    runner.run(&scope.root_path, &args, mutation_options())?;
    operation_result(runner, scope, None, None)
}

pub fn remove_worktree(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
    worktree_path: &str,
    force: bool,
) -> GitResult<NativeGitOperationResult> {
    let mut args = vec!["worktree".to_string(), "remove".to_string()];
    if force {
        args.push("--force".to_string());
    }
    args.push(worktree_path.to_string());

    runner.run(&scope.root_path, &args, mutation_options())?;
    operation_result(runner, scope, None, None)
}

fn run_path_mutation(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
    command: &str,
    paths: &[String],
) -> GitResult<NativeGitOperationResult> {
    let paths = validate_paths(paths)?;
    if paths.is_empty() {
        return operation_result(runner, scope, None, None);
    }

    let mut args = vec![command.to_string(), "--".to_string()];
    args.extend(paths);
    runner.run(&scope.root_path, &args, mutation_options())?;
    operation_result(runner, scope, None, None)
}

fn operation_result(
    runner: &GitRunner,
    scope: &NativeGitRepositoryScope,
    commit_sha: Option<String>,
    message: Option<String>,
) -> GitResult<NativeGitOperationResult> {
    let snapshot = get_repository_snapshot(runner, scope)?;
    let updated_at = snapshot.updated_at.clone();

    Ok(NativeGitOperationResult {
        ok: true,
        message,
        commit_sha,
        snapshot: Some(snapshot),
        updated_at,
    })
}

fn read_git_config(runner: &GitRunner, root_path: &str, key: &str) -> GitResult<Option<String>> {
    let output = runner.run(
        root_path,
        &["config", "--get", key],
        GitRunOptions::read_only().allow_exit_code(1),
    )?;
    let value = output.stdout.trim();
    Ok((!value.is_empty()).then(|| value.to_string()))
}

fn is_untracked_path(runner: &GitRunner, root_path: &str, relative_path: &str) -> GitResult<bool> {
    let output = runner.run(
        root_path,
        &[
            "status".to_string(),
            "--porcelain=v1".to_string(),
            "--".to_string(),
            relative_path.to_string(),
        ],
        GitRunOptions::read_only(),
    )?;
    Ok(output
        .stdout
        .lines()
        .next()
        .is_some_and(|line| line.starts_with("??")))
}

fn unstage_path_for_discard(
    runner: &GitRunner,
    root_path: &str,
    relative_path: &str,
) -> GitResult<()> {
    runner.run(
        root_path,
        &[
            "restore".to_string(),
            "--staged".to_string(),
            "--".to_string(),
            relative_path.to_string(),
        ],
        mutation_options().allow_exit_code(1),
    )?;
    Ok(())
}

fn restore_worktree_path(
    runner: &GitRunner,
    root_path: &str,
    relative_path: &str,
) -> GitResult<()> {
    runner.run(
        root_path,
        &[
            "restore".to_string(),
            "--".to_string(),
            relative_path.to_string(),
        ],
        mutation_options(),
    )?;
    Ok(())
}

fn remove_untracked_path(root_path: &str, relative_path: &str) -> GitResult<()> {
    let target_path = repository_relative_path(root_path, relative_path)?;
    let metadata = match fs::symlink_metadata(&target_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    if metadata.file_type().is_dir() {
        fs::remove_dir_all(target_path)?;
    } else {
        fs::remove_file(target_path)?;
    }

    Ok(())
}

fn repository_relative_path(root_path: &str, relative_path: &str) -> GitResult<PathBuf> {
    let relative_path = validate_relative_path(relative_path)?;
    Ok(Path::new(root_path).join(relative_path))
}

fn validate_paths(paths: &[String]) -> GitResult<Vec<String>> {
    paths
        .iter()
        .map(|path| validate_relative_path(path))
        .collect()
}

fn validate_relative_path(relative_path: &str) -> GitResult<String> {
    if relative_path.trim().is_empty() {
        return Err(GitError::InvalidPath);
    }

    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err(GitError::InvalidPath);
    }

    let mut normalized = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => normalized.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(GitError::PathEscape);
            }
        }
    }

    if normalized.is_empty() {
        return Err(GitError::InvalidPath);
    }

    Ok(normalized.join("/"))
}

fn mutation_options() -> GitRunOptions {
    GitRunOptions {
        timeout: MUTATION_TIMEOUT,
        ..GitRunOptions::mutation()
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use comando_types::git::NativeGitRepositoryScope;
    use comando_types::ids::ProjectId;
    use tempfile::TempDir;

    use crate::runner::{GitRunOptions, GitRunner};
    use crate::test_support::run_git_fixture;

    use super::{
        checkout_branch, commit, create_branch, create_worktree, delete_local_branch,
        discard_paths, init_repository, remove_worktree, stage_paths, unstage_paths,
    };

    #[test]
    fn stages_unstages_and_discards_paths() {
        let temp = initialized_repo();
        let scope = scope(temp.path());
        fs::write(temp.path().join("tracked.txt"), "changed\n").expect("change");
        fs::write(temp.path().join("scratch.txt"), "scratch\n").expect("scratch");

        stage_paths(
            &GitRunner::new(),
            &scope,
            &["tracked.txt".to_string(), "scratch.txt".to_string()],
        )
        .expect("stage");
        assert!(status(&temp).starts_with("A  scratch.txt\nM  tracked.txt"));

        unstage_paths(&GitRunner::new(), &scope, &["tracked.txt".to_string()])
            .expect("unstage tracked");
        assert!(status(&temp).contains(" M tracked.txt"));

        discard_paths(
            &GitRunner::new(),
            &scope,
            &["tracked.txt".to_string(), "scratch.txt".to_string()],
        )
        .expect("discard");
        assert_eq!(
            fs::read_to_string(temp.path().join("tracked.txt")).unwrap(),
            "base\n"
        );
        assert!(!temp.path().join("scratch.txt").exists());
    }

    #[test]
    fn commits_staged_changes() {
        let temp = initialized_repo();
        let scope = scope(temp.path());
        fs::write(temp.path().join("tracked.txt"), "changed\n").expect("change");
        stage_paths(&GitRunner::new(), &scope, &["tracked.txt".to_string()]).expect("stage");

        let result =
            commit(&GitRunner::new(), &scope, "Update tracked", false, true).expect("commit");

        assert!(result.commit_sha.is_some());
        assert!(result.snapshot.expect("snapshot").status.is_clean);
    }

    #[test]
    fn creates_checks_out_and_deletes_branches() {
        let temp = initialized_repo();
        let scope = scope(temp.path());

        create_branch(&GitRunner::new(), &scope, "feature/sidebar", Some("main"))
            .expect("create branch");
        checkout_branch(
            &GitRunner::new(),
            &scope,
            "main",
            false,
            Some("feature/current"),
            Some("main"),
        )
        .expect("checkout new branch");

        assert_eq!(current_branch(&temp), "feature/current");
        checkout_branch(&GitRunner::new(), &scope, "main", false, None, None)
            .expect("checkout main");
        delete_local_branch(&GitRunner::new(), &scope, "feature/sidebar", true)
            .expect("delete branch");
        assert!(!branches(&temp).contains("feature/sidebar"));
    }

    #[test]
    fn creates_and_removes_worktrees() {
        let temp = initialized_repo();
        let worktree = TempDir::new().expect("worktree temp");
        let worktree_path = worktree.path().join("feature-worktree");
        let scope = scope(temp.path());

        create_worktree(
            &GitRunner::new(),
            &scope,
            "feature/worktree",
            false,
            worktree_path.to_str().expect("utf8 worktree"),
            Some("main"),
        )
        .expect("create worktree");
        assert!(worktree_path.exists());

        remove_worktree(
            &GitRunner::new(),
            &scope,
            worktree_path.to_str().expect("utf8 worktree"),
            false,
        )
        .expect("remove worktree");
        assert!(!worktree_path.exists());
    }

    #[test]
    fn initializes_plain_directories() {
        let temp = TempDir::new().expect("temp");
        let scope = scope(temp.path());

        let result = init_repository(&GitRunner::new(), &scope).expect("init");

        assert_eq!(result.snapshot.expect("snapshot").resolution.state, "ready");
        assert_eq!(current_branch(&temp), "main");
    }

    fn initialized_repo() -> TempDir {
        let temp = TempDir::new().expect("temp");
        run_git_fixture(temp.path(), &["init", "-b", "main"]);
        run_git_fixture(temp.path(), &["config", "user.name", "Test User"]);
        run_git_fixture(
            temp.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        fs::write(temp.path().join("tracked.txt"), "base\n").expect("base");
        run_git_fixture(temp.path(), &["add", "tracked.txt"]);
        run_git_fixture(temp.path(), &["commit", "-m", "initial"]);
        temp
    }

    fn status(temp: &TempDir) -> String {
        output(temp.path(), &["status", "--porcelain=v1"])
    }

    fn current_branch(temp: &TempDir) -> String {
        output(temp.path(), &["branch", "--show-current"])
            .trim()
            .to_string()
    }

    fn branches(temp: &TempDir) -> String {
        output(temp.path(), &["branch", "--format=%(refname:short)"])
    }

    fn output(root: &Path, args: &[&str]) -> String {
        GitRunner::new()
            .run(root, args, GitRunOptions::read_only())
            .expect("git command")
            .stdout
    }

    fn scope(path: &Path) -> NativeGitRepositoryScope {
        NativeGitRepositoryScope {
            project_id: ProjectId("project_1".to_string()),
            worktree_id: None,
            root_path: path.to_string_lossy().to_string(),
        }
    }
}
