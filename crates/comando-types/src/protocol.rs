use std::io::{self, Write};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::capabilities::PROTOCOL_VERSION;
use crate::error::{NativeError, NativeErrorCode};
use crate::ids::{ProjectId, RequestId, WindowId, WorktreeId};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRequestMeta {
    pub protocol_version: u32,
    #[serde(default)]
    pub sent_at: Option<String>,
    #[serde(default)]
    pub window_id: Option<WindowId>,
    #[serde(default)]
    pub project_id: Option<ProjectId>,
    #[serde(default)]
    pub worktree_id: Option<WorktreeId>,
}

impl Default for NativeRequestMeta {
    fn default() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            sent_at: None,
            window_id: None,
            project_id: None,
            worktree_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeResponseMeta {
    pub protocol_version: u32,
    #[serde(default)]
    pub handled_at: Option<String>,
}

impl Default for NativeResponseMeta {
    fn default() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            handled_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeEventMeta {
    pub protocol_version: u32,
    #[serde(default)]
    pub emitted_at: Option<String>,
    #[serde(default)]
    pub project_id: Option<ProjectId>,
    #[serde(default)]
    pub worktree_id: Option<WorktreeId>,
    #[serde(default)]
    pub window_id: Option<WindowId>,
}

impl Default for NativeEventMeta {
    fn default() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            emitted_at: None,
            project_id: None,
            worktree_id: None,
            window_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRpcRequest {
    pub id: RequestId,
    pub command: String,
    #[serde(default = "empty_object")]
    pub args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<NativeRequestMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRpcResponse {
    pub id: Option<RequestId>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<NativeError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<NativeResponseMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRpcEvent {
    pub event_name: String,
    pub payload: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<NativeEventMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NativeRpcOutput {
    #[serde(rename = "response")]
    Response(NativeRpcResponse),
    #[serde(rename = "event")]
    Event(NativeRpcEvent),
}

#[derive(Debug, Clone)]
pub struct RequestParseError {
    pub id: Option<RequestId>,
    pub error: Box<NativeError>,
}

impl RequestParseError {
    fn new(id: Option<RequestId>, error: NativeError) -> Self {
        Self {
            id,
            error: Box::new(error),
        }
    }
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

    pub fn write_output(&mut self, output: &NativeRpcOutput) -> io::Result<()> {
        serde_json::to_writer(&mut self.writer, output).map_err(io::Error::other)?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()
    }
}

pub fn parse_request_line(line: &str) -> Result<NativeRpcRequest, RequestParseError> {
    let value = serde_json::from_str::<Value>(line).map_err(|error| {
        RequestParseError::new(
            extract_id_from_malformed_json(line),
            NativeError::new(
                NativeErrorCode::InvalidJson,
                format!("Invalid JSON request: {error}"),
            ),
        )
    })?;

    parse_request_value(value)
}

pub fn parse_request_value(value: Value) -> Result<NativeRpcRequest, RequestParseError> {
    let object = value.as_object().ok_or_else(|| {
        RequestParseError::new(
            None,
            NativeError::new(
                NativeErrorCode::InvalidRequest,
                "Request must be a JSON object.",
            ),
        )
    })?;
    let id_value = object.get("id").cloned().ok_or_else(|| {
        RequestParseError::new(
            None,
            NativeError::new(NativeErrorCode::InvalidRequest, "Request id is required."),
        )
    })?;
    let id = parse_request_id(id_value).map_err(|error| RequestParseError::new(None, error))?;
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RequestParseError::new(
                Some(id.clone()),
                NativeError::new(
                    NativeErrorCode::InvalidRequest,
                    "Request command is required.",
                ),
            )
        })?;
    let args = object
        .get("args")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));

    if !args.is_object() {
        return Err(RequestParseError::new(
            Some(id),
            NativeError::new(
                NativeErrorCode::InvalidRequest,
                "Request args must be an object.",
            ),
        ));
    }

    let meta = object
        .get("meta")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| {
            RequestParseError::new(
                Some(id.clone()),
                NativeError::new(
                    NativeErrorCode::InvalidRequest,
                    format!("Request meta is invalid: {error}"),
                ),
            )
        })?;

    Ok(NativeRpcRequest {
        id,
        command: command.to_string(),
        args,
        meta,
    })
}

pub fn response_ok(id: RequestId, result: Value) -> NativeRpcOutput {
    NativeRpcOutput::Response(NativeRpcResponse {
        id: Some(id),
        ok: true,
        result: Some(result),
        error: None,
        meta: None,
    })
}

pub fn error_response(id: Option<RequestId>, error: NativeError) -> NativeRpcOutput {
    NativeRpcOutput::Response(NativeRpcResponse {
        id,
        ok: false,
        result: None,
        error: Some(error),
        meta: None,
    })
}

pub fn event(event_name: impl Into<String>, payload: Value) -> NativeRpcOutput {
    NativeRpcOutput::Event(NativeRpcEvent {
        event_name: event_name.into(),
        payload,
        meta: None,
    })
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}

fn parse_request_id(value: Value) -> Result<RequestId, NativeError> {
    serde_json::from_value(value).map_err(|_| {
        NativeError::new(
            NativeErrorCode::InvalidRequest,
            "Request id must be a string or number.",
        )
    })
}

fn extract_id_from_malformed_json(line: &str) -> Option<RequestId> {
    let id_key_start = line.find("\"id\"")?;
    let colon_offset = line[id_key_start + 4..].find(':')?;
    let value_start = id_key_start + 4 + colon_offset + 1;
    let value_text = line[value_start..].trim_start();

    if value_text.starts_with('"') {
        return parse_string_id(value_text);
    }

    let token: String = value_text
        .chars()
        .take_while(|character| !matches!(character, ',' | '}' | ']') && !character.is_whitespace())
        .collect();
    if token.is_empty() {
        return None;
    }

    serde_json::from_str::<RequestId>(&token).ok()
}

fn parse_string_id(value_text: &str) -> Option<RequestId> {
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

    fn req_id(value: i64) -> RequestId {
        RequestId::Number(value)
    }

    #[test]
    fn parses_request_with_args() {
        let request = parse_request_line(r#"{"id":1,"command":"backend_ping","args":{}}"#)
            .expect("request should parse");

        assert_eq!(request.id, req_id(1));
        assert_eq!(request.command, "backend_ping");
        assert_eq!(request.args, json!({}));
    }

    #[test]
    fn parses_request_without_args() {
        let request = parse_request_line(r#"{"id":"abc","command":"backend_ping"}"#)
            .expect("request should parse");

        assert_eq!(request.id, RequestId::String("abc".to_string()));
        assert_eq!(request.args, json!({}));
    }

    #[test]
    fn reports_invalid_json_with_id_when_possible() {
        let error = parse_request_line(r#"{"id":42,"command":"backend_ping""#)
            .expect_err("request should fail");

        assert_eq!(error.id, Some(req_id(42)));
        assert_eq!(error.error.code, NativeErrorCode::InvalidJson);
    }

    #[test]
    fn rejects_non_object_args() {
        let error = parse_request_line(r#"{"id":1,"command":"backend_ping","args":[]}"#)
            .expect_err("request should fail");

        assert_eq!(error.id, Some(req_id(1)));
        assert_eq!(error.error.code, NativeErrorCode::InvalidRequest);
    }

    #[test]
    fn serializes_success_response() {
        let output = response_ok(req_id(1), json!({"pong": true}));
        let serialized = serde_json::to_value(output).expect("response should serialize");

        assert_eq!(
            serialized,
            json!({"type":"response","id":1,"ok":true,"result":{"pong":true}})
        );
    }

    #[test]
    fn serializes_error_response() {
        let output = error_response(
            Some(req_id(1)),
            NativeError::new(NativeErrorCode::UnknownCommand, "Unknown command: missing"),
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
                    "details":null,
                    "retryable":false
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
