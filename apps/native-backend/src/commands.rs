use comando_types::capabilities::{
    BACKEND_NAME, NativeBackendCapabilitiesOutput, NativeBackendHandshakeInput,
    NativeBackendHandshakeOutput, PROTOCOL_VERSION, RUST_VERSION, backend_capabilities,
    bootstrap_capabilities, negotiate_protocol_version,
};
use comando_types::commands::{
    BACKEND_CAPABILITIES, BACKEND_EMIT_TEST_EVENT, BACKEND_HANDSHAKE, BACKEND_PING,
    BACKEND_SHUTDOWN,
};
use comando_types::error::{NativeError, NativeErrorCode};
use comando_types::events::BACKEND_TEST_EVENT;
use comando_types::ids::RequestId;
use serde_json::{Value, json};

use crate::protocol::{RpcOutput, RpcRequest, error_response, event, response_ok};

#[derive(Debug, Clone, PartialEq)]
pub struct CommandResult {
    pub outputs: Vec<RpcOutput>,
    pub should_shutdown: bool,
}

pub fn handle_request(request: RpcRequest) -> CommandResult {
    match request.command.as_str() {
        BACKEND_PING => response_only(request.id, ping_payload()),
        BACKEND_HANDSHAKE => handle_handshake(request),
        BACKEND_CAPABILITIES => response_only(request.id, capabilities_payload()),
        BACKEND_SHUTDOWN => CommandResult {
            outputs: vec![response_ok(request.id, json!({"accepted": true}))],
            should_shutdown: true,
        },
        BACKEND_EMIT_TEST_EVENT => emit_test_event(request),
        command => CommandResult {
            outputs: vec![error_response(
                Some(request.id),
                NativeError::new(
                    NativeErrorCode::UnknownCommand,
                    format!("Unknown command: {command}"),
                ),
            )],
            should_shutdown: false,
        },
    }
}

fn response_only(id: RequestId, payload: Value) -> CommandResult {
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
    serde_json::to_value(NativeBackendCapabilitiesOutput {
        backend_name: BACKEND_NAME.to_string(),
        backend_version: env!("CARGO_PKG_VERSION").to_string(),
        rust_version: RUST_VERSION.to_string(),
        protocol_version: PROTOCOL_VERSION,
        minimum_client_protocol_version: comando_types::MINIMUM_CLIENT_PROTOCOL_VERSION,
        minimum_backend_protocol_version: comando_types::MINIMUM_BACKEND_PROTOCOL_VERSION,
        capabilities: backend_capabilities(),
    })
    .expect("capabilities should serialize")
}

fn handle_handshake(request: RpcRequest) -> CommandResult {
    let input = match serde_json::from_value::<NativeBackendHandshakeInput>(request.args.clone()) {
        Ok(input) => input,
        Err(error) => {
            return CommandResult {
                outputs: vec![error_response(
                    Some(request.id),
                    NativeError::new(
                        NativeErrorCode::InvalidArgs,
                        format!("Invalid backend_handshake args: {error}"),
                    ),
                )],
                should_shutdown: false,
            };
        }
    };

    let Some(protocol_version) =
        negotiate_protocol_version(input.protocol_version, &input.supported_protocol_versions)
    else {
        return CommandResult {
            outputs: vec![error_response(
                Some(request.id),
                NativeError::new(
                    NativeErrorCode::UnsupportedProtocolVersion,
                    format!(
                        "Unsupported protocol version: client={} backend={}",
                        input.protocol_version, PROTOCOL_VERSION
                    ),
                )
                .with_details(json!({
                    "clientProtocolVersion": input.protocol_version,
                    "supportedProtocolVersions": input.supported_protocol_versions,
                    "backendProtocolVersion": PROTOCOL_VERSION,
                })),
            )],
            should_shutdown: false,
        };
    };

    response_only(
        request.id,
        serde_json::to_value(NativeBackendHandshakeOutput {
            backend_name: BACKEND_NAME.to_string(),
            backend_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version,
            minimum_client_protocol_version: comando_types::MINIMUM_CLIENT_PROTOCOL_VERSION,
            capabilities: bootstrap_capabilities(),
        })
        .expect("handshake should serialize"),
    )
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
            event(BACKEND_TEST_EVENT, json!({"message": message})),
        ],
        should_shutdown: false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use comando_types::ids::RequestId;

    use crate::protocol::{RpcOutput, RpcRequest};

    fn request(command: &str, args: Value) -> RpcRequest {
        RpcRequest {
            id: RequestId::Number(1),
            command: command.to_string(),
            args,
            meta: None,
        }
    }

    #[test]
    fn handles_ping() {
        let result = handle_request(request("backend_ping", json!({})));

        assert_eq!(
            result.outputs,
            vec![response_ok(
                RequestId::Number(1),
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
            vec![response_ok(RequestId::Number(1), capabilities_payload())]
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
                response_ok(RequestId::Number(1), json!({"emitted": true})),
                event(BACKEND_TEST_EVENT, json!({"message": "hola"})),
            ]
        );
    }

    #[test]
    fn handles_shutdown() {
        let result = handle_request(request("backend_shutdown", json!({})));

        assert_eq!(
            result.outputs,
            vec![response_ok(RequestId::Number(1), json!({"accepted": true}))]
        );
        assert!(result.should_shutdown);
    }

    #[test]
    fn rejects_unknown_command() {
        let result = handle_request(request("backend_missing", json!({})));
        let [RpcOutput::Response(response)] = result.outputs.as_slice() else {
            panic!("expected one response");
        };

        assert!(!response.ok);
        assert!(response.result.is_none());
        assert_eq!(
            response.error.as_ref().map(|error| error.code.as_str()),
            Some("unknown_command")
        );
    }
}
