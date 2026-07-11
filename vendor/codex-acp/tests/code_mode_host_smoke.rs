use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use codex_code_mode::{
    CellId, CodeModeNestedToolCall, CodeModeSessionDelegate, CodeModeSessionProvider,
    CodeModeToolKind, ExecuteRequest, FunctionCallOutputContentItem, NotificationFuture,
    ProcessOwnedCodeModeSessionProvider, RuntimeResponse, ToolDefinition, ToolInvocationFuture,
};
use codex_protocol::ToolName;
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct RecordingDelegate {
    invocations: Mutex<Vec<CodeModeNestedToolCall>>,
}

impl CodeModeSessionDelegate for RecordingDelegate {
    fn invoke_tool<'a>(
        &'a self,
        invocation: CodeModeNestedToolCall,
        _cancellation_token: CancellationToken,
    ) -> ToolInvocationFuture<'a> {
        self.invocations
            .lock()
            .expect("invocations lock")
            .push(invocation);
        Box::pin(async { Ok(json!({ "value": "nested output" })) })
    }

    fn notify<'a>(
        &'a self,
        _call_id: String,
        _cell_id: CellId,
        _text: String,
        _cancellation_token: CancellationToken,
    ) -> NotificationFuture<'a> {
        Box::pin(async { Ok(()) })
    }

    fn cell_closed(&self, _cell_id: &CellId) {}
}

#[tokio::test]
async fn bundled_host_executes_javascript_and_shuts_down() {
    let provider = ProcessOwnedCodeModeSessionProvider::with_host_program(PathBuf::from(env!(
        "CARGO_BIN_EXE_codex-code-mode-host"
    )));
    let delegate = Arc::new(RecordingDelegate::default());
    let session = provider
        .create_session(delegate.clone())
        .await
        .expect("create code mode session");
    let started = session
        .execute(ExecuteRequest {
            tool_call_id: "smoke-1".to_string(),
            enabled_tools: vec![ToolDefinition {
                name: "echo".to_string(),
                tool_name: ToolName::plain("echo"),
                description: "Return a deterministic value".to_string(),
                kind: CodeModeToolKind::Function,
                input_schema: None,
                output_schema: None,
            }],
            source: r#"const result = await tools.echo({ value: "input" }); text(result.value);"#
                .to_string(),
            yield_time_ms: None,
            max_output_tokens: None,
        })
        .await
        .expect("start JavaScript execution");
    let response = started
        .initial_response()
        .await
        .expect("receive JavaScript response");

    assert_eq!(
        response,
        RuntimeResponse::Result {
            cell_id: CellId::new("1".to_string()),
            content_items: vec![FunctionCallOutputContentItem::InputText {
                text: "nested output".to_string(),
            }],
            error_text: None,
        }
    );
    let invocations = delegate.invocations.lock().expect("invocations lock");
    assert_eq!(invocations.len(), 1);
    assert_eq!(invocations[0].cell_id, CellId::new("1".to_string()));
    assert_eq!(invocations[0].runtime_tool_call_id, "tool-1");
    assert_eq!(invocations[0].tool_name, ToolName::plain("echo"));
    drop(invocations);
    session.shutdown().await.expect("shutdown code mode host");
}
