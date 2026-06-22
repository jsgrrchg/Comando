use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

struct BackendProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl BackendProcess {
    fn spawn() -> Self {
        Self::spawn_with_env([])
    }

    fn spawn_with_env<const N: usize>(env_values: [(&str, &str); N]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_comando-native-backend"));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in env_values {
            command.env(key, value);
        }

        let mut child = command.spawn().expect("backend process should spawn");
        let stdin = child.stdin.take().expect("stdin should be piped");
        let stdout = child.stdout.take().expect("stdout should be piped");

        Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        }
    }

    fn send(&mut self, value: Value) {
        writeln!(self.stdin, "{value}").expect("request should be written");
        self.stdin.flush().expect("stdin should flush");
    }

    fn send_raw(&mut self, line: &str) {
        writeln!(self.stdin, "{line}").expect("request should be written");
        self.stdin.flush().expect("stdin should flush");
    }

    fn read_json(&mut self) -> Value {
        let mut line = String::new();
        let bytes = self
            .stdout
            .read_line(&mut line)
            .expect("stdout should be readable");
        assert!(bytes > 0, "backend stdout closed before a response");

        serde_json::from_str(line.trim_end()).expect("stdout line should be JSON")
    }

    fn wait_for_exit(&mut self) -> Option<i32> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(status) = self.child.try_wait().expect("process status should read") {
                return status.code();
            }

            if Instant::now() >= deadline {
                return None;
            }

            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for BackendProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[test]
fn ping_over_stdio() {
    let mut backend = BackendProcess::spawn();

    backend.send(json!({"id": 1, "command": "backend_ping", "args": {}}));

    assert_eq!(
        backend.read_json(),
        json!({
            "type": "response",
            "id": 1,
            "ok": true,
            "result": {
                "backend": "comando-native-backend",
                "pong": true,
            },
        })
    );
}

#[test]
fn reports_capabilities() {
    let mut backend = BackendProcess::spawn();

    backend.send(json!({"id": "caps", "command": "backend_capabilities"}));
    let response = backend.read_json();

    assert_eq!(response["type"], "response");
    assert_eq!(response["id"], "caps");
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["protocolVersion"], 1);
    assert_eq!(response["result"]["backendVersion"], "0.1.0");
    assert_eq!(response["result"]["rustVersion"], "1.96");
    assert_eq!(
        response["result"]["capabilities"]["features"],
        json!([
            "bootstrap",
            "versioned-protocol",
            "json-fixtures",
            "native-persistence",
            "native-project-registry",
            "native-fs",
            "native-watchers",
            "native-index",
            "native-path-search",
            "native-search-cancel",
            "native-git",
            "native-git-diff",
            "native-git-history",
            "native-git-worktrees",
            "native-git-mutations",
            "native-git-network",
            "native-terminal",
            "native-ai"
        ])
    );
    assert_eq!(
        response["result"]["capabilities"]["commands"][0],
        json!("backend_ping")
    );
    assert_eq!(
        response["result"]["capabilities"]["commands"][1],
        json!("backend_handshake")
    );
}

#[test]
fn handshakes_protocol_v1() {
    let mut backend = BackendProcess::spawn();

    backend.send(json!({
        "id": "hello",
        "command": "backend_handshake",
        "args": {
            "clientName": "comando-electron-main",
            "clientVersion": "0.1.0",
            "protocolVersion": 1,
            "supportedProtocolVersions": [1],
        },
    }));

    let response = backend.read_json();

    assert_eq!(response["type"], "response");
    assert_eq!(response["id"], "hello");
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["backendName"], "comando-native-backend");
    assert_eq!(response["result"]["protocolVersion"], 1);
    assert_eq!(
        response["result"]["capabilities"]["features"],
        json!(["bootstrap", "versioned-protocol"])
    );
}

#[test]
fn terminal_create_streams_data_exit_and_closed_events() {
    let mut backend = BackendProcess::spawn();
    let temp_dir = tempfile::tempdir().expect("temp dir");

    backend.send(json!({
        "id": "term-create",
        "command": "terminal_create",
        "args": {
            "windowId": "window_main",
            "terminalId": "terminal_tab_1",
            "preferredSessionId": null,
            "projectId": null,
            "worktreeId": null,
            "cwd": temp_dir.path().to_string_lossy(),
            "cols": 120,
            "rows": 32,
            "extraEnv": {},
            "shellPreference": {"windowsShell": "default"},
            "purpose": "workspace",
            "launchedBy": "user",
            "launch": terminal_print_command(),
        },
    }));

    let response = backend.read_json();
    assert_eq!(response["type"], "response");
    assert_eq!(response["id"], "term-create");
    assert_eq!(response["ok"], true);
    let session_id = response["result"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();

    let mut saw_created = false;
    let mut saw_data = false;
    let mut saw_exit = false;
    let mut saw_closed = false;
    for _ in 0..8 {
        let output = backend.read_json();
        match output["eventName"].as_str() {
            Some("terminal://created") => {
                saw_created = output["payload"]["session"]["sessionId"] == session_id;
            }
            Some("terminal://data") => {
                saw_data = output["payload"]["sessionId"] == session_id
                    && output["payload"]["windowId"] == "window_main"
                    && output["payload"]["data"]
                        .as_str()
                        .is_some_and(|data| data.contains("ready"));
            }
            Some("terminal://exit") => {
                saw_exit = output["payload"]["sessionId"] == session_id
                    && output["payload"]["exitCode"] == 0;
            }
            Some("terminal://closed") => {
                saw_closed = output["payload"]["sessionId"] == session_id
                    && output["payload"]["reason"] == "process_exit";
            }
            _ => {}
        }

        if saw_created && saw_data && saw_exit && saw_closed {
            return;
        }
    }

    panic!(
        "missing terminal events created={saw_created} data={saw_data} exit={saw_exit} closed={saw_closed}"
    );
}

#[test]
fn rejects_incompatible_handshake_version() {
    let mut backend = BackendProcess::spawn();

    backend.send(json!({
        "id": "bad-version",
        "command": "backend_handshake",
        "args": {
            "clientName": "comando-electron-main",
            "clientVersion": "0.1.0",
            "protocolVersion": 99,
            "supportedProtocolVersions": [99],
        },
    }));
    let response = backend.read_json();

    assert_eq!(response["type"], "response");
    assert_eq!(response["id"], "bad-version");
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "unsupported_protocol_version");
    assert_eq!(response["error"]["retryable"], false);
}

#[cfg(unix)]
fn terminal_print_command() -> Value {
    json!({
        "kind": "command",
        "program": "/bin/sh",
        "args": ["-lc", "printf ready"],
        "displayName": "print",
    })
}

#[cfg(windows)]
fn terminal_print_command() -> Value {
    json!({
        "kind": "command",
        "program": "cmd.exe",
        "args": ["/C", "echo ready"],
        "displayName": "print",
    })
}

#[test]
fn emits_out_of_band_test_event() {
    let mut backend = BackendProcess::spawn();

    backend.send(json!({
        "id": 7,
        "command": "backend_emit_test_event",
        "args": {"message": "hello"},
    }));

    assert_eq!(
        backend.read_json(),
        json!({
            "type": "response",
            "id": 7,
            "ok": true,
            "result": {"emitted": true},
        })
    );
    assert_eq!(
        backend.read_json(),
        json!({
            "type": "event",
            "eventName": "backend://test-event",
            "payload": {"message": "hello"},
        })
    );
}

#[test]
fn unknown_command_returns_serialized_error() {
    let mut backend = BackendProcess::spawn();

    backend.send(json!({"id": 9, "command": "backend_missing"}));
    let response = backend.read_json();

    assert_eq!(response["type"], "response");
    assert_eq!(response["id"], 9);
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "unknown_command");
    assert_eq!(
        response["error"]["message"],
        "Unknown command: backend_missing"
    );
}

#[test]
fn malformed_input_does_not_crash() {
    let mut backend = BackendProcess::spawn();

    backend.send_raw(r#"{"id": 4, "command": "backend_ping""#);
    let malformed_response = backend.read_json();
    assert_eq!(malformed_response["type"], "response");
    assert_eq!(malformed_response["id"], 4);
    assert_eq!(malformed_response["ok"], false);
    assert_eq!(malformed_response["error"]["code"], "invalid_json");

    backend.send(json!({"id": 5, "command": "backend_ping"}));
    assert_eq!(backend.read_json()["id"], 5);
}

#[test]
fn handles_multiple_requests() {
    let mut backend = BackendProcess::spawn();

    backend.send(json!({"id": 1, "command": "backend_ping"}));
    backend.send(json!({"id": 2, "command": "backend_capabilities"}));

    let first = backend.read_json();
    let second = backend.read_json();

    assert_eq!(first["id"], 1);
    assert_eq!(second["id"], 2);
    assert_eq!(first["ok"], true);
    assert_eq!(second["ok"], true);
}

#[test]
fn native_ai_prepare_requires_launch_context_over_jsonl() {
    let mut backend = BackendProcess::spawn();

    backend.send(json!({
        "id": "list-ai",
        "command": "ai_list_runtimes",
        "args": {},
    }));
    let list_response = backend.read_json();
    assert_eq!(list_response["type"], "response");
    assert_eq!(list_response["ok"], true);
    assert!(
        list_response["result"]["runtimes"]
            .as_array()
            .expect("runtimes array")
            .iter()
            .any(|runtime| runtime["runtimeId"] == "opencode" && runtime["nativeReady"] == true)
    );

    backend.send(json!({
        "id": "prepare-ai",
        "command": "ai_prepare_session",
        "args": {
            "windowId": "window_main",
            "sessionId": "session_1",
            "runtimeId": "opencode",
            "projectId": null,
            "worktreeId": null,
            "cwd": "/tmp",
            "title": "AI Session",
            "modelId": null,
            "modeId": null,
            "configOptions": {},
            "additionalRoots": [],
            "launch": null
        },
    }));
    let prepare_response = backend.read_json();
    assert_eq!(prepare_response["type"], "response");
    assert_eq!(prepare_response["ok"], false);
    assert_eq!(
        prepare_response["error"]["code"],
        "ai_runtime_launch_context_invalid"
    );
}

#[test]
fn shutdown_exits_with_zero() {
    let mut backend = BackendProcess::spawn();

    backend.send(json!({"id": "bye", "command": "backend_shutdown"}));

    assert_eq!(
        backend.read_json(),
        json!({
            "type": "response",
            "id": "bye",
            "ok": true,
            "result": {"accepted": true},
        })
    );
    assert_eq!(backend.wait_for_exit(), Some(0));
}

#[test]
fn stdout_contains_only_jsonl() {
    let mut backend = BackendProcess::spawn();

    backend.send_raw(r#"{"id": 1, "command": "backend_ping""#);
    backend.send(json!({"id": 2, "command": "backend_ping"}));

    let malformed_response = backend.read_json();
    let ping_response = backend.read_json();

    assert_eq!(malformed_response["type"], "response");
    assert_eq!(ping_response["type"], "response");
}
