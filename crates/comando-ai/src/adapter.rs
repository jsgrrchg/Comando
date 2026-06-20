use comando_types::ai::{
    NativeAiCancelSessionOutput, NativeAiCloseSessionOutput, NativeAiPrepareSessionInput,
    NativeAiSendPromptInput, NativeAiSendPromptOutput, NativeAiSessionSummary,
};
use comando_types::ids::RuntimeId;

use crate::error::AiResult;

pub trait RuntimeAdapter: Send {
    fn runtime_id(&self) -> RuntimeId;

    fn prepare_session(
        &mut self,
        input: NativeAiPrepareSessionInput,
    ) -> AiResult<NativeAiSessionSummary>;

    fn send_prompt(&mut self, input: NativeAiSendPromptInput)
    -> AiResult<NativeAiSendPromptOutput>;

    fn cancel_session(&mut self, session_id: &str) -> AiResult<NativeAiCancelSessionOutput>;

    fn close_session(&mut self, session_id: &str) -> AiResult<NativeAiCloseSessionOutput>;
}
