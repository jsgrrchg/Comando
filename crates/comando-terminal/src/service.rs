use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc::{self, SyncSender},
};
use std::thread;
use std::time::Duration;

use comando_types::ids::{TerminalSessionId, WindowId};
use comando_types::terminal::{
    NativeTerminalCloseInput, NativeTerminalCloseReason, NativeTerminalCloseWindowInput,
    NativeTerminalClosedEvent, NativeTerminalCreateInput, NativeTerminalCreatedEvent,
    NativeTerminalDataEvent, NativeTerminalErrorEvent, NativeTerminalExitEvent,
    NativeTerminalKillInput, NativeTerminalLaunch, NativeTerminalListInput,
    NativeTerminalListResult, NativeTerminalResizeInput, NativeTerminalSession,
    NativeTerminalStatus, NativeTerminalWindowsShell, NativeTerminalWriteInput,
};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use uuid::Uuid;

use crate::error::TerminalError;
use crate::output::{TerminalOutputMessage, TerminalRuntimeEvent, start_output_coalescer};
use crate::session::{
    OwnerTerminalKey, RegistryState, SessionHandle, normalize_terminal_cols,
    normalize_terminal_rows,
};
use crate::shell::resolve_current_terminal_shell;
use crate::utf8::Utf8CarryDecoder;

const OUTPUT_CHANNEL_CAPACITY: usize = 1024;
const OUTPUT_READ_BUFFER_SIZE: usize = 4096;
const MONITOR_INTERVAL: Duration = Duration::from_millis(120);

#[derive(Debug, Clone)]
struct TerminalLaunchConfig {
    program: String,
    args: Vec<String>,
    display_name: String,
    cwd: PathBuf,
    env: HashMap<String, String>,
}

pub struct TerminalService {
    state: Arc<Mutex<RegistryState>>,
    output_tx: SyncSender<TerminalOutputMessage>,
}

impl TerminalService {
    pub fn new(event_sender: SyncSender<TerminalRuntimeEvent>) -> Self {
        let (output_tx, output_rx) = mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY);
        let _coalescer = start_output_coalescer(output_rx, event_sender);
        Self {
            state: Arc::new(Mutex::new(RegistryState::default())),
            output_tx,
        }
    }

    pub fn create_session(
        &self,
        input: NativeTerminalCreateInput,
    ) -> Result<NativeTerminalSession, TerminalError> {
        if let Some(existing) = self.reusable_session(&input)? {
            return Ok(existing);
        }

        let session_id = self.next_session_id(input.preferred_session_id.as_ref())?;
        let cols = normalize_terminal_cols(input.cols);
        let rows = normalize_terminal_rows(input.rows);
        let launch_config = resolve_launch_config(&input, cols, rows)?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::OpenPty(error.to_string()))?;

        let master = Arc::new(Mutex::new(Some(pair.master)));
        let mut command = CommandBuilder::new(&launch_config.program);
        command.args(&launch_config.args);
        command.cwd(&launch_config.cwd);
        for (key, value) in &launch_config.env {
            command.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| TerminalError::Spawn(error.to_string()))?;
        let killer = child.clone_killer();
        let writer = master
            .lock()
            .map_err(|error| TerminalError::State(error.to_string()))?
            .as_ref()
            .ok_or(TerminalError::PtyUnavailable)?
            .take_writer()
            .map_err(|error| TerminalError::Writer(error.to_string()))?;
        let reader = master
            .lock()
            .map_err(|error| TerminalError::State(error.to_string()))?
            .as_ref()
            .ok_or(TerminalError::PtyUnavailable)?
            .try_clone_reader()
            .map_err(|error| TerminalError::Reader(error.to_string()))?;

        let owner_key = input
            .terminal_id
            .as_ref()
            .map(|terminal_id| OwnerTerminalKey::new(input.window_id.clone(), terminal_id.clone()));
        let snapshot = Arc::new(Mutex::new(NativeTerminalSession {
            session_id: TerminalSessionId(session_id.clone()),
            window_id: input.window_id.clone(),
            terminal_id: input.terminal_id.clone(),
            project_id: input.project_id.clone(),
            worktree_id: input.worktree_id.clone(),
            cwd: launch_config.cwd.to_string_lossy().into_owned(),
            cols,
            rows,
            status: NativeTerminalStatus::Running,
            exit_code: None,
            signal_code: None,
            program: launch_config.program.clone(),
            display_name: launch_config.display_name.clone(),
            purpose: input.purpose,
            launched_by: input.launched_by,
        }));

        let handle = Arc::new(SessionHandle {
            snapshot: Arc::clone(&snapshot),
            master: Arc::clone(&master),
            writer: Arc::new(Mutex::new(Some(writer))),
            child: Arc::new(Mutex::new(Some(child))),
            killer: Arc::new(Mutex::new(Some(killer))),
            closed: Arc::new(AtomicBool::new(false)),
            owner_key: owner_key.clone(),
        });

        let created_snapshot = handle.snapshot()?;
        self.insert_session(session_id.clone(), owner_key.clone(), Arc::clone(&handle))?;

        spawn_output_reader(
            reader,
            Arc::clone(&handle.closed),
            self.output_tx.clone(),
            input.window_id.clone(),
            TerminalSessionId(session_id.clone()),
            input.terminal_id.clone(),
        );
        spawn_exit_monitor(
            Arc::clone(&self.state),
            Arc::clone(&handle.master),
            Arc::clone(&handle.writer),
            Arc::clone(&handle.child),
            Arc::clone(&handle.killer),
            Arc::clone(&handle.snapshot),
            Arc::clone(&handle.closed),
            self.output_tx.clone(),
            owner_key.clone(),
        );

        send_output_deferred(
            &self.output_tx,
            TerminalOutputMessage::Created(NativeTerminalCreatedEvent {
                session: created_snapshot.clone(),
            }),
        );

        Ok(created_snapshot)
    }

    pub fn write_input(&self, input: NativeTerminalWriteInput) -> Result<(), TerminalError> {
        let Some(handle) = self.owned_session(&input.window_id, &input.session_id.0)? else {
            return Ok(());
        };

        let mut writer_guard = handle
            .writer
            .lock()
            .map_err(|error| TerminalError::State(error.to_string()))?;
        let Some(writer) = writer_guard.as_mut() else {
            return Ok(());
        };

        writer
            .write_all(input.data.as_bytes())
            .map_err(|error| TerminalError::Write(error.to_string()))?;
        writer
            .flush()
            .map_err(|error| TerminalError::Write(error.to_string()))?;
        Ok(())
    }

    pub fn resize_session(
        &self,
        input: NativeTerminalResizeInput,
    ) -> Result<Option<NativeTerminalSession>, TerminalError> {
        let Some(handle) = self.owned_session(&input.window_id, &input.session_id.0)? else {
            return Ok(None);
        };

        let cols = normalize_terminal_cols(Some(input.cols));
        let rows = normalize_terminal_rows(Some(input.rows));
        {
            let mut snapshot = handle
                .snapshot
                .lock()
                .map_err(|error| TerminalError::State(error.to_string()))?;
            if snapshot.cols == cols && snapshot.rows == rows {
                return Ok(Some(snapshot.clone()));
            }
            snapshot.cols = cols;
            snapshot.rows = rows;
        }

        if let Some(master) = handle
            .master
            .lock()
            .map_err(|error| TerminalError::State(error.to_string()))?
            .as_ref()
        {
            master
                .resize(PtySize {
                    cols,
                    rows,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| TerminalError::Resize(error.to_string()))?;
        }

        Ok(Some(handle.snapshot()?))
    }

    pub fn kill_session(&self, input: NativeTerminalKillInput) -> Result<(), TerminalError> {
        self.close_session_by_id(
            &input.window_id,
            &input.session_id.0,
            NativeTerminalCloseReason::User,
        )
        .map(|_| ())
    }

    pub fn close_session(&self, input: NativeTerminalCloseInput) -> Result<(), TerminalError> {
        self.close_session_or_owned_terminal(&input.window_id, &input.id, input.reason)
            .map(|_| ())
    }

    pub fn close_window(&self, input: NativeTerminalCloseWindowInput) -> Result<(), TerminalError> {
        self.close_owned_by_window(&input.window_id, NativeTerminalCloseReason::WindowClosed)
    }

    pub fn list_sessions(
        &self,
        input: NativeTerminalListInput,
    ) -> Result<NativeTerminalListResult, TerminalError> {
        let handles = {
            let state = self
                .state
                .lock()
                .map_err(|error| TerminalError::State(error.to_string()))?;
            state.sessions.values().cloned().collect::<Vec<_>>()
        };

        let mut sessions = Vec::new();
        for handle in handles {
            let snapshot = handle.snapshot()?;
            if input
                .window_id
                .as_ref()
                .is_none_or(|window_id| *window_id == snapshot.window_id)
            {
                sessions.push(snapshot);
            }
        }

        Ok(NativeTerminalListResult { sessions })
    }

    pub fn close(&self) {
        let _ = self.close_all(NativeTerminalCloseReason::User);
    }

    fn reusable_session(
        &self,
        input: &NativeTerminalCreateInput,
    ) -> Result<Option<NativeTerminalSession>, TerminalError> {
        let owner_key = input
            .terminal_id
            .as_ref()
            .map(|terminal_id| OwnerTerminalKey::new(input.window_id.clone(), terminal_id.clone()));

        if let Some(owner_key) = &owner_key {
            let existing = {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|error| TerminalError::State(error.to_string()))?;
                match state
                    .session_ids_by_owner_terminal_id
                    .get(owner_key)
                    .cloned()
                {
                    Some(session_id) => {
                        if let Some(handle) = state.sessions.get(&session_id) {
                            Some(handle.clone())
                        } else {
                            state.session_ids_by_owner_terminal_id.remove(owner_key);
                            None
                        }
                    }
                    None => None,
                }
            };

            if let Some(handle) = existing {
                return Ok(Some(handle.snapshot()?));
            }
        }

        if let Some(preferred_session_id) = &input.preferred_session_id {
            let preferred = {
                let state = self
                    .state
                    .lock()
                    .map_err(|error| TerminalError::State(error.to_string()))?;
                state.sessions.get(&preferred_session_id.0).cloned()
            };

            if let Some(handle) = preferred {
                let snapshot = handle.snapshot()?;
                if snapshot.window_id == input.window_id {
                    return Ok(Some(snapshot));
                }
            }
        }

        Ok(None)
    }

    fn next_session_id(
        &self,
        preferred_session_id: Option<&TerminalSessionId>,
    ) -> Result<String, TerminalError> {
        let state = self
            .state
            .lock()
            .map_err(|error| TerminalError::State(error.to_string()))?;
        let mut session_id = preferred_session_id
            .map(|id| id.0.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        while state.sessions.contains_key(&session_id) {
            session_id = Uuid::new_v4().to_string();
        }

        Ok(session_id)
    }

    fn insert_session(
        &self,
        session_id: String,
        owner_key: Option<OwnerTerminalKey>,
        handle: Arc<SessionHandle>,
    ) -> Result<(), TerminalError> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| TerminalError::State(error.to_string()))?;
        state.sessions.insert(session_id.clone(), handle);
        if let Some(owner_key) = owner_key {
            state
                .session_ids_by_owner_terminal_id
                .insert(owner_key, session_id);
        }
        Ok(())
    }

    fn owned_session(
        &self,
        window_id: &WindowId,
        session_id: &str,
    ) -> Result<Option<Arc<SessionHandle>>, TerminalError> {
        let handle = {
            let state = self
                .state
                .lock()
                .map_err(|error| TerminalError::State(error.to_string()))?;
            state.sessions.get(session_id).cloned()
        };

        let Some(handle) = handle else {
            return Ok(None);
        };
        if handle.snapshot()?.window_id != *window_id {
            return Ok(None);
        }

        Ok(Some(handle))
    }

    fn close_session_or_owned_terminal(
        &self,
        window_id: &WindowId,
        id: &str,
        reason: NativeTerminalCloseReason,
    ) -> Result<bool, TerminalError> {
        let direct_session = {
            let state = self
                .state
                .lock()
                .map_err(|error| TerminalError::State(error.to_string()))?;
            state.sessions.get(id).cloned()
        };

        if let Some(handle) = direct_session {
            if handle.snapshot()?.window_id == *window_id {
                return self.close_handle(handle, reason).map(|_| true);
            }
            return Ok(false);
        }

        let owner_key = OwnerTerminalKey::new(window_id.clone(), id.to_string());
        let session_id = {
            let state = self
                .state
                .lock()
                .map_err(|error| TerminalError::State(error.to_string()))?;
            state
                .session_ids_by_owner_terminal_id
                .get(&owner_key)
                .cloned()
        };

        if let Some(session_id) = session_id {
            return self.close_session_by_id(window_id, &session_id, reason);
        }

        Ok(false)
    }

    fn close_session_by_id(
        &self,
        window_id: &WindowId,
        session_id: &str,
        reason: NativeTerminalCloseReason,
    ) -> Result<bool, TerminalError> {
        let Some(handle) = self.owned_session(window_id, session_id)? else {
            return Ok(false);
        };
        self.close_handle(handle, reason).map(|_| true)
    }

    fn close_owned_by_window(
        &self,
        window_id: &WindowId,
        reason: NativeTerminalCloseReason,
    ) -> Result<(), TerminalError> {
        let handles = {
            let state = self
                .state
                .lock()
                .map_err(|error| TerminalError::State(error.to_string()))?;
            state.sessions.values().cloned().collect::<Vec<_>>()
        };

        for handle in handles {
            if handle.snapshot()?.window_id == *window_id {
                self.close_handle(handle, reason)?;
            }
        }

        Ok(())
    }

    fn close_all(&self, reason: NativeTerminalCloseReason) -> Result<(), TerminalError> {
        let handles = {
            let state = self
                .state
                .lock()
                .map_err(|error| TerminalError::State(error.to_string()))?;
            state.sessions.values().cloned().collect::<Vec<_>>()
        };

        for handle in handles {
            self.close_handle(handle, reason)?;
        }

        Ok(())
    }

    fn close_handle(
        &self,
        handle: Arc<SessionHandle>,
        reason: NativeTerminalCloseReason,
    ) -> Result<(), TerminalError> {
        let snapshot = handle.snapshot()?;
        remove_session_from_state(&self.state, &snapshot.session_id.0, &handle.owner_key)?;
        handle.closed.store(true, Ordering::Relaxed);
        handle.release_runtime_resources(true);
        send_output_deferred(
            &self.output_tx,
            TerminalOutputMessage::Closed(NativeTerminalClosedEvent {
                window_id: snapshot.window_id,
                session_id: snapshot.session_id,
                terminal_id: snapshot.terminal_id,
                reason,
            }),
        );
        Ok(())
    }
}

impl Drop for TerminalService {
    fn drop(&mut self) {
        self.close();
    }
}

fn resolve_launch_config(
    input: &NativeTerminalCreateInput,
    cols: u16,
    rows: u16,
) -> Result<TerminalLaunchConfig, TerminalError> {
    let cwd = resolve_terminal_cwd(input.cwd.as_deref())?;
    let (program, args, display_name) = match &input.launch {
        NativeTerminalLaunch::Shell => {
            let windows_shell = input
                .shell_preference
                .as_ref()
                .map(|preference| preference.windows_shell)
                .unwrap_or(NativeTerminalWindowsShell::Default);
            let resolved = resolve_current_terminal_shell(windows_shell);
            let display_name = shell_display_name(&resolved.command);
            (resolved.command, resolved.args, display_name)
        }
        NativeTerminalLaunch::Command {
            program,
            args,
            display_name,
        } => (
            program.clone(),
            args.clone(),
            display_name
                .clone()
                .unwrap_or_else(|| shell_display_name(program)),
        ),
    };

    let mut environment = env::vars().collect::<HashMap<_, _>>();
    environment.insert("TERM".to_string(), "xterm-256color".to_string());
    environment.insert("COLORTERM".to_string(), "truecolor".to_string());
    environment.insert("COLUMNS".to_string(), cols.to_string());
    environment.insert("LINES".to_string(), rows.to_string());
    for (key, value) in &input.extra_env {
        environment.insert(key.clone(), value.clone());
    }

    Ok(TerminalLaunchConfig {
        program,
        args,
        display_name,
        cwd,
        env: environment,
    })
}

fn resolve_terminal_cwd(requested_cwd: Option<&str>) -> Result<PathBuf, TerminalError> {
    let cwd = match requested_cwd {
        Some(cwd) if !cwd.trim().is_empty() => PathBuf::from(cwd),
        _ => env::current_dir().map_err(TerminalError::CwdIo)?,
    };

    let metadata = cwd.metadata().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            TerminalError::CwdNotFound
        } else {
            TerminalError::CwdIo(error)
        }
    })?;
    if !metadata.is_dir() {
        return Err(TerminalError::CwdNotDirectory);
    }

    Ok(cwd)
}

fn shell_display_name(program: &str) -> String {
    program
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(program)
        .to_string()
}

fn normalize_signal_code(signal: &str) -> String {
    let trimmed = signal.trim();
    let trailing_number = trimmed
        .rsplit(|character: char| !character.is_ascii_digit())
        .find(|part| !part.is_empty());

    trailing_number.unwrap_or(trimmed).to_string()
}

fn spawn_output_reader(
    mut reader: Box<dyn Read + Send>,
    closed: Arc<AtomicBool>,
    output_tx: SyncSender<TerminalOutputMessage>,
    window_id: WindowId,
    session_id: TerminalSessionId,
    terminal_id: Option<String>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; OUTPUT_READ_BUFFER_SIZE];
        let mut decoder = Utf8CarryDecoder::default();

        loop {
            if closed.load(Ordering::Relaxed) {
                break;
            }

            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if closed.load(Ordering::Relaxed) {
                        break;
                    }
                    let data = decoder.decode(&buffer[..read]);
                    if data.is_empty() {
                        continue;
                    }
                    if output_tx
                        .send(TerminalOutputMessage::Data(NativeTerminalDataEvent {
                            window_id: window_id.clone(),
                            session_id: session_id.clone(),
                            data,
                        }))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) => {
                    if !closed.load(Ordering::Relaxed) {
                        send_output(
                            &output_tx,
                            TerminalOutputMessage::Error(NativeTerminalErrorEvent {
                                window_id: window_id.clone(),
                                session_id: Some(session_id.clone()),
                                terminal_id: terminal_id.clone(),
                                message: format!("Failed to read terminal output: {error}"),
                                retryable: false,
                            }),
                        );
                    }
                    break;
                }
            }
        }
    });
}

#[allow(clippy::too_many_arguments)]
fn spawn_exit_monitor(
    state: Arc<Mutex<RegistryState>>,
    master: Arc<Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: Arc<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>,
    killer: Arc<Mutex<Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>>>,
    snapshot: Arc<Mutex<NativeTerminalSession>>,
    closed: Arc<AtomicBool>,
    output_tx: SyncSender<TerminalOutputMessage>,
    owner_key: Option<OwnerTerminalKey>,
) {
    thread::spawn(move || {
        loop {
            if closed.load(Ordering::Relaxed) {
                break;
            }

            let exit_status = {
                let mut child_guard = match child.lock() {
                    Ok(child_guard) => child_guard,
                    Err(error) => {
                        emit_monitor_error(
                            &snapshot,
                            &output_tx,
                            format!("Internal terminal state error: {error}"),
                        );
                        break;
                    }
                };
                let Some(process) = child_guard.as_mut() else {
                    break;
                };

                match process.try_wait() {
                    Ok(status) => status,
                    Err(error) => {
                        emit_monitor_error(
                            &snapshot,
                            &output_tx,
                            format!("Failed to monitor terminal process: {error}"),
                        );
                        release_runtime_resources(&master, &writer, &child, &killer, false);
                        break;
                    }
                }
            };

            if let Some(exit_status) = exit_status {
                let snapshot_after_exit = {
                    let mut snapshot_guard = match snapshot.lock() {
                        Ok(snapshot_guard) => snapshot_guard,
                        Err(error) => {
                            emit_monitor_error(
                                &snapshot,
                                &output_tx,
                                format!("Internal terminal state error: {error}"),
                            );
                            break;
                        }
                    };
                    snapshot_guard.status = NativeTerminalStatus::Exited;
                    snapshot_guard.exit_code = i32::try_from(exit_status.exit_code()).ok();
                    snapshot_guard.signal_code = exit_status.signal().map(normalize_signal_code);
                    snapshot_guard.clone()
                };

                release_runtime_resources(&master, &writer, &child, &killer, false);
                remove_session_from_state(&state, &snapshot_after_exit.session_id.0, &owner_key)
                    .ok();
                closed.store(true, Ordering::Relaxed);
                send_output(
                    &output_tx,
                    TerminalOutputMessage::Exit(NativeTerminalExitEvent {
                        window_id: snapshot_after_exit.window_id.clone(),
                        session_id: snapshot_after_exit.session_id.clone(),
                        exit_code: snapshot_after_exit.exit_code,
                        signal_code: snapshot_after_exit.signal_code.clone(),
                    }),
                );
                send_output(
                    &output_tx,
                    TerminalOutputMessage::Closed(NativeTerminalClosedEvent {
                        window_id: snapshot_after_exit.window_id,
                        session_id: snapshot_after_exit.session_id,
                        terminal_id: snapshot_after_exit.terminal_id,
                        reason: NativeTerminalCloseReason::ProcessExit,
                    }),
                );
                break;
            }

            thread::sleep(MONITOR_INTERVAL);
        }
    });
}

fn emit_monitor_error(
    snapshot: &Arc<Mutex<NativeTerminalSession>>,
    output_tx: &SyncSender<TerminalOutputMessage>,
    message: String,
) {
    let event = match snapshot.lock() {
        Ok(mut snapshot_guard) => {
            snapshot_guard.status = NativeTerminalStatus::Error;
            NativeTerminalErrorEvent {
                window_id: snapshot_guard.window_id.clone(),
                session_id: Some(snapshot_guard.session_id.clone()),
                terminal_id: snapshot_guard.terminal_id.clone(),
                message,
                retryable: false,
            }
        }
        Err(_) => NativeTerminalErrorEvent {
            window_id: WindowId("unknown".to_string()),
            session_id: None,
            terminal_id: None,
            message,
            retryable: false,
        },
    };

    send_output(output_tx, TerminalOutputMessage::Error(event));
}

fn release_runtime_resources(
    master: &Arc<Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>>,
    writer: &Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: &Arc<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>,
    killer: &Arc<Mutex<Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>>>,
    terminate_process: bool,
) {
    if terminate_process {
        if let Ok(mut killer_guard) = killer.lock() {
            if let Some(killer) = killer_guard.as_mut() {
                let _ = killer.kill();
            }
        }
    }

    if let Ok(mut writer_guard) = writer.lock() {
        writer_guard.take();
    }
    if let Ok(mut child_guard) = child.lock() {
        child_guard.take();
    }
    if let Ok(mut killer_guard) = killer.lock() {
        killer_guard.take();
    }
    if let Ok(mut master_guard) = master.lock() {
        master_guard.take();
    }
}

fn remove_session_from_state(
    state: &Arc<Mutex<RegistryState>>,
    session_id: &str,
    owner_key: &Option<OwnerTerminalKey>,
) -> Result<(), TerminalError> {
    let mut state = state
        .lock()
        .map_err(|error| TerminalError::State(error.to_string()))?;
    state.sessions.remove(session_id);
    if let Some(owner_key) = owner_key {
        if state
            .session_ids_by_owner_terminal_id
            .get(owner_key)
            .is_some_and(|tracked_session_id| tracked_session_id == session_id)
        {
            state.session_ids_by_owner_terminal_id.remove(owner_key);
        }
    }
    Ok(())
}

fn send_output(sender: &SyncSender<TerminalOutputMessage>, message: TerminalOutputMessage) {
    let _ = sender.send(message);
}

fn send_output_deferred(
    sender: &SyncSender<TerminalOutputMessage>,
    message: TerminalOutputMessage,
) {
    match sender.try_send(message) {
        Ok(()) => {}
        Err(mpsc::TrySendError::Full(message)) => {
            let sender = sender.clone();
            thread::spawn(move || {
                let _ = sender.send(message);
            });
        }
        Err(mpsc::TrySendError::Disconnected(_)) => {}
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::mpsc;

    use comando_types::terminal::{
        NativeTerminalLaunchedBy, NativeTerminalPurpose, NativeTerminalShellPreference,
    };

    use super::*;

    #[test]
    fn resolves_cwd_and_rejects_missing_paths() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let resolved =
            resolve_terminal_cwd(Some(temp_dir.path().to_string_lossy().as_ref())).expect("cwd");
        assert!(resolved.is_dir());

        let missing = temp_dir.path().join("missing");
        assert!(matches!(
            resolve_terminal_cwd(Some(missing.to_string_lossy().as_ref())),
            Err(TerminalError::CwdNotFound)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn preserves_requested_cwd_path_after_validation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let real_dir = temp_dir.path().join("real");
        std::fs::create_dir_all(&real_dir).expect("real dir");
        let symlink_dir = temp_dir.path().join("linked");
        std::os::unix::fs::symlink(&real_dir, &symlink_dir).expect("symlink");

        let resolved =
            resolve_terminal_cwd(Some(symlink_dir.to_string_lossy().as_ref())).expect("cwd");

        assert_eq!(resolved, symlink_dir);
    }

    #[test]
    fn reuses_terminal_id_only_inside_owner_window() {
        let (event_tx, _event_rx) = mpsc::sync_channel(64);
        let service = TerminalService::new(event_tx);
        let temp_dir = tempfile::tempdir().expect("temp dir");

        let first = service
            .create_session(create_input(
                "window_1",
                "terminal_1",
                temp_dir.path(),
                long_running_command(),
            ))
            .expect("first session");
        let reused = service
            .create_session(create_input(
                "window_1",
                "terminal_1",
                temp_dir.path(),
                long_running_command(),
            ))
            .expect("reused session");
        let other_window = service
            .create_session(create_input(
                "window_2",
                "terminal_1",
                temp_dir.path(),
                long_running_command(),
            ))
            .expect("other window session");

        assert_eq!(first.session_id, reused.session_id);
        assert_ne!(first.session_id, other_window.session_id);
        service.close();
    }

    #[test]
    fn close_does_not_reinterpret_foreign_session_id_as_terminal_id() {
        let (event_tx, _event_rx) = mpsc::sync_channel(64);
        let service = TerminalService::new(event_tx);
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let foreign = service
            .create_session(create_input(
                "window_1",
                "terminal_1",
                temp_dir.path(),
                long_running_command(),
            ))
            .expect("foreign session");
        let owned = service
            .create_session(create_input(
                "window_2",
                &foreign.session_id.0,
                temp_dir.path(),
                long_running_command(),
            ))
            .expect("owned terminal id");

        service
            .close_session_or_owned_terminal(
                &WindowId("window_2".to_string()),
                &foreign.session_id.0,
                NativeTerminalCloseReason::User,
            )
            .expect("close foreign no-op");

        let sessions = service
            .list_sessions(NativeTerminalListInput { window_id: None })
            .expect("list")
            .sessions;
        assert!(
            sessions
                .iter()
                .any(|session| session.session_id == foreign.session_id)
        );
        assert!(
            sessions
                .iter()
                .any(|session| session.session_id == owned.session_id)
        );
        service.close();
    }

    #[test]
    fn command_session_emits_output_before_exit() {
        let (event_tx, event_rx) = mpsc::sync_channel(64);
        let service = TerminalService::new(event_tx);
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let session = service
            .create_session(create_input(
                "window_1",
                "terminal_1",
                temp_dir.path(),
                print_and_exit_command(),
            ))
            .expect("session");

        let mut saw_data = false;
        let mut saw_exit = false;
        for _ in 0..10 {
            let event = event_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("terminal event");
            match event {
                TerminalRuntimeEvent::Data(event) if event.session_id == session.session_id => {
                    if event.data.contains("ready") {
                        saw_data = true;
                    }
                }
                TerminalRuntimeEvent::Exit(event) if event.session_id == session.session_id => {
                    saw_exit = true;
                    break;
                }
                _ => {}
            }
        }

        assert!(saw_data);
        assert!(saw_exit);
    }

    #[test]
    fn foreground_lifecycle_send_does_not_block_when_pipeline_is_full() {
        let (sender, receiver) = mpsc::sync_channel(0);

        send_output_deferred(
            &sender,
            TerminalOutputMessage::Error(NativeTerminalErrorEvent {
                window_id: WindowId("window_1".to_string()),
                session_id: None,
                terminal_id: None,
                message: "Terminal lifecycle event queued.".to_string(),
                retryable: false,
            }),
        );

        assert!(matches!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("deferred lifecycle event"),
            TerminalOutputMessage::Error(_)
        ));
    }

    #[test]
    fn normalizes_portable_pty_signal_text_to_numeric_string() {
        assert_eq!(normalize_signal_code("Terminated: 15"), "15");
        assert_eq!(normalize_signal_code("Signal 9"), "9");
        assert_eq!(normalize_signal_code("SIGTERM"), "SIGTERM");
    }

    fn create_input(
        window_id: &str,
        terminal_id: &str,
        cwd: &Path,
        launch: NativeTerminalLaunch,
    ) -> NativeTerminalCreateInput {
        NativeTerminalCreateInput {
            window_id: WindowId(window_id.to_string()),
            terminal_id: Some(terminal_id.to_string()),
            preferred_session_id: None,
            project_id: None,
            worktree_id: None,
            cwd: Some(cwd.to_string_lossy().into_owned()),
            cols: Some(120),
            rows: Some(32),
            extra_env: HashMap::new(),
            shell_preference: Some(NativeTerminalShellPreference {
                windows_shell: NativeTerminalWindowsShell::Default,
            }),
            purpose: NativeTerminalPurpose::Workspace,
            launched_by: NativeTerminalLaunchedBy::User,
            launch,
        }
    }

    #[cfg(unix)]
    fn long_running_command() -> NativeTerminalLaunch {
        NativeTerminalLaunch::Command {
            program: "/bin/sh".to_string(),
            args: vec!["-lc".to_string(), "sleep 5".to_string()],
            display_name: Some("sleep".to_string()),
        }
    }

    #[cfg(unix)]
    fn print_and_exit_command() -> NativeTerminalLaunch {
        NativeTerminalLaunch::Command {
            program: "/bin/sh".to_string(),
            args: vec!["-lc".to_string(), "printf ready".to_string()],
            display_name: Some("print".to_string()),
        }
    }

    #[cfg(windows)]
    fn long_running_command() -> NativeTerminalLaunch {
        NativeTerminalLaunch::Command {
            program: "cmd.exe".to_string(),
            args: vec!["/C".to_string(), "ping -n 6 127.0.0.1 >NUL".to_string()],
            display_name: Some("ping".to_string()),
        }
    }

    #[cfg(windows)]
    fn print_and_exit_command() -> NativeTerminalLaunch {
        NativeTerminalLaunch::Command {
            program: "cmd.exe".to_string(),
            args: vec!["/C".to_string(), "echo ready".to_string()],
            display_name: Some("print".to_string()),
        }
    }
}
