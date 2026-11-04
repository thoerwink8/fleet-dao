//! One connection: read request frames from `input`, answer on `output`, and push `out` / `exit` events for
//! the runs the client attached to. Nothing here keeps a worker alive or dead: when the connection ends,
//! workers carry on and the client can attach again from the line numbers it already has.
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::ChildStdin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::frames::{
    parse_frame, peek_id, to_line, Exit, Frame, OutStream, ReadStream, PROTOCOL_VERSION,
};
use crate::platform::{self, marker_for, SpawnSpec};
use crate::store::{log_path, write_json_atomic, LogReader, Meta, Store};

const FOLLOW_POLL: Duration = Duration::from_millis(15);
const CAPABILITIES: [&str; 8] = [
    "spawn", "attach", "read", "stdin", "stop", "reap", "status", "forget",
];

type Output = Arc<Mutex<Box<dyn Write + Send>>>;

/// Writes one frame as a line. False when the client is gone.
fn send(out: &Output, frame: &Frame) -> bool {
    let line = to_line(frame);
    let Ok(mut w) = out.lock() else {
        return false;
    };
    w.write_all(line.as_bytes())
        .and_then(|_| w.write_all(b"\n"))
        .and_then(|_| w.flush())
        .is_ok()
}

fn error(id: Option<u64>, code: &str, message: impl Into<String>) -> Frame {
    Frame::Error {
        id,
        code: code.to_string(),
        message: message.into(),
    }
}

/// How the run ended, if it has. A supervisor that is gone without leaving a result ended as `lost`.
fn current_exit(meta: &Meta, dir: &std::path::Path) -> Option<Exit> {
    let alive = platform::alive(meta);
    if let Some(e) = platform::read_exit(dir) {
        return Some(e);
    }
    if alive == Some(false) {
        // The result is written before the supervisor exits, so look once more now that it is surely gone.
        return Some(platform::read_exit(dir).unwrap_or(Exit {
            code: None,
            signal: Some("lost".into()),
        }));
    }
    None
}

struct Conn {
    store: Arc<Store>,
    out: Output,
    greeted: bool,
    stdins: HashMap<String, ChildStdin>,
    followers: HashMap<String, Arc<AtomicBool>>,
}

enum Flow {
    Reply(Frame),
    /// Reply and close the connection.
    Close(Frame),
    /// The handler already wrote its own reply.
    Silent,
}

impl Conn {
    fn handle(&mut self, frame: Frame) -> Flow {
        if let Frame::Hello {
            id,
            protocol,
            client: _,
        } = &frame
        {
            if *protocol != PROTOCOL_VERSION {
                return Flow::Close(error(
                    Some(*id),
                    "version_mismatch",
                    format!(
                        "hostd speaks protocol {PROTOCOL_VERSION}, the client asked for {protocol}"
                    ),
                ));
            }
            self.greeted = true;
            return Flow::Reply(Frame::Welcome {
                id: *id,
                protocol: PROTOCOL_VERSION,
                hostd: env!("CARGO_PKG_VERSION").to_string(),
                os: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
                capabilities: CAPABILITIES.iter().map(|c| (*c).to_string()).collect(),
            });
        }
        if !self.greeted {
            return Flow::Reply(error(
                request_id(&frame),
                "hello_required",
                "the first frame must be hello",
            ));
        }
        Flow::Reply(match frame {
            Frame::Spawn {
                id,
                run_id,
                command,
                cwd,
                env,
            } => self.spawn(id, run_id, command, cwd, env),
            Frame::Attach { id, run_id, after } => {
                match self.attach(id, run_id, after.stdout, after.stderr) {
                    Some(failure) => failure,
                    None => return Flow::Silent,
                }
            }
            Frame::Read {
                id,
                run_id,
                stream,
                after,
                max,
            } => self.read(id, run_id, stream, after, max.get()),
            Frame::Stdin {
                id,
                run_id,
                data,
                end,
            } => self.stdin(id, &run_id, &data, end),
            Frame::Stop { id, run_id, mode } => match self.store.meta(&run_id) {
                Some(meta) => {
                    platform::stop(&meta, mode);
                    Frame::Ok { id }
                }
                None => not_found(id, &run_id),
            },
            Frame::Reap {
                id,
                run_id,
                grace_ms,
            } => match self.store.meta(&run_id) {
                Some(meta) => {
                    let r = platform::reap(
                        &meta,
                        &self.store.run_dir(&run_id),
                        Duration::from_millis(grace_ms),
                    );
                    Frame::Reaped {
                        id,
                        run_id,
                        found: r.found,
                        leftovers: r.leftovers,
                    }
                }
                None => not_found(id, &run_id),
            },
            Frame::Status { id, run_id } => match self.store.meta(&run_id) {
                Some(meta) => {
                    let exit = current_exit(&meta, &self.store.run_dir(&run_id));
                    Frame::State {
                        id,
                        run_id,
                        known: true,
                        alive: exit
                            .as_ref()
                            .map_or_else(|| platform::alive(&meta), |_| Some(false)),
                        pid: Some(u64::from(meta.pid)),
                        exit,
                    }
                }
                None => Frame::State {
                    id,
                    run_id,
                    known: false,
                    alive: Some(false),
                    pid: None,
                    exit: None,
                },
            },
            Frame::Forget { id, run_id } => self.forget(id, &run_id),
            Frame::PtyOpen { id, .. }
            | Frame::PtyInput { id, .. }
            | Frame::PtyResize { id, .. }
            | Frame::PtyClose { id, .. } => error(
                Some(id),
                "unsupported",
                "terminals are not available in this version of hostd",
            ),
            other => error(
                request_id(&other),
                "bad_frame",
                "this frame is not a request",
            ),
        })
    }

    fn spawn(
        &mut self,
        id: u64,
        run_id: String,
        command: Vec<String>,
        cwd: String,
        env: std::collections::BTreeMap<String, String>,
    ) -> Frame {
        let dir = match self.store.create_run(&run_id) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return error(
                    Some(id),
                    "run_exists",
                    format!("run {run_id} already exists"),
                )
            }
            Err(e) => return error(Some(id), "io", format!("cannot create the run: {e}")),
        };
        let marker = marker_for(&run_id, &env);
        let spec = SpawnSpec {
            run_id: &run_id,
            command: &command,
            cwd: &cwd,
            env: &env,
            marker: &marker,
        };
        let (meta, mut child) = match platform::spawn(&dir, &spec) {
            Ok(r) => r,
            Err(e) => {
                let _ = self.store.forget(&run_id);
                return error(Some(id), "spawn_failed", format!("cannot start: {e}"));
            }
        };
        if let Some(stdin) = child.stdin.take() {
            self.stdins.insert(run_id.clone(), stdin);
        }
        // Reap the supervisor when it ends so it does not linger as a zombie while this connection lives.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        if let Err(e) = write_json_atomic(&dir.join("meta.json"), &meta) {
            return error(Some(id), "io", format!("cannot record the run: {e}"));
        }
        Frame::Spawned {
            id,
            run_id,
            pid: u64::from(meta.pid),
        }
    }

    /// `None` when it answered and started following; `Some(error)` when it could not.
    fn attach(&mut self, id: u64, run_id: String, after_out: u64, after_err: u64) -> Option<Frame> {
        let Some(meta) = self.store.meta(&run_id) else {
            return Some(not_found(id, &run_id));
        };
        if self.followers.contains_key(&run_id) {
            return Some(error(
                Some(id),
                "already_attached",
                format!("run {run_id} is already attached on this connection"),
            ));
        }
        let dir = self.store.run_dir(&run_id);
        let exit = current_exit(&meta, &dir);
        let finished = exit.is_some();
        let open = |stream, after| {
            LogReader::open(log_path(&dir, stream), after, finished).map_err(|have| {
                error(
                    Some(id),
                    "cursor_ahead",
                    format!("{stream:?} has {have} lines, the cursor says {after}"),
                )
            })
        };
        let stdout = match open(ReadStream::Stdout, after_out) {
            Ok(r) => r,
            Err(f) => return Some(f),
        };
        let stderr = match open(ReadStream::Stderr, after_err) {
            Ok(r) => r,
            Err(f) => return Some(f),
        };
        let stop = Arc::new(AtomicBool::new(false));
        self.followers.insert(run_id.clone(), stop.clone());
        let reply = Frame::Attached {
            id,
            run_id: run_id.clone(),
            alive: exit
                .as_ref()
                .map_or_else(|| platform::alive(&meta), |_| Some(false)),
            exit,
        };
        // The reply has to reach the client before the first pushed line: send it from here, start following after.
        if !send(&self.out, &reply) {
            stop.store(true, Ordering::SeqCst);
        }
        let out = self.out.clone();
        std::thread::spawn(move || follow(out, meta, dir, stdout, stderr, stop));
        None
    }

    fn read(&self, id: u64, run_id: String, stream: ReadStream, after: u64, max: u64) -> Frame {
        let Some(meta) = self.store.meta(&run_id) else {
            return not_found(id, &run_id);
        };
        let dir = self.store.run_dir(&run_id);
        let finished = current_exit(&meta, &dir).is_some();
        match LogReader::open(log_path(&dir, stream), after, finished) {
            Ok(mut reader) => {
                let chunk = reader.next(finished, usize::try_from(max).unwrap_or(usize::MAX));
                Frame::Lines {
                    id,
                    run_id,
                    stream,
                    after,
                    lines: chunk.lines,
                    eof: chunk.drained,
                }
            }
            Err(have) => error(
                Some(id),
                "cursor_ahead",
                format!("{stream:?} has {have} lines, the cursor says {after}"),
            ),
        }
    }

    fn stdin(&mut self, id: u64, run_id: &str, data: &str, end: bool) -> Frame {
        let Some(stdin) = self.stdins.get_mut(run_id) else {
            return error(
                Some(id),
                "stdin_closed",
                "stdin is only open on the connection that started the run",
            );
        };
        let written = stdin.write_all(data.as_bytes()).and_then(|_| stdin.flush());
        if end || written.is_err() {
            self.stdins.remove(run_id);
        }
        match written {
            Ok(()) => Frame::Ok { id },
            Err(e) => error(Some(id), "stdin_closed", format!("cannot write stdin: {e}")),
        }
    }

    fn forget(&mut self, id: u64, run_id: &str) -> Frame {
        let Some(meta) = self.store.meta(run_id) else {
            return not_found(id, run_id);
        };
        let dir = self.store.run_dir(run_id);
        if current_exit(&meta, &dir).is_none() {
            return error(Some(id), "run_alive", "the run has not ended");
        }
        if let Some(flag) = self.followers.remove(run_id) {
            flag.store(true, Ordering::SeqCst);
        }
        self.stdins.remove(run_id);
        match self.store.forget(run_id) {
            Ok(()) => Frame::Ok { id },
            Err(e) => error(Some(id), "io", format!("cannot remove the run: {e}")),
        }
    }
}

fn not_found(id: u64, run_id: &str) -> Frame {
    error(Some(id), "run_not_found", format!("no run {run_id}"))
}

fn request_id(frame: &Frame) -> Option<u64> {
    match frame {
        Frame::Hello { id, .. }
        | Frame::Spawn { id, .. }
        | Frame::Attach { id, .. }
        | Frame::Read { id, .. }
        | Frame::Stdin { id, .. }
        | Frame::Stop { id, .. }
        | Frame::Reap { id, .. }
        | Frame::Status { id, .. }
        | Frame::Forget { id, .. }
        | Frame::PtyOpen { id, .. }
        | Frame::PtyInput { id, .. }
        | Frame::PtyResize { id, .. }
        | Frame::PtyClose { id, .. } => Some(*id),
        _ => None,
    }
}

/// Pushes the run's lines as `out` frames and, once the worker has ended and both logs are drained, one `exit` frame.
fn follow(
    out: Output,
    meta: Meta,
    dir: PathBuf,
    mut stdout: LogReader,
    mut stderr: LogReader,
    stop: Arc<AtomicBool>,
) {
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        // Ask first, read after: once the end is recorded the logs are complete.
        let exit = current_exit(&meta, &dir);
        let finished = exit.is_some();
        let mut sent = false;
        let (mut out_done, mut err_done) = (false, false);
        for (stream, reader, done) in [
            (OutStream::Stdout, &mut stdout, &mut out_done),
            (OutStream::Stderr, &mut stderr, &mut err_done),
        ] {
            loop {
                let chunk = reader.next(finished, 512);
                let n = chunk.lines.len() as u64;
                let first = reader.line - n;
                for (i, text) in chunk.lines.into_iter().enumerate() {
                    let Some(line) = std::num::NonZeroU64::new(first + i as u64 + 1) else {
                        continue;
                    };
                    let frame = Frame::Out {
                        run_id: meta.run_id.clone(),
                        stream,
                        line,
                        text,
                    };
                    if !send(&out, &frame) {
                        return;
                    }
                    sent = true;
                }
                if chunk.drained {
                    *done = true;
                }
                if n == 0 || chunk.drained {
                    break;
                }
            }
        }
        if let Some(e) = exit {
            if out_done && err_done {
                send(
                    &out,
                    &Frame::ExitEvent {
                        run_id: meta.run_id.clone(),
                        code: e.code,
                        signal: e.signal,
                    },
                );
                return;
            }
        }
        if !sent {
            std::thread::sleep(FOLLOW_POLL);
        }
    }
}

/// Serves one connection until the client closes its side. Returns the process exit code.
pub fn serve(store: Arc<Store>, mut input: impl BufRead, output: Box<dyn Write + Send>) -> i32 {
    let out: Output = Arc::new(Mutex::new(output));
    let mut conn = Conn {
        store,
        out: out.clone(),
        greeted: false,
        stdins: HashMap::new(),
        followers: HashMap::new(),
    };
    let mut line = String::new();
    let code = loop {
        line.clear();
        match input.read_line(&mut line) {
            Ok(0) => break 0,
            Ok(_) => {}
            Err(_) => break 1,
        }
        let text = line.trim_end_matches(['\n', '\r']);
        if text.is_empty() {
            continue;
        }
        let frame = match parse_frame(text) {
            Ok(f) => f,
            Err(why) => {
                send(&out, &error(peek_id(text), "bad_frame", why));
                continue;
            }
        };
        match conn.handle(frame) {
            // `attach` already answered by itself (so its reply precedes the pushed lines).
            Flow::Silent => {}
            Flow::Reply(reply) => {
                if !send(&out, &reply) {
                    break 1;
                }
            }
            Flow::Close(reply) => {
                send(&out, &reply);
                break 3;
            }
        }
    };
    // Stop following; closing the workers' stdin tells them the client is gone. The workers themselves carry on.
    for flag in conn.followers.values() {
        flag.store(true, Ordering::SeqCst);
    }
    drop(conn);
    code
}
