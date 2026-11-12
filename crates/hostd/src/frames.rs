//! The stdio frame protocol: one JSON object per line. The definition lives in
//! `packages/harness-contract/src/hostd-frames.ts`; `tests/frames.rs` reads the sample frames exported from
//! there and checks that these types accept exactly the same frames and write them back unchanged.
//! Every frame is strict: an unknown or missing field is an error (versions are negotiated in the handshake).
use std::collections::BTreeMap;
use std::num::NonZeroU64;

use serde::{Deserialize, Serialize};

/// Bumped whenever a frame gains, loses or changes a field. hostd refuses a client that speaks another one.
pub const PROTOCOL_VERSION: u64 = 2;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReadStream {
    Stdout,
    Stderr,
}

/// `Pty` is the terminal. `text` is standard base64 of the raw bytes (no extra newline), and `line` counts chunks from 1.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutStream {
    Stdout,
    Stderr,
    Pty,
}

impl From<ReadStream> for OutStream {
    fn from(s: ReadStream) -> Self {
        match s {
            ReadStream::Stdout => OutStream::Stdout,
            ReadStream::Stderr => OutStream::Stderr,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StopMode {
    Term,
    Kill,
}

/// How a worker ended. `signal` is `lost` when its supervisor vanished before it could say.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Exit {
    pub code: Option<i64>,
    pub signal: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct After {
    pub stdout: u64,
    pub stderr: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "type", deny_unknown_fields, rename_all_fields = "camelCase")]
pub enum Frame {
    // client -> hostd
    #[serde(rename = "hello")]
    Hello {
        id: u64,
        protocol: u64,
        client: String,
    },
    #[serde(rename = "spawn")]
    Spawn {
        id: u64,
        run_id: String,
        command: Vec<String>,
        cwd: String,
        env: BTreeMap<String, String>,
    },
    #[serde(rename = "attach")]
    Attach {
        id: u64,
        run_id: String,
        after: After,
    },
    #[serde(rename = "read")]
    Read {
        id: u64,
        run_id: String,
        stream: ReadStream,
        after: u64,
        max: NonZeroU64,
    },
    #[serde(rename = "stdin")]
    Stdin {
        id: u64,
        run_id: String,
        data: String,
        end: bool,
    },
    #[serde(rename = "stop")]
    Stop {
        id: u64,
        run_id: String,
        mode: StopMode,
    },
    #[serde(rename = "reap")]
    Reap {
        id: u64,
        run_id: String,
        grace_ms: u64,
    },
    #[serde(rename = "status")]
    Status { id: u64, run_id: String },
    #[serde(rename = "forget")]
    Forget { id: u64, run_id: String },
    // Terminal: a real pty in `cwd`. Bytes come back as `out` frames with `stream: pty`.
    #[serde(rename = "pty.open")]
    PtyOpen {
        id: u64,
        run_id: String,
        cwd: String,
        cols: u64,
        rows: u64,
    },
    #[serde(rename = "pty.input")]
    PtyInput {
        id: u64,
        run_id: String,
        data: String,
    },
    #[serde(rename = "pty.resize")]
    PtyResize {
        id: u64,
        run_id: String,
        cols: u64,
        rows: u64,
    },
    #[serde(rename = "pty.close")]
    PtyClose { id: u64, run_id: String },

    // hostd -> client
    #[serde(rename = "welcome")]
    Welcome {
        id: u64,
        protocol: u64,
        hostd: String,
        os: String,
        arch: String,
        capabilities: Vec<String>,
    },
    #[serde(rename = "spawned")]
    Spawned { id: u64, run_id: String, pid: u64 },
    #[serde(rename = "attached")]
    Attached {
        id: u64,
        run_id: String,
        alive: Option<bool>,
        exit: Option<Exit>,
    },
    #[serde(rename = "lines")]
    Lines {
        id: u64,
        run_id: String,
        stream: ReadStream,
        after: u64,
        lines: Vec<String>,
        eof: bool,
    },
    #[serde(rename = "state")]
    State {
        id: u64,
        run_id: String,
        known: bool,
        alive: Option<bool>,
        pid: Option<u64>,
        exit: Option<Exit>,
    },
    #[serde(rename = "ok")]
    Ok { id: u64 },
    #[serde(rename = "reaped")]
    Reaped {
        id: u64,
        run_id: String,
        found: u64,
        leftovers: Option<u64>,
    },
    #[serde(rename = "error")]
    Error {
        id: Option<u64>,
        code: String,
        message: String,
    },

    // hostd -> client, pushed
    #[serde(rename = "out")]
    Out {
        run_id: String,
        stream: OutStream,
        line: NonZeroU64,
        text: String,
    },
    #[serde(rename = "exit")]
    ExitEvent {
        run_id: String,
        code: Option<i64>,
        signal: Option<String>,
    },
}

const MAX_RUN_ID: usize = 200;

fn check_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty() || run_id.chars().count() > MAX_RUN_ID {
        return Err("runId must be 1..=200 characters".into());
    }
    Ok(())
}

fn check_cwd(cwd: &str) -> Result<(), String> {
    if cwd.is_empty() || cwd.chars().count() > 4096 {
        return Err("cwd must be 1..=4096 characters".into());
    }
    Ok(())
}

fn check_pty_size(cols: u64, rows: u64) -> Result<(), String> {
    if !(1..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err("cols and rows must be 1..=1000".into());
    }
    Ok(())
}

impl Frame {
    /// The checks the JSON Schema expresses beyond field shapes.
    fn validate(&self) -> Result<(), String> {
        match self {
            Frame::Hello { client, .. } if client.chars().count() > 200 => {
                Err("client is too long".into())
            }
            Frame::Spawn {
                run_id, command, ..
            } => {
                check_run_id(run_id)?;
                if command.is_empty() {
                    return Err("command must not be empty".into());
                }
                Ok(())
            }
            Frame::PtyOpen {
                run_id,
                cwd,
                cols,
                rows,
                ..
            } => {
                check_run_id(run_id)?;
                check_cwd(cwd)?;
                check_pty_size(*cols, *rows)
            }
            Frame::PtyResize {
                run_id, cols, rows, ..
            } => {
                check_run_id(run_id)?;
                check_pty_size(*cols, *rows)
            }
            Frame::Attach { run_id, .. }
            | Frame::Read { run_id, .. }
            | Frame::Stdin { run_id, .. }
            | Frame::Stop { run_id, .. }
            | Frame::Reap { run_id, .. }
            | Frame::Status { run_id, .. }
            | Frame::Forget { run_id, .. }
            | Frame::PtyInput { run_id, .. }
            | Frame::PtyClose { run_id, .. }
            | Frame::Spawned { run_id, .. }
            | Frame::Attached { run_id, .. }
            | Frame::Lines { run_id, .. }
            | Frame::State { run_id, .. }
            | Frame::Reaped { run_id, .. }
            | Frame::Out { run_id, .. }
            | Frame::ExitEvent { run_id, .. } => check_run_id(run_id),
            _ => Ok(()),
        }
    }
}

/// Parses one line into a frame, applying the same rules as the TypeScript definition.
pub fn parse_frame(line: &str) -> Result<Frame, String> {
    let frame: Frame = serde_json::from_str(line).map_err(|e| e.to_string())?;
    frame.validate()?;
    Ok(frame)
}

/// The request id, when the line is at least a JSON object with a numeric `id` (used to answer a bad frame).
pub fn peek_id(line: &str) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()?
        .get("id")?
        .as_u64()
}

pub fn to_line(frame: &Frame) -> String {
    // A frame that was built in memory always serializes.
    serde_json::to_string(frame).unwrap_or_else(|e| {
        format!(
            "{{\"type\":\"error\",\"id\":null,\"code\":\"internal\",\"message\":{}}}",
            serde_json::Value::String(e.to_string())
        )
    })
}
