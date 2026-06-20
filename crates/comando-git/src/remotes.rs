use std::path::Path;

use comando_types::git::NativeGitRemoteSummary;

use crate::runner::{GitRunOptions, GitRunner};

pub fn list_remotes(
    runner: &GitRunner,
    root_path: impl AsRef<Path>,
    tracking_branch_name: Option<&str>,
    ahead_by: i64,
    behind_by: i64,
) -> Vec<NativeGitRemoteSummary> {
    let Ok(output) = runner.run(root_path.as_ref(), &["remote"], GitRunOptions::read_only()) else {
        return Vec::new();
    };
    let names = output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let default_remote = default_remote_name(&names, tracking_branch_name);

    names
        .into_iter()
        .map(|name| {
            let is_default = Some(name) == default_remote.as_deref();
            NativeGitRemoteSummary {
                ahead_by: if is_default { ahead_by } else { 0 },
                behind_by: if is_default { behind_by } else { 0 },
                fetch_url: remote_url(runner, root_path.as_ref(), name, false),
                is_default,
                name: name.to_string(),
                push_url: remote_url(runner, root_path.as_ref(), name, true),
                ref_name: if is_default {
                    tracking_branch_name.map(ToString::to_string)
                } else {
                    None
                },
            }
        })
        .collect()
}

fn default_remote_name(names: &[&str], tracking_branch_name: Option<&str>) -> Option<String> {
    if let Some(remote_name) = tracking_branch_name.and_then(|name| name.split('/').next()) {
        if names.iter().any(|name| *name == remote_name) {
            return Some(remote_name.to_string());
        }
    }

    if names.iter().any(|name| *name == "origin") {
        return Some("origin".to_string());
    }

    names.first().map(|name| (*name).to_string())
}

fn remote_url(runner: &GitRunner, root_path: &Path, name: &str, push: bool) -> Option<String> {
    let args = if push {
        vec!["remote", "get-url", "--push", name]
    } else {
        vec!["remote", "get-url", name]
    };

    runner
        .run(root_path, &args, GitRunOptions::read_only())
        .ok()
        .map(|output| output.stdout.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use crate::runner::GitRunner;
    use crate::test_support::run_git_fixture;

    use super::list_remotes;

    #[test]
    fn lists_default_origin_remote_with_sync_counts() {
        let temp = TempDir::new().expect("temp");
        let remote = TempDir::new().expect("remote");
        init_repo(&temp);
        run_git_fixture(remote.path(), &["init", "--bare"]);
        run_git_fixture(
            temp.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );

        let remotes = list_remotes(&GitRunner::new(), temp.path(), Some("origin/main"), 1, 2);

        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].name, "origin");
        assert!(remotes[0].is_default);
        assert_eq!(remotes[0].ahead_by, 1);
        assert_eq!(remotes[0].behind_by, 2);
        assert_eq!(remotes[0].fetch_url.as_deref(), remote.path().to_str());
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
