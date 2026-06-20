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
        let mut child = Command::new(env!("CARGO_BIN_EXE_comando-native-backend"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("backend process should spawn");
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
            "native-git-network"
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
