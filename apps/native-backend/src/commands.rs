use serde_json::{Value, json};

use crate::protocol::{RpcOutput, RpcRequest, error_response, event, response_ok, rpc_error};

pub const BACKEND_NAME: &str = "comando-native-backend";
pub const PROTOCOL_VERSION: u32 = 1;
pub const RUST_VERSION: &str = "1.96";
pub const TEST_EVENT_NAME: &str = "backend://test-event";
pub const COMMANDS: &[&str] = &[
    "backend_ping",
    "backend_capabilities",
    "backend_shutdown",
    "backend_emit_test_event",
];

#[derive(Debug, Clone, PartialEq)]
pub struct CommandResult {
    pub outputs: Vec<RpcOutput>,
    pub should_shutdown: bool,
}

pub fn handle_request(request: RpcRequest) -> CommandResult {
    match request.command.as_str() {
        "backend_ping" => response_only(request.id, ping_payload()),
        "backend_capabilities" => response_only(request.id, capabilities_payload()),
        "backend_shutdown" => CommandResult {
            outputs: vec![response_ok(request.id, json!({"accepted": true}))],
            should_shutdown: true,
        },
        "backend_emit_test_event" => emit_test_event(request),
        command => CommandResult {
            outputs: vec![error_response(
                request.id,
                rpc_error(
                    "unknown_command",
                    format!("Unknown command: {command}"),
                    None,
                ),
            )],
            should_shutdown: false,
        },
    }
}

fn response_only(id: Value, payload: Value) -> CommandResult {
    CommandResult {
        outputs: vec![response_ok(id, payload)],
        should_shutdown: false,
    }
}

fn ping_payload() -> Value {
    json!({
        "pong": true,
        "backend": BACKEND_NAME,
    })
}

fn capabilities_payload() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "backendVersion": env!("CARGO_PKG_VERSION"),
        "rustVersion": RUST_VERSION,
        "commands": COMMANDS,
        "features": ["bootstrap"],
    })
}

fn emit_test_event(request: RpcRequest) -> CommandResult {
    let message = request
        .args
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("hello");

    CommandResult {
        outputs: vec![
            response_ok(request.id, json!({"emitted": true})),
            event(TEST_EVENT_NAME, json!({"message": message})),
        ],
        should_shutdown: false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::protocol::{RpcOutput, RpcRequest};

    fn request(command: &str, args: Value) -> RpcRequest {
        RpcRequest {
            id: json!(1),
            command: command.to_string(),
            args,
        }
    }

    #[test]
    fn handles_ping() {
        let result = handle_request(request("backend_ping", json!({})));

        assert_eq!(
            result.outputs,
            vec![response_ok(
                json!(1),
                json!({"pong": true, "backend": BACKEND_NAME})
            )]
        );
        assert!(!result.should_shutdown);
    }

    #[test]
    fn handles_capabilities() {
        let result = handle_request(request("backend_capabilities", json!({})));

        assert_eq!(
            result.outputs,
            vec![response_ok(
                json!(1),
                json!({
                    "protocolVersion": 1,
                    "backendVersion": "0.1.0",
                    "rustVersion": "1.96",
                    "commands": COMMANDS,
                    "features": ["bootstrap"],
                })
            )]
        );
    }

    #[test]
    fn handles_test_event() {
        let result = handle_request(request(
            "backend_emit_test_event",
            json!({"message": "hola"}),
        ));

        assert_eq!(
            result.outputs,
            vec![
                response_ok(json!(1), json!({"emitted": true})),
                RpcOutput::Event {
                    event_name: TEST_EVENT_NAME.to_string(),
                    payload: json!({"message": "hola"}),
                },
            ]
        );
    }

    #[test]
    fn handles_shutdown() {
        let result = handle_request(request("backend_shutdown", json!({})));

        assert_eq!(
            result.outputs,
            vec![response_ok(json!(1), json!({"accepted": true}))]
        );
        assert!(result.should_shutdown);
    }

    #[test]
    fn rejects_unknown_command() {
        let result = handle_request(request("backend_missing", json!({})));
        let [
            RpcOutput::Response {
                ok, error, result, ..
            },
        ] = result.outputs.as_slice()
        else {
            panic!("expected one response");
        };

        assert!(!ok);
        assert!(result.is_none());
        assert_eq!(
            error.as_ref().map(|error| error.code.as_str()),
            Some("unknown_command")
        );
    }
}
