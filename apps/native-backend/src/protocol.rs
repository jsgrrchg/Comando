use std::io::{self, Write};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type RpcId = Value;

#[derive(Debug, Clone, PartialEq)]
pub struct RpcRequest {
    pub id: RpcId,
    pub command: String,
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct RequestParseError {
    pub id: RpcId,
    pub error: RpcError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum RpcOutput {
    #[serde(rename = "response")]
    Response {
        id: RpcId,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    #[serde(rename = "event")]
    Event {
        #[serde(rename = "eventName")]
        event_name: String,
        payload: Value,
    },
}

pub struct JsonlWriter<W> {
    writer: W,
}

impl<W> JsonlWriter<W>
where
    W: Write,
{
    pub fn new(writer: W) -> Self {
        Self { writer }
    }

    pub fn write_output(&mut self, output: &RpcOutput) -> io::Result<()> {
        serde_json::to_writer(&mut self.writer, output).map_err(io::Error::other)?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()
    }
}

pub fn parse_request_line(line: &str) -> Result<RpcRequest, RequestParseError> {
    let value = serde_json::from_str::<Value>(line).map_err(|error| RequestParseError {
        id: extract_id_from_malformed_json(line),
        error: rpc_error(
            "malformed_json",
            format!("Malformed JSON request: {error}"),
            None,
        ),
    })?;

    parse_request_value(value)
}

pub fn parse_request_value(value: Value) -> Result<RpcRequest, RequestParseError> {
    let object = value.as_object().ok_or_else(|| RequestParseError {
        id: Value::Null,
        error: rpc_error("invalid_request", "Request must be a JSON object.", None),
    })?;
    let id = object.get("id").cloned().ok_or_else(|| RequestParseError {
        id: Value::Null,
        error: rpc_error("invalid_request", "Request id is required.", None),
    })?;
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| RequestParseError {
            id: id.clone(),
            error: rpc_error("invalid_request", "Request command is required.", None),
        })?;
    let args = object
        .get("args")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));

    if !args.is_object() {
        return Err(RequestParseError {
            id,
            error: rpc_error("invalid_request", "Request args must be an object.", None),
        });
    }

    Ok(RpcRequest {
        id,
        command: command.to_string(),
        args,
    })
}

pub fn response_ok(id: RpcId, result: Value) -> RpcOutput {
    RpcOutput::Response {
        id,
        ok: true,
        result: Some(result),
        error: None,
    }
}

pub fn error_response(id: RpcId, error: RpcError) -> RpcOutput {
    RpcOutput::Response {
        id,
        ok: false,
        result: None,
        error: Some(error),
    }
}

pub fn event(event_name: impl Into<String>, payload: Value) -> RpcOutput {
    RpcOutput::Event {
        event_name: event_name.into(),
        payload,
    }
}

pub fn rpc_error(
    code: impl Into<String>,
    message: impl Into<String>,
    details: Option<Value>,
) -> RpcError {
    RpcError {
        code: code.into(),
        message: message.into(),
        details,
    }
}

fn extract_id_from_malformed_json(line: &str) -> Value {
    let Some(id_key_start) = line.find("\"id\"") else {
        return Value::Null;
    };
    let Some(colon_offset) = line[id_key_start + 4..].find(':') else {
        return Value::Null;
    };
    let value_start = id_key_start + 4 + colon_offset + 1;
    let value_text = line[value_start..].trim_start();

    if value_text.starts_with('"') {
        return parse_string_id(value_text).unwrap_or(Value::Null);
    }

    let token: String = value_text
        .chars()
        .take_while(|character| !matches!(character, ',' | '}' | ']') && !character.is_whitespace())
        .collect();
    if token.is_empty() {
        return Value::Null;
    }

    serde_json::from_str(&token).unwrap_or(Value::Null)
}

fn parse_string_id(value_text: &str) -> Option<Value> {
    let mut escaped = false;

    for (index, character) in value_text.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }

        match character {
            '\\' => escaped = true,
            '"' => return serde_json::from_str(&value_text[..=index]).ok(),
            _ => {}
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_request_with_args() {
        let request = parse_request_line(r#"{"id":1,"command":"backend_ping","args":{}}"#)
            .expect("request should parse");

        assert_eq!(request.id, json!(1));
        assert_eq!(request.command, "backend_ping");
        assert_eq!(request.args, json!({}));
    }

    #[test]
    fn parses_request_without_args() {
        let request = parse_request_line(r#"{"id":"abc","command":"backend_ping"}"#)
            .expect("request should parse");

        assert_eq!(request.id, json!("abc"));
        assert_eq!(request.args, json!({}));
    }

    #[test]
    fn reports_invalid_json_with_id_when_possible() {
        let error = parse_request_line(r#"{"id":42,"command":"backend_ping""#)
            .expect_err("request should fail");

        assert_eq!(error.id, json!(42));
        assert_eq!(error.error.code, "malformed_json");
    }

    #[test]
    fn rejects_non_object_args() {
        let error = parse_request_line(r#"{"id":1,"command":"backend_ping","args":[]}"#)
            .expect_err("request should fail");

        assert_eq!(error.id, json!(1));
        assert_eq!(error.error.code, "invalid_request");
    }

    #[test]
    fn serializes_success_response() {
        let output = response_ok(json!(1), json!({"pong": true}));
        let serialized = serde_json::to_value(output).expect("response should serialize");

        assert_eq!(
            serialized,
            json!({"type":"response","id":1,"ok":true,"result":{"pong":true}})
        );
    }

    #[test]
    fn serializes_error_response() {
        let output = error_response(
            json!(1),
            rpc_error("unknown_command", "Unknown command: missing", None),
        );
        let serialized = serde_json::to_value(output).expect("response should serialize");

        assert_eq!(
            serialized,
            json!({
                "type":"response",
                "id":1,
                "ok":false,
                "error":{
                    "code":"unknown_command",
                    "message":"Unknown command: missing",
                    "details":null
                }
            })
        );
    }

    #[test]
    fn serializes_event() {
        let output = event("backend://test-event", json!({"message":"hello"}));
        let serialized = serde_json::to_value(output).expect("event should serialize");

        assert_eq!(
            serialized,
            json!({
                "type":"event",
                "eventName":"backend://test-event",
                "payload":{"message":"hello"}
            })
        );
    }
}
