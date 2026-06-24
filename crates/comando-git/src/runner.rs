use std::ffi::OsString;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::env::GitEnvironment;
use crate::error::{GitError, GitResult};

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_NETWORK_TIMEOUT_MS: u64 = 90_000;
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
            timeout: Duration::from_millis(DEFAULT_NETWORK_TIMEOUT_MS),
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
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let stdout_limit = options.max_stdout_bytes;
        let stderr_limit = options.max_stderr_bytes;
        let stdout_reader = thread::spawn(move || read_limited(stdout, stdout_limit));
        let stderr_reader = thread::spawn(move || read_limited(stderr, stderr_limit));
        let started_at = Instant::now();

        let status = match wait_for_child(&mut child, started_at, options.timeout) {
            Ok(status) => status,
            Err(error) => {
                let _ = join_reader(stdout_reader);
                let _ = join_reader(stderr_reader);
                return Err(error);
            }
        };
        let stdout = join_reader(stdout_reader)?;
        let stderr = join_reader(stderr_reader)?;
        ensure_output_limit("stdout", stdout.total_bytes, options.max_stdout_bytes)?;
        ensure_output_limit("stderr", stderr.total_bytes, options.max_stderr_bytes)?;

        let stdout = String::from_utf8_lossy(&stdout.bytes).to_string();
        let stderr = redact_git_stderr(&String::from_utf8_lossy(&stderr.bytes));
        let status_code = status.code();

        if !status.success()
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

#[derive(Debug)]
struct StreamRead {
    bytes: Vec<u8>,
    total_bytes: usize,
}

fn wait_for_child(
    child: &mut std::process::Child,
    started_at: Instant,
    timeout: Duration,
) -> GitResult<ExitStatus> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }

        if started_at.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(GitError::CommandTimedOut);
        }

        thread::sleep(POLL_INTERVAL);
    }
}

fn read_limited(mut reader: impl Read, limit_bytes: usize) -> io::Result<StreamRead> {
    let mut bytes = Vec::new();
    let mut total_bytes = 0usize;
    let mut buffer = [0u8; 8192];

    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }

        total_bytes += read;
        if bytes.len() < limit_bytes {
            let remaining = limit_bytes - bytes.len();
            bytes.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }

    Ok(StreamRead { bytes, total_bytes })
}

fn join_reader(handle: thread::JoinHandle<io::Result<StreamRead>>) -> GitResult<StreamRead> {
    handle
        .join()
        .map_err(|_| GitError::Io(io::Error::other("Git output reader panicked.")))?
        .map_err(GitError::Io)
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
    fn network_commands_have_a_longer_timeout_budget() {
        assert_eq!(GitRunOptions::network().timeout, Duration::from_secs(90));
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
    fn drains_stdout_while_process_is_running() {
        let temp = TempDir::new().expect("temp");
        let options = GitRunOptions {
            max_stdout_bytes: 256 * 1024,
            ..GitRunOptions::read_only()
        };
        let output = GitRunner::with_executable("sh")
            .with_environment(GitEnvironment::empty().with_value("PATH", "/bin:/usr/bin"))
            .run(
                temp.path(),
                &["-c", "head -c 131072 /dev/zero | tr '\\0' x"],
                options,
            )
            .expect("large stdout");

        assert_eq!(output.stdout.len(), 131072);
    }

    #[test]
    fn reports_large_stdout_after_draining_the_child() {
        let temp = TempDir::new().expect("temp");
        let options = GitRunOptions {
            max_stdout_bytes: 64 * 1024,
            ..GitRunOptions::read_only()
        };
        let error = GitRunner::with_executable("sh")
            .with_environment(GitEnvironment::empty().with_value("PATH", "/bin:/usr/bin"))
            .run(
                temp.path(),
                &["-c", "head -c 131072 /dev/zero | tr '\\0' x"],
                options,
            )
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
