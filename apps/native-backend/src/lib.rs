use std::io::{self, BufRead, Write};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

pub mod commands;
pub mod logging;
pub mod protocol;
pub mod review;

use commands::NativeBackend;
use protocol::{JsonlWriter, RpcOutput, error_response, parse_request_line};

const BACKGROUND_CHANNEL_CAPACITY: usize = 256;
const BACKGROUND_DRAIN_OUTPUT_LIMIT: usize = 64;

enum InputMessage {
    Line(io::Result<String>),
    Eof,
}

pub fn run_stdio<R, W>(reader: R, writer: W) -> io::Result<()>
where
    R: BufRead + Send + 'static,
    W: Write,
{
    let mut writer = JsonlWriter::new(writer);
    let mut backend = NativeBackend::default();
    let (sender, receiver) = mpsc::channel::<InputMessage>();
    let (background_sender, background_receiver) =
        mpsc::sync_channel::<Vec<RpcOutput>>(BACKGROUND_CHANNEL_CAPACITY);

    thread::spawn(move || {
        for line_result in reader.lines() {
            if sender.send(InputMessage::Line(line_result)).is_err() {
                return;
            }
        }
        let _ = sender.send(InputMessage::Eof);
    });

    loop {
        let message = match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                write_background_outputs(
                    &mut writer,
                    &background_receiver,
                    BACKGROUND_DRAIN_OUTPUT_LIMIT,
                )?;
                write_outputs(&mut writer, backend.drain_fs_events(false))?;
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };

        let line = match message {
            InputMessage::Line(line_result) => line_result?,
            InputMessage::Eof => {
                write_background_outputs(&mut writer, &background_receiver, usize::MAX)?;
                write_outputs(&mut writer, backend.drain_fs_events(true))?;
                break;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let command_result = match parse_request_line(&line) {
            Ok(request) => backend.handle_request_background(request, background_sender.clone()),
            Err(error) => {
                logging::diagnostic(format!(
                    "Rejected malformed request: {}",
                    error.error.message
                ));
                commands::CommandResult {
                    outputs: vec![error_response(error.id, *error.error)],
                    should_shutdown: false,
                }
            }
        };

        write_outputs(&mut writer, command_result.outputs)?;
        write_background_outputs(
            &mut writer,
            &background_receiver,
            BACKGROUND_DRAIN_OUTPUT_LIMIT,
        )?;

        if command_result.should_shutdown {
            break;
        }
    }

    Ok(())
}

fn write_background_outputs<W>(
    writer: &mut JsonlWriter<W>,
    receiver: &mpsc::Receiver<Vec<RpcOutput>>,
    max_outputs: usize,
) -> io::Result<()>
where
    W: Write,
{
    let mut written = 0usize;
    for outputs in receiver.try_iter() {
        if written >= max_outputs {
            break;
        }
        written = written.saturating_add(outputs.len());
        write_outputs(writer, outputs)?;
    }
    Ok(())
}

pub fn run_lines(input: &str) -> io::Result<Vec<RpcOutput>> {
    let mut output = Vec::new();
    run_stdio(io::Cursor::new(input.as_bytes().to_vec()), &mut output)?;

    output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(serde_json::from_slice)
        .collect::<Result<Vec<_>, _>>()
        .map_err(io::Error::other)
}

fn write_outputs<W>(writer: &mut JsonlWriter<W>, outputs: Vec<RpcOutput>) -> io::Result<()>
where
    W: Write,
{
    for output in outputs {
        writer.write_output(&output)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{self, BufReader, Cursor, Read, Write};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use serde_json::json;

    use super::run_stdio;

    struct ChannelRead {
        current: Cursor<Vec<u8>>,
        receiver: mpsc::Receiver<Vec<u8>>,
    }

    impl ChannelRead {
        fn new(receiver: mpsc::Receiver<Vec<u8>>) -> Self {
            Self {
                current: Cursor::new(Vec::new()),
                receiver,
            }
        }
    }

    impl Read for ChannelRead {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            loop {
                let bytes_read = self.current.read(buffer)?;
                if bytes_read > 0 {
                    return Ok(bytes_read);
                }

                match self.receiver.recv() {
                    Ok(bytes) => {
                        self.current = Cursor::new(bytes);
                    }
                    Err(_) => return Ok(0),
                }
            }
        }
    }

    #[derive(Clone)]
    struct SharedWriter {
        output: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for SharedWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.output
                .lock()
                .expect("output lock")
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn emits_watcher_invalidations_without_waiting_for_next_request() {
        let (sender, receiver) = mpsc::channel();
        let output = Arc::new(Mutex::new(Vec::new()));
        let writer = SharedWriter {
            output: Arc::clone(&output),
        };
        let handle = thread::spawn(move || {
            run_stdio(BufReader::new(ChannelRead::new(receiver)), writer).expect("stdio");
        });

        send_request(
            &sender,
            json!({
                "id": "queue",
                "command": "backend_queue_test_fs_event",
                "args": {}
            }),
        );
        assert!(wait_for_output(
            &output,
            "\"id\":\"queue\"",
            Duration::from_secs(2)
        ));

        assert!(
            wait_for_output(
                &output,
                "project://tree-invalidated",
                Duration::from_secs(3)
            ),
            "{}",
            String::from_utf8_lossy(&output.lock().expect("output lock"))
        );

        send_request(
            &sender,
            json!({
                "id": "shutdown",
                "command": "backend_shutdown",
                "args": {}
            }),
        );
        drop(sender);
        handle.join().expect("stdio thread");
    }

    #[test]
    fn emits_git_invalidations_from_git_metadata_watch_events() {
        let (sender, receiver) = mpsc::channel();
        let output = Arc::new(Mutex::new(Vec::new()));
        let writer = SharedWriter {
            output: Arc::clone(&output),
        };
        let handle = thread::spawn(move || {
            run_stdio(BufReader::new(ChannelRead::new(receiver)), writer).expect("stdio");
        });

        send_request(
            &sender,
            json!({
                "id": "queue",
                "command": "backend_queue_test_fs_event",
                "args": {
                    "relativePath": ".git/HEAD"
                }
            }),
        );
        assert!(wait_for_output(
            &output,
            "\"id\":\"queue\"",
            Duration::from_secs(2)
        ));

        assert!(
            wait_for_output(
                &output,
                "git://repository-invalidated",
                Duration::from_secs(3)
            ),
            "{}",
            String::from_utf8_lossy(&output.lock().expect("output lock"))
        );

        send_request(
            &sender,
            json!({
                "id": "shutdown",
                "command": "backend_shutdown",
                "args": {}
            }),
        );
        drop(sender);
        handle.join().expect("stdio thread");
    }

    #[test]
    fn ignores_noisy_git_index_watch_events() {
        let (sender, receiver) = mpsc::channel();
        let output = Arc::new(Mutex::new(Vec::new()));
        let writer = SharedWriter {
            output: Arc::clone(&output),
        };
        let handle = thread::spawn(move || {
            run_stdio(BufReader::new(ChannelRead::new(receiver)), writer).expect("stdio");
        });

        send_request(
            &sender,
            json!({
                "id": "queue",
                "command": "backend_queue_test_fs_event",
                "args": {
                    "relativePath": ".git/index"
                }
            }),
        );
        assert!(wait_for_output(
            &output,
            "\"id\":\"queue\"",
            Duration::from_secs(2)
        ));

        thread::sleep(Duration::from_millis(450));
        let snapshot = String::from_utf8_lossy(&output.lock().expect("output lock")).to_string();
        assert!(
            !snapshot.contains("git://repository-invalidated"),
            "{snapshot}"
        );
        assert!(
            !snapshot.contains("project://tree-invalidated"),
            "{snapshot}"
        );

        send_request(
            &sender,
            json!({
                "id": "shutdown",
                "command": "backend_shutdown",
                "args": {}
            }),
        );
        drop(sender);
        handle.join().expect("stdio thread");
    }

    fn send_request(sender: &mpsc::Sender<Vec<u8>>, value: serde_json::Value) {
        let mut line = serde_json::to_vec(&value).expect("json");
        line.push(b'\n');
        sender.send(line).expect("send request");
    }

    fn wait_for_output(output: &Arc<Mutex<Vec<u8>>>, needle: &str, timeout: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            let snapshot =
                String::from_utf8_lossy(&output.lock().expect("output lock")).to_string();
            if snapshot.contains(needle) {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }

        false
    }
}
