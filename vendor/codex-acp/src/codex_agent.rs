use acp::schema::{
    AgentAuthCapabilities, AgentCapabilities, AuthEnvVar, AuthMethod, AuthMethodAgent,
    AuthMethodEnvVar, AuthMethodId, AuthenticateRequest, AuthenticateResponse, CancelNotification,
    ClientCapabilities, CloseSessionRequest, CloseSessionResponse, Implementation,
    InitializeRequest, InitializeResponse, ListSessionsRequest, ListSessionsResponse,
    LoadSessionRequest, LoadSessionResponse, LogoutCapabilities, LogoutRequest, LogoutResponse,
    McpCapabilities, McpServer, McpServerHttp, McpServerStdio, NewSessionRequest,
    NewSessionResponse, PromptCapabilities, PromptRequest, PromptResponse, ProtocolVersion,
    ResumeSessionRequest, ResumeSessionResponse, SessionCapabilities, SessionCloseCapabilities,
    SessionId, SessionInfo, SessionListCapabilities, SessionResumeCapabilities,
    SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModeRequest,
    SetSessionModeResponse,
};
use acp::{Agent, Client, ConnectTo, ConnectionTo, Error};
use agent_client_protocol as acp;
use codex_config::{DEFAULT_MCP_SERVER_ENVIRONMENT_ID, McpServerConfig, McpServerTransportConfig};
use codex_core::{
    NewThread, RolloutRecorder, StateDbHandle, ThreadConfigSnapshot, ThreadManager,
    config::{Config, PermissionProfileSnapshot},
    find_thread_path_by_id_str, init_state_db, resolve_installation_id, thread_store_from_config,
};
use codex_exec_server::{EnvironmentManager, ExecServerRuntimePaths};
use codex_extension_api::{
    ExtensionRegistryBuilder, LoadUserInstructionsFuture, LoadedUserInstructions,
    UserInstructionsProvider,
};
use codex_login::{
    CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR,
    auth::{
        AuthKeyringBackendKind, AuthManager, CodexAuth, read_codex_api_key_from_env,
        read_openai_api_key_from_env,
    },
};
use codex_protocol::{
    ThreadId,
    protocol::{InitialHistory, SessionConfiguredEvent, SessionSource},
};
use codex_thread_store::{
    ListThreadsParams, SortDirection as StoreSortDirection, StoredThread,
    ThreadSortKey as StoreThreadSortKey, ThreadStore,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::time::{MissedTickBehavior, interval};
use tracing::{debug, info, warn};

use crate::session_title::stored_session_title;
use crate::subagents;
use crate::thread::Thread;

#[derive(Debug, Default)]
struct EmptyUserInstructionsProvider;

impl UserInstructionsProvider for EmptyUserInstructionsProvider {
    fn load_user_instructions(&self) -> LoadUserInstructionsFuture<'_> {
        Box::pin(async { LoadedUserInstructions::default() })
    }
}

/// The Codex implementation of the ACP Agent.
///
/// This bridges the ACP protocol with the existing codex-rs infrastructure,
/// allowing codex to be used as an ACP agent.
pub struct CodexAgent {
    /// Handle to the current authentication
    auth_manager: Arc<AuthManager>,
    /// Capabilities of the connected client
    client_capabilities: Arc<Mutex<ClientCapabilities>>,
    /// The underlying codex configuration
    config: Config,
    /// Thread manager for handling sessions
    thread_manager: Arc<ThreadManager>,
    /// Store for listing and updating persisted thread metadata
    thread_store: Arc<dyn ThreadStore>,
    /// SQLite-backed Codex state index, when initialization succeeds
    state_db: Option<StateDbHandle>,
    /// Active sessions mapped by `SessionId`
    sessions: Arc<Mutex<HashMap<SessionId, Arc<Thread>>>>,
    /// Session working directories for filesystem sandboxing
    session_roots: Arc<Mutex<HashMap<SessionId, PathBuf>>>,
    /// Registration state for child-session creation notifications.
    subagent_registration_states: Arc<Mutex<HashMap<SessionId, SubagentRegistrationState>>>,
    /// Ensures we only attach one child-thread observer per ACP connection.
    subagent_watcher_started: AtomicBool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubagentRegistrationState {
    Registered,
    Notifying,
    Notified,
}

const SESSION_LIST_PAGE_SIZE: usize = 25;
const SUBAGENT_NOTIFICATION_RETRY_INTERVAL: Duration = Duration::from_secs(1);

fn debug_ai_worker_enabled() -> bool {
    matches!(std::env::var("COMANDO_DEBUG_AI_WORKER").as_deref(), Ok("1"))
}

impl CodexAgent {
    /// Create a new `CodexAgent` with the given configuration
    pub async fn new(
        config: Config,
        codex_linux_sandbox_exe: Option<PathBuf>,
    ) -> std::io::Result<Self> {
        let auth_manager = AuthManager::shared(
            config.codex_home.to_path_buf(),
            false,
            config.cli_auth_credentials_store_mode,
            None,
            Some(config.chatgpt_base_url.clone()),
            AuthKeyringBackendKind::default(),
            None,
        )
        .await;

        let client_capabilities: Arc<Mutex<ClientCapabilities>> = Arc::default();
        let session_roots: Arc<Mutex<HashMap<SessionId, PathBuf>>> = Arc::default();
        let state_db = init_state_db(&config).await;
        let local_runtime_paths =
            ExecServerRuntimePaths::new(std::env::current_exe()?, codex_linux_sandbox_exe)?;
        let environment_manager = Arc::new(
            EnvironmentManager::from_codex_home(&config.codex_home, Some(local_runtime_paths))
                .await
                .map_err(std::io::Error::other)?,
        );
        let thread_store = thread_store_from_config(&config, state_db.clone());
        let installation_id = resolve_installation_id(&config.codex_home).await?;
        let mut extensions = ExtensionRegistryBuilder::<Config>::new();
        codex_image_generation_extension::install(
            &mut extensions,
            auth_manager.clone(),
            |config: &Config| Some(config.codex_home.clone()),
        );
        let thread_manager = Arc::new(ThreadManager::new(
            &config,
            auth_manager.clone(),
            SessionSource::Unknown,
            environment_manager,
            Arc::new(extensions.build()),
            Arc::new(EmptyUserInstructionsProvider),
            None,
            thread_store.clone(),
            None,
            installation_id,
            None,
            None,
        ));
        Ok(Self {
            auth_manager,
            client_capabilities,
            config,
            thread_manager,
            thread_store,
            state_db,
            sessions: Arc::default(),
            session_roots,
            subagent_registration_states: Arc::default(),
            subagent_watcher_started: AtomicBool::new(false),
        })
    }

    /// Build and run the ACP agent, serving requests over the given transport.
    pub async fn serve(
        self: Arc<Self>,
        transport: impl ConnectTo<Agent> + 'static,
    ) -> acp::Result<()> {
        let agent = self;
        Agent
            .builder()
            .name("codex-acp")
            .on_receive_request(
                {
                    let agent = agent.clone();
                    async move |request: InitializeRequest, responder, cx: ConnectionTo<Client>| {
                        agent.ensure_subagent_watcher(cx)?;
                        responder.respond_with_result(agent.initialize(request).await)
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let agent = agent.clone();
                    async move |request: AuthenticateRequest,
                                responder,
                                cx: ConnectionTo<Client>| {
                        let agent = agent.clone();
                        cx.spawn(async move {
                            responder.respond_with_result(agent.authenticate(request).await)
                        })?;
                        Ok(())
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let agent = agent.clone();
                    async move |request: LogoutRequest, responder, cx: ConnectionTo<Client>| {
                        let agent = agent.clone();
                        cx.spawn(async move {
                            responder.respond_with_result(agent.logout(request).await)
                        })?;
                        Ok(())
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let agent = agent.clone();
                    async move |request: NewSessionRequest, responder, cx: ConnectionTo<Client>| {
                        let agent = agent.clone();
                        let session_cx = cx.clone();
                        cx.spawn(async move {
                            responder
                                .respond_with_result(agent.new_session(request, session_cx).await)
                        })?;
                        Ok(())
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let agent = agent.clone();
                    async move |request: LoadSessionRequest, responder, cx: ConnectionTo<Client>| {
                        let agent = agent.clone();
                        let session_cx = cx.clone();
                        cx.spawn(async move {
                            responder
                                .respond_with_result(agent.load_session(request, session_cx).await)
                        })?;
                        Ok(())
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let agent = agent.clone();
                    async move |request: ResumeSessionRequest,
                                responder,
                                cx: ConnectionTo<Client>| {
                        let agent = agent.clone();
                        let session_cx = cx.clone();
                        cx.spawn(async move {
                            responder.respond_with_result(
                                agent.resume_session(request, session_cx).await,
                            )
                        })?;
                        Ok(())
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let agent = agent.clone();
                    async move |request: ListSessionsRequest,
                                responder,
                                cx: ConnectionTo<Client>| {
                        let agent = agent.clone();
                        cx.spawn(async move {
                            responder.respond_with_result(agent.list_sessions(request).await)
                        })?;
                        Ok(())
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let agent = agent.clone();
                    async move |request: CloseSessionRequest,
                                responder,
                                cx: ConnectionTo<Client>| {
                        let agent = agent.clone();
                        cx.spawn(async move {
                            responder.respond_with_result(agent.close_session(request).await)
                        })?;
                        Ok(())
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let agent = agent.clone();
                    async move |request: PromptRequest, responder, cx: ConnectionTo<Client>| {
                        let agent = agent.clone();
                        let prompt_cx = cx.clone();
                        cx.spawn(async move {
                            responder.respond_with_result(
                                agent
                                    .prompt_with_subagent_registration(request, prompt_cx)
                                    .await,
                            )
                        })?;
                        Ok(())
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_notification(
                {
                    let agent = agent.clone();
                    async move |notification: CancelNotification, cx: ConnectionTo<Client>| {
                        let agent = agent.clone();
                        cx.spawn(async move {
                            if let Err(e) = agent.cancel(notification).await {
                                tracing::error!("Error handling cancel: {:?}", e);
                            }
                            Ok(())
                        })?;
                        Ok(())
                    }
                },
                acp::on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let agent = agent.clone();
                    async move |request: SetSessionModeRequest,
                                responder,
                                cx: ConnectionTo<Client>| {
                        let agent = agent.clone();
                        cx.spawn(async move {
                            responder.respond_with_result(agent.set_session_mode(request).await)
                        })?;
                        Ok(())
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let agent = agent.clone();
                    async move |request: SetSessionConfigOptionRequest,
                                responder,
                                cx: ConnectionTo<Client>| {
                        let agent = agent.clone();
                        cx.spawn(async move {
                            responder
                                .respond_with_result(agent.set_session_config_option(request).await)
                        })?;
                        Ok(())
                    }
                },
                acp::on_receive_request!(),
            )
            .connect_to(transport)
            .await
    }

    fn session_id_from_thread_id(thread_id: ThreadId) -> SessionId {
        SessionId::new(thread_id.to_string())
    }

    fn get_thread(&self, session_id: &SessionId) -> Result<Arc<Thread>, Error> {
        Ok(self
            .sessions
            .lock()
            .unwrap()
            .get(session_id)
            .ok_or_else(|| Error::resource_not_found(None))?
            .clone())
    }

    async fn prompt_with_subagent_registration(
        &self,
        request: PromptRequest,
        cx: ConnectionTo<Client>,
    ) -> Result<PromptResponse, Error> {
        if self.get_thread(&request.session_id).is_err()
            && let Ok(thread_id) = ThreadId::from_string(&request.session_id.0)
            && self.thread_manager.get_thread(thread_id).await.is_ok()
        {
            register_subagent_thread(
                thread_id,
                self.thread_manager.clone(),
                self.thread_store.clone(),
                self.sessions.clone(),
                self.session_roots.clone(),
                self.subagent_registration_states.clone(),
                self.auth_manager.clone(),
                Arc::new(self.thread_manager.get_models_manager()),
                self.client_capabilities.clone(),
                self.config.clone(),
                cx,
            )
            .await?;
        }

        self.prompt(request).await
    }

    fn ensure_subagent_watcher(&self, cx: ConnectionTo<Client>) -> acp::Result<()> {
        if self.subagent_watcher_started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let thread_manager = self.thread_manager.clone();
        let thread_store = self.thread_store.clone();
        let sessions = self.sessions.clone();
        let session_roots = self.session_roots.clone();
        let subagent_registration_states = self.subagent_registration_states.clone();
        let auth_manager = self.auth_manager.clone();
        let models_manager = Arc::new(self.thread_manager.get_models_manager());
        let client_capabilities = self.client_capabilities.clone();
        let base_config = self.config.clone();
        let task_cx = cx.clone();

        cx.spawn(async move {
            let mut thread_created_rx = thread_manager.subscribe_thread_created();
            let mut retry_tick = interval(SUBAGENT_NOTIFICATION_RETRY_INTERVAL);
            retry_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
            retry_tick.tick().await;

            loop {
                tokio::select! {
                    result = thread_created_rx.recv() => match result {
                        Ok(thread_id) => {
                            if let Err(error) = register_subagent_thread(
                                thread_id,
                                thread_manager.clone(),
                                thread_store.clone(),
                                sessions.clone(),
                                session_roots.clone(),
                                subagent_registration_states.clone(),
                                auth_manager.clone(),
                                models_manager.clone(),
                                client_capabilities.clone(),
                                base_config.clone(),
                                task_cx.clone(),
                            )
                            .await
                            {
                                warn!(
                                    "Failed to register spawned ACP subagent thread {thread_id}: {error:?}"
                                );
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            warn!("Skipped {skipped} ACP subagent thread creation notifications");
                            for thread_id in thread_manager.list_thread_ids().await {
                                if let Err(error) = register_subagent_thread(
                                    thread_id,
                                    thread_manager.clone(),
                                    thread_store.clone(),
                                    sessions.clone(),
                                    session_roots.clone(),
                                    subagent_registration_states.clone(),
                                    auth_manager.clone(),
                                    models_manager.clone(),
                                    client_capabilities.clone(),
                                    base_config.clone(),
                                    task_cx.clone(),
                                )
                                .await
                                {
                                    warn!(
                                        "Failed to reconcile ACP subagent thread {thread_id}: {error:?}"
                                    );
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    },
                    _ = retry_tick.tick() => {
                        for thread_id in pending_subagent_notification_thread_ids(
                            &subagent_registration_states,
                        ) {
                            if let Err(error) = register_subagent_thread(
                                thread_id,
                                thread_manager.clone(),
                                thread_store.clone(),
                                sessions.clone(),
                                session_roots.clone(),
                                subagent_registration_states.clone(),
                                auth_manager.clone(),
                                models_manager.clone(),
                                client_capabilities.clone(),
                                base_config.clone(),
                                task_cx.clone(),
                            )
                            .await
                            {
                                debug!("Failed to retry pending ACP subagent registration: {error:?}");
                            }
                        }
                    }
                }
            }

            Ok(())
        })?;

        Ok(())
    }

    async fn check_auth(&self) -> Result<(), Error> {
        if self.config.model_provider_id == "openai"
            && self.auth_manager.auth().await.is_none()
            // Check if anything changed on disk since the last reload
            && !self.auth_manager.reload().await
        {
            return Err(Error::auth_required());
        }
        Ok(())
    }

    /// Build a session config from base config, working directory, and MCP servers.
    /// This is shared between `new_session` and `load_session`.
    fn build_session_config(
        &self,
        cwd: &Path,
        mcp_servers: Vec<McpServer>,
    ) -> Result<Config, Error> {
        let mut config = self.config.clone();
        config.cwd = cwd.try_into().map_err(Error::into_internal_error)?;
        let cwd = config.cwd.clone();

        // Propagate any client-provided MCP servers that codex-rs supports.
        let mut new_mcp_servers = config.mcp_servers.get().clone();
        for mcp_server in mcp_servers {
            if let Some((name, server_config)) = mcp_server_config_from_acp(mcp_server, &cwd) {
                new_mcp_servers.insert(name, server_config);
            }
        }

        config
            .mcp_servers
            .set(new_mcp_servers)
            .map_err(|e| anyhow::anyhow!(e))?;

        Ok(config)
    }

    fn sync_config_with_session(
        config: &mut Config,
        session_configured: &SessionConfiguredEvent,
    ) -> Result<(), Error> {
        config.cwd = session_configured
            .cwd
            .clone()
            .try_into()
            .map_err(Error::into_internal_error)?;
        config.model = Some(session_configured.model.clone());
        config.model_provider_id = session_configured.model_provider_id.clone();
        config.model_reasoning_effort = session_configured.reasoning_effort.clone();
        config.service_tier = session_configured.service_tier.clone();
        config.approvals_reviewer = session_configured.approvals_reviewer;
        config
            .permissions
            .approval_policy
            .set(session_configured.approval_policy)
            .map_err(Error::into_internal_error)?;
        Self::sync_permission_profile_snapshot(
            config,
            PermissionProfileSnapshot::from_session_snapshot(
                session_configured.permission_profile.clone(),
                session_configured.active_permission_profile.clone(),
            ),
        )?;
        Ok(())
    }

    fn sync_config_with_thread_snapshot(
        config: &mut Config,
        snapshot: &ThreadConfigSnapshot,
    ) -> Result<(), Error> {
        config.cwd = snapshot.cwd().clone();
        config.model = Some(snapshot.model.clone());
        config.model_provider_id = snapshot.model_provider_id.clone();
        config.model_reasoning_effort = snapshot.reasoning_effort.clone();
        config.service_tier = snapshot.service_tier.clone();
        config.approvals_reviewer = snapshot.approvals_reviewer;
        config
            .permissions
            .set_workspace_roots(snapshot.workspace_roots.clone());
        config
            .permissions
            .approval_policy
            .set(snapshot.approval_policy)
            .map_err(Error::into_internal_error)?;
        let permission_snapshot =
            if let Some(active_permission_profile) = snapshot.active_permission_profile.clone() {
                PermissionProfileSnapshot::active_with_profile_workspace_roots(
                    snapshot.permission_profile.clone(),
                    active_permission_profile,
                    snapshot.profile_workspace_roots.clone(),
                )
            } else {
                PermissionProfileSnapshot::legacy(snapshot.permission_profile.clone())
            };
        Self::sync_permission_profile_snapshot(config, permission_snapshot)?;
        Ok(())
    }

    fn sync_permission_profile_snapshot(
        config: &mut Config,
        snapshot: PermissionProfileSnapshot,
    ) -> Result<(), Error> {
        let replacement_snapshot = snapshot.clone();
        config
            .permissions
            .set_permission_profile_from_session_snapshot(snapshot)
            .or_else(|_| {
                config
                    .permissions
                    .replace_permission_profile_from_session_snapshot(replacement_snapshot)
            })
            .map_err(Error::into_internal_error)
    }
}

#[expect(clippy::too_many_arguments)]
async fn register_subagent_thread(
    child_thread_id: ThreadId,
    thread_manager: Arc<ThreadManager>,
    thread_store: Arc<dyn ThreadStore>,
    sessions: Arc<Mutex<HashMap<SessionId, Arc<Thread>>>>,
    session_roots: Arc<Mutex<HashMap<SessionId, PathBuf>>>,
    subagent_registration_states: Arc<Mutex<HashMap<SessionId, SubagentRegistrationState>>>,
    auth_manager: Arc<AuthManager>,
    models_manager: Arc<dyn crate::thread::ModelsManagerImpl>,
    client_capabilities: Arc<Mutex<ClientCapabilities>>,
    mut config: Config,
    cx: ConnectionTo<Client>,
) -> Result<(), Error> {
    let child_thread = thread_manager
        .get_thread(child_thread_id)
        .await
        .map_err(|error| Error::internal_error().data(error.to_string()))?;
    let snapshot = child_thread.config_snapshot().await;
    let Some(registration) = subagents::registration_for_thread(child_thread_id, &snapshot) else {
        return Ok(());
    };

    let session_was_registered = {
        let mut sessions = sessions.lock().unwrap();
        if sessions.contains_key(&registration.child_session_id) {
            true
        } else {
            CodexAgent::sync_config_with_thread_snapshot(&mut config, &snapshot)?;
            let thread = Arc::new(Thread::new(
                registration.child_session_id.clone(),
                child_thread,
                thread_store,
                child_thread_id,
                auth_manager,
                models_manager,
                client_capabilities,
                config.clone(),
                cx.clone(),
            ));
            sessions.insert(registration.child_session_id.clone(), thread);
            false
        }
    };

    if !session_was_registered {
        let session_root = session_roots
            .lock()
            .unwrap()
            .get(&registration.parent_session_id)
            .cloned()
            .unwrap_or_else(|| config.cwd.to_path_buf());
        session_roots
            .lock()
            .unwrap()
            .insert(registration.child_session_id.clone(), session_root);
    }

    let should_notify = begin_subagent_notification(
        &subagent_registration_states,
        &registration.child_session_id,
    );
    if !should_notify {
        return Ok(());
    }

    match cx.send_notification(subagents::session_created_notification(
        &registration,
        &snapshot,
    )) {
        Ok(()) => {
            finish_subagent_notification(
                &subagent_registration_states,
                registration.child_session_id,
                true,
            );
            Ok(())
        }
        Err(error) => {
            finish_subagent_notification(
                &subagent_registration_states,
                registration.child_session_id,
                false,
            );
            Err(error)
        }
    }
}

fn begin_subagent_notification(
    states: &Arc<Mutex<HashMap<SessionId, SubagentRegistrationState>>>,
    child_session_id: &SessionId,
) -> bool {
    let mut states = states.lock().unwrap();
    match states.get(child_session_id) {
        Some(SubagentRegistrationState::Notified) | Some(SubagentRegistrationState::Notifying) => {
            false
        }
        Some(SubagentRegistrationState::Registered) | None => {
            states.insert(
                child_session_id.clone(),
                SubagentRegistrationState::Notifying,
            );
            true
        }
    }
}

fn finish_subagent_notification(
    states: &Arc<Mutex<HashMap<SessionId, SubagentRegistrationState>>>,
    child_session_id: SessionId,
    delivered: bool,
) {
    states.lock().unwrap().insert(
        child_session_id,
        if delivered {
            SubagentRegistrationState::Notified
        } else {
            SubagentRegistrationState::Registered
        },
    );
}

fn pending_subagent_notification_thread_ids(
    states: &Arc<Mutex<HashMap<SessionId, SubagentRegistrationState>>>,
) -> Vec<ThreadId> {
    states
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, state)| **state == SubagentRegistrationState::Registered)
        .filter_map(|(session_id, _)| ThreadId::from_string(&session_id.0).ok())
        .collect()
}

impl CodexAgent {
    async fn initialize(&self, request: InitializeRequest) -> Result<InitializeResponse, Error> {
        let InitializeRequest {
            protocol_version,
            client_capabilities,
            client_info: _, // TODO: save and pass into Codex somehow
            ..
        } = request;
        debug!("Received initialize request with protocol version {protocol_version:?}",);
        let protocol_version = ProtocolVersion::V1;

        *self.client_capabilities.lock().unwrap() = client_capabilities;

        let mut agent_capabilities = AgentCapabilities::new()
            .prompt_capabilities(PromptCapabilities::new().embedded_context(true).image(true))
            .mcp_capabilities(McpCapabilities::new().http(true))
            .load_session(true)
            .auth(AgentAuthCapabilities::new().logout(LogoutCapabilities::new()));

        agent_capabilities.session_capabilities = SessionCapabilities::new()
            .close(SessionCloseCapabilities::new())
            .list(SessionListCapabilities::new())
            .resume(SessionResumeCapabilities::new());

        let mut auth_methods = vec![
            CodexAuthMethod::ChatGpt.into(),
            CodexAuthMethod::CodexApiKey.into(),
            CodexAuthMethod::OpenAiApiKey.into(),
        ];
        // Until codex device code auth works, we can't use this in remote ssh projects
        if std::env::var("NO_BROWSER").is_ok() {
            auth_methods.remove(0);
        }

        Ok(InitializeResponse::new(protocol_version)
            .agent_capabilities(agent_capabilities)
            .agent_info(Implementation::new("codex-acp", env!("CARGO_PKG_VERSION")).title("Codex"))
            .auth_methods(auth_methods))
    }

    async fn authenticate(
        &self,
        request: AuthenticateRequest,
    ) -> Result<AuthenticateResponse, Error> {
        let auth_method = CodexAuthMethod::try_from(request.method_id)?;

        // Check before starting login flow if already authenticated with the same method
        if let Some(auth) = self.auth_manager.auth().await {
            match (auth, auth_method) {
                (
                    CodexAuth::ApiKey(..),
                    CodexAuthMethod::CodexApiKey | CodexAuthMethod::OpenAiApiKey,
                )
                | (CodexAuth::Chatgpt(..), CodexAuthMethod::ChatGpt) => {
                    return Ok(AuthenticateResponse::new());
                }
                _ => {}
            }
        }

        match auth_method {
            CodexAuthMethod::ChatGpt => {
                // Perform browser/device login via codex-rs, then report success/failure to the client.
                let opts = codex_login::ServerOptions::new(
                    self.config.codex_home.to_path_buf(),
                    codex_login::auth::CLIENT_ID.to_string(),
                    None,
                    self.config.cli_auth_credentials_store_mode,
                    AuthKeyringBackendKind::default(),
                    None,
                );

                let server =
                    codex_login::run_login_server(opts).map_err(Error::into_internal_error)?;

                server
                    .block_until_done()
                    .await
                    .map_err(Error::into_internal_error)?;
            }
            CodexAuthMethod::CodexApiKey => {
                let api_key = read_codex_api_key_from_env().ok_or_else(|| {
                    Error::internal_error().data(format!("{CODEX_API_KEY_ENV_VAR} is not set"))
                })?;
                codex_login::login_with_api_key(
                    &self.config.codex_home,
                    &api_key,
                    self.config.cli_auth_credentials_store_mode,
                    AuthKeyringBackendKind::default(),
                )
                .map_err(Error::into_internal_error)?;
            }
            CodexAuthMethod::OpenAiApiKey => {
                let api_key = read_openai_api_key_from_env().ok_or_else(|| {
                    Error::internal_error().data(format!("{OPENAI_API_KEY_ENV_VAR} is not set"))
                })?;
                codex_login::login_with_api_key(
                    &self.config.codex_home,
                    &api_key,
                    self.config.cli_auth_credentials_store_mode,
                    AuthKeyringBackendKind::default(),
                )
                .map_err(Error::into_internal_error)?;
            }
        }

        self.auth_manager.reload().await;

        Ok(AuthenticateResponse::new())
    }

    async fn logout(&self, _request: LogoutRequest) -> Result<LogoutResponse, Error> {
        self.auth_manager
            .logout()
            .await
            .map_err(Error::into_internal_error)?;
        Ok(LogoutResponse::new())
    }

    async fn new_session(
        &self,
        request: NewSessionRequest,
        cx: ConnectionTo<Client>,
    ) -> Result<NewSessionResponse, Error> {
        // Check before sending if authentication was successful or not
        self.check_auth().await?;

        let NewSessionRequest {
            cwd, mcp_servers, ..
        } = request;
        info!("Creating new session with cwd: {}", cwd.display());

        let mut config = self.build_session_config(&cwd, mcp_servers)?;
        let num_mcp_servers = config.mcp_servers.len();

        let NewThread {
            thread_id,
            thread,
            session_configured,
        } = Box::pin(self.thread_manager.start_thread(config.clone()))
            .await
            .map_err(|_e| Error::internal_error())?;

        Self::sync_config_with_session(&mut config, &session_configured)?;

        let session_id = Self::session_id_from_thread_id(thread_id);
        // Record the session root for filesystem sandboxing.
        self.session_roots
            .lock()
            .unwrap()
            .insert(session_id.clone(), config.cwd.to_path_buf());
        let thread = Arc::new(Thread::new(
            session_id.clone(),
            thread,
            self.thread_store.clone(),
            thread_id,
            self.auth_manager.clone(),
            Arc::new(self.thread_manager.get_models_manager()),
            self.client_capabilities.clone(),
            config.clone(),
            cx,
        ));
        let load = thread.load().await?;

        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), thread);

        debug!("Created new session with {} MCP servers", num_mcp_servers);

        Ok(NewSessionResponse::new(session_id)
            .modes(load.modes)
            .config_options(load.config_options))
    }

    async fn load_session(
        &self,
        request: LoadSessionRequest,
        cx: ConnectionTo<Client>,
    ) -> Result<LoadSessionResponse, Error> {
        info!("Loading session: {}", request.session_id);
        // Check before sending if authentication was successful or not
        self.check_auth().await?;

        let LoadSessionRequest {
            session_id,
            cwd,
            mcp_servers,
            ..
        } = request;

        self.restore_session(session_id, cwd, mcp_servers, cx, true)
            .await
    }

    async fn resume_session(
        &self,
        request: ResumeSessionRequest,
        cx: ConnectionTo<Client>,
    ) -> Result<ResumeSessionResponse, Error> {
        info!("Resuming session: {}", request.session_id);
        // Check before sending if authentication was successful or not
        self.check_auth().await?;

        let ResumeSessionRequest {
            session_id,
            cwd,
            mcp_servers,
            ..
        } = request;

        let load = self
            .restore_session(session_id, cwd, mcp_servers, cx, false)
            .await?;

        Ok(ResumeSessionResponse::new()
            .modes(load.modes)
            .config_options(load.config_options))
    }

    async fn restore_session(
        &self,
        session_id: SessionId,
        cwd: PathBuf,
        mcp_servers: Vec<McpServer>,
        cx: ConnectionTo<Client>,
        replay_history: bool,
    ) -> Result<LoadSessionResponse, Error> {
        let rollout_path = find_thread_path_by_id_str(
            &self.config.codex_home,
            session_id.0.as_ref(),
            self.state_db.as_deref(),
        )
        .await
        .map_err(|e| Error::internal_error().data(e.to_string()))?
        .ok_or_else(|| Error::resource_not_found(None))?;

        let rollout_items = if replay_history {
            let history = RolloutRecorder::get_rollout_history(&rollout_path)
                .await
                .map_err(|e| Error::internal_error().data(e.to_string()))?;

            match &history {
                InitialHistory::Resumed(resumed) => resumed.history.clone().as_ref().clone(),
                InitialHistory::Forked(items) => items.clone(),
                InitialHistory::Cleared | InitialHistory::New => Vec::new(),
            }
        } else {
            Vec::new()
        };

        let mut config = self.build_session_config(&cwd, mcp_servers)?;

        let NewThread {
            thread_id,
            thread,
            session_configured,
        } = Box::pin(self.thread_manager.resume_thread_from_rollout(
            config.clone(),
            rollout_path,
            self.auth_manager.clone(),
            None,
            false,
        ))
        .await
        .map_err(|e| Error::internal_error().data(e.to_string()))?;

        Self::sync_config_with_session(&mut config, &session_configured)?;

        let thread = Arc::new(Thread::new(
            session_id.clone(),
            thread,
            self.thread_store.clone(),
            thread_id,
            self.auth_manager.clone(),
            Arc::new(self.thread_manager.get_models_manager()),
            self.client_capabilities.clone(),
            config.clone(),
            cx,
        ));

        if replay_history {
            thread.replay_history(rollout_items).await?;
        }

        let load = thread.load().await?;

        self.session_roots
            .lock()
            .unwrap()
            .insert(session_id.clone(), config.cwd.to_path_buf());
        self.sessions.lock().unwrap().insert(session_id, thread);

        Ok(LoadSessionResponse::new()
            .modes(load.modes)
            .config_options(load.config_options))
    }

    async fn list_sessions(
        &self,
        request: ListSessionsRequest,
    ) -> Result<ListSessionsResponse, Error> {
        self.check_auth().await?;

        let ListSessionsRequest { cwd, cursor, .. } = request;
        let allowed_sources = list_session_allowed_sources();
        let cwd_filter = cwd.clone();

        let page = self
            .thread_store
            .list_threads(list_sessions_params(cwd, cursor, &allowed_sources))
            .await
            .map_err(|err| {
                Error::internal_error().data(format!("failed to list sessions: {err}"))
            })?;

        let sessions = page
            .items
            .into_iter()
            .filter(|item| {
                stored_thread_matches_list_request(
                    &item.source,
                    item.cwd.as_path(),
                    &allowed_sources,
                    cwd_filter.as_deref(),
                )
            })
            .map(stored_thread_session_info)
            .collect::<Vec<_>>();

        Ok(ListSessionsResponse::new(sessions).next_cursor(page.next_cursor))
    }

    async fn close_session(
        &self,
        request: CloseSessionRequest,
    ) -> Result<CloseSessionResponse, Error> {
        self.get_thread(&request.session_id)?.shutdown().await?;
        self.thread_manager
            .remove_thread(
                &ThreadId::from_string(&request.session_id.0)
                    .map_err(Error::into_internal_error)?,
            )
            .await;
        self.sessions.lock().unwrap().remove(&request.session_id);
        self.session_roots
            .lock()
            .unwrap()
            .remove(&request.session_id);

        Ok(CloseSessionResponse::new())
    }
    async fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, Error> {
        info!("Processing prompt for session: {}", request.session_id);
        // Check before sending if authentication was successful or not
        self.check_auth().await?;

        // Get the session state
        let session_id = request.session_id.clone();
        let thread = self.get_thread(&session_id)?;
        if debug_ai_worker_enabled() {
            info!(
                prompt_items = request.prompt.len(),
                session_id = %session_id,
                "diagnostic: submitting ACP prompt"
            );
        }
        let stop_reason = thread.prompt(request).await.inspect_err(|error| {
            warn!("Prompt failed for session {session_id}: {error}");
            if debug_ai_worker_enabled() {
                info!(
                    error = %error,
                    session_id = %session_id,
                    "diagnostic: ACP prompt failed without live replay retry"
                );
            }
        })?;
        if debug_ai_worker_enabled() {
            info!(
                session_id = %session_id,
                "diagnostic: ACP prompt completed"
            );
        }

        Ok(PromptResponse::new(stop_reason))
    }

    async fn cancel(&self, args: CancelNotification) -> Result<(), Error> {
        info!("Cancelling operations for session: {}", args.session_id);
        self.get_thread(&args.session_id)?.cancel().await?;
        Ok(())
    }

    async fn set_session_mode(
        &self,
        args: SetSessionModeRequest,
    ) -> Result<SetSessionModeResponse, Error> {
        info!("Setting session mode for session: {}", args.session_id);
        self.get_thread(&args.session_id)?
            .set_mode(args.mode_id)
            .await?;
        Ok(SetSessionModeResponse::default())
    }

    async fn set_session_config_option(
        &self,
        args: SetSessionConfigOptionRequest,
    ) -> Result<SetSessionConfigOptionResponse, Error> {
        info!(
            "Setting session config option for session: {} (config_id: {}, value: {:?})",
            args.session_id, args.config_id.0, args.value
        );

        let thread = self.get_thread(&args.session_id)?;

        let config_options = thread.set_config_option(args.config_id, args.value).await?;

        Ok(SetSessionConfigOptionResponse::new(config_options))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexAuthMethod {
    ChatGpt,
    CodexApiKey,
    OpenAiApiKey,
}

impl From<CodexAuthMethod> for AuthMethodId {
    fn from(method: CodexAuthMethod) -> Self {
        Self::new(match method {
            CodexAuthMethod::ChatGpt => "chatgpt",
            CodexAuthMethod::CodexApiKey => "codex-api-key",
            CodexAuthMethod::OpenAiApiKey => "openai-api-key",
        })
    }
}

impl From<CodexAuthMethod> for AuthMethod {
    fn from(method: CodexAuthMethod) -> Self {
        match method {
            CodexAuthMethod::ChatGpt => Self::Agent(
                AuthMethodAgent::new(method, "Login with ChatGPT").description(
                    "Use your ChatGPT login with Codex CLI (requires a paid ChatGPT subscription)",
                ),
            ),
            CodexAuthMethod::CodexApiKey => Self::EnvVar(
                AuthMethodEnvVar::new(
                    method,
                    format!("Use {CODEX_API_KEY_ENV_VAR}"),
                    vec![AuthEnvVar::new(CODEX_API_KEY_ENV_VAR)],
                )
                .description(format!(
                    "Requires setting the `{CODEX_API_KEY_ENV_VAR}` environment variable."
                )),
            ),
            CodexAuthMethod::OpenAiApiKey => Self::EnvVar(
                AuthMethodEnvVar::new(
                    method,
                    format!("Use {OPENAI_API_KEY_ENV_VAR}"),
                    vec![AuthEnvVar::new(OPENAI_API_KEY_ENV_VAR)],
                )
                .description(format!(
                    "Requires setting the `{OPENAI_API_KEY_ENV_VAR}` environment variable."
                )),
            ),
        }
    }
}

impl TryFrom<AuthMethodId> for CodexAuthMethod {
    type Error = Error;

    fn try_from(value: AuthMethodId) -> Result<Self, Self::Error> {
        match value.0.as_ref() {
            "chatgpt" => Ok(CodexAuthMethod::ChatGpt),
            "codex-api-key" => Ok(CodexAuthMethod::CodexApiKey),
            "openai-api-key" => Ok(CodexAuthMethod::OpenAiApiKey),
            _ => Err(Error::invalid_params().data("unsupported authentication method")),
        }
    }
}

fn normalize_mcp_server_name(name: String) -> String {
    // Codex does not allow whitespace in MCP server names; replace with underscores.
    name.replace(|c: char| c.is_whitespace(), "_")
}

fn default_client_mcp_server_config(transport: McpServerTransportConfig) -> McpServerConfig {
    McpServerConfig {
        transport,
        required: false,
        enabled: true,
        startup_timeout_sec: None,
        tool_timeout_sec: None,
        disabled_tools: None,
        enabled_tools: None,
        disabled_reason: None,
        scopes: None,
        oauth: None,
        oauth_resource: None,
        tools: Default::default(),
        environment_id: DEFAULT_MCP_SERVER_ENVIRONMENT_ID.to_string(),
        supports_parallel_tool_calls: false,
        default_tools_approval_mode: None,
        auth: Default::default(),
    }
}

fn mcp_server_config_from_acp(
    mcp_server: McpServer,
    cwd: &Path,
) -> Option<(String, McpServerConfig)> {
    match mcp_server {
        // Not supported in codex.
        McpServer::Sse(..) => None,
        McpServer::Http(McpServerHttp {
            name, url, headers, ..
        }) => Some((
            normalize_mcp_server_name(name),
            default_client_mcp_server_config(McpServerTransportConfig::StreamableHttp {
                url,
                bearer_token_env_var: None,
                http_headers: if headers.is_empty() {
                    None
                } else {
                    Some(headers.into_iter().map(|h| (h.name, h.value)).collect())
                },
                env_http_headers: None,
            }),
        )),
        McpServer::Stdio(McpServerStdio {
            name,
            command,
            args,
            env,
            ..
        }) => Some((
            normalize_mcp_server_name(name),
            default_client_mcp_server_config(McpServerTransportConfig::Stdio {
                command: command.display().to_string(),
                args,
                env: if env.is_empty() {
                    None
                } else {
                    Some(env.into_iter().map(|env| (env.name, env.value)).collect())
                },
                env_vars: vec![],
                cwd: Some(codex_utils_path_uri::LegacyAppPathString::from_path(cwd)),
            }),
        )),
        _ => None,
    }
}

fn list_session_allowed_sources() -> Vec<SessionSource> {
    vec![
        SessionSource::Cli,
        SessionSource::VSCode,
        SessionSource::Unknown,
    ]
}

fn list_sessions_params(
    cwd: Option<PathBuf>,
    cursor: Option<String>,
    allowed_sources: &[SessionSource],
) -> ListThreadsParams {
    ListThreadsParams {
        page_size: SESSION_LIST_PAGE_SIZE,
        cursor,
        sort_key: StoreThreadSortKey::UpdatedAt,
        sort_direction: StoreSortDirection::Desc,
        allowed_sources: allowed_sources.to_vec(),
        model_providers: None,
        cwd_filters: cwd.map(|cwd| vec![cwd]),
        archived: false,
        search_term: None,
        relation_filter: None,
        use_state_db_only: false,
    }
}

fn stored_thread_matches_list_request(
    source: &SessionSource,
    cwd: &Path,
    allowed_sources: &[SessionSource],
    cwd_filter: Option<&Path>,
) -> bool {
    allowed_sources.contains(source) && cwd_filter.is_none_or(|filter_cwd| cwd == filter_cwd)
}

fn stored_thread_session_info(item: StoredThread) -> SessionInfo {
    let title = stored_session_title(&item);
    let updated_at = item.updated_at.to_rfc3339();

    SessionInfo::new(SessionId::new(item.thread_id.to_string()), item.cwd)
        .title(title)
        .updated_at(updated_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use acp::schema::{EnvVariable, HttpHeader};

    #[test]
    fn subagent_creation_notification_retries_until_it_is_delivered() {
        let states = Arc::new(Mutex::new(HashMap::new()));
        let child_session_id = SessionId::new("child-thread");

        assert!(begin_subagent_notification(&states, &child_session_id));
        finish_subagent_notification(&states, child_session_id.clone(), false);

        assert!(begin_subagent_notification(&states, &child_session_id));
        finish_subagent_notification(&states, child_session_id.clone(), false);

        assert!(begin_subagent_notification(&states, &child_session_id));
        finish_subagent_notification(&states, child_session_id.clone(), true);

        assert!(!begin_subagent_notification(&states, &child_session_id));
    }

    #[test]
    fn list_sessions_params_preserve_cursor_and_filters_active_threads() {
        let allowed_sources = list_session_allowed_sources();
        let cwd = PathBuf::from("/workspace/project");
        let params = list_sessions_params(
            Some(cwd.clone()),
            Some("cursor-1".to_string()),
            &allowed_sources,
        );

        assert_eq!(params.page_size, SESSION_LIST_PAGE_SIZE);
        assert_eq!(params.cursor, Some("cursor-1".to_string()));
        assert_eq!(params.sort_key, StoreThreadSortKey::UpdatedAt);
        assert_eq!(params.sort_direction, StoreSortDirection::Desc);
        assert_eq!(params.allowed_sources, allowed_sources);
        assert_eq!(params.cwd_filters, Some(vec![cwd]));
        assert!(!params.archived);
        assert_eq!(params.model_providers, None);
        assert_eq!(params.search_term, None);
        assert!(!params.use_state_db_only);
    }

    #[test]
    fn stored_thread_filter_respects_source_and_exact_cwd() {
        let allowed_sources = list_session_allowed_sources();

        assert!(stored_thread_matches_list_request(
            &SessionSource::Cli,
            Path::new("/workspace/project"),
            &allowed_sources,
            Some(Path::new("/workspace/project")),
        ));
        assert!(!stored_thread_matches_list_request(
            &SessionSource::Cli,
            Path::new("/workspace/project"),
            &allowed_sources,
            Some(Path::new("/workspace/other")),
        ));
        assert!(!stored_thread_matches_list_request(
            &SessionSource::Exec,
            Path::new("/workspace/project"),
            &allowed_sources,
            Some(Path::new("/workspace/project")),
        ));
    }

    #[test]
    fn client_http_mcp_server_preserves_headers_and_local_environment() {
        let (name, config) = mcp_server_config_from_acp(
            McpServer::Http(
                McpServerHttp::new("Remote Tools", "https://example.com/mcp").headers(vec![
                    HttpHeader::new("Authorization", "Bearer token"),
                    HttpHeader::new("X-Workspace", "comando"),
                ]),
            ),
            Path::new("/workspace/project"),
        )
        .expect("http MCP server should be supported");

        assert_eq!(name, "Remote_Tools");
        assert_eq!(config.environment_id, DEFAULT_MCP_SERVER_ENVIRONMENT_ID);
        assert!(config.enabled);
        assert!(!config.required);
        match config.transport {
            McpServerTransportConfig::StreamableHttp {
                url,
                bearer_token_env_var,
                http_headers,
                env_http_headers,
            } => {
                assert_eq!(url, "https://example.com/mcp");
                assert_eq!(bearer_token_env_var, None);
                assert_eq!(env_http_headers, None);
                let headers = http_headers.expect("headers should be preserved");
                assert_eq!(
                    headers.get("Authorization").map(String::as_str),
                    Some("Bearer token"),
                );
                assert_eq!(
                    headers.get("X-Workspace").map(String::as_str),
                    Some("comando")
                );
            }
            _ => panic!("expected streamable HTTP MCP transport"),
        }
    }

    #[test]
    fn client_stdio_mcp_server_preserves_env_cwd_and_local_environment() {
        let cwd = Path::new("/workspace/project");
        let (name, config) = mcp_server_config_from_acp(
            McpServer::Stdio(
                McpServerStdio::new("Local Tools", "/usr/bin/env")
                    .args(vec!["node".to_string(), "server.js".to_string()])
                    .env(vec![EnvVariable::new("API_KEY", "secret")]),
            ),
            cwd,
        )
        .expect("stdio MCP server should be supported");

        assert_eq!(name, "Local_Tools");
        assert_eq!(config.environment_id, DEFAULT_MCP_SERVER_ENVIRONMENT_ID);
        assert!(config.enabled);
        assert!(!config.required);
        match config.transport {
            McpServerTransportConfig::Stdio {
                command,
                args,
                env,
                env_vars,
                cwd: server_cwd,
            } => {
                assert_eq!(command, "/usr/bin/env");
                assert_eq!(args, vec!["node".to_string(), "server.js".to_string()]);
                assert_eq!(
                    env.expect("env should be preserved")
                        .get("API_KEY")
                        .map(String::as_str),
                    Some("secret"),
                );
                assert!(env_vars.is_empty());
                assert_eq!(
                    server_cwd.map(|path| path.render_for_ui()),
                    Some(cwd.to_string_lossy().into_owned()),
                );
            }
            _ => panic!("expected stdio MCP transport"),
        }
    }

    #[test]
    fn client_sse_mcp_server_is_ignored() {
        let server = serde_json::from_value::<McpServer>(serde_json::json!({
            "type": "sse",
            "name": "Legacy SSE",
            "url": "https://example.com/sse",
            "headers": []
        }))
        .expect("sse MCP server should deserialize");

        assert!(mcp_server_config_from_acp(server, Path::new("/workspace/project")).is_none());
    }
}
