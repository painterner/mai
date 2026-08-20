//! Standalone sandboxed-command-execution helper.
//!
//! Exists so a non-Rust front end (currently the Ink/Node CLI in
//! `mai-cli-node`) can reuse `maicli`'s bubblewrap + seccomp sandbox
//! without linking against Rust at all: it just spawns this binary as a
//! subprocess, writes one JSON request to stdin, and reads one JSON
//! response from stdout.
//!
//! Request  (stdin):  {"workspace": "/abs/path", "command": "...", "timeout_seconds": 120}
//! Response (stdout): {"ok": true, "exit_code": 0, "stdout": "...", "stderr": "..."}
//!                  | {"ok": false, "error": "..."}

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
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
