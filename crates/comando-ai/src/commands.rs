use comando_types::ai::{
    NativeAiCancelSessionOutput, NativeAiCloseSessionOutput, NativeAiListRuntimesOutput,
    NativeAiSendPromptOutput, NativeAiSessionSummary,
};

pub fn list_runtimes_output(
    runtimes: Vec<comando_types::ai::NativeAiRuntimeDescriptor>,
) -> NativeAiListRuntimesOutput {
    NativeAiListRuntimesOutput { runtimes }
}

pub fn send_prompt_output(session_id: comando_types::ids::SessionId) -> NativeAiSendPromptOutput {
    NativeAiSendPromptOutput {
        accepted: true,
        session_id,
    }
}

pub fn cancel_session_output(
    session_id: comando_types::ids::SessionId,
) -> NativeAiCancelSessionOutput {
    NativeAiCancelSessionOutput {
        cancelled: true,
        session_id,
    }
}

pub fn close_session_output(
    session_id: comando_types::ids::SessionId,
) -> NativeAiCloseSessionOutput {
    NativeAiCloseSessionOutput {
        closed: true,
        session_id,
    }
}

pub fn prepare_session_output(summary: NativeAiSessionSummary) -> NativeAiSessionSummary {
    summary
}
