use std::collections::HashMap;
use std::io::Write;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use comando_types::ids::WindowId;
use comando_types::terminal::NativeTerminalSession;
use portable_pty::{Child as PtyChild, ChildKiller, MasterPty};

use crate::error::TerminalError;

pub const DEFAULT_COLS: u16 = 120;
pub const DEFAULT_ROWS: u16 = 34;
pub const MIN_COLS: u16 = 10;
pub const MIN_ROWS: u16 = 4;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct OwnerTerminalKey {
    window_id: WindowId,
    terminal_id: String,
}

impl OwnerTerminalKey {
    pub(crate) fn new(window_id: WindowId, terminal_id: String) -> Self {
        Self {
            window_id,
            terminal_id,
        }
    }
}

#[derive(Default)]
pub(crate) struct RegistryState {
    pub(crate) sessions: HashMap<String, Arc<SessionHandle>>,
    pub(crate) session_ids_by_owner_terminal_id: HashMap<OwnerTerminalKey, String>,
}

pub(crate) struct SessionHandle {
    pub(crate) snapshot: Arc<Mutex<NativeTerminalSession>>,
    pub(crate) master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    pub(crate) writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    pub(crate) child: Arc<Mutex<Option<Box<dyn PtyChild + Send + Sync>>>>,
    pub(crate) killer: Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
    pub(crate) closed: Arc<AtomicBool>,
    pub(crate) owner_key: Option<OwnerTerminalKey>,
}

impl SessionHandle {
    pub(crate) fn snapshot(&self) -> Result<NativeTerminalSession, TerminalError> {
        self.snapshot
            .lock()
            .map_err(|error| TerminalError::State(error.to_string()))
            .map(|snapshot| snapshot.clone())
    }

    pub(crate) fn release_runtime_resources(&self, terminate_process: bool) {
        release_session_runtime_resources(
            &self.master,
            &self.writer,
            &self.child,
            &self.killer,
            terminate_process,
        );
    }
}

impl Drop for SessionHandle {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Relaxed);
        self.release_runtime_resources(true);
    }
}

pub fn normalize_terminal_cols(cols: Option<u16>) -> u16 {
    cols.unwrap_or(DEFAULT_COLS).max(MIN_COLS)
}

pub fn normalize_terminal_rows(rows: Option<u16>) -> u16 {
    rows.unwrap_or(DEFAULT_ROWS).max(MIN_ROWS)
}

fn release_session_runtime_resources(
    master: &Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    writer: &Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: &Arc<Mutex<Option<Box<dyn PtyChild + Send + Sync>>>>,
    killer: &Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_terminal_dimensions_like_legacy_service() {
        assert_eq!(normalize_terminal_cols(None), 120);
        assert_eq!(normalize_terminal_rows(None), 34);
        assert_eq!(normalize_terminal_cols(Some(1)), 10);
        assert_eq!(normalize_terminal_rows(Some(1)), 4);
        assert_eq!(normalize_terminal_cols(Some(82)), 82);
        assert_eq!(normalize_terminal_rows(Some(18)), 18);
    }

    #[test]
    fn owner_terminal_key_is_scoped_by_window() {
        assert_ne!(
            OwnerTerminalKey::new(WindowId("window_1".to_string()), "terminal".to_string()),
            OwnerTerminalKey::new(WindowId("window_2".to_string()), "terminal".to_string()),
        );
    }
}
