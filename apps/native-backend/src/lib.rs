use std::io::{self, BufRead, Write};

pub mod commands;
pub mod logging;
pub mod protocol;

use commands::NativeBackend;
use protocol::{JsonlWriter, RpcOutput, error_response, parse_request_line};

pub fn run_stdio<R, W>(reader: R, writer: W) -> io::Result<()>
where
    R: BufRead,
    W: Write,
{
    let mut writer = JsonlWriter::new(writer);
    let mut backend = NativeBackend::default();

    for line_result in reader.lines() {
        let line = line_result?;
        if line.trim().is_empty() {
            continue;
        }

        let command_result = match parse_request_line(&line) {
            Ok(request) => backend.handle_request(request),
            Err(error) => {
                logging::diagnostic(format!(
                    "Rejected malformed request: {}",
                    error.error.message
                ));
                commands::CommandResult {
                    outputs: vec![error_response(error.id, error.error)],
                    should_shutdown: false,
                }
            }
        };

        for output in command_result.outputs {
            writer.write_output(&output)?;
        }

        if command_result.should_shutdown {
            break;
        }
    }

    Ok(())
}

pub fn run_lines(input: &str) -> io::Result<Vec<RpcOutput>> {
    let mut output = Vec::new();
    run_stdio(input.as_bytes(), &mut output)?;

    output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(serde_json::from_slice)
        .collect::<Result<Vec<_>, _>>()
        .map_err(io::Error::other)
}
