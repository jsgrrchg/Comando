use std::collections::HashMap;
use std::env;
use std::path::Path;

use comando_types::terminal::NativeTerminalWindowsShell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalPlatform {
    Windows,
    MacOs,
    Linux,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTerminalShell {
    pub command: String,
    pub args: Vec<String>,
    pub fallback_reason: Option<String>,
}

pub fn resolve_current_terminal_shell(
    windows_shell: NativeTerminalWindowsShell,
) -> ResolvedTerminalShell {
    let env = env::vars().collect::<HashMap<_, _>>();
    resolve_terminal_shell_with_env(windows_shell, current_platform(), &env, &|command| {
        command_is_available(command, &env)
    })
}

pub fn resolve_terminal_shell_with_env(
    windows_shell: NativeTerminalWindowsShell,
    platform: TerminalPlatform,
    env: &HashMap<String, String>,
    is_command_available: &dyn Fn(&str) -> bool,
) -> ResolvedTerminalShell {
    let (command, fallback_reason) = if platform == TerminalPlatform::Windows {
        resolve_windows_shell(windows_shell, env, is_command_available)
    } else {
        (resolve_posix_shell(platform, env), None::<String>)
    };

    let args = resolve_terminal_shell_args(&command, platform);
    ResolvedTerminalShell {
        command,
        args,
        fallback_reason,
    }
}

pub fn resolve_terminal_shell_args(shell: &str, platform: TerminalPlatform) -> Vec<String> {
    if platform == TerminalPlatform::Windows {
        let normalized_shell = shell.to_ascii_lowercase();
        let shell_base_name = windows_base_name(&normalized_shell);
        return if normalized_shell.contains("powershell") || shell_base_name == "pwsh.exe" {
            vec!["-NoLogo".to_string()]
        } else {
            Vec::new()
        };
    }

    let shell_base_name = posix_base_name(shell).to_ascii_lowercase();
    if shell_base_name == "fish" {
        return Vec::new();
    }

    vec!["-l".to_string()]
}

fn resolve_windows_shell(
    windows_shell: NativeTerminalWindowsShell,
    env: &HashMap<String, String>,
    is_command_available: &dyn Fn(&str) -> bool,
) -> (String, Option<String>) {
    match windows_shell {
        NativeTerminalWindowsShell::Cmd => ("cmd.exe".to_string(), None),
        NativeTerminalWindowsShell::Powershell => ("powershell.exe".to_string(), None),
        NativeTerminalWindowsShell::Pwsh => {
            if !is_command_available("pwsh") {
                return (
                    "powershell.exe".to_string(),
                    Some(
                        "PowerShell 7 (pwsh) was not found. Falling back to Windows PowerShell."
                            .to_string(),
                    ),
                );
            }

            ("pwsh.exe".to_string(), None)
        }
        NativeTerminalWindowsShell::Default => (
            env.get("COMSPEC")
                .or_else(|| env.get("ComSpec"))
                .cloned()
                .unwrap_or_else(|| "powershell.exe".to_string()),
            None,
        ),
    }
}

fn resolve_posix_shell(platform: TerminalPlatform, env: &HashMap<String, String>) -> String {
    env.get("SHELL").cloned().unwrap_or_else(|| {
        if platform == TerminalPlatform::MacOs {
            "zsh".to_string()
        } else {
            "bash".to_string()
        }
    })
}

fn current_platform() -> TerminalPlatform {
    if cfg!(target_os = "windows") {
        TerminalPlatform::Windows
    } else if cfg!(target_os = "macos") {
        TerminalPlatform::MacOs
    } else if cfg!(target_os = "linux") {
        TerminalPlatform::Linux
    } else {
        TerminalPlatform::Other
    }
}

fn command_is_available(command: &str, env: &HashMap<String, String>) -> bool {
    if command.contains('/') || command.contains('\\') {
        return Path::new(command).is_file();
    }

    let Some(path) = env.get("PATH") else {
        return false;
    };

    let extensions = if current_platform() == TerminalPlatform::Windows {
        env.get("PATHEXT")
            .map(|value| {
                value
                    .split(';')
                    .filter(|part| !part.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec![".EXE".to_string(), ".CMD".to_string(), ".BAT".to_string()])
    } else {
        vec![String::new()]
    };

    env::split_paths(path).any(|entry| {
        extensions.iter().any(|extension| {
            let candidate = entry.join(format!("{command}{extension}"));
            candidate.is_file()
        })
    })
}

fn windows_base_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

fn posix_base_name(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn uses_comspec_for_the_default_windows_shell() {
        assert_eq!(
            resolve_terminal_shell_with_env(
                NativeTerminalWindowsShell::Default,
                TerminalPlatform::Windows,
                &env(&[("COMSPEC", "C:\\Windows\\System32\\cmd.exe")]),
                &|_| true,
            ),
            ResolvedTerminalShell {
                args: Vec::new(),
                command: "C:\\Windows\\System32\\cmd.exe".to_string(),
                fallback_reason: None,
            }
        );
    }

    #[test]
    fn falls_back_to_windows_powershell_when_comspec_is_absent() {
        assert_eq!(
            resolve_terminal_shell_with_env(
                NativeTerminalWindowsShell::Default,
                TerminalPlatform::Windows,
                &HashMap::new(),
                &|_| true,
            ),
            ResolvedTerminalShell {
                args: vec!["-NoLogo".to_string()],
                command: "powershell.exe".to_string(),
                fallback_reason: None,
            }
        );
    }

    #[test]
    fn resolves_configured_windows_shells() {
        for (preference, command, args) in [
            (
                NativeTerminalWindowsShell::Cmd,
                "cmd.exe",
                Vec::<String>::new(),
            ),
            (
                NativeTerminalWindowsShell::Powershell,
                "powershell.exe",
                vec!["-NoLogo".to_string()],
            ),
            (
                NativeTerminalWindowsShell::Pwsh,
                "pwsh.exe",
                vec!["-NoLogo".to_string()],
            ),
        ] {
            assert_eq!(
                resolve_terminal_shell_with_env(
                    preference,
                    TerminalPlatform::Windows,
                    &HashMap::new(),
                    &|_| true,
                ),
                ResolvedTerminalShell {
                    args,
                    command: command.to_string(),
                    fallback_reason: None,
                }
            );
        }
    }

    #[test]
    fn falls_back_when_pwsh_is_unavailable() {
        assert_eq!(
            resolve_terminal_shell_with_env(
                NativeTerminalWindowsShell::Pwsh,
                TerminalPlatform::Windows,
                &HashMap::new(),
                &|command| command != "pwsh",
            ),
            ResolvedTerminalShell {
                args: vec!["-NoLogo".to_string()],
                command: "powershell.exe".to_string(),
                fallback_reason: Some(
                    "PowerShell 7 (pwsh) was not found. Falling back to Windows PowerShell."
                        .to_string(),
                ),
            }
        );
    }

    #[test]
    fn resolves_windows_args_from_absolute_paths_on_any_host() {
        assert_eq!(
            resolve_terminal_shell_args(
                "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
                TerminalPlatform::Windows,
            ),
            vec!["-NoLogo".to_string()],
        );
        assert_eq!(
            resolve_terminal_shell_args(
                "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                TerminalPlatform::Windows,
            ),
            vec!["-NoLogo".to_string()],
        );
        assert_eq!(
            resolve_terminal_shell_args(
                "C:\\Windows\\System32\\cmd.exe",
                TerminalPlatform::Windows
            ),
            Vec::<String>::new(),
        );
    }

    #[test]
    fn resolves_posix_shells_from_env_and_defaults() {
        assert_eq!(
            resolve_terminal_shell_with_env(
                NativeTerminalWindowsShell::Pwsh,
                TerminalPlatform::MacOs,
                &env(&[("SHELL", "/opt/homebrew/bin/fish")]),
                &|_| false,
            ),
            ResolvedTerminalShell {
                args: Vec::new(),
                command: "/opt/homebrew/bin/fish".to_string(),
                fallback_reason: None,
            }
        );
        assert_eq!(
            resolve_terminal_shell_with_env(
                NativeTerminalWindowsShell::Pwsh,
                TerminalPlatform::MacOs,
                &HashMap::new(),
                &|_| false,
            ),
            ResolvedTerminalShell {
                args: vec!["-l".to_string()],
                command: "zsh".to_string(),
                fallback_reason: None,
            }
        );
        assert_eq!(
            resolve_terminal_shell_with_env(
                NativeTerminalWindowsShell::Pwsh,
                TerminalPlatform::Linux,
                &HashMap::new(),
                &|_| false,
            ),
            ResolvedTerminalShell {
                args: vec!["-l".to_string()],
                command: "bash".to_string(),
                fallback_reason: None,
            }
        );
    }
}
