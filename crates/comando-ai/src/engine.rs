use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, mpsc};

use comando_settings::RuntimeSetupStore;
use comando_types::ai::{
    NativeAiCancelSessionOutput, NativeAiCloseSessionOutput, NativeAiGetRuntimeStatusInput,
    NativeAiImageAttachment, NativeAiListRuntimesOutput, NativeAiPermissionResponseInput,
    NativeAiPrepareSessionInput, NativeAiRuntimeStatus, NativeAiSendPromptInput,
    NativeAiSendPromptOutput, NativeAiSessionIdInput, NativeAiSessionStatus,
    NativeAiSessionSummary, NativeAiSetSessionConfigOptionInput, NativeAiSetSessionModeInput,
    NativeAiSetSessionModelInput, NativeAiUserInputResponseInput,
};
use comando_types::ids::{ProjectId, RuntimeSessionId, WorktreeId};
use serde_json::{Value, json};

use crate::acp::{
    AcpProcessSpec, AcpRuntimeAuthAction, NativeAiConfigValue, run_acp_runtime_auth,
    start_acp_session,
};
use crate::commands::{
    cancel_session_output, close_session_output, list_runtimes_output, prepare_session_output,
    send_prompt_output,
};
use crate::error::{AiError, AiResult};
use crate::events::{
    AI_ERROR_EVENT, AI_IMAGE_GENERATION_EVENT, AI_MESSAGE_COMPLETED_EVENT, AI_MESSAGE_DELTA_EVENT,
    AI_MESSAGE_STARTED_EVENT, AI_PERMISSION_REQUEST_EVENT, AI_PLAN_UPDATED_EVENT,
    AI_SESSION_CATALOG_UPDATED_EVENT, AI_SESSION_CLOSED_EVENT, AI_SESSION_UPDATED_EVENT,
    AI_STATUS_EVENT, AI_SUBAGENT_BREADCRUMB_EVENT, AI_SUBAGENT_CREATED_EVENT,
    AI_THINKING_COMPLETED_EVENT, AI_THINKING_DELTA_EVENT, AI_THINKING_STARTED_EVENT,
    AI_TOKEN_USAGE_EVENT, AI_TOOL_ACTIVITY_EVENT, AI_USER_INPUT_REQUEST_EVENT, AiRuntimeEvent,
    now_iso8601, status_event, turn_status_event,
};
use crate::history::{
    AiHistorySessionMetadata, AiHistorySessionMetadataInput, AiHistoryStore,
    AiHistorySubagentMetadata,
};
use crate::runtime::{RuntimeDefinition, RuntimeRegistry};
use crate::runtime_setup::{
    RuntimeAuthTerminalLaunch, prepare_auth_terminal_launch, prepare_auth_terminal_logout,
    prepare_runtime_auth_connection, prepare_runtime_launch, runtime_status,
};
use crate::scope::SessionScope;
use crate::session::{NativeAiSession, SessionRegistry};

#[derive(Debug, Clone)]
pub struct AiEngineConfig {
    pub selected_native_runtime: String,
}

const MAX_IMAGE_ATTACHMENTS: usize = 12;
const MAX_IMAGE_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;

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
            return runtime_status(&store, &definition);
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
        prepare_auth_terminal_launch(&store, &definition, method_id)
    }

    pub fn prepare_auth_terminal_logout(
        &self,
        runtime_id: &str,
    ) -> AiResult<RuntimeAuthTerminalLaunch> {
        let definition = self.registry.require_native(runtime_id)?;
        let store =
            self.runtime_setup_store()?
                .ok_or_else(|| AiError::RuntimeLaunchContextInvalid {
                    runtime_id: runtime_id.to_string(),
                    message: "Native runtime setup is not initialized.".to_string(),
                })?;
        prepare_auth_terminal_logout(&store, &definition)
    }

    pub fn authenticate_runtime_auth(
        &self,
        runtime_id: &str,
        method_id: &str,
        cwd: String,
        owner_window_id: String,
        project_id: Option<ProjectId>,
        worktree_id: Option<WorktreeId>,
    ) -> AiResult<()> {
        let definition = self.registry.require_native(runtime_id)?;
        let store =
            self.runtime_setup_store()?
                .ok_or_else(|| AiError::RuntimeLaunchContextInvalid {
                    runtime_id: runtime_id.to_string(),
                    message: "Native runtime setup is not initialized.".to_string(),
                })?;
        let launch = prepare_runtime_auth_connection(
            &store,
            &definition,
            method_id,
            cwd,
            owner_window_id,
            project_id,
            worktree_id,
        )?;
        let spec = AcpProcessSpec::from_launch(&definition, &launch)?;
        run_acp_runtime_auth(
            &self.runtime,
            spec,
            AcpRuntimeAuthAction::Authenticate {
                method_id: method_id.to_string(),
            },
        )
    }

    pub fn logout_runtime_auth(&self, runtime_id: &str, cwd: String) -> AiResult<()> {
        let definition = self.registry.require_native(runtime_id)?;
        let store =
            self.runtime_setup_store()?
                .ok_or_else(|| AiError::RuntimeLaunchContextInvalid {
                    runtime_id: runtime_id.to_string(),
                    message: "Native runtime setup is not initialized.".to_string(),
                })?;
        let launch = prepare_runtime_auth_connection(
            &store,
            &definition,
            "chatgpt",
            cwd,
            String::new(),
            None,
            None,
        )?;
        let spec = AcpProcessSpec::from_launch(&definition, &launch)?;
        run_acp_runtime_auth(&self.runtime, spec, AcpRuntimeAuthAction::Logout)
    }

    pub fn prepare_session(
        &self,
        input: NativeAiPrepareSessionInput,
    ) -> AiResult<NativeAiSessionSummary> {
        let custom_launch = input.custom_acp_launch.clone();
        let definition = match custom_launch.as_ref() {
            Some(launch) => RuntimeDefinition::from_custom_launch(launch)?,
            None => self.registry.require_native(&input.runtime_id.0)?,
        };
        if input.runtime_id.0 != definition.id {
            return Err(AiError::RuntimeLaunchContextInvalid {
                runtime_id: input.runtime_id.0.clone(),
                message: "Runtime launch identity does not match the requested session."
                    .to_string(),
            });
        }
        if custom_launch.is_some() && input.launch.is_some() {
            return Err(AiError::RuntimeLaunchContextInvalid {
                runtime_id: input.runtime_id.0.clone(),
                message: "Custom runtimes cannot include a built-in launch context.".to_string(),
            });
        }
        let resolved_launch = match custom_launch.as_ref() {
            Some(_) => None,
            None => Some(match input.launch.clone() {
                Some(launch) => launch,
                None => {
                    let store = self.runtime_setup_store()?.ok_or_else(|| {
                        AiError::RuntimeLaunchContextInvalid {
                            runtime_id: input.runtime_id.0.clone(),
                            message: "Native runtime setup is not initialized.".to_string(),
                        }
                    })?;
                    prepare_runtime_launch(&store, &definition, &input)?.launch
                }
            }),
        };
        let mut history_metadata =
            AiHistorySessionMetadata::new_native(AiHistorySessionMetadataInput {
                session_id: input.session_id.clone(),
                runtime_id: input.runtime_id.clone(),
                runtime_session_id: input
                    .launch
                    .as_ref()
                    .and_then(|launch| launch.persisted_runtime_session_id.clone())
                    .or_else(|| input.persisted_runtime_session_id.clone())
                    .or_else(|| {
                        resolved_launch
                            .as_ref()
                            .and_then(|launch| launch.persisted_runtime_session_id.clone())
                    }),
                parent_session_id: None,
                project_id: input.project_id.clone(),
                worktree_id: input.worktree_id.clone(),
                title: input.title.clone(),
                status: NativeAiSessionStatus::Idle,
                model_id: input.model_id.clone(),
                mode_id: input.mode_id.clone(),
                reasoning_effort: reasoning_effort_from_config_values(&input.config_options),
                config_values: input.config_options.clone(),
                cwd: input.cwd.clone(),
                additional_roots: input.additional_roots.clone(),
            });
        if let Some(launch) = custom_launch.as_ref() {
            history_metadata.runtime_display_name = Some(launch.display_name.clone());
            history_metadata.runtime_launch_fingerprint = Some(launch.launch_fingerprint.clone());
            history_metadata.runtime_revision = Some(launch.revision);
        }

        let spec = match custom_launch.as_ref() {
            Some(launch) => AcpProcessSpec::from_custom_launch(&definition, launch, &input)?,
            None => AcpProcessSpec::from_launch(
                &definition,
                resolved_launch
                    .as_ref()
                    .ok_or_else(|| AiError::RuntimeLaunchContextInvalid {
                        runtime_id: input.runtime_id.0.clone(),
                        message: "Built-in runtime launch details are missing.".to_string(),
                    })?,
            )?,
        };
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
        let (session, controller) = start_acp_session(
            &self.runtime,
            spec,
            session,
            Arc::clone(&self.sessions),
            event_sender,
        )?;
        let mut sessions = self.lock_sessions()?;
        let summary = sessions.insert_with_acp_controller(session, controller)?;
        drop(sessions);
        history_metadata.runtime_session_id = summary.runtime_session_id.clone();
        history_metadata.custom_acp_continuation_strategy =
            summary.custom_acp_continuation_strategy.clone();
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
        validate_image_attachments(&input.prompt.attachments)?;

        let root_session_id = input.session_id.clone();
        let target_session_id = input
            .target_session_id
            .clone()
            .unwrap_or_else(|| root_session_id.clone());
        let mut sessions = self.lock_sessions()?;
        let session = sessions.get_mut(&root_session_id)?;
        let Some(controller) = session.acp_controller.clone() else {
            return Err(AiError::Unsupported(
                "Native prompts require an ACP-backed session.".to_string(),
            ));
        };
        let runtime_session_id = input
            .runtime_session_id
            .clone()
            .or_else(|| session.session.runtime_session_id.clone())
            .ok_or_else(|| {
                AiError::Unsupported("Native prompts require an ACP runtime session.".to_string())
            })?;
        if !session.begin_prompt(&target_session_id, &input.message_id.0) {
            return Err(AiError::SessionBusy {
                session_id: target_session_id.0,
            });
        }
        if target_session_id == root_session_id {
            session.set_status(NativeAiSessionStatus::Streaming);
        }
        if let Err(error) = controller.send_prompt(
            runtime_session_id.clone(),
            target_session_id.clone(),
            input.message_id.clone(),
            input.prompt.text.clone(),
            input.prompt.attachments.clone(),
        ) {
            session.finish_prompt(&target_session_id, &input.message_id.0);
            if target_session_id == root_session_id {
                session.set_status(NativeAiSessionStatus::Error);
            }
            return Err(error);
        }
        let mut summary = session.session.summary();
        drop(sessions);
        if target_session_id != root_session_id {
            self.retarget_session_summary(
                &mut summary,
                &target_session_id,
                Some(runtime_session_id),
                NativeAiSessionStatus::Streaming,
            )?;
        }
        self.emit_synthetic_turn_started_status(&summary, &input.message_id.0)?;
        self.update_history_status(&summary)?;
        self.push_history_user_message(
            &target_session_id,
            &input.message_id.0,
            input
                .prompt
                .display_text
                .as_deref()
                .unwrap_or(&input.prompt.text),
            &input.prompt.attachments,
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
        let cancelled_turn_id = session.cancel_prompt(&target_session_id);
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
        drop(sessions);
        if !target_is_root {
            self.retarget_session_summary(
                &mut summary,
                &target_session_id,
                runtime_session_id,
                NativeAiSessionStatus::Idle,
            )?;
        }
        self.update_history_status(&summary)?;
        if let (Some(turn_id), Some(sender)) = (cancelled_turn_id, self.event_sender()?) {
            let _ = sender.send(AiRuntimeEvent::new(
                AI_STATUS_EVENT,
                &turn_status_event(&summary, turn_id, "cancelled", None),
            ));
        }
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
        session.clear_prompts();
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
        if let Some(store) = self.history_store()?
            && store.has_session(&input.session_id)
        {
            store.rename_session(&input.session_id, input.title)?;
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
            AI_IMAGE_GENERATION_EVENT => self.record_history_image_generation(&event.payload),
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

    pub fn load_tool_activity_detail(
        &self,
        session_id: &comando_types::ids::SessionId,
        detail_id: &str,
    ) -> AiResult<Option<Value>> {
        self.history_store()?
            .map(|store| store.load_tool_activity_detail(session_id, detail_id))
            .transpose()
            .map(|detail| detail.flatten())
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
        {
            let sessions = self.lock_sessions()?;
            if let Ok(session) = sessions.get(session_id) {
                return Ok(session.session.clone());
            }
        }

        let Some(store) = self.history_store()? else {
            return Err(AiError::SessionNotFound {
                session_id: session_id.0.clone(),
            });
        };
        if !store.has_session(session_id) {
            return Err(AiError::SessionNotFound {
                session_id: session_id.0.clone(),
            });
        }

        let metadata = store.load_metadata(session_id)?;
        let Some(cwd) = metadata
            .cwd
            .clone()
            .filter(|candidate| !candidate.trim().is_empty())
        else {
            return Err(AiError::InvalidInput(format!(
                "AI session `{}` does not have a review cwd.",
                session_id.0
            )));
        };
        let scope = SessionScope::new(
            metadata.project_id.clone(),
            metadata.worktree_id.clone(),
            cwd,
            metadata.additional_roots.clone(),
        )?;

        Ok(NativeAiSession {
            custom_acp_continuation_strategy: metadata.custom_acp_continuation_strategy,
            owner_window_id: String::new(),
            runtime_id: metadata.runtime_id,
            runtime_session_id: metadata.runtime_session_id,
            scope,
            session_id: metadata.session_id,
            status: metadata.status,
            title: metadata.title,
            updated_at: metadata.updated_at,
        })
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
        controller.set_config_option(runtime_session_id, config_id.clone(), value.clone())?;
        self.update_history_config_value(session_id, &config_id, &value)?;
        self.update_history_status(&session.summary())
    }

    fn update_history_config_value(
        &self,
        session_id: &comando_types::ids::SessionId,
        config_id: &str,
        value: &NativeAiConfigValue,
    ) -> AiResult<()> {
        let Some(store) = self.history_store()? else {
            return Ok(());
        };
        if !store.has_session(session_id) {
            return Ok(());
        }

        let mut metadata = store.load_metadata(session_id)?;
        update_history_metadata_config_value(&mut metadata, config_id, value);
        store.save_metadata(&metadata)
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

    fn emit_synthetic_turn_started_status(
        &self,
        summary: &NativeAiSessionSummary,
        message_id: &str,
    ) -> AiResult<()> {
        if summary.runtime_id.0 == "codex" {
            return Ok(());
        }

        if let Some(sender) = self.event_sender()? {
            let _ = sender.send(AiRuntimeEvent::new(
                AI_STATUS_EVENT,
                &status_event(
                    summary,
                    format!("comando:status:turn:{message_id}"),
                    "completed",
                    "New turn",
                    None,
                ),
            ));
        }
        Ok(())
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
        current.custom_acp_continuation_strategy = metadata
            .custom_acp_continuation_strategy
            .or(current.custom_acp_continuation_strategy);
        current.runtime_display_name = metadata
            .runtime_display_name
            .or(current.runtime_display_name);
        current.runtime_launch_fingerprint = metadata
            .runtime_launch_fingerprint
            .or(current.runtime_launch_fingerprint);
        current.runtime_revision = metadata.runtime_revision.or(current.runtime_revision);
        current.runtime_session_id = metadata.runtime_session_id.or(current.runtime_session_id);
        current.parent_session_id = metadata.parent_session_id;
        current.project_id = metadata.project_id;
        current.worktree_id = metadata.worktree_id;
        current.title = metadata.title;
        current.status = metadata.status;
        current.closed_at = None;
        current.model_id = metadata.model_id;
        current.mode_id = metadata.mode_id;
        current.reasoning_effort = metadata.reasoning_effort;
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
        if let Some(store) = self.history_store()?
            && store.has_session(&summary.session_id)
        {
            let mut metadata = store.load_metadata(&summary.session_id)?;
            metadata.runtime_session_id = summary.runtime_session_id.clone();
            metadata.custom_acp_continuation_strategy = summary
                .custom_acp_continuation_strategy
                .clone()
                .or(metadata.custom_acp_continuation_strategy);
            metadata.status = summary.status.clone();
            metadata.title = preferred_status_title(&metadata, &summary.title);
            metadata.updated_at = summary.updated_at.clone();
            if summary.status == NativeAiSessionStatus::Closed {
                metadata.closed_at = Some(summary.updated_at.clone());
            }
            store.save_metadata(&metadata)?;
        }
        Ok(())
    }

    fn retarget_session_summary(
        &self,
        summary: &mut NativeAiSessionSummary,
        target_session_id: &comando_types::ids::SessionId,
        runtime_session_id: Option<RuntimeSessionId>,
        status: NativeAiSessionStatus,
    ) -> AiResult<()> {
        summary.session_id = target_session_id.clone();
        summary.runtime_session_id = runtime_session_id;
        summary.status = status;
        summary.updated_at = now_iso8601();

        let Some(store) = self.history_store()? else {
            return Ok(());
        };
        if !store.has_session(target_session_id) {
            return Ok(());
        }

        let metadata = store.load_metadata(target_session_id)?;
        summary.runtime_id = metadata.runtime_id.clone();
        summary.project_id = metadata.project_id.clone();
        summary.worktree_id = metadata.worktree_id.clone();
        summary.title = metadata.display_title().to_string();
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
        attachments: &[NativeAiImageAttachment],
    ) -> AiResult<()> {
        let message = json!({
            "attachments": attachments,
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

    fn record_history_image_generation(&self, payload: &Value) -> AiResult<()> {
        let Some(session_id) = payload_session_id(payload) else {
            return Ok(());
        };
        let Some(message) = payload.get("message").cloned() else {
            return Ok(());
        };
        let mut messages = self.history_messages.lock().map_err(|error| {
            AiError::Internal(format!("AI history messages lock failed: {error}"))
        })?;
        upsert_history_message(messages.entry(session_id.0.clone()).or_default(), message);
        drop(messages);
        self.flush_history_messages(&session_id)
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
            if metadata.reasoning_effort.is_none() {
                metadata.reasoning_effort =
                    reasoning_effort_from_config_options(&metadata.config_options);
            }
            if let Some(reasoning_effort) = metadata.reasoning_effort.clone() {
                update_reasoning_effort_config_options(
                    &mut metadata.config_options,
                    &reasoning_effort,
                );
            }
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
            // Terminal turn events drive queue lifecycle and are not transcript activities.
            if payload.get("turnId").and_then(Value::as_str).is_some()
                && matches!(
                    payload.get("status").and_then(Value::as_str),
                    Some("cancelled" | "completed" | "failed")
                )
            {
                return Ok(());
            }
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
            let detail_id = tool_activity_detail_id(&session_id.0, tool_call_id);
            let detail = json!({
                "diffs": payload.get("diffs").cloned().unwrap_or_else(|| json!([])),
                "rawInput": payload.get("rawInput").cloned().unwrap_or(Value::Null),
                "rawOutput": payload.get("rawOutput").cloned().unwrap_or(Value::Null),
                "terminalOutput": payload.get("terminalOutput").cloned().unwrap_or(Value::Null),
            });
            if let Some(store) = self.history_store()? {
                // The content hash prevents repeated streaming updates from rewriting a blob.
                store.store_tool_activity_detail(&session_id, &detail_id, detail)?;
            }
            json!({
                "action": null,
                "createdAt": updated_at,
                "diffs": [],
                "exitCode": payload.get("exitCode").filter(|value| value.is_number()).cloned().unwrap_or(Value::Null),
                "id": tool_call_id,
                "kind": payload.get("kind").and_then(Value::as_str).unwrap_or("tool"),
                "locations": [],
                "rawInputJson": null,
                "rawOutputJson": null,
                "sessionId": session_id.0,
                "status": payload.get("status").and_then(Value::as_str).unwrap_or("pending"),
                "summary": payload.get("summary").cloned().unwrap_or(Value::Null),
                "terminalOutput": null,
                "toolActivityDetailId": detail_id,
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
            let mut metadata = store.load_metadata(&session_id)?;
            if let Some(title) = payload
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.trim().is_empty())
            {
                metadata.title = title.to_string();
            }
            if let Some(model_id) = payload
                .get("modelId")
                .and_then(Value::as_str)
                .filter(|model_id| !model_id.trim().is_empty())
            {
                metadata.model_id = Some(model_id.to_string());
            }
            if let Some(reasoning_effort) = payload
                .get("reasoningEffort")
                .and_then(Value::as_str)
                .filter(|reasoning_effort| !reasoning_effort.trim().is_empty())
            {
                metadata.reasoning_effort = Some(reasoning_effort.to_string());
                update_reasoning_effort_config_values(
                    &mut metadata.config_values,
                    reasoning_effort,
                );
            }
            if let Some(runtime_session_id) =
                payload.get("childRuntimeSessionId").and_then(Value::as_str)
            {
                metadata.runtime_session_id = Some(comando_types::ids::RuntimeSessionId(
                    runtime_session_id.to_string(),
                ));
            }
            let parent_metadata = parent_session_id
                .as_ref()
                .and_then(|parent_id| store.load_metadata(parent_id).ok());
            if let Some(parent_metadata) = parent_metadata {
                metadata.custom_acp_continuation_strategy =
                    parent_metadata.custom_acp_continuation_strategy;
                metadata.runtime_display_name = parent_metadata.runtime_display_name;
                metadata.runtime_launch_fingerprint = parent_metadata.runtime_launch_fingerprint;
                metadata.runtime_revision = parent_metadata.runtime_revision;
                metadata.project_id = metadata.project_id.or(parent_metadata.project_id);
                metadata.worktree_id = metadata.worktree_id.or(parent_metadata.worktree_id);
                if metadata.cwd.as_deref().is_none_or(str::is_empty) {
                    metadata.cwd = parent_metadata.cwd;
                }
                if metadata.additional_roots.is_empty() {
                    metadata.additional_roots = parent_metadata.additional_roots;
                }
                if metadata.config_values.is_empty() {
                    metadata.config_values = parent_metadata.config_values;
                }
            }
            metadata.parent_session_id = parent_session_id.clone();
            if let Some(parent_session_id) = parent_session_id {
                metadata.subagent = Some(AiHistorySubagentMetadata {
                    parent_session_id,
                    parent_runtime_session_id: payload
                        .get("parentRuntimeSessionId")
                        .and_then(Value::as_str)
                        .map(|value| comando_types::ids::RuntimeSessionId(value.to_string())),
                    nickname: payload
                        .get("title")
                        .and_then(Value::as_str)
                        .filter(|title| !title.trim().is_empty())
                        .map(ToOwned::to_owned),
                });
            }
            metadata.updated_at = payload
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or(&metadata.updated_at)
                .to_string();
            store.save_metadata(&metadata)?;
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
        let reasoning_effort = payload
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .filter(|reasoning_effort| !reasoning_effort.trim().is_empty())
            .map(ToOwned::to_owned);
        let mut config_values = parent_metadata
            .as_ref()
            .map(|metadata| metadata.config_values.clone())
            .unwrap_or_default();
        if let Some(reasoning_effort) = reasoning_effort.as_deref() {
            update_reasoning_effort_config_values(&mut config_values, reasoning_effort);
        }
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
            model_id: payload
                .get("modelId")
                .and_then(Value::as_str)
                .filter(|model_id| !model_id.trim().is_empty())
                .map(ToOwned::to_owned)
                .or_else(|| {
                    parent_metadata
                        .as_ref()
                        .and_then(|metadata| metadata.model_id.clone())
                }),
            mode_id: parent_metadata
                .as_ref()
                .and_then(|metadata| metadata.mode_id.clone()),
            reasoning_effort,
            config_values,
            cwd: parent_metadata
                .as_ref()
                .and_then(|metadata| metadata.cwd.clone())
                .unwrap_or_default(),
            additional_roots: parent_metadata
                .as_ref()
                .map(|metadata| metadata.additional_roots.clone())
                .unwrap_or_default(),
        });
        if let Some(parent_metadata) = parent_metadata {
            metadata.custom_acp_continuation_strategy =
                parent_metadata.custom_acp_continuation_strategy;
            metadata.runtime_display_name = parent_metadata.runtime_display_name;
            metadata.runtime_launch_fingerprint = parent_metadata.runtime_launch_fingerprint;
            metadata.runtime_revision = parent_metadata.runtime_revision;
        }
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
                    metadata.title = preferred_status_title(&metadata, title);
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
        if let Some(store) = self.history_store()?
            && store.has_session(&session_id)
        {
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
        Ok(())
    }
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}

impl<T> Pipe for T {}

fn validate_image_attachments(attachments: &[NativeAiImageAttachment]) -> AiResult<()> {
    if attachments.len() > MAX_IMAGE_ATTACHMENTS {
        return Err(AiError::InvalidInput(format!(
            "You can attach up to {MAX_IMAGE_ATTACHMENTS} images per message."
        )));
    }

    for attachment in attachments {
        if attachment.id.trim().is_empty() {
            return Err(AiError::InvalidInput(
                "Image attachments require an id.".to_string(),
            ));
        }
        if !attachment.mime_type.starts_with("image/") {
            return Err(AiError::InvalidInput(
                "Only image attachments are supported.".to_string(),
            ));
        }
        if attachment.data_base64.trim().is_empty() {
            return Err(AiError::InvalidInput(
                "Image attachments require base64 data.".to_string(),
            ));
        }

        let estimated_size = estimate_base64_size(&attachment.data_base64);
        let size = attachment.size_bytes.unwrap_or(estimated_size);
        if size > MAX_IMAGE_ATTACHMENT_BYTES || estimated_size > MAX_IMAGE_ATTACHMENT_BYTES {
            return Err(AiError::InvalidInput(format!(
                "Image attachments must be {} MiB or smaller.",
                MAX_IMAGE_ATTACHMENT_BYTES / (1024 * 1024)
            )));
        }
    }

    Ok(())
}

fn estimate_base64_size(data_base64: &str) -> u64 {
    let data = data_base64.trim();
    let padding = if data.ends_with("==") {
        2
    } else if data.ends_with('=') {
        1
    } else {
        0
    };
    ((data.len() as u64 * 3) / 4).saturating_sub(padding)
}

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

pub fn tool_activity_detail_id(session_id: &str, tool_call_id: &str) -> String {
    format!("tool-detail:{session_id}:{tool_call_id}")
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
        let preserved_fields = [
            "action",
            "exitCode",
            "locations",
            "summary",
            "toolActivityDetailId",
        ]
        .into_iter()
        .filter_map(|key| {
            current
                .get(key)
                .filter(|value| !is_empty_history_activity_value(value))
                .cloned()
                .map(|value| (key, value))
        })
        .collect::<Vec<_>>();
        *current = next;
        if let Some(object) = current.as_object_mut() {
            for (key, value) in preserved_fields {
                if object.get(key).is_none_or(is_empty_history_activity_value) {
                    object.insert(key.to_string(), value);
                }
            }
        }
        if let (Some(created_at), Some(object)) = (created_at, current.as_object_mut()) {
            object.insert("createdAt".to_string(), created_at);
        }
    } else {
        activities.push(next);
    }
}

fn is_empty_history_activity_value(value: &Value) -> bool {
    value.is_null()
        || value.as_str().is_some_and(str::is_empty)
        || value.as_array().is_some_and(Vec::is_empty)
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

fn reasoning_effort_from_config_values(config_values: &BTreeMap<String, Value>) -> Option<String> {
    REASONING_EFFORT_CONFIG_KEYS.iter().find_map(|key| {
        config_values
            .get(*key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToOwned::to_owned)
    })
}

const REASONING_EFFORT_CONFIG_KEYS: &[&str] = &[
    "reasoning_effort",
    "reasoning-effort",
    "codex-reasoning-effort",
    "effort",
    "thought_level",
];

fn is_reasoning_effort_config_key(config_id: &str) -> bool {
    REASONING_EFFORT_CONFIG_KEYS.contains(&config_id)
}

fn update_history_metadata_config_value(
    metadata: &mut AiHistorySessionMetadata,
    config_id: &str,
    value: &NativeAiConfigValue,
) {
    let value_json = match value {
        NativeAiConfigValue::Boolean(value) => json!(value),
        NativeAiConfigValue::ValueId(value) => json!(value),
    };
    metadata
        .config_values
        .insert(config_id.to_string(), value_json.clone());
    update_history_config_options_value(&mut metadata.config_options, config_id, &value_json);

    if let NativeAiConfigValue::ValueId(value) = value {
        if config_id == "model" {
            metadata.model_id = Some(value.clone());
        }
        if config_id == "mode" {
            metadata.mode_id = Some(value.clone());
        }
        if is_reasoning_effort_config_key(config_id) {
            metadata.reasoning_effort = Some(value.clone());
        }
    }
}

fn update_history_config_options_value(
    config_options: &mut [Value],
    config_id: &str,
    value: &Value,
) {
    for option in config_options {
        let option_matches = option
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id == config_id);
        let reasoning_matches =
            is_reasoning_effort_config_key(config_id) && is_reasoning_effort_config_option(option);

        if (option_matches || reasoning_matches)
            && let Some(object) = option.as_object_mut()
        {
            object.insert("value".to_string(), value.clone());
        }
    }
}

fn update_reasoning_effort_config_values(
    config_values: &mut BTreeMap<String, Value>,
    reasoning_effort: &str,
) {
    let key = REASONING_EFFORT_CONFIG_KEYS
        .iter()
        .find(|key| config_values.contains_key(**key))
        .copied()
        .unwrap_or("reasoning_effort");
    config_values.insert(key.to_string(), json!(reasoning_effort));
}

fn update_reasoning_effort_config_options(config_options: &mut [Value], reasoning_effort: &str) {
    update_history_config_options_value(
        config_options,
        "reasoning_effort",
        &json!(reasoning_effort),
    );
}

fn reasoning_effort_from_config_options(config_options: &[Value]) -> Option<String> {
    config_options.iter().find_map(|option| {
        if !is_reasoning_effort_config_option(option) {
            return None;
        }
        option
            .get("value")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToOwned::to_owned)
    })
}

fn is_reasoning_effort_config_option(option: &Value) -> bool {
    let id = option.get("id").and_then(Value::as_str).unwrap_or_default();
    let category = option
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or_default();
    category == "reasoning" || is_reasoning_effort_config_key(id)
}

fn preferred_status_title(metadata: &AiHistorySessionMetadata, incoming_title: &str) -> String {
    if let Some(nickname) = metadata
        .subagent
        .as_ref()
        .and_then(|subagent| subagent.nickname.as_deref())
    {
        return nickname.to_string();
    }
    let incoming_title = incoming_title.trim();
    if incoming_title.is_empty() {
        metadata.title.clone()
    } else {
        incoming_title.to_string()
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

    use comando_types::ai::{
        NativeAiDesiredSelections, NativeAiImageAttachment, NativeAiLaunchSpec,
        NativeAiRuntimeStatus,
    };
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
            custom_acp_continuation_strategy: None,
            custom_acp_launch: None,
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

    fn image_attachment(id: &str) -> NativeAiImageAttachment {
        NativeAiImageAttachment {
            id: id.to_string(),
            data_base64: "aGVsbG8=".to_string(),
            mime_type: "image/png".to_string(),
            name: Some("capture.png".to_string()),
            size_bytes: Some(5),
        }
    }

    #[test]
    fn synthetic_turn_started_status_emits_for_non_codex_runtime() {
        let engine = AiEngine::default();
        let (sender, receiver) = mpsc::sync_channel(8);
        engine.set_event_sender(sender).unwrap();
        let mut summary = NativeAiSession::from_prepare_input(prepare_input("s1", "opencode"))
            .unwrap()
            .summary();
        summary.runtime_session_id = Some(RuntimeSessionId("runtime-1".to_string()));
        summary.status = NativeAiSessionStatus::Streaming;

        engine
            .emit_synthetic_turn_started_status(&summary, "message-1")
            .unwrap();

        let event = receiver.recv().unwrap();
        assert_eq!(event.event_name, AI_STATUS_EVENT);
        assert_eq!(
            event.payload.get("eventId").and_then(Value::as_str),
            Some("comando:status:turn:message-1")
        );
        assert_eq!(
            event.payload.get("sessionId").and_then(Value::as_str),
            Some("s1")
        );
        assert_eq!(
            event.payload.get("runtimeId").and_then(Value::as_str),
            Some("opencode")
        );
        assert_eq!(
            event
                .payload
                .get("runtimeSessionId")
                .and_then(Value::as_str),
            Some("runtime-1")
        );
        assert_eq!(
            event.payload.get("title").and_then(Value::as_str),
            Some("New turn")
        );
    }

    #[test]
    fn synthetic_turn_started_status_skips_codex_runtime() {
        let engine = AiEngine::default();
        let (sender, receiver) = mpsc::sync_channel(8);
        engine.set_event_sender(sender).unwrap();
        let summary = NativeAiSession::from_prepare_input(prepare_input("s1", "codex"))
            .unwrap()
            .summary();

        engine
            .emit_synthetic_turn_started_status(&summary, "message-1")
            .unwrap();

        assert!(receiver.try_recv().is_err());
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
            engine.prepare_session(prepare_input("s1", "unknown-runtime")),
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
    fn review_session_can_be_rebuilt_from_history_metadata() {
        let app_data = tempfile::tempdir().expect("app data");
        let project = tempfile::tempdir().expect("project");
        let store = AiHistoryStore::new(app_data.path()).expect("history store");
        let metadata = AiHistorySessionMetadata::new_native(AiHistorySessionMetadataInput {
            session_id: SessionId("s-history".to_string()),
            runtime_id: RuntimeId("opencode".to_string()),
            runtime_session_id: Some(RuntimeSessionId("runtime-history".to_string())),
            parent_session_id: None,
            project_id: None,
            worktree_id: None,
            title: "Historical session".to_string(),
            status: NativeAiSessionStatus::Idle,
            model_id: None,
            mode_id: None,
            reasoning_effort: None,
            config_values: BTreeMap::new(),
            cwd: project.path().to_string_lossy().to_string(),
            additional_roots: vec!["/tmp/extra-root".to_string()],
        });
        store
            .create_session(metadata)
            .expect("create history session");
        let engine = AiEngine::default();
        engine
            .set_history_store(Some(store))
            .expect("install history store");

        let session = engine
            .session_for_review(&SessionId("s-history".to_string()))
            .expect("review session");

        assert_eq!(session.session_id, SessionId("s-history".to_string()));
        assert_eq!(session.runtime_id, RuntimeId("opencode".to_string()));
        assert_eq!(
            session.runtime_session_id,
            Some(RuntimeSessionId("runtime-history".to_string()))
        );
        assert_eq!(session.scope.cwd, project.path().to_string_lossy());
        assert_eq!(session.scope.additional_roots, vec!["/tmp/extra-root"]);
    }

    #[test]
    fn history_config_updates_keep_snapshot_options_aligned() {
        let app_data = tempfile::tempdir().expect("app data");
        let store = AiHistoryStore::new(app_data.path()).expect("history store");
        let session_id = SessionId("s-history".to_string());
        let mut metadata = AiHistorySessionMetadata::new_native(AiHistorySessionMetadataInput {
            session_id: session_id.clone(),
            runtime_id: RuntimeId("codex".to_string()),
            runtime_session_id: Some(RuntimeSessionId("runtime-history".to_string())),
            parent_session_id: None,
            project_id: None,
            worktree_id: None,
            title: "Historical session".to_string(),
            status: NativeAiSessionStatus::Idle,
            model_id: None,
            mode_id: None,
            reasoning_effort: Some("low".to_string()),
            config_values: BTreeMap::from([("reasoning_effort".to_string(), json!("low"))]),
            cwd: "/tmp/project".to_string(),
            additional_roots: Vec::new(),
        });
        metadata.config_options = vec![json!({
            "category": "reasoning",
            "description": null,
            "id": "reasoning_effort",
            "label": "Reasoning",
            "options": [
                { "description": null, "groupLabel": null, "label": "Low", "value": "low" },
                { "description": null, "groupLabel": null, "label": "High", "value": "high" }
            ],
            "type": "select",
            "value": "low"
        })];
        store
            .create_session(metadata)
            .expect("create history session");
        let engine = AiEngine::default();
        engine
            .set_history_store(Some(store.clone()))
            .expect("install history store");

        engine
            .update_history_config_value(
                &session_id,
                "reasoning_effort",
                &NativeAiConfigValue::ValueId("high".to_string()),
            )
            .expect("update history config value");

        let metadata = store.load_metadata(&session_id).expect("metadata");
        let snapshot = store
            .load_session_snapshot(&session_id)
            .expect("snapshot")
            .expect("snapshot");

        assert_eq!(metadata.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(
            metadata
                .config_values
                .get("reasoning_effort")
                .and_then(Value::as_str),
            Some("high")
        );
        assert_eq!(snapshot.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(snapshot.config_options[0]["value"], "high");
    }

    #[test]
    fn subagent_history_overrides_inherited_reasoning_values() {
        let app_data = tempfile::tempdir().expect("app data");
        let store = AiHistoryStore::new(app_data.path()).expect("history store");
        let parent_session_id = SessionId("s-parent".to_string());
        let mut parent = AiHistorySessionMetadata::new_native(AiHistorySessionMetadataInput {
            session_id: parent_session_id.clone(),
            runtime_id: RuntimeId("codex".to_string()),
            runtime_session_id: Some(RuntimeSessionId("runtime-parent".to_string())),
            parent_session_id: None,
            project_id: None,
            worktree_id: None,
            title: "Parent session".to_string(),
            status: NativeAiSessionStatus::Idle,
            model_id: Some("gpt-5".to_string()),
            mode_id: None,
            reasoning_effort: Some("low".to_string()),
            config_values: BTreeMap::from([("reasoning_effort".to_string(), json!("low"))]),
            cwd: "/tmp/project".to_string(),
            additional_roots: Vec::new(),
        });
        parent.config_options = vec![json!({
            "category": "reasoning",
            "description": null,
            "id": "reasoning_effort",
            "label": "Reasoning",
            "options": [
                { "description": null, "groupLabel": null, "label": "Low", "value": "low" },
                { "description": null, "groupLabel": null, "label": "High", "value": "high" }
            ],
            "type": "select",
            "value": "low"
        })];
        store.create_session(parent).expect("create parent");
        let engine = AiEngine::default();
        engine
            .set_history_store(Some(store.clone()))
            .expect("install history store");

        engine
            .record_history_event(&AiRuntimeEvent::new(
                AI_SUBAGENT_CREATED_EVENT,
                &json!({
                    "childRuntimeSessionId": "runtime-child",
                    "childSessionId": "s-child",
                    "parentRuntimeSessionId": "runtime-parent",
                    "parentSessionId": "s-parent",
                    "reasoningEffort": "high",
                    "runtimeId": "codex",
                    "runtimeSessionId": "runtime-child",
                    "sessionId": "s-child",
                    "title": "explorer"
                }),
            ))
            .expect("record subagent");
        let child_session_id = SessionId("s-child".to_string());
        let child = store
            .load_metadata(&child_session_id)
            .expect("child metadata");
        assert_eq!(child.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(
            child
                .config_values
                .get("reasoning_effort")
                .and_then(Value::as_str),
            Some("high")
        );

        engine
            .record_history_event(&AiRuntimeEvent::new(
                AI_SUBAGENT_CREATED_EVENT,
                &json!({
                    "childRuntimeSessionId": "runtime-child",
                    "childSessionId": "s-child",
                    "modelId": "gpt-5.6",
                    "parentRuntimeSessionId": "runtime-parent",
                    "parentSessionId": "s-parent",
                    "reasoningEffort": "high",
                    "runtimeId": "codex",
                    "runtimeSessionId": "runtime-child",
                    "sessionId": "s-child",
                    "title": "Galileo"
                }),
            ))
            .expect("enrich existing subagent");
        let child = store
            .load_metadata(&child_session_id)
            .expect("enriched child metadata");
        assert_eq!(child.title, "Galileo");
        assert_eq!(child.model_id.as_deref(), Some("gpt-5.6"));

        engine
            .record_history_event(&AiRuntimeEvent::new(
                AI_SUBAGENT_CREATED_EVENT,
                &json!({
                    "childRuntimeSessionId": "runtime-intermediate",
                    "childSessionId": "s-intermediate",
                    "parentRuntimeSessionId": "runtime-parent",
                    "parentSessionId": "s-parent",
                    "runtimeId": "codex",
                    "runtimeSessionId": "runtime-intermediate",
                    "sessionId": "s-intermediate",
                    "title": "Intermediate agent"
                }),
            ))
            .expect("record intermediate subagent");
        engine
            .record_history_event(&AiRuntimeEvent::new(
                AI_SUBAGENT_CREATED_EVENT,
                &json!({
                    "childRuntimeSessionId": "runtime-child",
                    "childSessionId": "s-child",
                    "parentRuntimeSessionId": "runtime-intermediate",
                    "parentSessionId": "s-intermediate",
                    "runtimeId": "codex",
                    "runtimeSessionId": "runtime-child",
                    "sessionId": "s-child",
                    "title": "Galileo"
                }),
            ))
            .expect("reparent existing subagent");
        let reparented_child = store
            .load_metadata(&child_session_id)
            .expect("reparented child metadata");
        assert_eq!(
            reparented_child
                .parent_session_id
                .as_ref()
                .map(|session_id| session_id.0.as_str()),
            Some("s-intermediate")
        );
        assert_eq!(
            reparented_child
                .subagent
                .as_ref()
                .and_then(|subagent| subagent.parent_runtime_session_id.as_ref())
                .map(|runtime_session_id| runtime_session_id.0.as_str()),
            Some("runtime-intermediate")
        );

        engine
            .record_history_event(&AiRuntimeEvent::new(
                AI_SESSION_UPDATED_EVENT,
                &json!({
                    "runtimeId": "codex",
                    "runtimeSessionId": "runtime-child",
                    "sessionId": "s-child",
                    "status": "streaming",
                    "title": "Parent prompt title",
                    "updatedAt": "2026-06-20T00:00:00.000Z"
                }),
            ))
            .expect("record child status");
        let child_after_status = store
            .load_metadata(&child_session_id)
            .expect("child metadata after status");
        assert_eq!(child_after_status.title, "Galileo");

        let mut root_input = prepare_input("s-parent", "codex");
        root_input.title = "Parent prompt title".to_string();
        let mut child_summary = NativeAiSession::from_prepare_input(root_input)
            .expect("root session")
            .summary();
        child_summary.updated_at = "2020-01-01T00:00:00.000Z".to_string();
        engine
            .retarget_session_summary(
                &mut child_summary,
                &child_session_id,
                Some(RuntimeSessionId("runtime-child".to_string())),
                NativeAiSessionStatus::Streaming,
            )
            .expect("retarget child summary");
        assert_eq!(child_summary.title, "Galileo");
        assert_ne!(child_summary.updated_at, "2020-01-01T00:00:00.000Z");

        engine
            .record_history_event(&AiRuntimeEvent::new(
                AI_SESSION_CATALOG_UPDATED_EVENT,
                &json!({
                    "configOptions": [
                        {
                            "category": "effort",
                            "currentValue": "low",
                            "description": null,
                            "id": "reasoning_effort",
                            "name": "Reasoning",
                            "options": [
                                { "description": null, "name": "Low", "value": "low" },
                                { "description": null, "name": "High", "value": "high" }
                            ],
                            "type": "select"
                        }
                    ],
                    "runtimeId": "codex",
                    "runtimeSessionId": "runtime-child",
                    "sessionId": "s-child",
                    "updatedAt": "2026-06-20T00:00:00.000Z"
                }),
            ))
            .expect("record child catalog");

        let snapshot = store
            .load_session_snapshot(&child_session_id)
            .expect("snapshot")
            .expect("snapshot");
        assert_eq!(snapshot.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(snapshot.config_options[0]["value"], "high");
    }

    #[test]
    fn records_subagent_user_message_chunks_in_history_order() {
        let app_data = tempfile::tempdir().expect("app data");
        let store = AiHistoryStore::new(app_data.path()).expect("history store");
        let child_session_id = SessionId("s-child".to_string());
        let metadata = AiHistorySessionMetadata::new_native(AiHistorySessionMetadataInput {
            session_id: child_session_id.clone(),
            runtime_id: RuntimeId("opencode".to_string()),
            runtime_session_id: Some(RuntimeSessionId("runtime-child".to_string())),
            parent_session_id: Some(SessionId("s-parent".to_string())),
            project_id: None,
            worktree_id: None,
            title: "Child agent".to_string(),
            status: NativeAiSessionStatus::Idle,
            model_id: None,
            mode_id: None,
            reasoning_effort: None,
            config_values: BTreeMap::new(),
            cwd: "/tmp/project".to_string(),
            additional_roots: Vec::new(),
        });
        store
            .create_session(metadata)
            .expect("create child history session");
        let engine = AiEngine::default();
        engine
            .set_history_store(Some(store.clone()))
            .expect("install history store");

        for event in [
            AiRuntimeEvent::new(
                AI_MESSAGE_STARTED_EVENT,
                &json!({
                    "content": "",
                    "messageId": "user-1",
                    "messageKind": "user",
                    "runtimeId": "opencode",
                    "runtimeSessionId": "runtime-child",
                    "sessionId": "s-child",
                    "updatedAt": "2026-06-20T00:00:00.000Z"
                }),
            ),
            AiRuntimeEvent::new(
                AI_MESSAGE_DELTA_EVENT,
                &json!({
                    "content": "Child prompt",
                    "delta": "Child prompt",
                    "messageId": "user-1",
                    "messageKind": "user",
                    "runtimeId": "opencode",
                    "runtimeSessionId": "runtime-child",
                    "sessionId": "s-child",
                    "updatedAt": "2026-06-20T00:00:00.100Z"
                }),
            ),
            AiRuntimeEvent::new(
                AI_MESSAGE_COMPLETED_EVENT,
                &json!({
                    "messageId": "user-1",
                    "messageKind": "user",
                    "runtimeId": "opencode",
                    "runtimeSessionId": "runtime-child",
                    "sessionId": "s-child",
                    "updatedAt": "2026-06-20T00:00:00.200Z"
                }),
            ),
            AiRuntimeEvent::new(
                AI_MESSAGE_STARTED_EVENT,
                &json!({
                    "content": "",
                    "messageId": "assistant-1",
                    "messageKind": "assistant",
                    "runtimeId": "opencode",
                    "runtimeSessionId": "runtime-child",
                    "sessionId": "s-child",
                    "updatedAt": "2026-06-20T00:00:01.000Z"
                }),
            ),
        ] {
            engine
                .record_history_event(&event)
                .expect("record history event");
        }

        let snapshot = store
            .load_session_snapshot(&child_session_id)
            .expect("load child snapshot")
            .expect("child snapshot");

        assert_eq!(snapshot.messages.len(), 2);
        assert_eq!(snapshot.messages[0]["kind"], "user");
        assert_eq!(snapshot.messages[0]["content"], "Child prompt");
        assert_eq!(snapshot.messages[0]["status"], "completed");
        assert_eq!(snapshot.messages[1]["kind"], "assistant");
    }

    #[test]
    fn terminal_turn_status_is_not_recorded_as_history_activity() {
        let app_data = tempfile::tempdir().expect("app data");
        let store = AiHistoryStore::new(app_data.path()).expect("history store");
        let session_id = SessionId("s-history".to_string());
        store
            .create_session(AiHistorySessionMetadata::new_native(
                AiHistorySessionMetadataInput {
                    session_id: session_id.clone(),
                    runtime_id: RuntimeId("codex".to_string()),
                    runtime_session_id: Some(RuntimeSessionId("runtime-history".to_string())),
                    parent_session_id: None,
                    project_id: None,
                    worktree_id: None,
                    title: "Historical session".to_string(),
                    status: NativeAiSessionStatus::Idle,
                    model_id: None,
                    mode_id: None,
                    reasoning_effort: None,
                    config_values: BTreeMap::new(),
                    cwd: "/tmp/project".to_string(),
                    additional_roots: Vec::new(),
                },
            ))
            .expect("create history session");
        let engine = AiEngine::default();
        engine
            .set_history_store(Some(store.clone()))
            .expect("install history store");

        for status in ["cancelled", "completed", "failed"] {
            engine
                .record_history_event(&AiRuntimeEvent::new(
                    AI_STATUS_EVENT,
                    &json!({
                        "detail": "Terminal turn state",
                        "eventId": format!("comando:turn:message-1:{status}"),
                        "runtimeId": "codex",
                        "runtimeSessionId": "runtime-history",
                        "sessionId": "s-history",
                        "status": status,
                        "title": "Terminal turn state",
                        "turnId": "message-1",
                        "updatedAt": "2026-06-20T00:00:00.000Z"
                    }),
                ))
                .expect("record terminal turn");
        }

        let snapshot = store
            .load_session_snapshot(&session_id)
            .expect("load snapshot")
            .expect("snapshot");
        assert!(snapshot.tool_activity.is_empty());
    }

    #[test]
    fn history_tool_activity_preserves_common_fields_across_updates() {
        let app_data = tempfile::tempdir().expect("app data");
        let store = AiHistoryStore::new(app_data.path()).expect("history store");
        let session_id = SessionId("s-history".to_string());
        store
            .create_session(AiHistorySessionMetadata::new_native(
                AiHistorySessionMetadataInput {
                    session_id: session_id.clone(),
                    runtime_id: RuntimeId("codex".to_string()),
                    runtime_session_id: Some(RuntimeSessionId("runtime-history".to_string())),
                    parent_session_id: None,
                    project_id: None,
                    worktree_id: None,
                    title: "Historical session".to_string(),
                    status: NativeAiSessionStatus::Idle,
                    model_id: None,
                    mode_id: None,
                    reasoning_effort: None,
                    config_values: BTreeMap::new(),
                    cwd: "/tmp/project".to_string(),
                    additional_roots: Vec::new(),
                },
            ))
            .expect("create history session");
        let engine = AiEngine::default();
        engine
            .set_history_store(Some(store.clone()))
            .expect("install history store");

        for payload in [
            json!({
                "diffs": [],
                "kind": "execute",
                "rawInput": { "command": "pnpm test" },
                "runtimeId": "codex",
                "runtimeSessionId": "runtime-history",
                "sessionId": "s-history",
                "status": "in_progress",
                "summary": "Running tests",
                "title": "Run tests",
                "toolCallId": "tool-1",
                "updatedAt": "2026-06-20T00:00:00.000Z"
            }),
            json!({
                "diffs": [],
                "exitCode": 0,
                "kind": "execute",
                "rawOutput": "done",
                "runtimeId": "codex",
                "runtimeSessionId": "runtime-history",
                "sessionId": "s-history",
                "status": "completed",
                "summary": null,
                "terminalOutput": "All tests passed",
                "title": "Run tests",
                "toolCallId": "tool-1",
                "updatedAt": "2026-06-20T00:00:01.000Z"
            }),
        ] {
            engine
                .record_history_event(&AiRuntimeEvent::new(AI_TOOL_ACTIVITY_EVENT, &payload))
                .expect("record tool activity");
        }

        let snapshot = store
            .load_session_snapshot(&session_id)
            .expect("load snapshot")
            .expect("snapshot");
        assert_eq!(snapshot.tool_activity.len(), 1);
        let activity = &snapshot.tool_activity[0];
        assert_eq!(activity["createdAt"], "2026-06-20T00:00:00.000Z");
        assert_eq!(activity["updatedAt"], "2026-06-20T00:00:01.000Z");
        assert_eq!(activity["exitCode"], 0);
        assert_eq!(activity["rawInputJson"], Value::Null);
        assert_eq!(activity["rawOutputJson"], Value::Null);
        assert_eq!(activity["summary"], "Running tests");
        assert_eq!(activity["terminalOutput"], Value::Null);
        let detail = engine
            .load_tool_activity_detail(&session_id, "tool-detail:s-history:tool-1")
            .expect("load detail")
            .expect("stored detail");
        assert_eq!(detail["rawInput"]["command"], "pnpm test");
        assert_eq!(detail["rawOutput"], "done");
        assert_eq!(detail["terminalOutput"], "All tests passed");
    }

    #[test]
    fn prompt_rejects_too_many_image_attachments() {
        let engine = AiEngine::default();
        let input = NativeAiSendPromptInput {
            session_id: SessionId("s1".to_string()),
            target_session_id: None,
            runtime_session_id: None,
            message_id: comando_types::ids::MessageId("m1".to_string()),
            prompt: comando_types::ai::NativeAiPromptInput {
                text: String::new(),
                display_text: None,
                attachments: (0..=MAX_IMAGE_ATTACHMENTS)
                    .map(|index| image_attachment(&format!("image-{index}")))
                    .collect(),
            },
        };

        assert!(matches!(
            engine.send_prompt(input),
            Err(AiError::InvalidInput(message)) if message.contains("attach up to")
        ));
    }

    #[test]
    fn prompt_allows_image_only_input_until_acp_dispatch() {
        let engine = AiEngine::default();
        {
            let mut sessions = engine.lock_sessions().unwrap();
            sessions
                .insert(NativeAiSession::from_prepare_input(prepare_input("s1", "codex")).unwrap())
                .unwrap();
        }
        let input = NativeAiSendPromptInput {
            session_id: SessionId("s1".to_string()),
            target_session_id: None,
            runtime_session_id: None,
            message_id: comando_types::ids::MessageId("m1".to_string()),
            prompt: comando_types::ai::NativeAiPromptInput {
                text: String::new(),
                display_text: None,
                attachments: vec![image_attachment("image-1")],
            },
        };

        assert!(matches!(
            engine.send_prompt(input),
            Err(AiError::Unsupported(message)) if message.contains("ACP-backed session")
        ));
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
                display_text: None,
                attachments: Vec::new(),
            },
        };

        assert!(matches!(
            engine.send_prompt(input),
            Err(AiError::Unsupported(_))
        ));
    }
}
