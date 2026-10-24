//! Standalone sandboxed-command-execution helper.
//!
//! Exists so a non-Rust front end (currently the Ink/Node CLI in
//! `apps/cli`) can reuse `maicli`'s bubblewrap + seccomp sandbox
//! without linking against Rust at all: it just spawns this binary as a
//! subprocess, writes one JSON request to stdin, and reads one JSON
//! response from stdout.
//!
//! Request  (stdin):  {"workspace": "/abs/path", "command": "...", "timeout_seconds": 120}
//! Response (stdout): {"ok": true, "exit_code": 0, "stdout": "...", "stderr": "..."}
//!                  | {"ok": false, "error": "..."}

use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};

use maicli::agent::sandbox;

#[derive(Deserialize)]
struct Request {
    workspace: PathBuf,
    command: String,
    #[serde(default = "default_timeout_seconds")]
    timeout_seconds: u64,
}

fn default_timeout_seconds() -> u64 {
    120
}

#[derive(Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stderr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Response {
    fn error(message: impl std::fmt::Display) -> Self {
        Self {
            ok: false,
            exit_code: None,
            stdout: None,
            stderr: None,
            error: Some(message.to_string()),
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args().any(|arg| arg == "--terminal") {
        return run_terminal();
    }

    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .context("Failed to read request JSON from stdin")?;

    let response = match serde_json::from_str::<Request>(&input) {
        Ok(request) => run(request).await,
        Err(err) => Response::error(format_args!("Invalid request JSON: {err}")),
    };

    println!(
        "{}",
        serde_json::to_string(&response).context("Failed to serialize response")?
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TerminalRequest {
    Start {
        workspace: PathBuf,
        command: Option<String>,
        #[serde(default = "default_cols")]
        cols: u16,
        #[serde(default = "default_rows")]
        rows: u16,
    },
    Input {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Signal {
        signal: String,
    },
    Close,
}

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TerminalEvent<'a> {
    Ready,
    Output { data: &'a str },
    Exit { code: Option<u32> },
    Error { message: &'a str },
}

fn emit_terminal(event: &TerminalEvent<'_>) {
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    let _ = serde_json::to_writer(&mut output, event);
    let _ = output.write_all(b"\n");
    let _ = output.flush();
}

fn run_terminal() -> Result<()> {
    #[cfg(not(target_os = "linux"))]
    {
        emit_terminal(&TerminalEvent::Error {
            message: "Interactive sandbox terminals currently require Linux and bubblewrap",
        });
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    run_linux_terminal()
}

#[cfg(target_os = "linux")]
fn run_linux_terminal() -> Result<()> {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};

    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let first = lines
        .next()
        .transpose()?
        .context("Expected a terminal start request")?;
    let request: TerminalRequest =
        serde_json::from_str(&first).context("Invalid terminal start request")?;
    let TerminalRequest::Start {
        workspace,
        command,
        cols,
        rows,
    } = request
    else {
        anyhow::bail!("The first terminal request must have type=start");
    };

    let script = command.unwrap_or_else(|| "exec sh -i".to_string());
    let prepared = sandbox::prepare_interactive_command(&workspace, &script)?;
    let pair = native_pty_system().openpty(PtySize {
        rows: rows.clamp(1, 500),
        cols: cols.clamp(1, 500),
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = CommandBuilder::new(&prepared.program);
    for arg in &prepared.args {
        command.arg(arg);
    }
    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let mut killer = child.clone_killer();

    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let encoded =
                        base64::engine::general_purpose::STANDARD.encode(&buffer[..count]);
                    emit_terminal(&TerminalEvent::Output { data: &encoded });
                }
                Err(error) => {
                    emit_terminal(&TerminalEvent::Error {
                        message: &error.to_string(),
                    });
                    break;
                }
            }
        }
    });

    std::thread::spawn(move || {
        match child.wait() {
            Ok(status) => emit_terminal(&TerminalEvent::Exit {
                code: Some(status.exit_code()),
            }),
            Err(error) => emit_terminal(&TerminalEvent::Error {
                message: &error.to_string(),
            }),
        }
        drop(prepared);
    });

    emit_terminal(&TerminalEvent::Ready);
    for line in lines {
        let line = line?;
        let request: TerminalRequest = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                emit_terminal(&TerminalEvent::Error {
                    message: &format!("Invalid terminal request: {error}"),
                });
                continue;
            }
        };
        match request {
            TerminalRequest::Input { data } => {
                let bytes = match base64::engine::general_purpose::STANDARD.decode(data) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        emit_terminal(&TerminalEvent::Error {
                            message: &format!("Invalid base64 terminal input: {error}"),
                        });
                        continue;
                    }
                };
                writer.write_all(&bytes)?;
                writer.flush()?;
            }
            TerminalRequest::Resize { cols, rows } => {
                pair.master.resize(PtySize {
                    rows: rows.clamp(1, 500),
                    cols: cols.clamp(1, 500),
                    pixel_width: 0,
                    pixel_height: 0,
                })?;
            }
            TerminalRequest::Signal { signal } => {
                if matches!(signal.to_ascii_uppercase().as_str(), "TERM" | "KILL") {
                    killer.kill()?;
                } else if signal.to_ascii_uppercase() == "INT" {
                    writer.write_all(&[3])?;
                    writer.flush()?;
                } else {
                    emit_terminal(&TerminalEvent::Error {
                        message: "Supported terminal signals are INT, TERM, and KILL",
                    });
                }
            }
            TerminalRequest::Close => {
                let _ = killer.kill();
                break;
            }
            TerminalRequest::Start { .. } => emit_terminal(&TerminalEvent::Error {
                message: "Terminal has already started",
            }),
        }
    }
    let _ = killer.kill();
    Ok(())
}

async fn run(request: Request) -> Response {
    let timeout = Duration::from_secs(request.timeout_seconds.clamp(1, 300));
    match sandbox::run_command(&request.workspace, &request.command, timeout).await {
        Ok(output) => Response {
            ok: true,
            exit_code: output.status.code(),
            stdout: Some(String::from_utf8_lossy(&output.stdout).into_owned()),
            stderr: Some(String::from_utf8_lossy(&output.stderr).into_owned()),
            error: None,
        },
        Err(err) => Response::error(format_args!("{err:#}")),
    }
}
