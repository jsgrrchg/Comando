use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use comando_settings::{RuntimeSetupState, RuntimeSetupStore};
use comando_types::ai::{
    NativeAiAuthHandshakeSpec, NativeAiAuthMethod, NativeAiCredentialSource,
    NativeAiDesiredSelections, NativeAiLaunchSpec, NativeAiPrepareSessionInput,
    NativeAiRuntimeSessionMapping, NativeAiRuntimeStatus,
};
use comando_types::ids::{RuntimeId, RuntimeSessionId};
use serde_json::json;

use crate::error::{AiError, AiResult};
use crate::events::now_iso8601;
use crate::runtime::RuntimeDefinition;

const SESSION_AUTH_MESSAGE: &str =
    "This affects new sessions. Active sessions may keep using credentials loaded at launch.";

#[derive(Debug, Clone)]
pub struct RuntimeResolvedSetup {
    pub launch: NativeAiLaunchSpec,
}

#[derive(Debug, Clone)]
struct ResolvedCommand {
    executable: String,
    args: Vec<String>,
    command: Option<String>,
    source: Option<String>,
    state: String,
    message: Option<String>,
    has_custom_binary_path: bool,
}

#[derive(Debug, Clone)]
struct RuntimeAuthState {
    method: Option<String>,
    credential_source: NativeAiCredentialSource,
    ready: bool,
    message: Option<String>,
    has_gateway_config: bool,
    has_gateway_url: bool,
    can_disconnect: bool,
    can_logout: bool,
}

pub fn runtime_status(
    store: &RuntimeSetupStore,
    definition: RuntimeDefinition,
) -> AiResult<NativeAiRuntimeStatus> {
    let setup = load_runtime_setup(store, definition.id)?;
    let command = resolve_runtime_command(definition, &setup);
    let auth = runtime_auth_state(store, definition.id, &setup);
    Ok(status_from_parts(definition, &setup, &command, &auth))
}

pub fn prepare_runtime_launch(
    store: &RuntimeSetupStore,
    definition: RuntimeDefinition,
    input: &NativeAiPrepareSessionInput,
) -> AiResult<RuntimeResolvedSetup> {
    let setup = load_runtime_setup(store, definition.id)?;
    let command = resolve_runtime_command(definition, &setup);
    let auth = runtime_auth_state(store, definition.id, &setup);
    let status = status_from_parts(definition, &setup, &command, &auth);
    if command.state != "ready" {
        return Err(AiError::RuntimeNotReady {
            runtime_id: definition.id.to_string(),
            message: status
                .message
                .clone()
                .unwrap_or_else(|| "Native runtime binary is not ready.".to_string()),
        });
    }
    if !auth.ready {
        return Err(AiError::RuntimeAuthMissing {
            runtime_id: definition.id.to_string(),
            message: status
                .message
                .clone()
                .unwrap_or_else(|| "Native runtime authentication is not ready.".to_string()),
        });
    }
    let executable = command.executable.clone();
    let env = runtime_spawn_env(store, definition.id, &setup, &auth, &executable);
    let auth_credential_source = credential_source_wire(&auth.credential_source);
    let auth_handshake = if definition.id == "grok" {
        Some(NativeAiAuthHandshakeSpec {
            env_method_id: "xai.api_key".to_string(),
            external_method_id: "cached_token".to_string(),
            meta: BTreeMap::from([("headless".to_string(), json!(true))]),
        })
    } else {
        None
    };
    let launch = NativeAiLaunchSpec {
        runtime_id: RuntimeId(definition.id.to_string()),
        owner_window_id: input.window_id.clone(),
        project_id: input.project_id.clone(),
        worktree_id: input.worktree_id.clone(),
        project_root: input.project_id.as_ref().map(|_| input.cwd.clone()),
        additional_roots: input.additional_roots.clone(),
        executable: command.executable,
        args: command.args.clone(),
        cwd: input.cwd.clone(),
        env,
        command: command
            .command
            .clone()
            .unwrap_or_else(|| command_line(&executable, &command.args)),
        status,
        auth_method: auth.method.clone(),
        auth_credential_source,
        auth_handshake,
        persisted_runtime_session_id: None::<RuntimeSessionId>,
        persisted_subagent_session_mappings: Vec::<NativeAiRuntimeSessionMapping>::new(),
        desired_selections: NativeAiDesiredSelections {
            model_id: input.model_id.clone(),
            mode_id: input.mode_id.clone(),
            config_options: input.config_options.clone(),
        },
    };
    Ok(RuntimeResolvedSetup { launch })
}

fn load_runtime_setup(
    store: &RuntimeSetupStore,
    runtime_id: &str,
) -> AiResult<RuntimeSetupState> {
    store.load_runtime(runtime_id).map_err(|error| {
        AiError::Internal(format!("Native runtime setup load failed: {error}"))
    })
}

fn status_from_parts(
    definition: RuntimeDefinition,
    _setup: &RuntimeSetupState,
    command: &ResolvedCommand,
    auth: &RuntimeAuthState,
) -> NativeAiRuntimeStatus {
    let binary_ready = command.state == "ready";
    let message = if binary_ready && !auth.ready {
        auth.message.clone()
    } else {
        command.message.clone().or_else(|| auth.message.clone())
    };
    NativeAiRuntimeStatus {
        runtime_id: RuntimeId(definition.id.to_string()),
        state: command.state.clone(),
        auth_method: auth.method.clone(),
        auth_methods: auth_methods(definition.id),
        auth_ready: auth.ready,
        auth_credential_source: Some(auth.credential_source.clone()),
        auth_credential_source_label: Some(credential_source_label(
            definition.id,
            &auth.credential_source,
        )),
        auth_session_message: Some(SESSION_AUTH_MESSAGE.to_string()),
        auth_storage_message: None,
        can_disconnect_auth: auth.can_disconnect,
        can_logout_auth: auth.can_logout,
        checked_at: now_iso8601(),
        command: command.command.clone(),
        message,
        onboarding_required: !binary_ready || !auth.ready,
        source: command.source.clone(),
        has_custom_binary_path: command.has_custom_binary_path,
        has_gateway_config: auth.has_gateway_config,
        has_gateway_url: auth.has_gateway_url,
    }
}

fn resolve_runtime_command(definition: RuntimeDefinition, setup: &RuntimeSetupState) -> ResolvedCommand {
    let env_var = match definition.id {
        "codex" => "COMANDO_CODEX_ACP_BIN",
        "claude" => "COMANDO_CLAUDE_ACP_BIN",
        "grok" => "COMANDO_GROK_ACP_BIN",
        "kilo" => "COMANDO_KILO_ACP_BIN",
        "opencode" => "COMANDO_OPENCODE_ACP_BIN",
        _ => "",
    };
    if let Ok(value) = env::var(env_var) {
        if !value.trim().is_empty() {
            return resolve_command_candidate(definition, value.trim(), "env");
        }
    }
    if let Some(binary_path) = setup.binary_path.as_deref() {
        if !binary_path.trim().is_empty() {
            return resolve_command_candidate(definition, binary_path.trim(), "settings");
        }
    }
    if let Some(candidate) = find_bundled_runtime(definition) {
        return command_from_existing_path(definition, candidate, "bundled");
    }
    if let Some(candidate) = find_vendor_runtime(definition) {
        return command_from_existing_path(definition, candidate, "vendor");
    }
    if let Some(candidate) = resolve_from_runtime_path(definition.default_executable, None) {
        return command_from_existing_path(definition, candidate, "path");
    }
    if definition.id == "codex" {
        if let Some(candidate) = resolve_from_runtime_path("codex", None) {
            return ResolvedCommand {
                executable: candidate.display().to_string(),
                args: Vec::new(),
                command: Some(candidate.display().to_string()),
                source: Some("path".to_string()),
                state: "error".to_string(),
                message: Some("`codex` was found, but this CLI exposes App Server/MCP instead of an ACP runtime. Current Comando integration still uses ACP.".to_string()),
                has_custom_binary_path: false,
            };
        }
    }
    ResolvedCommand {
        executable: definition.default_executable.to_string(),
        args: definition_args(definition),
        command: None,
        source: None,
        state: "missing".to_string(),
        message: Some(missing_binary_message(definition.id).to_string()),
        has_custom_binary_path: false,
    }
}

fn resolve_command_candidate(
    definition: RuntimeDefinition,
    raw: &str,
    source: &str,
) -> ResolvedCommand {
    let looks_like_path = raw.contains(std::path::MAIN_SEPARATOR)
        || raw.contains('/')
        || raw.contains('\\')
        || Path::new(raw).is_absolute();
    if looks_like_path {
        let candidate = PathBuf::from(raw);
        let candidate = if candidate.is_absolute() {
            candidate
        } else {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(candidate)
        };
        if !is_file(&candidate) || !is_executable_or_script(&candidate) {
            return ResolvedCommand {
                executable: candidate.display().to_string(),
                args: Vec::new(),
                command: Some(candidate.display().to_string()),
                source: Some(source.to_string()),
                state: "error".to_string(),
                message: Some(format!(
                    "Could not execute the configured {} runtime: {}",
                    definition.display_name,
                    candidate.display()
                )),
                has_custom_binary_path: source == "settings",
            };
        }
        return command_from_existing_path(definition, candidate, source);
    }
    if let Some(candidate) = resolve_from_runtime_path(raw, None) {
        return command_from_existing_path(definition, candidate, source);
    }
    ResolvedCommand {
        executable: raw.to_string(),
        args: Vec::new(),
        command: Some(raw.to_string()),
        source: Some(source.to_string()),
        state: "missing".to_string(),
        message: Some(format!("Configured command was not found: {raw}")),
        has_custom_binary_path: source == "settings",
    }
}

fn command_from_existing_path(
    definition: RuntimeDefinition,
    candidate: PathBuf,
    source: &str,
) -> ResolvedCommand {
    let executable = candidate.display().to_string();
    if definition.id == "codex" && is_codex_mcp_cli(&candidate) {
        return ResolvedCommand {
            executable: executable.clone(),
            args: Vec::new(),
            command: Some(executable),
            source: Some(source.to_string()),
            state: "error".to_string(),
            message: Some("`codex` was found, but this CLI exposes App Server/MCP instead of an ACP runtime. Current Comando integration still uses ACP.".to_string()),
            has_custom_binary_path: source == "settings",
        };
    }
    let args = definition_args(definition);
    let command = command_line(&executable, &args);
    ResolvedCommand {
        executable,
        args,
        command: Some(command),
        source: Some(source.to_string()),
        state: "ready".to_string(),
        message: None,
        has_custom_binary_path: source == "settings",
    }
}

fn runtime_auth_state(
    store: &RuntimeSetupStore,
    runtime_id: &str,
    setup: &RuntimeSetupState,
) -> RuntimeAuthState {
    match runtime_id {
        "codex" => codex_auth_state(store, setup),
        "claude" => claude_auth_state(store, setup),
        "grok" => grok_auth_state(store, setup),
        "kilo" => kilo_auth_state(store, setup),
        "opencode" => opencode_auth_state(setup),
        _ => RuntimeAuthState {
            method: None,
            credential_source: NativeAiCredentialSource::None,
            ready: false,
            message: Some("Unknown runtime.".to_string()),
            has_gateway_config: false,
            has_gateway_url: false,
            can_disconnect: false,
            can_logout: false,
        },
    }
}

fn codex_auth_state(store: &RuntimeSetupStore, setup: &RuntimeSetupState) -> RuntimeAuthState {
    let codex_env = env_secret_present("CODEX_API_KEY");
    let openai_env = env_secret_present("OPENAI_API_KEY");
    let codex_secret = secret_present(store, "codex", "CODEX_API_KEY");
    let openai_secret = secret_present(store, "codex", "OPENAI_API_KEY");
    let selected = normalize_auth_method(
        setup.auth_method.as_deref(),
        &["chatgpt", "codex-api-key", "openai-api-key"],
    );
    let method = if codex_env {
        Some("codex-api-key".to_string())
    } else if openai_env {
        Some("openai-api-key".to_string())
    } else if selected.as_deref() == Some("chatgpt") {
        selected
    } else if selected.as_deref() == Some("codex-api-key") && codex_secret {
        selected
    } else if selected.as_deref() == Some("openai-api-key") && openai_secret {
        selected
    } else if selected.is_some() {
        None
    } else if codex_secret {
        Some("codex-api-key".to_string())
    } else if openai_secret {
        Some("openai-api-key".to_string())
    } else {
        None
    };
    let credential_source = match method.as_deref() {
        Some("codex-api-key") if codex_env => NativeAiCredentialSource::Environment,
        Some("openai-api-key") if openai_env => NativeAiCredentialSource::Environment,
        Some("codex-api-key") | Some("openai-api-key") => NativeAiCredentialSource::ComandoSecret,
        Some("chatgpt") => NativeAiCredentialSource::ExternalRuntime,
        _ => NativeAiCredentialSource::None,
    };
    RuntimeAuthState {
        ready: method.is_some(),
        method: method.clone(),
        credential_source,
        message: if method.is_none() {
            Some("Log in with ChatGPT or add an API key to finish setup.".to_string())
        } else {
            None
        },
        has_gateway_config: false,
        has_gateway_url: false,
        can_disconnect: setup.auth_method.is_some() || codex_secret || openai_secret,
        can_logout: method.as_deref() == Some("chatgpt"),
    }
}

fn claude_auth_state(store: &RuntimeSetupStore, setup: &RuntimeSetupState) -> RuntimeAuthState {
    let anthropic_env = env_secret_present("ANTHROPIC_API_KEY");
    let base_url_env = env_secret_present("ANTHROPIC_BASE_URL");
    let bedrock_url_env = env_secret_present("ANTHROPIC_BEDROCK_BASE_URL");
    let token_env = env_secret_present("ANTHROPIC_AUTH_TOKEN");
    let headers_env = env_secret_present("ANTHROPIC_CUSTOM_HEADERS");
    let api_key_secret = secret_present(store, "claude", "ANTHROPIC_API_KEY");
    let token_secret = secret_present(store, "claude", "ANTHROPIC_AUTH_TOKEN");
    let headers_secret = secret_present(store, "claude", "ANTHROPIC_CUSTOM_HEADERS");
    let selected = normalize_auth_method(
        setup.auth_method.as_deref(),
        &[
            "claude-login",
            "claude-ai-login",
            "console-login",
            "anthropic-api-key",
            "gateway",
            "gateway-bedrock",
        ],
    );
    let gateway_url = validate_gateway_url(setup.gateway_base_url.as_deref());
    let bedrock_url = validate_gateway_url(setup.bedrock_gateway_base_url.as_deref());
    let method = if bedrock_url_env {
        Some("gateway-bedrock".to_string())
    } else if base_url_env {
        Some("gateway".to_string())
    } else if anthropic_env {
        Some("anthropic-api-key".to_string())
    } else if selected.as_deref() == Some("anthropic-api-key") && api_key_secret {
        selected
    } else if selected.as_deref() == Some("gateway")
        && gateway_url.is_ok()
        && gateway_url.as_ref().ok().and_then(|value| value.as_ref()).is_some()
        && (token_env || headers_env || token_secret || headers_secret)
    {
        selected
    } else if selected.as_deref() == Some("gateway-bedrock")
        && bedrock_url.is_ok()
        && bedrock_url.as_ref().ok().and_then(|value| value.as_ref()).is_some()
    {
        selected
    } else if matches!(
        selected.as_deref(),
        Some("claude-login" | "claude-ai-login" | "console-login")
    ) && external_auth_available(claude_auth_file_path(), setup.auth_invalidated_at_ms)
    {
        selected
    } else if selected.is_some() {
        None
    } else if api_key_secret {
        Some("anthropic-api-key".to_string())
    } else if external_auth_available(claude_auth_file_path(), setup.auth_invalidated_at_ms) {
        Some(default_claude_login_method().to_string())
    } else {
        None
    };
    let credential_source = match method.as_deref() {
        Some("anthropic-api-key") if anthropic_env => NativeAiCredentialSource::Environment,
        Some("gateway") if base_url_env || token_env || headers_env => {
            NativeAiCredentialSource::Environment
        }
        Some("gateway-bedrock") if bedrock_url_env => NativeAiCredentialSource::Environment,
        Some("anthropic-api-key" | "gateway" | "gateway-bedrock") => {
            NativeAiCredentialSource::ComandoSecret
        }
        Some("claude-login" | "claude-ai-login" | "console-login") => {
            NativeAiCredentialSource::ExternalRuntime
        }
        _ => NativeAiCredentialSource::None,
    };
    let message = if method.is_none() {
        if let Err(message) = gateway_url {
            Some(message)
        } else if let Err(message) = bedrock_url {
            Some(message)
        } else {
            Some("Log in with Claude or configure a Claude credential to finish setup.".to_string())
        }
    } else {
        None
    };
    RuntimeAuthState {
        ready: method.is_some(),
        method,
        credential_source,
        message,
        has_gateway_config: (base_url_env || setup.gateway_base_url.is_some())
            && (token_env || headers_env || token_secret || headers_secret)
            || bedrock_url_env
            || setup.bedrock_gateway_base_url.is_some(),
        has_gateway_url: base_url_env
            || bedrock_url_env
            || setup.gateway_base_url.is_some()
            || setup.bedrock_gateway_base_url.is_some(),
        can_disconnect: setup.auth_method.is_some()
            || api_key_secret
            || token_secret
            || headers_secret
            || setup.auth_invalidated_at_ms.is_some(),
        can_logout: false,
    }
}

fn grok_auth_state(store: &RuntimeSetupStore, setup: &RuntimeSetupState) -> RuntimeAuthState {
    let env_ready = env_secret_present("XAI_API_KEY");
    let stored_ready = secret_present(store, "grok", "XAI_API_KEY");
    let selected = normalize_auth_method(setup.auth_method.as_deref(), &["grok-login", "xai-api-key"]);
    let login_ready = external_auth_dir_available(grok_auth_dir_path(), setup.auth_invalidated_at_ms);
    let method = if env_ready {
        Some("xai-api-key".to_string())
    } else if selected.as_deref() == Some("xai-api-key") && stored_ready {
        selected
    } else if selected.as_deref() == Some("grok-login") && setup.auth_invalidated_at_ms.is_none() {
        Some("grok-login".to_string())
    } else if selected.is_some() {
        None
    } else if stored_ready {
        Some("xai-api-key".to_string())
    } else if login_ready {
        Some("grok-login".to_string())
    } else {
        None
    };
    RuntimeAuthState {
        ready: method.is_some(),
        credential_source: match method.as_deref() {
            Some("xai-api-key") if env_ready => NativeAiCredentialSource::Environment,
            Some("xai-api-key") => NativeAiCredentialSource::ComandoSecret,
            Some("grok-login") => NativeAiCredentialSource::ExternalRuntime,
            _ => NativeAiCredentialSource::None,
        },
        message: if method.is_none() {
            Some("Run Grok login or add an xAI API key to finish setup.".to_string())
        } else {
            None
        },
        method,
        has_gateway_config: false,
        has_gateway_url: false,
        can_disconnect: setup.auth_method.is_some()
            || stored_ready
            || setup.auth_invalidated_at_ms.is_some()
            || login_ready,
        can_logout: false,
    }
}

fn kilo_auth_state(store: &RuntimeSetupStore, setup: &RuntimeSetupState) -> RuntimeAuthState {
    let env_ready = env_secret_present("KILO_API_KEY");
    let stored_ready = secret_present(store, "kilo", "KILO_API_KEY");
    let selected = normalize_auth_method(setup.auth_method.as_deref(), &["kilo-login", "kilo-api-key"]);
    let login_ready = external_auth_available(kilo_auth_file_path(), setup.auth_invalidated_at_ms);
    let method = if env_ready {
        Some("kilo-api-key".to_string())
    } else if selected.as_deref() == Some("kilo-api-key") && stored_ready {
        selected
    } else if selected.as_deref() == Some("kilo-login") && login_ready {
        selected
    } else if selected.is_some() {
        None
    } else if stored_ready {
        Some("kilo-api-key".to_string())
    } else if login_ready {
        Some("kilo-login".to_string())
    } else {
        None
    };
    RuntimeAuthState {
        ready: method.is_some(),
        credential_source: match method.as_deref() {
            Some("kilo-api-key") if env_ready => NativeAiCredentialSource::Environment,
            Some("kilo-api-key") => NativeAiCredentialSource::ComandoSecret,
            Some("kilo-login") => NativeAiCredentialSource::ExternalRuntime,
            _ => NativeAiCredentialSource::None,
        },
        message: if method.is_none() {
            Some("Sign in with Kilo or add a Kilo API key to finish setup.".to_string())
        } else {
            None
        },
        method,
        has_gateway_config: false,
        has_gateway_url: false,
        can_disconnect: setup.auth_method.is_some()
            || stored_ready
            || setup.auth_invalidated_at_ms.is_some()
            || login_ready,
        can_logout: false,
    }
}

fn opencode_auth_state(setup: &RuntimeSetupState) -> RuntimeAuthState {
    let env_ready = [
        "OPENCODE_API_KEY",
        "ANTHROPIC_API_KEY",
        "CODEX_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "OPENAI_API_KEY",
    ]
    .iter()
    .any(|key| env_secret_present(key));
    let selected = normalize_auth_method(setup.auth_method.as_deref(), &["opencode-login"]);
    let login_ready = external_auth_available(opencode_auth_file_path(), setup.auth_invalidated_at_ms);
    let method = if env_ready
        || (selected.as_deref() == Some("opencode-login") && setup.auth_invalidated_at_ms.is_none())
        || login_ready
    {
        Some("opencode-login".to_string())
    } else {
        None
    };
    RuntimeAuthState {
        ready: method.is_some(),
        credential_source: if env_ready {
            NativeAiCredentialSource::Environment
        } else if method.is_some() {
            NativeAiCredentialSource::ExternalRuntime
        } else {
            NativeAiCredentialSource::None
        },
        message: if method.is_none() {
            Some("Run OpenCode auth login, use /connect in OpenCode, set OPENCODE_API_KEY, or provide credentials through a project .env.".to_string())
        } else if selected.is_some() && !login_ready && !env_ready {
            Some("OpenCode auth is selected. Comando could not verify local OpenCode credentials, but OpenCode may still load providers from /connect, environment variables, or a project .env.".to_string())
        } else {
            None
        },
        method,
        has_gateway_config: false,
        has_gateway_url: false,
        can_disconnect: setup.auth_method.is_some()
            || setup.auth_invalidated_at_ms.is_some()
            || login_ready,
        can_logout: false,
    }
}

fn runtime_spawn_env(
    store: &RuntimeSetupStore,
    runtime_id: &str,
    setup: &RuntimeSetupState,
    auth: &RuntimeAuthState,
    executable: &str,
) -> BTreeMap<String, String> {
    let mut env_map = env::vars().collect::<BTreeMap<_, _>>();
    apply_runtime_auth_env(store, runtime_id, setup, auth, &mut env_map);
    let path_value = build_runtime_path(&env_map, executable);
    if !path_value.is_empty() {
        env_map.insert("PATH".to_string(), path_value);
    }
    env_map
}

fn apply_runtime_auth_env(
    store: &RuntimeSetupStore,
    runtime_id: &str,
    setup: &RuntimeSetupState,
    auth: &RuntimeAuthState,
    env_map: &mut BTreeMap<String, String>,
) {
    match runtime_id {
        "codex" => {
            if env_secret_present_in(env_map, "CODEX_API_KEY")
                || env_secret_present_in(env_map, "OPENAI_API_KEY")
            {
                return;
            }
            env_map.remove("CODEX_API_KEY");
            env_map.remove("OPENAI_API_KEY");
            match auth.method.as_deref() {
                Some("codex-api-key") => insert_secret_env(store, env_map, "codex", "CODEX_API_KEY"),
                Some("openai-api-key") => insert_secret_env(store, env_map, "codex", "OPENAI_API_KEY"),
                _ => {}
            }
        }
        "claude" => apply_claude_env(store, setup, auth, env_map),
        "grok" => {
            if !env_secret_present_in(env_map, "XAI_API_KEY")
                && auth.method.as_deref() == Some("xai-api-key")
            {
                insert_secret_env(store, env_map, "grok", "XAI_API_KEY");
            }
        }
        "kilo" => {
            if !env_secret_present_in(env_map, "KILO_API_KEY")
                && auth.method.as_deref() == Some("kilo-api-key")
            {
                insert_secret_env(store, env_map, "kilo", "KILO_API_KEY");
            }
        }
        "opencode" => {}
        _ => {}
    }
}

fn apply_claude_env(
    store: &RuntimeSetupStore,
    setup: &RuntimeSetupState,
    auth: &RuntimeAuthState,
    env_map: &mut BTreeMap<String, String>,
) {
    if auth.method.as_deref() == Some("anthropic-api-key")
        && !env_secret_present_in(env_map, "ANTHROPIC_API_KEY")
    {
        insert_secret_env(store, env_map, "claude", "ANTHROPIC_API_KEY");
        return;
    }
    if auth.method.as_deref() == Some("gateway-bedrock") {
        if !env_secret_present_in(env_map, "ANTHROPIC_BEDROCK_BASE_URL") {
            if let Some(url) = setup.bedrock_gateway_base_url.as_deref() {
                env_map.insert("ANTHROPIC_BEDROCK_BASE_URL".to_string(), url.to_string());
            }
        }
        env_map.entry("CLAUDE_CODE_USE_BEDROCK".to_string()).or_insert_with(|| "1".to_string());
        env_map
            .entry("AWS_BEARER_TOKEN_BEDROCK".to_string())
            .or_insert_with(|| " ".to_string());
        if !env_secret_present_in(env_map, "ANTHROPIC_CUSTOM_HEADERS") {
            insert_secret_env(store, env_map, "claude", "ANTHROPIC_CUSTOM_HEADERS");
        }
        return;
    }
    if auth.method.as_deref() == Some("gateway") {
        if !env_secret_present_in(env_map, "ANTHROPIC_BASE_URL") {
            if let Some(url) = setup.gateway_base_url.as_deref() {
                env_map.insert("ANTHROPIC_BASE_URL".to_string(), url.to_string());
            }
        }
        if !env_secret_present_in(env_map, "ANTHROPIC_AUTH_TOKEN") {
            insert_secret_env(store, env_map, "claude", "ANTHROPIC_AUTH_TOKEN");
        }
        if !env_secret_present_in(env_map, "ANTHROPIC_CUSTOM_HEADERS") {
            insert_secret_env(store, env_map, "claude", "ANTHROPIC_CUSTOM_HEADERS");
        }
    }
}

fn insert_secret_env(
    store: &RuntimeSetupStore,
    env_map: &mut BTreeMap<String, String>,
    runtime_id: &str,
    env_key: &str,
) {
    if let Ok(Some(value)) = store.secrets().get_secret(runtime_id, env_key) {
        if !value.trim().is_empty() {
            env_map.insert(env_key.to_string(), value);
        }
    }
}

fn secret_present(store: &RuntimeSetupStore, runtime_id: &str, env_key: &str) -> bool {
    store
        .secrets()
        .get_secret(runtime_id, env_key)
        .ok()
        .flatten()
        .is_some_and(|value| !value.trim().is_empty())
}

fn env_secret_present(key: &str) -> bool {
    env::var(key).is_ok_and(|value| !value.trim().is_empty())
}

fn env_secret_present_in(env_map: &BTreeMap<String, String>, key: &str) -> bool {
    env_map.get(key).is_some_and(|value| !value.trim().is_empty())
}

fn auth_methods(runtime_id: &str) -> Vec<NativeAiAuthMethod> {
    match runtime_id {
        "codex" => {
            let mut methods = Vec::new();
            if !env_secret_present("NO_BROWSER") {
                methods.push(auth_method(
                    "chatgpt",
                    "ChatGPT account",
                    "Open the Codex ChatGPT login flow to connect your paid ChatGPT account.",
                ));
            }
            methods.push(auth_method(
                "codex-api-key",
                "Codex API key",
                "Use a Codex API key stored only for Comando on this machine.",
            ));
            methods.push(auth_method(
                "openai-api-key",
                "OpenAI API key",
                "Use an OpenAI API key stored only for Comando on this machine.",
            ));
            methods
        }
        "claude" => {
            let mut methods = if is_remote_claude_auth_environment() {
                vec![auth_method(
                    "claude-login",
                    "Log in with Claude",
                    "Open a Claude terminal session and complete sign-in with /login.",
                )]
            } else {
                vec![
                    auth_method(
                        "claude-ai-login",
                        "Claude subscription",
                        "Open a terminal-based Claude subscription login flow.",
                    ),
                    auth_method(
                        "console-login",
                        "Anthropic Console",
                        "Open a terminal-based Anthropic Console login flow.",
                    ),
                ]
            };
            methods.push(auth_method(
                "anthropic-api-key",
                "Anthropic API key",
                "Use an Anthropic API key stored only for Comando on this machine.",
            ));
            methods.push(auth_method(
                "gateway",
                "Custom gateway",
                "Use a custom Anthropic-compatible gateway just for Comando.",
            ));
            methods.push(auth_method(
                "gateway-bedrock",
                "Bedrock gateway",
                "Use a custom Bedrock-compatible Claude gateway just for Comando.",
            ));
            methods
        }
        "grok" => vec![
            auth_method(
                "grok-login",
                "Grok login",
                "Open Grok CLI in a terminal and complete sign-in there.",
            ),
            auth_method(
                "xai-api-key",
                "xAI API key",
                "Use an xAI API key stored only for Comando on this machine.",
            ),
        ],
        "kilo" => vec![
            auth_method(
                "kilo-login",
                "Kilo login",
                "Open Kilo CLI in a terminal and complete sign-in there.",
            ),
            auth_method(
                "kilo-api-key",
                "Kilo API key",
                "Use a Kilo API key stored only for Comando on this machine.",
            ),
        ],
        "opencode" => vec![auth_method(
            "opencode-login",
            "OpenCode auth",
            "Use providers and credentials configured by the OpenCode CLI.",
        )],
        _ => Vec::new(),
    }
}

fn auth_method(id: &str, name: &str, description: &str) -> NativeAiAuthMethod {
    NativeAiAuthMethod {
        id: id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
    }
}

fn credential_source_wire(source: &NativeAiCredentialSource) -> Option<String> {
    Some(match source {
        NativeAiCredentialSource::ComandoSecret => "comando-secret",
        NativeAiCredentialSource::Environment => "environment",
        NativeAiCredentialSource::ExternalRuntime => "external-runtime",
        NativeAiCredentialSource::None => "none",
    }
    .to_string())
}

fn credential_source_label(runtime_id: &str, source: &NativeAiCredentialSource) -> String {
    match source {
        NativeAiCredentialSource::ComandoSecret => "Using Comando stored credentials",
        NativeAiCredentialSource::Environment => "Using environment variable",
        NativeAiCredentialSource::ExternalRuntime => match runtime_id {
            "claude" => "Using external Claude login",
            "grok" => "Using external Grok login",
            "kilo" => "Using external Kilo login",
            "opencode" => "Using external OpenCode auth",
            _ => "Using external runtime login",
        },
        NativeAiCredentialSource::None => "Needs authentication",
    }
    .to_string()
}

fn normalize_auth_method(method: Option<&str>, allowed: &[&str]) -> Option<String> {
    let method = method?.trim();
    allowed
        .iter()
        .any(|allowed| *allowed == method)
        .then(|| method.to_string())
}

fn definition_args(definition: RuntimeDefinition) -> Vec<String> {
    definition
        .acp_args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect()
}

fn command_line(executable: &str, args: &[String]) -> String {
    std::iter::once(executable.to_string())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn missing_binary_message(runtime_id: &str) -> &'static str {
    match runtime_id {
        "codex" => "No compatible ACP runtime was found. Run `pnpm run stage:ai` to build/stage `codex-acp`, or configure an explicit binary.",
        "claude" => "Claude runtime was not found. Run `pnpm run stage:ai`, install `claude-agent-acp`, or provide a custom runtime path.",
        "grok" => "Grok CLI was not found. Install `grok` or provide a custom runtime path.",
        "kilo" => "Kilo CLI was not found. Install `kilo` or provide a custom runtime path.",
        "opencode" => "OpenCode CLI was not found. Install opencode or provide a custom runtime path.",
        _ => "Native runtime was not found.",
    }
}

fn runtime_binary_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn find_bundled_runtime(definition: RuntimeDefinition) -> Option<PathBuf> {
    let app_root = find_app_root()?;
    let name = runtime_binary_name(definition.default_executable);
    [
        app_root.join("resources").join("ai").join("binaries").join(&name),
        app_root
            .join("resources")
            .join("ai")
            .join("binaries")
            .join(format!("{}-{}", env::consts::OS, env::consts::ARCH))
            .join(&name),
    ]
    .into_iter()
    .find(|candidate| is_executable_or_script(candidate))
}

fn find_vendor_runtime(definition: RuntimeDefinition) -> Option<PathBuf> {
    let app_root = find_app_root()?;
    let name = runtime_binary_name(definition.default_executable);
    let candidates = match definition.id {
        "codex" => vec![
            app_root
                .join("resources")
                .join("ai")
                .join("embedded")
                .join("codex-acp")
                .join("target")
                .join("release")
                .join(&name),
            app_root
                .join("vendor")
                .join("codex-acp")
                .join("target")
                .join("release")
                .join(&name),
        ],
        _ => vec![app_root.join("vendor").join(&name)],
    };
    candidates
        .into_iter()
        .find(|candidate| is_executable_or_script(candidate))
}

fn find_app_root() -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = env::current_dir() {
        roots.push(cwd);
    }
    for root in roots {
        let mut current = root.as_path();
        loop {
            if current.join("package.json").exists() && current.join("resources").join("ai").exists()
            {
                return Some(current.to_path_buf());
            }
            let Some(parent) = current.parent() else {
                break;
            };
            if parent == current {
                break;
            }
            current = parent;
        }
    }
    None
}

fn resolve_from_runtime_path(command: &str, extra_path: Option<&str>) -> Option<PathBuf> {
    let env_map = env::vars().collect::<BTreeMap<_, _>>();
    let path_entries = runtime_path_entries(
        env_map.get("PATH").map(String::as_str),
        extra_path.unwrap_or(command),
        &env_map,
    );
    #[cfg(windows)]
    let extensions = env_map
        .get("PATHEXT")
        .map(String::as_str)
        .unwrap_or(".EXE;.CMD;.BAT;.COM")
        .split(';')
        .filter(|entry| !entry.trim().is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    #[cfg(not(windows))]
    let extensions = vec!["".to_string()];
    for entry in path_entries {
        for extension in &extensions {
            let file_name = if cfg!(windows)
                && !command.to_lowercase().ends_with(&extension.to_lowercase())
            {
                format!("{command}{extension}")
            } else {
                command.to_string()
            };
            let candidate = Path::new(&entry).join(file_name);
            if is_executable_or_script(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn build_runtime_path(env_map: &BTreeMap<String, String>, executable: &str) -> String {
    runtime_path_entries(env_map.get("PATH").map(String::as_str), executable, env_map)
        .join(if cfg!(windows) { ";" } else { ":" })
}

fn runtime_path_entries(
    current_path: Option<&str>,
    executable: &str,
    env_map: &BTreeMap<String, String>,
) -> Vec<String> {
    let mut entries = Vec::new();
    let executable_path = Path::new(executable);
    if executable_path.is_absolute() {
        if let Some(parent) = executable_path.parent() {
            entries.push(parent.display().to_string());
        }
    }
    if let Some(home) = env_map
        .get("HOME")
        .or_else(|| env_map.get("USERPROFILE"))
        .filter(|value| !value.trim().is_empty())
    {
        for entry in [
            "bin",
            ".grok/bin",
            ".opencode/bin",
            ".local/bin",
            ".npm-global/bin",
            ".yarn/bin",
            ".bun/bin",
            ".deno/bin",
            ".cargo/bin",
            "Library/pnpm",
            ".volta/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
        ] {
            entries.push(Path::new(home).join(entry).display().to_string());
        }
    }
    if cfg!(target_os = "macos") {
        entries.extend(
            ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"]
                .iter()
                .map(|entry| (*entry).to_string()),
        );
    }
    entries.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].iter().map(|entry| (*entry).to_string()));
    if let Some(path) = current_path {
        entries.extend(path.split(if cfg!(windows) { ';' } else { ':' }).filter(|entry| !entry.is_empty()).map(ToString::to_string));
    }
    dedupe(entries)
}

fn dedupe(values: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn is_codex_mcp_cli(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name.to_ascii_lowercase().as_str(), "codex" | "codex.exe"))
}

fn is_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}

fn is_executable_or_script(path: &Path) -> bool {
    if !is_file(path) {
        return false;
    }
    if path.extension().and_then(|ext| ext.to_str()) == Some("js") {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn validate_gateway_url(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let lower = raw.to_ascii_lowercase();
    if lower.contains('@') {
        return Err("Gateway URL must not include embedded credentials.".to_string());
    }
    if lower.starts_with("https://") {
        return Ok(Some(raw.to_string()));
    }
    if lower.starts_with("http://") {
        let host = lower
            .trim_start_matches("http://")
            .split(['/', ':'])
            .next()
            .unwrap_or("");
        if matches!(host, "localhost" | "127.0.0.1" | "::1") || host.ends_with(".localhost") {
            return Ok(Some(raw.to_string()));
        }
        return Err("HTTP gateways are only allowed for localhost.".to_string());
    }
    Err("Gateway URL must use HTTPS.".to_string())
}

fn default_claude_login_method() -> &'static str {
    if is_remote_claude_auth_environment() {
        "claude-login"
    } else {
        "claude-ai-login"
    }
}

fn is_remote_claude_auth_environment() -> bool {
    [
        "NO_BROWSER",
        "SSH_CONNECTION",
        "SSH_CLIENT",
        "SSH_TTY",
        "CLAUDE_CODE_REMOTE",
    ]
    .iter()
    .any(|key| env_secret_present(key))
}

fn external_auth_available(path: Option<PathBuf>, invalidated_at_ms: Option<u64>) -> bool {
    let Some(path) = path else {
        return false;
    };
    if !is_file(&path) {
        return false;
    }
    if invalidated_at_ms.is_none() {
        return true;
    }
    modified_at_ms(&path).is_some_and(|modified| modified > invalidated_at_ms.unwrap_or_default())
}

fn external_auth_dir_available(path: Option<PathBuf>, invalidated_at_ms: Option<u64>) -> bool {
    let Some(path) = path else {
        return false;
    };
    let Ok(entries) = fs::read_dir(&path) else {
        return false;
    };
    let mut newest = modified_at_ms(&path);
    let mut has_non_empty_file = false;
    for entry in entries.flatten() {
        if let Ok(metadata) = entry.metadata() {
            if metadata.is_file() && metadata.len() > 0 {
                has_non_empty_file = true;
                newest = newest.max(modified_at_ms(&entry.path()));
            }
        }
    }
    has_non_empty_file
        && invalidated_at_ms.is_none_or(|invalidated| {
            newest.is_some_and(|modified| modified > invalidated)
        })
}

fn modified_at_ms(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(duration.as_millis().try_into().unwrap_or(u64::MAX))
}

fn home_dir() -> Option<PathBuf> {
    env::var("HOME")
        .ok()
        .or_else(|| env::var("USERPROFILE").ok())
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn xdg_data_dir() -> Option<PathBuf> {
    if let Ok(value) = env::var("XDG_DATA_HOME") {
        if !value.trim().is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    if cfg!(windows) {
        if let Ok(value) = env::var("LOCALAPPDATA") {
            if !value.trim().is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    home_dir().map(|home| home.join(".local").join("share"))
}

fn claude_auth_file_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".claude.json"))
}

fn grok_auth_dir_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".grok").join("auth"))
}

fn kilo_auth_file_path() -> Option<PathBuf> {
    xdg_data_dir().map(|base| base.join("kilo").join("auth.json"))
}

fn opencode_auth_file_path() -> Option<PathBuf> {
    xdg_data_dir().map(|base| base.join("opencode").join("auth.json"))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use comando_settings::{InMemoryRuntimeSecretStore, RuntimeSecretStore};
    use tempfile::tempdir;

    use super::*;

    fn store_with_secret(runtime_id: &str, env_key: &str, value: &str) -> RuntimeSetupStore {
        let temp = tempdir().expect("temp");
        let secrets = Arc::new(InMemoryRuntimeSecretStore::default());
        secrets.set_secret(runtime_id, env_key, value).expect("secret");
        let store = RuntimeSetupStore::with_secret_store(temp.path().join("runtime-setup.json"), secrets);
        store
            .update_runtime(runtime_id, |state| {
                state.secret_env_keys.insert(env_key.to_string());
            })
            .expect("marker");
        store
    }

    #[test]
    fn codex_status_uses_stored_openai_key() {
        let store = store_with_secret("codex", "OPENAI_API_KEY", "sk-test");
        store
            .update_runtime("codex", |state| {
                state.auth_method = Some("openai-api-key".to_string());
            })
            .expect("setup");
        let definition = crate::runtime::RuntimeRegistry::default().get("codex").unwrap();

        let status = runtime_status(&store, definition).expect("status");

        assert_eq!(status.auth_method.as_deref(), Some("openai-api-key"));
        assert!(status.auth_ready);
        assert_eq!(
            status.auth_credential_source,
            Some(NativeAiCredentialSource::ComandoSecret)
        );
    }

    #[test]
    fn claude_gateway_rejects_embedded_credentials() {
        let temp = tempdir().expect("temp");
        let store = RuntimeSetupStore::in_memory_for_tests(temp.path().join("runtime-setup.json"));
        store
            .update_runtime("claude", |state| {
                state.binary_path = Some(std::env::current_exe().unwrap().display().to_string());
                state.auth_method = Some("gateway".to_string());
                state.gateway_base_url = Some("https://user:pass@example.com".to_string());
            })
            .expect("setup");
        let definition = crate::runtime::RuntimeRegistry::default().get("claude").unwrap();

        let status = runtime_status(&store, definition).expect("status");

        assert!(!status.auth_ready);
        assert_eq!(
            status.message.as_deref(),
            Some("Gateway URL must not include embedded credentials.")
        );
    }
}
