use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use comando_types::terminal::{
    NativeTerminalClosedEvent, NativeTerminalCreatedEvent, NativeTerminalDataEvent,
    NativeTerminalErrorEvent, NativeTerminalExitEvent,
};

pub const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
pub const OUTPUT_FLUSH_BYTES: usize = 256 * 1024;
pub const OUTPUT_MAX_EVENT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalRuntimeEvent {
    Created(NativeTerminalCreatedEvent),
    Data(NativeTerminalDataEvent),
    Exit(NativeTerminalExitEvent),
    Closed(NativeTerminalClosedEvent),
    Error(NativeTerminalErrorEvent),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalOutputMessage {
    Created(NativeTerminalCreatedEvent),
    Data(NativeTerminalDataEvent),
    Exit(NativeTerminalExitEvent),
    Closed(NativeTerminalClosedEvent),
    Error(NativeTerminalErrorEvent),
}

#[derive(Debug, Clone)]
struct PendingOutput {
    event: NativeTerminalDataEvent,
}

pub fn start_output_coalescer(
    receiver: Receiver<TerminalOutputMessage>,
    event_sender: SyncSender<TerminalRuntimeEvent>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut pending = HashMap::<String, PendingOutput>::new();
        let mut pending_bytes = 0usize;

        loop {
            match receiver.recv_timeout(OUTPUT_FLUSH_INTERVAL) {
                Ok(message) => {
                    handle_message(message, &event_sender, &mut pending, &mut pending_bytes);
                    if pending_bytes >= OUTPUT_FLUSH_BYTES {
                        flush_all(&event_sender, &mut pending, &mut pending_bytes);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    flush_all(&event_sender, &mut pending, &mut pending_bytes);
                }
                Err(RecvTimeoutError::Disconnected) => {
                    flush_all(&event_sender, &mut pending, &mut pending_bytes);
                    break;
                }
            }
        }
    })
}

fn handle_message(
    message: TerminalOutputMessage,
    event_sender: &SyncSender<TerminalRuntimeEvent>,
    pending: &mut HashMap<String, PendingOutput>,
    pending_bytes: &mut usize,
) {
    match message {
        TerminalOutputMessage::Created(event) => {
            send_event(event_sender, TerminalRuntimeEvent::Created(event));
        }
        TerminalOutputMessage::Data(event) => {
            if event.data.is_empty() {
                return;
            }

            let key = event.session_id.0.clone();
            let event_len = event.data.len();
            pending
                .entry(key)
                .and_modify(|pending| {
                    pending.event.data.push_str(&event.data);
                })
                .or_insert_with(|| PendingOutput { event });
            *pending_bytes = pending_bytes.saturating_add(event_len);
        }
        TerminalOutputMessage::Exit(event) => {
            flush_session(event_sender, pending, pending_bytes, &event.session_id.0);
            send_event(event_sender, TerminalRuntimeEvent::Exit(event));
        }
        TerminalOutputMessage::Closed(event) => {
            flush_session(event_sender, pending, pending_bytes, &event.session_id.0);
            send_event(event_sender, TerminalRuntimeEvent::Closed(event));
        }
        TerminalOutputMessage::Error(event) => {
            if let Some(session_id) = &event.session_id {
                flush_session(event_sender, pending, pending_bytes, &session_id.0);
            }
            send_event(event_sender, TerminalRuntimeEvent::Error(event));
        }
    }
}

fn flush_all(
    event_sender: &SyncSender<TerminalRuntimeEvent>,
    pending: &mut HashMap<String, PendingOutput>,
    pending_bytes: &mut usize,
) {
    let keys = pending.keys().cloned().collect::<Vec<_>>();
    for key in keys {
        flush_session(event_sender, pending, pending_bytes, &key);
    }
}

fn flush_session(
    event_sender: &SyncSender<TerminalRuntimeEvent>,
    pending: &mut HashMap<String, PendingOutput>,
    pending_bytes: &mut usize,
    session_id: &str,
) {
    let Some(mut pending_output) = pending.remove(session_id) else {
        return;
    };
    *pending_bytes = pending_bytes.saturating_sub(pending_output.event.data.len());

    while !pending_output.event.data.is_empty() {
        let split_at = split_at_byte_limit(&pending_output.event.data, OUTPUT_MAX_EVENT_BYTES);
        let chunk = pending_output.event.data[..split_at].to_string();
        pending_output.event.data.replace_range(..split_at, "");
        if chunk.is_empty() {
            continue;
        }

        send_event(
            event_sender,
            TerminalRuntimeEvent::Data(NativeTerminalDataEvent {
                window_id: pending_output.event.window_id.clone(),
                session_id: pending_output.event.session_id.clone(),
                data: chunk,
            }),
        );
    }
}

fn split_at_byte_limit(value: &str, limit: usize) -> usize {
    if value.len() <= limit {
        return value.len();
    }

    let mut split_at = 0;
    for (index, _) in value.char_indices() {
        if index > limit {
            break;
        }
        split_at = index;
    }

    if split_at == 0 { value.len() } else { split_at }
}

fn send_event(sender: &SyncSender<TerminalRuntimeEvent>, event: TerminalRuntimeEvent) {
    let _ = sender.send(event);
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use comando_types::ids::{TerminalSessionId, WindowId};
    use comando_types::terminal::NativeTerminalExitEvent;

    use super::*;

    #[test]
    fn coalesces_small_chunks() {
        let (input_tx, input_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::sync_channel(64);
        let _handle = start_output_coalescer(input_rx, event_tx);

        for chunk in ["a", "b", "c"] {
            input_tx
                .send(TerminalOutputMessage::Data(data_event(chunk)))
                .expect("send data");
        }

        let event = event_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("coalesced event");
        assert_eq!(event, TerminalRuntimeEvent::Data(data_event("abc")));
    }

    #[test]
    fn flushes_session_before_exit() {
        let (input_tx, input_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::sync_channel(64);
        let _handle = start_output_coalescer(input_rx, event_tx);

        input_tx
            .send(TerminalOutputMessage::Data(data_event("ready\n")))
            .expect("send data");
        input_tx
            .send(TerminalOutputMessage::Exit(NativeTerminalExitEvent {
                window_id: WindowId("window_1".to_string()),
                session_id: TerminalSessionId("terminal_1".to_string()),
                exit_code: Some(0),
                signal_code: None,
            }))
            .expect("send exit");

        assert_eq!(
            event_rx.recv_timeout(Duration::from_secs(1)).expect("data"),
            TerminalRuntimeEvent::Data(data_event("ready\n")),
        );
        assert!(matches!(
            event_rx.recv_timeout(Duration::from_secs(1)).expect("exit"),
            TerminalRuntimeEvent::Exit(_)
        ));
    }

    #[test]
    fn chunks_large_output_on_flush() {
        let (input_tx, input_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::sync_channel(64);
        let _handle = start_output_coalescer(input_rx, event_tx);
        let data = "x".repeat(OUTPUT_MAX_EVENT_BYTES + 5);

        input_tx
            .send(TerminalOutputMessage::Data(data_event(&data)))
            .expect("send data");

        let first = event_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("first");
        let second = event_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("second");
        let TerminalRuntimeEvent::Data(first) = first else {
            panic!("expected data");
        };
        let TerminalRuntimeEvent::Data(second) = second else {
            panic!("expected data");
        };
        assert_eq!(first.data.len(), OUTPUT_MAX_EVENT_BYTES);
        assert_eq!(second.data.len(), 5);
    }

    fn data_event(data: &str) -> NativeTerminalDataEvent {
        NativeTerminalDataEvent {
            window_id: WindowId("window_1".to_string()),
            session_id: TerminalSessionId("terminal_1".to_string()),
            data: data.to_string(),
        }
    }
}
