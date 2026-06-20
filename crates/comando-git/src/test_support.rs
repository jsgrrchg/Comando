use std::path::Path;
use std::process::Command;

pub fn run_git_fixture(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(root)
        .args(args)
        .status()
        .expect("git fixture command should start");

    assert!(status.success(), "git fixture command failed: {args:?}");
}
