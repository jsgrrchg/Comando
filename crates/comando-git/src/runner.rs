use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::env::GitEnvironment;
use crate::error::{GitError, GitResult};

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_STDOUT_LIMIT_BYTES: usize = 20 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT_BYTES: usize = 256 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitCommandKind {
    ReadOnly,
    Mutation,
    Network,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRunOptions {
    pub command_kind: GitCommandKind,
    pub timeout: Duration,
    pub max_stdout_bytes: usize,
    pub max_stderr_bytes: usize,
    pub allowed_exit_codes: Vec<i32>,
}

impl GitRunOptions {
    pub fn read_only() -> Self {
        Self {
            command_kind: GitCommandKind::ReadOnly,
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
            max_stdout_bytes: DEFAULT_STDOUT_LIMIT_BYTES,
            max_stderr_bytes: DEFAULT_STDERR_LIMIT_BYTES,
            allowed_exit_codes: Vec::new(),
        }
    }

    pub fn mutation() -> Self {
        Self {
            command_kind: GitCommandKind::Mutation,
            ..Self::read_only()
        }
    }

    pub fn network() -> Self {
        Self {
            command_kind: GitCommandKind::Network,
            timeout: Duration::from_millis(30_000),
            ..Self::read_only()
        }
    }

    fn optional_locks(&self) -> bool {
        matches!(self.command_kind, GitCommandKind::ReadOnly)
    }

    pub fn allow_exit_code(mut self, code: i32) -> Self {
        self.allowed_exit_codes.push(code);
        self
    }
}

impl Default for GitRunOptions {
    fn default() -> Self {
        Self::read_only()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub status_code: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct GitRunner {
    executable: OsString,
    environment: GitEnvironment,
}

impl GitRunner {
    pub fn new() -> Self {
        Self {
            executable: OsString::from("git"),
            environment: GitEnvironment::default(),
        }
    }

    pub fn with_executable(executable: impl Into<OsString>) -> Self {
        Self {
            executable: executable.into(),
            environment: GitEnvironment::default(),
        }
    }

    pub fn with_environment(mut self, environment: GitEnvironment) -> Self {
        self.environment = environment;
        self
    }

    pub fn run(
        &self,
        root: impl AsRef<Path>,
        args: &[impl AsRef<str>],
        options: GitRunOptions,
    ) -> GitResult<GitOutput> {
        let mut command = Command::new(&self.executable);
        command
            .current_dir(root)
            .args(args.iter().map(AsRef::as_ref))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear()
            .envs(self.environment.command_values(options.optional_locks()));

        let mut child = command.spawn().map_err(map_spawn_error)?;
        let started_at = Instant::now();

        loop {
            if child.try_wait()?.is_some() {
                break;
            }

            if started_at.elapsed() >= options.timeout {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitError::CommandTimedOut);
            }

            thread::sleep(POLL_INTERVAL);
        }

        let output = child.wait_with_output()?;
        ensure_output_limit("stdout", output.stdout.len(), options.max_stdout_bytes)?;
        ensure_output_limit("stderr", output.stderr.len(), options.max_stderr_bytes)?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = redact_git_stderr(&String::from_utf8_lossy(&output.stderr));
        let status_code = output.status.code();

        if !output.status.success()
            && !status_code.is_some_and(|code| options.allowed_exit_codes.contains(&code))
        {
            return Err(GitError::CommandFailed {
                code: status_code,
                stderr,
            });
        }

        Ok(GitOutput {
            stdout,
            stderr,
            status_code,
        })
    }
}

impl Default for GitRunner {
    fn default() -> Self {
        Self::new()
    }
}

fn map_spawn_error(error: io::Error) -> GitError {
    if error.kind() == io::ErrorKind::NotFound {
        GitError::GitNotFound
    } else if error.kind() == io::ErrorKind::PermissionDenied {
        GitError::PermissionDenied
    } else {
        GitError::Io(error)
    }
}

fn ensure_output_limit(
    stream: &'static str,
    actual_bytes: usize,
    limit_bytes: usize,
) -> GitResult<()> {
    if actual_bytes > limit_bytes {
        return Err(GitError::OutputTooLarge {
            stream,
            limit_bytes,
        });
    }

    Ok(())
}

pub(crate) fn redact_git_stderr(stderr: &str) -> String {
    stderr
        .split_whitespace()
        .map(redact_token)
        .collect::<Vec<_>>()
        .join(" ")
}

fn redact_token(token: &str) -> String {
    let Some(scheme_index) = token.find("://") else {
        return token.to_string();
    };
    let authority_start = scheme_index + "://".len();
    let authority_end = token[authority_start..]
        .find('/')
        .map(|index| authority_start + index)
        .unwrap_or(token.len());
    let authority = &token[authority_start..authority_end];
    let Some(at_index) = authority.rfind('@') else {
        return token.to_string();
    };

    format!(
        "{}://<redacted>@{}{}",
        &token[..scheme_index],
        &authority[at_index + 1..],
        &token[authority_end..]
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tempfile::TempDir;

    use crate::env::GitEnvironment;
    use crate::error::GitError;

    use super::{GitRunOptions, GitRunner, redact_git_stderr};

    #[test]
    fn runs_git_with_args() {
        let temp = TempDir::new().expect("temp");
        let output = GitRunner::new()
            .run(temp.path(), &["--version"], GitRunOptions::read_only())
            .expect("git version");

        assert!(output.stdout.starts_with("git version"));
    }

    #[test]
    fn injects_safe_environment_for_read_only_commands() {
        let temp = TempDir::new().expect("temp");
        let output = GitRunner::with_executable("sh")
            .with_environment(GitEnvironment::empty().with_value("PATH", "/bin:/usr/bin"))
            .run(
                temp.path(),
                &[
                    "-c",
                    "printf '%s' \"$GIT_OPTIONAL_LOCKS:$GIT_PAGER:$PAGER\"",
                ],
                GitRunOptions::read_only(),
            )
            .expect("shell");

        assert_eq!(output.stdout, "0::");
    }

    #[test]
    fn maps_non_zero_exit_to_command_failed() {
        let temp = TempDir::new().expect("temp");
        let error = GitRunner::with_executable("sh")
            .with_environment(GitEnvironment::empty().with_value("PATH", "/bin:/usr/bin"))
            .run(
                temp.path(),
                &["-c", "printf 'fatal: nope' >&2; exit 7"],
                GitRunOptions::read_only(),
            )
            .expect_err("failed command");

        assert!(matches!(
            error,
            GitError::CommandFailed { code: Some(7), .. }
        ));
    }

    #[test]
    fn fails_when_stdout_exceeds_limit() {
        let temp = TempDir::new().expect("temp");
        let options = GitRunOptions {
            max_stdout_bytes: 2,
            ..GitRunOptions::read_only()
        };
        let error = GitRunner::with_executable("sh")
            .with_environment(GitEnvironment::empty().with_value("PATH", "/bin:/usr/bin"))
            .run(temp.path(), &["-c", "printf 'abcd'"], options)
            .expect_err("too large");

        assert!(matches!(
            error,
            GitError::OutputTooLarge {
                stream: "stdout",
                ..
            }
        ));
    }

    #[test]
    fn times_out_long_running_commands() {
        let temp = TempDir::new().expect("temp");
        let options = GitRunOptions {
            timeout: Duration::from_millis(30),
            ..GitRunOptions::read_only()
        };
        let error = GitRunner::with_executable("sh")
            .with_environment(GitEnvironment::empty().with_value("PATH", "/bin:/usr/bin"))
            .run(temp.path(), &["-c", "sleep 1"], options)
            .expect_err("timeout");

        assert!(matches!(error, GitError::CommandTimedOut));
    }

    #[test]
    fn redacts_credentials_in_urls() {
        assert_eq!(
            redact_git_stderr("fatal https://user:token@example.com/repo.git failed"),
            "fatal https://<redacted>@example.com/repo.git failed"
        );
    }
}
