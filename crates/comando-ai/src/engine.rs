use std::collections::HashMap;
use std::sync::{Arc, Mutex, mpsc};

use comando_settings::RuntimeSetupStore;
use comando_types::ai::{
    NativeAiCancelSessionOutput, NativeAiCloseSessionOutput, NativeAiGetRuntimeStatusInput,
    NativeAiListRuntimesOutput, NativeAiPermissionResponseInput, NativeAiPrepareSessionInput,
    NativeAiRuntimeStatus, NativeAiSendPromptInput, NativeAiSendPromptOutput,
    NativeAiSessionIdInput, NativeAiSessionStatus, NativeAiSessionSummary,
    NativeAiSetSessionConfigOptionInput, NativeAiSetSessionModeInput, NativeAiSetSessionModelInput,
    NativeAiUserInputResponseInput,
};
use comando_types::ids::RuntimeSessionId;
use serde_json::{Value, json};

use crate::acp::{AcpProcessSpec, NativeAiConfigValue, start_acp_session};
use crate::commands::{
    cancel_session_output, close_session_output, list_runtimes_output, prepare_session_output,
    send_prompt_output,
};
use crate::error::{AiError, AiResult};
use crate::events::{
    AI_ERROR_EVENT, AI_MESSAGE_COMPLETED_EVENT, AI_MESSAGE_DELTA_EVENT, AI_MESSAGE_STARTED_EVENT,
    AI_PERMISSION_REQUEST_EVENT, AI_PLAN_UPDATED_EVENT, AI_SESSION_CATALOG_UPDATED_EVENT,
    AI_SESSION_CLOSED_EVENT, AI_SESSION_UPDATED_EVENT, AI_STATUS_EVENT,
    AI_SUBAGENT_BREADCRUMB_EVENT, AI_SUBAGENT_CREATED_EVENT, AI_THINKING_COMPLETED_EVENT,
    AI_THINKING_DELTA_EVENT, AI_THINKING_STARTED_EVENT, AI_TOKEN_USAGE_EVENT,
    AI_TOOL_ACTIVITY_EVENT, AI_USER_INPUT_REQUEST_EVENT, AiRuntimeEvent, now_iso8601,
};
use crate::history::{
    AiHistorySessionMetadata, AiHistorySessionMetadataInput, AiHistoryStore,
    AiHistorySubagentMetadata,
};
use crate::runtime::RuntimeRegistry;
use crate::runtime_setup::{
    RuntimeAuthTerminalLaunch, invalidate_grok_auth_on_error, prepare_auth_terminal_launch,
    prepare_runtime_launch, runtime_status,
};
use crate::session::{NativeAiSession, SessionRegistry};

#[derive(Debug, Clone)]
pub struct AiEngineConfig {
    pub selected_native_runtime: String,
}

impl Default for AiEngineConfig {
    fn default() -> Self {
        Self {
            selected_native_runtime: "opencode".to_string(),
        }
    }
}

#[derive(Clone)]
pub struct AiEngine {
    _config: AiEngineConfig,
    event_sender: Arc<Mutex<Option<mpsc::SyncSender<AiRuntimeEvent>>>>,
    registry: RuntimeRegistry,
    history_messages: Arc<Mutex<HashMap<String, Vec<Value>>>>,
    history_store: Arc<Mutex<Option<AiHistoryStore>>>,
    runtime_setup_store: Arc<Mutex<Option<RuntimeSetupStore>>>,
    runtime: Arc<tokio::runtime::Runtime>,
    sessions: Arc<Mutex<SessionRegistry>>,
}

impl Default for AiEngine {
    fn default() -> Self {
        Self::new(AiEngineConfig::default())
    }
}

impl AiEngine {
    pub fn new(config: AiEngineConfig) -> Self {
        Self {
            _config: config,
            event_sender: Arc::new(Mutex::new(None)),
            registry: RuntimeRegistry::default(),
            history_messages: Arc::new(Mutex::new(HashMap::new())),
            history_store: Arc::new(Mutex::new(None)),
            runtime_setup_store: Arc::new(Mutex::new(None)),
            runtime: Arc::new(
                tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .thread_name("comando-ai-acp")
                    .build()
                    .expect("native AI Tokio runtime starts"),
            ),
            sessions: Arc::new(Mutex::new(SessionRegistry::default())),
        }
    }

    pub fn set_event_sender(&self, sender: mpsc::SyncSender<AiRuntimeEvent>) -> AiResult<()> {
        let mut event_sender = self
            .event_sender
            .lock()
            .map_err(|error| AiError::Internal(format!("AI event sender lock failed: {error}")))?;
        *event_sender = Some(sender);
        Ok(())
    }

    pub fn set_history_store(&self, store: Option<AiHistoryStore>) -> AiResult<()> {
        let mut history_store = self
            .history_store
            .lock()
            .map_err(|error| AiError::Internal(format!("AI history store lock failed: {error}")))?;
        *history_store = store;
        Ok(())
    }

    pub fn set_runtime_setup_store(&self, store: Option<RuntimeSetupStore>) -> AiResult<()> {
        let mut runtime_setup_store = self.runtime_setup_store.lock().map_err(|error| {
            AiError::Internal(format!("AI runtime setup store lock failed: {error}"))
        })?;
        *runtime_setup_store = store;
        Ok(())
    }

    pub fn list_runtimes(&self) -> NativeAiListRuntimesOutput {
        list_runtimes_output(self.registry.list())
    }

    pub fn get_runtime_status(
        &self,
        input: NativeAiGetRuntimeStatusInput,
    ) -> AiResult<NativeAiRuntimeStatus> {
        let runtime_id = input.runtime_id.0;
        if let Some(store) = self.runtime_setup_store()? {
            let definition = self.registry.get(&runtime_id)?;
            return runtime_status(&store, definition);
        }
        let launch_status = input.launch.map(|launch| launch.status);
        self.registry.status_from_launch(&runtime_id, launch_status)
    }

    pub fn prepare_auth_terminal_launch(
        &self,
        runtime_id: &str,
        method_id: &str,
    ) -> AiResult<RuntimeAuthTerminalLaunch> {
        let definition = self.registry.require_native(runtime_id)?;
        let store =
            self.runtime_setup_store()?
                .ok_or_else(|| AiError::RuntimeLaunchContextInvalid {
                    runtime_id: runtime_id.to_string(),
                    message: "Native runtime setup is not initialized.".to_string(),
                })?;
        prepare_auth_terminal_launch(&store, definition, method_id)
    }

    pub fn prepare_session(
        &self,
        input: NativeAiPrepareSessionInput,
    ) -> AiResult<NativeAiSessionSummary> {
        let definition = self.registry.require_native(&input.runtime_id.0)?;
        let resolved_launch = match input.launch.clone() {
            Some(launch) => launch,
            None => {
                let store = self.runtime_setup_store()?.ok_or_else(|| {
                    AiError::RuntimeLaunchContextInvalid {
                        runtime_id: input.runtime_id.0.clone(),
                        message: "Native runtime setup is not initialized.".to_string(),
                    }
                })?;
                prepare_runtime_launch(&store, definition, &input)?.launch
            }
        };
        let history_metadata =
            AiHistorySessionMetadata::new_native(AiHistorySessionMetadataInput {
                session_id: input.session_id.clone(),
                runtime_id: input.runtime_id.clone(),
                runtime_session_id: input
                    .launch
                    .as_ref()
                    .and_then(|launch| launch.persisted_runtime_session_id.clone())
                    .or_else(|| resolved_launch.persisted_runtime_session_id.clone()),
                parent_session_id: None,
                project_id: input.project_id.clone(),
                worktree_id: input.worktree_id.clone(),
                title: input.title.clone(),
                status: NativeAiSessionStatus::Idle,
                model_id: input.model_id.clone(),
                mode_id: input.mode_id.clone(),
                config_values: input.config_options.clone(),
                cwd: input.cwd.clone(),
                additional_roots: input.additional_roots.clone(),
            });

        let launch = resolved_launch;
        let runtime_id_for_invalidation = input.runtime_id.0.clone();
        let session = NativeAiSession::from_prepare_input(input)?;
        let mut sessions = self.lock_sessions()?;
        if let Ok(existing) = sessions.get_mut(&session.session_id) {
            if existing.session.runtime_id != session.runtime_id {
                return Err(AiError::SessionOwnerMismatch {
                    session_id: session.session_id.0,
                    owner: existing.session.runtime_id.0.clone(),
                    expected: session.runtime_id.0,
                });
            }
            existing.session.owner_window_id = session.owner_window_id;
            return Ok(prepare_session_output(existing.session.summary()));
        }
        let event_sender = self.event_sender()?;
        drop(sessions);
        let spec = AcpProcessSpec::from_launch(definition, &launch)?;
        let (session, controller) = match start_acp_session(
            &self.runtime,
            spec,
            session,
            Arc::clone(&self.sessions),
            event_sender,
        ) {
            Ok(result) => result,
            Err(error) => {
                self.invalidate_runtime_auth_on_error(
                    &runtime_id_for_invalidation,
                    &error.to_string(),
                );
                return Err(error);
            }
        };
        let mut sessions = self.lock_sessions()?;
        let summary = sessions.insert_with_acp_controller(session, controller)?;
        drop(sessions);
        let initial_history_messages = self.initialize_history_session(history_metadata)?;
        self.history_messages
            .lock()
            .map_err(|error| {
                AiError::Internal(format!("AI history messages lock failed: {error}"))
            })?
            .insert(summary.session_id.0.clone(), initial_history_messages);
        prepare_session_output(summary).pipe(Ok)
    }

    pub fn send_prompt(
        &self,
        input: NativeAiSendPromptInput,
    ) -> AiResult<(NativeAiSendPromptOutput, NativeAiSessionSummary)> {
        if input.prompt.text.trim().is_empty() && input.prompt.attachments.is_empty() {
            return Err(AiError::PromptRejected {
                session_id: input.session_id.0,
                message: "Type a prompt before sending it.".to_string(),
            });
        }
        if !input.prompt.attachments.is_empty() {
            return Err(AiError::Unsupported(
                "Native AI image attachments are not supported in this rollout yet.".to_string(),
            ));
        }

        let root_session_id = input.session_id.clone();
        let target_session_id = input
            .target_session_id
            .clone()
            .unwrap_or_else(|| root_session_id.clone());
        let mut sessions = self.lock_sessions()?;
        let session = sessions.get_mut(&root_session_id)?;
        if session.prompt_in_flight || session.session.status == NativeAiSessionStatus::Streaming {
            return Err(AiError::SessionBusy {
                session_id: target_session_id.0,
            });
        }
        let Some(controller) = session.acp_controller.clone() else {
            return Err(AiError::Unsupported(
                "Native prompts require an ACP-backed session.".to_string(),
            ));
        };

        session.prompt_in_flight = true;
        session.active_message_id = Some(input.message_id.0.clone());
        session.set_status(NativeAiSessionStatus::Streaming);
        let runtime_session_id = input
            .runtime_session_id
            .clone()
            .or_else(|| session.session.runtime_session_id.clone())
            .ok_or_else(|| {
                AiError::Unsupported("Native prompts require an ACP runtime session.".to_string())
            })?;
        if let Err(error) = controller.send_prompt(
            runtime_session_id.clone(),
            target_session_id.clone(),
            input.message_id.clone(),
            input.prompt.text.clone(),
        ) {
            session.prompt_in_flight = false;
            session.active_message_id = None;
            session.set_status(NativeAiSessionStatus::Error);
            return Err(error);
        }
        let mut summary = session.session.summary();
        if target_session_id != root_session_id {
            summary.session_id = target_session_id.clone();
            summary.runtime_session_id = Some(runtime_session_id);
            summary.status = NativeAiSessionStatus::Streaming;
        }
        drop(sessions);
        self.update_history_status(&summary)?;
        self.push_history_user_message(
            &target_session_id,
            &input.message_id.0,
            &input.prompt.text,
        )?;
        Ok((send_prompt_output(target_session_id), summary))
    }

    pub fn cancel_session(
        &self,
        input: NativeAiSessionIdInput,
    ) -> AiResult<(NativeAiCancelSessionOutput, NativeAiSessionSummary)> {
        let root_session_id = input.session_id.clone();
        let target_session_id = input
            .target_session_id
            .clone()
            .unwrap_or_else(|| root_session_id.clone());
        let target_is_root = target_session_id == root_session_id;
        let mut sessions = self.lock_sessions()?;
        let session = sessions.get_mut(&root_session_id)?;
        if target_is_root {
            session.prompt_in_flight = false;
            session.active_message_id = None;
        }
        let runtime_session_id = input
            .runtime_session_id
            .clone()
            .or_else(|| session.session.runtime_session_id.clone());
        if let (Some(controller), Some(runtime_session_id)) =
            (session.acp_controller.clone(), runtime_session_id.clone())
        {
            if target_is_root {
                controller.cancel_pending_requests();
            } else {
                controller
                    .cancel_pending_requests_for_target(&runtime_session_id, &target_session_id);
            }
            controller.cancel(runtime_session_id)?;
        }
        if target_is_root {
            session.set_status(NativeAiSessionStatus::Idle);
        }
        let mut summary = session.session.summary();
        if !target_is_root {
            summary.session_id = target_session_id.clone();
            summary.runtime_session_id = runtime_session_id;
            summary.status = NativeAiSessionStatus::Idle;
        }
        drop(sessions);
        self.update_history_status(&summary)?;
        Ok((cancel_session_output(target_session_id), summary))
    }

    pub fn close_session(
        &self,
        input: NativeAiSessionIdInput,
    ) -> AiResult<(NativeAiCloseSessionOutput, NativeAiSessionSummary)> {
        let mut sessions = self.lock_sessions()?;
        let mut session = sessions.close(&input.session_id)?;
        if let Some(controller) = session.acp_controller.take() {
            controller.close();
        }
        session.prompt_in_flight = false;
        session.active_message_id = None;
        session.set_status(NativeAiSessionStatus::Closed);
        let summary = session.session.summary();
        drop(sessions);
        self.update_history_status(&summary)?;
        Ok((close_session_output(input.session_id), summary))
    }

    pub fn set_session_mode(&self, input: NativeAiSetSessionModeInput) -> AiResult<()> {
        self.set_session_config_value(
            &input.session_id,
            input.runtime_session_id,
            "mode".to_string(),
            NativeAiConfigValue::ValueId(input.mode_id),
        )
    }

    pub fn set_session_model(&self, input: NativeAiSetSessionModelInput) -> AiResult<()> {
        self.set_session_config_value(
            &input.session_id,
            input.runtime_session_id,
            "model".to_string(),
            NativeAiConfigValue::ValueId(input.model_id),
        )
    }

    pub fn set_session_config_option(
        &self,
        input: NativeAiSetSessionConfigOptionInput,
    ) -> AiResult<()> {
        let value = native_config_value(input.value)?;
        self.set_session_config_value(
            &input.session_id,
            input.runtime_session_id,
            input.option_id,
            value,
        )
    }

    pub fn respond_permission(&self, input: NativeAiPermissionResponseInput) -> AiResult<()> {
        let controller = self
            .lock_sessions()?
            .get(&input.session_id)?
            .acp_controller
            .clone()
            .ok_or_else(|| {
                AiError::Unsupported(
                    "Native permission responses require an ACP-backed session.".to_string(),
                )
            })?;
        controller.respond_permission(input)
    }

    pub fn respond_user_input(&self, input: NativeAiUserInputResponseInput) -> AiResult<()> {
        let controller = self
            .lock_sessions()?
            .get(&input.session_id)?
            .acp_controller
            .clone()
            .ok_or_else(|| {
                AiError::Unsupported(
                    "Native user input responses require an ACP-backed session.".to_string(),
                )
            })?;
        controller.respond_user_input(input)
    }

    pub fn rename_session(
        &self,
        input: comando_types::ai::NativeAiRenameSessionInput,
    ) -> AiResult<()> {
        if let Ok(mut sessions) = self.lock_sessions()
            && let Ok(session) = sessions.get_mut(&input.session_id)
        {
            session.session.title = input.title.clone();
            session.session.updated_at = now_iso8601();
        }
        if let Some(store) = self.history_store()? {
            if store.has_session(&input.session_id) {
                store.rename_session(&input.session_id, input.title)?;
            }
        }
        Ok(())
    }

    pub fn record_history_event(&self, event: &AiRuntimeEvent) -> AiResult<()> {
        match event.event_name.as_str() {
            AI_MESSAGE_STARTED_EVENT | AI_THINKING_STARTED_EVENT => {
                self.record_history_message_started(&event.payload)
            }
            AI_MESSAGE_DELTA_EVENT | AI_THINKING_DELTA_EVENT => {
                self.record_history_message_delta(&event.payload)
            }
            AI_MESSAGE_COMPLETED_EVENT | AI_THINKING_COMPLETED_EVENT => {
                self.record_history_message_completed(&event.payload)
            }
            AI_SESSION_CATALOG_UPDATED_EVENT => self.record_history_catalog_updated(&event.payload),
            AI_TOOL_ACTIVITY_EVENT | AI_STATUS_EVENT => {
                self.record_history_tool_activity(&event.payload, event.event_name.as_str())
            }
            AI_PLAN_UPDATED_EVENT => self.record_history_plan_updated(&event.payload),
            AI_PERMISSION_REQUEST_EVENT => self.record_history_permission_request(&event.payload),
            AI_USER_INPUT_REQUEST_EVENT => self.record_history_user_input_request(&event.payload),
            AI_TOKEN_USAGE_EVENT => self.record_history_token_usage(&event.payload),
            AI_SUBAGENT_CREATED_EVENT => self.record_history_subagent_created(&event.payload),
            AI_SUBAGENT_BREADCRUMB_EVENT => self.record_history_subagent_breadcrumb(&event.payload),
            AI_SESSION_UPDATED_EVENT | AI_SESSION_CLOSED_EVENT => {
                self.record_history_session_status(&event.payload)
            }
            AI_ERROR_EVENT => self.record_history_error(&event.payload),
            _ => Ok(()),
        }
    }

    pub fn close_owned_by_window(
        &self,
        owner_window_id: &str,
    ) -> AiResult<Vec<NativeAiSessionSummary>> {
        let mut sessions = self.lock_sessions()?;
        Ok(sessions
            .close_owned_by_window(owner_window_id)
            .into_iter()
            .map(|mut session| {
                if let Some(controller) = session.acp_controller.take() {
                    controller.close();
                }
                session.session.summary()
            })
            .collect())
    }

    pub fn session_for_review(
        &self,
        session_id: &comando_types::ids::SessionId,
    ) -> AiResult<crate::session::NativeAiSession> {
        Ok(self.lock_sessions()?.get(session_id)?.session.clone())
    }

    fn set_session_config_value(
        &self,
        session_id: &comando_types::ids::SessionId,
        runtime_session_id: Option<RuntimeSessionId>,
        config_id: String,
        value: NativeAiConfigValue,
    ) -> AiResult<()> {
        let session = self.lock_sessions()?.get(session_id)?.session.clone();
        let runtime_session_id = runtime_session_id
            .or_else(|| session.runtime_session_id.clone())
            .ok_or_else(|| {
                AiError::Unsupported(
                    "Native config changes require an ACP-backed session.".to_string(),
                )
            })?;
        let controller = self
            .lock_sessions()?
            .get(session_id)?
            .acp_controller
            .clone()
            .ok_or_else(|| {
                AiError::Unsupported(
                    "Native config changes require an ACP-backed session.".to_string(),
                )
            })?;
        controller.set_config_option(runtime_session_id, config_id, value)?;
        self.update_history_status(&session.summary())
    }

    fn lock_sessions(&self) -> AiResult<std::sync::MutexGuard<'_, SessionRegistry>> {
        self.sessions
            .lock()
            .map_err(|error| AiError::Internal(format!("AI session registry lock failed: {error}")))
    }

    fn event_sender(&self) -> AiResult<Option<mpsc::SyncSender<AiRuntimeEvent>>> {
        self.event_sender
            .lock()
            .map(|sender| sender.clone())
            .map_err(|error| AiError::Internal(format!("AI event sender lock failed: {error}")))
    }

    fn history_store(&self) -> AiResult<Option<AiHistoryStore>> {
        Ok(self
            .history_store
            .lock()
            .map_err(|error| AiError::Internal(format!("AI history store lock failed: {error}")))?
            .clone())
    }

    fn runtime_setup_store(&self) -> AiResult<Option<RuntimeSetupStore>> {
        Ok(self
            .runtime_setup_store
            .lock()
            .map_err(|error| {
                AiError::Internal(format!("AI runtime setup store lock failed: {error}"))
            })?
            .clone())
    }

    fn invalidate_runtime_auth_on_error(&self, runtime_id: &str, message: &str) {
        if runtime_id != "grok" {
            return;
        }
        let Ok(Some(store)) = self.runtime_setup_store() else {
            return;
        };
        let _ = invalidate_grok_auth_on_error(&store, message);
    }

    fn initialize_history_session(
        &self,
        metadata: AiHistorySessionMetadata,
    ) -> AiResult<Vec<Value>> {
        let Some(store) = self.history_store()? else {
            return Ok(Vec::new());
        };
        if !store.has_session(&metadata.session_id) {
            store.create_session(metadata)?;
            return Ok(Vec::new());
        }

        let snapshot = store.load_session_snapshot(&metadata.session_id)?;
        let mut current = store.load_metadata(&metadata.session_id)?;
        current.runtime_id = metadata.runtime_id;
        current.runtime_session_id = metadata.runtime_session_id.or(current.runtime_session_id);
        current.parent_session_id = metadata.parent_session_id;
        current.project_id = metadata.project_id;
        current.worktree_id = metadata.worktree_id;
        current.title = metadata.title;
        current.status = metadata.status;
        current.model_id = metadata.model_id;
        current.mode_id = metadata.mode_id;
        current.config_values = metadata.config_values;
        current.cwd = metadata.cwd;
        current.additional_roots = metadata.additional_roots;
        current.updated_at = now_iso8601();
        store.save_metadata(&current)?;
        Ok(snapshot
            .map(|snapshot| snapshot.messages)
            .unwrap_or_default())
    }

    fn update_history_status(&self, summary: &NativeAiSessionSummary) -> AiResult<()> {
        if let Some(store) = self.history_store()? {
            if store.has_session(&summary.session_id) {
                let mut metadata = store.load_metadata(&summary.session_id)?;
                metadata.runtime_session_id = summary.runtime_session_id.clone();
                metadata.status = summary.status.clone();
                metadata.title = summary.title.clone();
                metadata.updated_at = summary.updated_at.clone();
                if summary.status == NativeAiSessionStatus::Closed {
                    metadata.closed_at = Some(summary.updated_at.clone());
                }
                store.save_metadata(&metadata)?;
            }
        }
        Ok(())
    }

    fn flush_history_messages(&self, session_id: &comando_types::ids::SessionId) -> AiResult<()> {
        let Some(store) = self.history_store()? else {
            return Ok(());
        };
        if !store.has_session(session_id) {
            return Ok(());
        }
        let messages = self
            .history_messages
            .lock()
            .map_err(|error| {
                AiError::Internal(format!("AI history messages lock failed: {error}"))
            })?
            .get(&session_id.0)
            .cloned()
            .unwrap_or_default();
        store.save_transcript_window(session_id, messages)
    }

    fn push_history_user_message(
        &self,
        session_id: &comando_types::ids::SessionId,
        message_id: &str,
        content: &str,
    ) -> AiResult<()> {
        let message = json!({
            "attachments": [],
            "content": content,
            "createdAt": now_iso8601(),
            "id": message_id,
            "kind": "user",
            "status": "completed"
        });
        self.history_messages
            .lock()
            .map_err(|error| {
                AiError::Internal(format!("AI history messages lock failed: {error}"))
            })?
            .entry(session_id.0.clone())
            .or_default()
            .push(message);
        self.flush_history_messages(session_id)
    }

    fn record_history_message_started(&self, payload: &Value) -> AiResult<()> {
        let Some((session_id, message_id, message_kind, updated_at)) =
            history_message_identity(payload)
        else {
            return Ok(());
        };
        let content = payload
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut messages = self.history_messages.lock().map_err(|error| {
            AiError::Internal(format!("AI history messages lock failed: {error}"))
        })?;
        upsert_history_message(
            messages.entry(session_id.0.clone()).or_default(),
            json!({
                "attachments": [],
                "content": content,
                "createdAt": updated_at,
                "id": message_id,
                "kind": message_kind,
                "status": "streaming"
            }),
        );
        drop(messages);
        self.flush_history_messages(&session_id)
    }

    fn record_history_message_delta(&self, payload: &Value) -> AiResult<()> {
        let Some((session_id, message_id, message_kind, updated_at)) =
            history_message_identity(payload)
        else {
            return Ok(());
        };
        let content = payload
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut messages = self.history_messages.lock().map_err(|error| {
            AiError::Internal(format!("AI history messages lock failed: {error}"))
        })?;
        upsert_history_message(
            messages.entry(session_id.0.clone()).or_default(),
            json!({
                "attachments": [],
                "content": content,
                "createdAt": updated_at,
                "id": message_id,
                "kind": message_kind,
                "status": "streaming"
            }),
        );
        drop(messages);
        self.flush_history_messages(&session_id)
    }

    fn record_history_message_completed(&self, payload: &Value) -> AiResult<()> {
        let Some((session_id, message_id, message_kind, updated_at)) =
            history_message_identity(payload)
        else {
            return Ok(());
        };
        let mut messages = self.history_messages.lock().map_err(|error| {
            AiError::Internal(format!("AI history messages lock failed: {error}"))
        })?;
        let target = messages
            .entry(session_id.0.clone())
            .or_default()
            .iter_mut()
            .find(|message| message.get("id").and_then(Value::as_str) == Some(message_id.as_str()));
        if let Some(message) = target {
            if let Some(object) = message.as_object_mut() {
                object.insert("status".to_string(), Value::String("completed".to_string()));
            }
        } else {
            messages
                .entry(session_id.0.clone())
                .or_default()
                .push(json!({
                    "attachments": [],
                    "content": "",
                    "createdAt": updated_at,
                    "id": message_id,
                    "kind": message_kind,
                    "status": "completed"
                }));
        }
        drop(messages);
        self.flush_history_messages(&session_id)
    }

    fn record_history_catalog_updated(&self, payload: &Value) -> AiResult<()> {
        let Some(session_id) = payload_session_id(payload) else {
            return Ok(());
        };
        let Some(store) = self.history_store()? else {
            return Ok(());
        };
        if !store.has_session(&session_id) {
            return Ok(());
        }
        let mut metadata = store.load_metadata(&session_id)?;
        if let Some(commands) = payload.get("availableCommands").and_then(Value::as_array) {
            metadata.available_commands = commands
                .iter()
                .filter_map(native_available_command_to_ipc)
                .collect();
        }
        if let Some(config_options) = payload.get("configOptions").and_then(Value::as_array) {
            metadata.config_options = config_options
                .iter()
                .filter_map(native_config_option_to_ipc)
                .collect();
        }
        metadata.updated_at = payload
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or(&metadata.updated_at)
            .to_string();
        store.save_metadata(&metadata)
    }

    fn record_history_tool_activity(&self, payload: &Value, event_name: &str) -> AiResult<()> {
        let Some(session_id) = payload_session_id(payload) else {
            return Ok(());
        };
        let activity = if event_name == AI_STATUS_EVENT {
            let Some(event_id) = payload.get("eventId").and_then(Value::as_str) else {
                return Ok(());
            };
            let updated_at = payload
                .get("updatedAt")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(now_iso8601);
            json!({
                "action": null,
                "createdAt": updated_at,
                "diffs": [],
                "exitCode": null,
                "id": event_id,
                "kind": "status",
                "locations": [],
                "rawInputJson": null,
                "rawOutputJson": null,
                "sessionId": session_id.0,
                "status": payload.get("status").and_then(Value::as_str).unwrap_or("pending"),
                "summary": payload.get("detail").cloned().unwrap_or(Value::Null),
                "terminalOutput": null,
                "title": payload.get("title").and_then(Value::as_str).unwrap_or("Status"),
                "updatedAt": updated_at
            })
        } else {
            let Some(tool_call_id) = payload.get("toolCallId").and_then(Value::as_str) else {
                return Ok(());
            };
            let updated_at = payload
                .get("updatedAt")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(now_iso8601);
            json!({
                "action": null,
                "createdAt": updated_at,
                "diffs": payload.get("diffs").cloned().unwrap_or_else(|| json!([])),
                "exitCode": null,
                "id": tool_call_id,
                "kind": payload.get("kind").and_then(Value::as_str).unwrap_or("tool"),
                "locations": [],
                "rawInputJson": null,
                "rawOutputJson": null,
                "sessionId": session_id.0,
                "status": payload.get("status").and_then(Value::as_str).unwrap_or("pending"),
                "summary": payload.get("summary").cloned().unwrap_or(Value::Null),
                "terminalOutput": null,
                "title": payload.get("title").and_then(Value::as_str).unwrap_or("Tool"),
                "updatedAt": updated_at
            })
        };
        if let Some(store) = self.history_store()? {
            store.update_session_state(&session_id, |state| {
                upsert_state_activity(&mut state.tool_activity, activity);
            })?;
        }
        Ok(())
    }

    fn record_history_plan_updated(&self, payload: &Value) -> AiResult<()> {
        let Some(session_id) = payload_session_id(payload) else {
            return Ok(());
        };
        let updated_at = payload
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(now_iso8601);
        let entries = payload
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let plan = json!({
            "entries": entries,
            "title": payload.get("title").cloned().unwrap_or(Value::Null),
            "updatedAt": updated_at
        });
        if let Some(store) = self.history_store()? {
            store.update_session_state(&session_id, |state| {
                state.plan = Some(plan);
            })?;
        }
        Ok(())
    }

    fn record_history_permission_request(&self, payload: &Value) -> AiResult<()> {
        let Some(session_id) = payload_session_id(payload) else {
            return Ok(());
        };
        let Some(request_id) = payload.get("requestId").and_then(Value::as_str) else {
            return Ok(());
        };
        let updated_at = payload
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(now_iso8601);
        let options = payload
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let request = json!({
            "description": payload.get("description").cloned().unwrap_or(Value::Null),
            "options": options,
            "requestId": request_id,
            "sessionId": session_id.0,
            "title": payload.get("title").and_then(Value::as_str).unwrap_or("Permission required"),
            "toolCallId": payload.get("toolCallId").and_then(Value::as_str).unwrap_or_default(),
            "updatedAt": updated_at
        });
        if let Some(store) = self.history_store()? {
            store.update_session_state(&session_id, |state| {
                state.pending_permission = Some(request);
                state.pending_user_input = None;
            })?;
        }
        Ok(())
    }

    fn record_history_user_input_request(&self, payload: &Value) -> AiResult<()> {
        let Some(session_id) = payload_session_id(payload) else {
            return Ok(());
        };
        let Some(request_id) = payload.get("requestId").and_then(Value::as_str) else {
            return Ok(());
        };
        let updated_at = payload
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(now_iso8601);
        let questions = payload
            .get("questions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let request = json!({
            "questions": questions,
            "requestId": request_id,
            "sessionId": session_id.0,
            "title": payload.get("title").and_then(Value::as_str).unwrap_or("Input required"),
            "toolCallId": payload.get("toolCallId").and_then(Value::as_str).unwrap_or_default(),
            "turnId": payload.get("turnId").cloned().unwrap_or(Value::Null),
            "updatedAt": updated_at
        });
        if let Some(store) = self.history_store()? {
            store.update_session_state(&session_id, |state| {
                state.pending_permission = None;
                state.pending_user_input = Some(request);
            })?;
        }
        Ok(())
    }

    fn record_history_token_usage(&self, payload: &Value) -> AiResult<()> {
        let Some(session_id) = payload_session_id(payload) else {
            return Ok(());
        };
        let updated_at = payload
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(now_iso8601);
        let token_usage = json!({
            "cost": payload.get("cost").cloned().unwrap_or(Value::Null),
            "size": payload.get("size").and_then(Value::as_u64).unwrap_or(0),
            "updatedAt": updated_at,
            "used": payload.get("used").and_then(Value::as_u64).unwrap_or(0)
        });
        if let Some(store) = self.history_store()? {
            store.update_session_state(&session_id, |state| {
                state.token_usage = Some(token_usage);
            })?;
        }
        Ok(())
    }

    fn record_history_subagent_breadcrumb(&self, payload: &Value) -> AiResult<()> {
        let Some(session_id) = payload_session_id(payload) else {
            return Ok(());
        };
        let Some(tool_call_id) = payload.get("toolCallId").and_then(Value::as_str) else {
            return Ok(());
        };
        let Some(child_session_id) = payload.get("childSessionId").and_then(Value::as_str) else {
            return Ok(());
        };
        if let Some(store) = self.history_store()? {
            store.update_session_state(&session_id, |state| {
                if let Some(activity) = state.tool_activity.iter_mut().find(|activity| {
                    activity.get("id").and_then(Value::as_str) == Some(tool_call_id)
                }) && let Some(object) = activity.as_object_mut()
                {
                    object.insert(
                        "action".to_string(),
                        json!({
                            "kind": "open_session",
                            "sessionId": child_session_id
                        }),
                    );
                }
            })?;
        }
        Ok(())
    }

    fn record_history_subagent_created(&self, payload: &Value) -> AiResult<()> {
        let Some(store) = self.history_store()? else {
            return Ok(());
        };
        let Some(child_session_id) = payload.get("childSessionId").and_then(Value::as_str) else {
            return Ok(());
        };
        let parent_session_id = payload
            .get("parentSessionId")
            .and_then(Value::as_str)
            .map(|value| comando_types::ids::SessionId(value.to_string()));
        let session_id = comando_types::ids::SessionId(child_session_id.to_string());
        if store.has_session(&session_id) {
            return Ok(());
        }
        let runtime_id = payload
            .get("runtimeId")
            .and_then(Value::as_str)
            .unwrap_or("codex");
        let title = payload
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Subagent");
        let parent_metadata = parent_session_id
            .as_ref()
            .and_then(|parent_session_id| store.load_metadata(parent_session_id).ok());
        let mut metadata = AiHistorySessionMetadata::new_native(AiHistorySessionMetadataInput {
            session_id: session_id.clone(),
            runtime_id: comando_types::ids::RuntimeId(runtime_id.to_string()),
            runtime_session_id: payload
                .get("childRuntimeSessionId")
                .and_then(Value::as_str)
                .map(|value| comando_types::ids::RuntimeSessionId(value.to_string())),
            parent_session_id: parent_session_id.clone(),
            project_id: parent_metadata
                .as_ref()
                .and_then(|metadata| metadata.project_id.clone()),
            worktree_id: parent_metadata
                .as_ref()
                .and_then(|metadata| metadata.worktree_id.clone()),
            title: title.to_string(),
            status: NativeAiSessionStatus::Idle,
            model_id: parent_metadata
                .as_ref()
                .and_then(|metadata| metadata.model_id.clone()),
            mode_id: parent_metadata
                .as_ref()
                .and_then(|metadata| metadata.mode_id.clone()),
            config_values: parent_metadata
                .as_ref()
                .map(|metadata| metadata.config_values.clone())
                .unwrap_or_default(),
            cwd: parent_metadata
                .as_ref()
                .and_then(|metadata| metadata.cwd.clone())
                .unwrap_or_default(),
            additional_roots: parent_metadata
                .as_ref()
                .map(|metadata| metadata.additional_roots.clone())
                .unwrap_or_default(),
        });
        if let Some(parent_session_id) = parent_session_id {
            metadata.subagent = Some(AiHistorySubagentMetadata {
                parent_session_id,
                parent_runtime_session_id: payload
                    .get("parentRuntimeSessionId")
                    .and_then(Value::as_str)
                    .map(|value| comando_types::ids::RuntimeSessionId(value.to_string())),
                nickname: Some(title.to_string()),
            });
        }
        store.create_session(metadata)?;
        self.history_messages
            .lock()
            .map_err(|error| {
                AiError::Internal(format!("AI history messages lock failed: {error}"))
            })?
            .entry(session_id.0)
            .or_default();
        Ok(())
    }

    fn record_history_session_status(&self, payload: &Value) -> AiResult<()> {
        let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) else {
            return Ok(());
        };
        if let Some(store) = self.history_store()? {
            let session_id = comando_types::ids::SessionId(session_id.to_string());
            if store.has_session(&session_id) {
                let mut metadata = store.load_metadata(&session_id)?;
                let updated_at = payload
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .unwrap_or(&metadata.updated_at)
                    .to_string();
                if let Some(status) = payload.get("status").and_then(Value::as_str) {
                    metadata.status = native_status_from_event(status);
                }
                if let Some(title) = payload.get("title").and_then(Value::as_str) {
                    metadata.title = title.to_string();
                }
                if let Some(runtime_session_id) =
                    payload.get("runtimeSessionId").and_then(Value::as_str)
                {
                    metadata.runtime_session_id = Some(comando_types::ids::RuntimeSessionId(
                        runtime_session_id.to_string(),
                    ));
                }
                metadata.updated_at = updated_at.clone();
                if metadata.status == NativeAiSessionStatus::Closed {
                    metadata.closed_at = Some(updated_at.clone());
                }
                store.save_metadata(&metadata)?;
                store.update_session_state(&session_id, |state| {
                    state.active_turn_started_at = (metadata.status
                        == NativeAiSessionStatus::Streaming)
                        .then(|| updated_at.clone());
                    if metadata.status != NativeAiSessionStatus::WaitingPermission {
                        state.pending_permission = None;
                    }
                    if metadata.status != NativeAiSessionStatus::WaitingUserInput {
                        state.pending_user_input = None;
                    }
                    state.last_error = (metadata.status == NativeAiSessionStatus::Error)
                        .then(|| "Native AI session failed.".to_string());
                })?;
            }
        }
        Ok(())
    }

    fn record_history_error(&self, payload: &Value) -> AiResult<()> {
        let Some(session_id) = payload_session_id(payload) else {
            return Ok(());
        };
        if let Some(store) = self.history_store()? {
            if store.has_session(&session_id) {
                let mut metadata = store.load_metadata(&session_id)?;
                metadata.status = NativeAiSessionStatus::Error;
                metadata.updated_at = payload
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .unwrap_or(&metadata.updated_at)
                    .to_string();
                store.save_metadata(&metadata)?;
                let message = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Native AI session failed.")
                    .to_string();
                store.update_session_state(&session_id, |state| {
                    state.active_turn_started_at = None;
                    state.last_error = Some(message);
                    state.pending_permission = None;
                    state.pending_user_input = None;
                })?;
            }
        }
        Ok(())
    }
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}

impl<T> Pipe for T {}

fn history_message_identity(
    payload: &Value,
) -> Option<(comando_types::ids::SessionId, String, String, String)> {
    Some((
        comando_types::ids::SessionId(payload.get("sessionId")?.as_str()?.to_string()),
        payload.get("messageId")?.as_str()?.to_string(),
        payload
            .get("messageKind")
            .and_then(Value::as_str)
            .unwrap_or("assistant")
            .to_string(),
        payload
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(now_iso8601),
    ))
}

fn payload_session_id(payload: &Value) -> Option<comando_types::ids::SessionId> {
    payload
        .get("sessionId")
        .and_then(Value::as_str)
        .map(|value| comando_types::ids::SessionId(value.to_string()))
}

fn upsert_history_message(messages: &mut Vec<Value>, next: Value) {
    let Some(message_id) = next.get("id").and_then(Value::as_str) else {
        return;
    };
    if let Some(current) = messages
        .iter_mut()
        .find(|message| message.get("id").and_then(Value::as_str) == Some(message_id))
    {
        *current = next;
    } else {
        messages.push(next);
    }
}

fn upsert_state_activity(activities: &mut Vec<Value>, next: Value) {
    let Some(activity_id) = next.get("id").and_then(Value::as_str) else {
        return;
    };
    if let Some(current) = activities
        .iter_mut()
        .find(|activity| activity.get("id").and_then(Value::as_str) == Some(activity_id))
    {
        let created_at = current
            .get("createdAt")
            .cloned()
            .or_else(|| next.get("createdAt").cloned());
        let existing_diffs = current.get("diffs").cloned();
        let next_has_diffs = next
            .get("diffs")
            .and_then(Value::as_array)
            .is_some_and(|diffs| !diffs.is_empty());
        *current = next;
        if let (Some(created_at), Some(object)) = (created_at, current.as_object_mut()) {
            object.insert("createdAt".to_string(), created_at);
            if !next_has_diffs
                && let Some(existing_diffs) = existing_diffs
                && existing_diffs
                    .as_array()
                    .is_some_and(|diffs| !diffs.is_empty())
            {
                object.insert("diffs".to_string(), existing_diffs);
            }
        }
    } else {
        activities.push(next);
    }
}

fn native_available_command_to_ipc(command: &Value) -> Option<Value> {
    let name = command.get("name").and_then(Value::as_str)?;
    Some(json!({
        "description": command.get("description").and_then(Value::as_str).unwrap_or_default(),
        "id": name,
        "insertText": format!("/{name} "),
        "label": format!("/{name}")
    }))
}

fn native_config_option_to_ipc(option: &Value) -> Option<Value> {
    let id = option.get("id").and_then(Value::as_str)?;
    let label = option.get("name").and_then(Value::as_str).unwrap_or(id);
    let category = native_config_category(
        option
            .get("category")
            .and_then(Value::as_str)
            .unwrap_or("other"),
    );
    let description = option.get("description").cloned().unwrap_or(Value::Null);
    match option.get("type").and_then(Value::as_str) {
        Some("boolean") => Some(json!({
            "category": category,
            "description": description,
            "id": id,
            "label": label,
            "type": "boolean",
            "value": option.get("currentValue").and_then(Value::as_bool).unwrap_or(false)
        })),
        Some("select") => Some(json!({
            "category": category,
            "description": description,
            "id": id,
            "label": label,
            "options": option
                .get("options")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(native_config_select_entry_to_ipc)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
            "type": "select",
            "value": option
                .get("currentValue")
                .and_then(Value::as_str)
                .unwrap_or_default()
        })),
        _ => None,
    }
}

fn native_config_select_entry_to_ipc(entry: &Value) -> Option<Value> {
    let value = entry.get("value").and_then(Value::as_str)?;
    Some(json!({
        "description": entry.get("description").cloned().unwrap_or(Value::Null),
        "groupLabel": entry.get("groupLabel").cloned().unwrap_or(Value::Null),
        "label": entry.get("name").and_then(Value::as_str).unwrap_or(value),
        "value": value
    }))
}

fn native_config_category(category: &str) -> String {
    match category {
        "mode" | "model" => category.to_string(),
        "thought_level" | "effort" => "reasoning".to_string(),
        _ => "other".to_string(),
    }
}

fn native_status_from_event(status: &str) -> NativeAiSessionStatus {
    match status {
        "streaming" => NativeAiSessionStatus::Streaming,
        "waiting_permission" => NativeAiSessionStatus::WaitingPermission,
        "waiting_user_input" => NativeAiSessionStatus::WaitingUserInput,
        "review_required" => NativeAiSessionStatus::ReviewRequired,
        "error" => NativeAiSessionStatus::Error,
        "closed" => NativeAiSessionStatus::Closed,
        _ => NativeAiSessionStatus::Idle,
    }
}

fn native_config_value(value: serde_json::Value) -> AiResult<NativeAiConfigValue> {
    match value {
        serde_json::Value::Bool(value) => Ok(NativeAiConfigValue::Boolean(value)),
        serde_json::Value::String(value) if !value.trim().is_empty() => {
            Ok(NativeAiConfigValue::ValueId(value))
        }
        _ => Err(AiError::Unsupported(
            "Native config changes only support boolean and select values.".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use comando_types::ai::{NativeAiDesiredSelections, NativeAiLaunchSpec, NativeAiRuntimeStatus};
    use comando_types::ids::{RuntimeId, SessionId};

    fn prepare_input(session_id: &str, runtime_id: &str) -> NativeAiPrepareSessionInput {
        NativeAiPrepareSessionInput {
            window_id: "window_main".to_string(),
            session_id: SessionId(session_id.to_string()),
            runtime_id: RuntimeId(runtime_id.to_string()),
            project_id: None,
            worktree_id: None,
            cwd: "/tmp".to_string(),
            title: "AI Session".to_string(),
            model_id: None,
            mode_id: None,
            config_options: Default::default(),
            additional_roots: Vec::new(),
            persisted_runtime_session_id: None,
            persisted_subagent_session_mappings: Vec::new(),
            launch: None,
        }
    }

    fn prepare_input_with_launch(
        session_id: &str,
        runtime_id: &str,
    ) -> NativeAiPrepareSessionInput {
        let mut input = prepare_input(session_id, runtime_id);
        input.launch = Some(NativeAiLaunchSpec {
            runtime_id: RuntimeId(runtime_id.to_string()),
            owner_window_id: "window_main".to_string(),
            project_id: None,
            worktree_id: None,
            project_root: None,
            additional_roots: Vec::new(),
            executable: "opencode".to_string(),
            args: vec!["acp".to_string()],
            cwd: "/tmp".to_string(),
            env: BTreeMap::new(),
            command: "opencode acp".to_string(),
            status: NativeAiRuntimeStatus {
                runtime_id: RuntimeId(runtime_id.to_string()),
                state: "ready".to_string(),
                auth_method: None,
                auth_methods: Vec::new(),
                auth_ready: true,
                auth_credential_source: None,
                auth_credential_source_label: None,
                auth_session_message: None,
                auth_storage_message: None,
                can_disconnect_auth: false,
                can_logout_auth: false,
                checked_at: "2026-06-21T00:00:00.000Z".to_string(),
                command: Some("opencode acp".to_string()),
                available_commands: Vec::new(),
                config_options: Vec::new(),
                message: None,
                mode_id: None,
                modes: Vec::new(),
                model_id: None,
                models: Vec::new(),
                onboarding_required: false,
                source: Some("test".to_string()),
                has_custom_binary_path: false,
                has_gateway_config: false,
                has_gateway_url: false,
            },
            auth_method: None,
            auth_credential_source: None,
            auth_handshake: None,
            persisted_runtime_session_id: None,
            persisted_subagent_session_mappings: Vec::new(),
            desired_selections: NativeAiDesiredSelections {
                model_id: None,
                mode_id: None,
                config_options: BTreeMap::new(),
            },
        });
        input
    }

    #[test]
    fn rejects_missing_launch_before_session_creation() {
        let engine = AiEngine::default();

        assert!(matches!(
            engine.prepare_session(prepare_input("s1", "opencode")),
            Err(AiError::RuntimeLaunchContextInvalid { .. })
        ));
    }

    #[test]
    fn rejects_unknown_runtime_before_session_creation() {
        let engine = AiEngine::default();

        assert!(matches!(
            engine.prepare_session(prepare_input("s1", "gemini")),
            Err(AiError::RuntimeMissing { .. })
        ));
    }

    #[test]
    fn prepare_existing_native_session_returns_live_summary() {
        let engine = AiEngine::default();
        {
            let mut sessions = engine.lock_sessions().unwrap();
            sessions
                .insert(
                    NativeAiSession::from_prepare_input(prepare_input("s1", "opencode")).unwrap(),
                )
                .unwrap();
        }

        let summary = engine
            .prepare_session(prepare_input_with_launch("s1", "opencode"))
            .unwrap();

        assert_eq!(summary.session_id, SessionId("s1".to_string()));
        assert_eq!(summary.runtime_id, RuntimeId("opencode".to_string()));
    }

    #[test]
    fn prompt_requires_acp_backed_session() {
        let engine = AiEngine::default();
        {
            let mut sessions = engine.lock_sessions().unwrap();
            sessions
                .insert(
                    NativeAiSession::from_prepare_input(prepare_input("s1", "opencode")).unwrap(),
                )
                .unwrap();
        }
        let input = NativeAiSendPromptInput {
            session_id: SessionId("s1".to_string()),
            target_session_id: None,
            runtime_session_id: None,
            message_id: comando_types::ids::MessageId("m1".to_string()),
            prompt: comando_types::ai::NativeAiPromptInput {
                text: "hello".to_string(),
                attachments: Vec::new(),
            },
        };

        assert!(matches!(
            engine.send_prompt(input),
            Err(AiError::Unsupported(_))
        ));
    }
}
