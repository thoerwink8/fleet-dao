// Drives the real binary over stdio the way the kernel does.
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

struct Session {
    child: Child,
    stdin: ChildStdin,
    out: BufReader<ChildStdout>,
}

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("hostd-it-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn open(state: &PathBuf) -> Session {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hostd"))
        .args(["--stdio", "--state-dir"])
        .arg(state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let out = BufReader::new(child.stdout.take().unwrap());
    Session { child, stdin, out }
}

impl Session {
    fn send(&mut self, v: Value) {
        writeln!(self.stdin, "{v}").unwrap();
        self.stdin.flush().unwrap();
    }
    fn recv(&mut self) -> Option<Value> {
        let mut line = String::new();
        if self.out.read_line(&mut line).ok()? == 0 {
            return None;
        }
        Some(serde_json::from_str(&line).unwrap_or_else(|_| panic!("not json: {line}")))
    }
    /// Frames up to and including the first one of this type.
    fn until(&mut self, ty: &str) -> Vec<Value> {
        let mut seen = Vec::new();
        while let Some(f) = self.recv() {
            let hit = f["type"] == ty;
            seen.push(f);
            if hit {
                return seen;
            }
        }
        panic!("connection closed before a {ty} frame; saw {seen:?}");
    }
    fn hello(&mut self) {
        self.send(json!({"type":"hello","id":1,"protocol":1,"client":"test"}));
        assert_eq!(self.recv().unwrap()["type"], "welcome");
    }
    fn close(mut self) {
        drop(self.stdin);
        let _ = self.child.wait();
    }
}

fn worker_cmd() -> Value {
    // The test binary's sibling `hostd --version` prints one line and exits: a worker that needs no shell.
    json!([env!("CARGO_BIN_EXE_hostd"), "--version"])
}

fn spawn(s: &mut Session, id: u64, run: &str, command: Value) {
    s.send(json!({"type":"spawn","id":id,"runId":run,"command":command,"cwd":std::env::temp_dir(),
        "env":{"PATH":std::env::var("PATH").unwrap_or_default(),"SYSTEMROOT":std::env::var("SYSTEMROOT").unwrap_or_default()}}));
}

#[test]
fn a_client_that_speaks_another_version_is_refused_and_disconnected() {
    let state = scratch("version");
    let mut s = open(&state);
    s.send(json!({"type":"hello","id":7,"protocol":99,"client":"test"}));
    let reply = s.recv().unwrap();
    assert_eq!(reply["type"], "error");
    assert_eq!(reply["code"], "version_mismatch");
    assert_eq!(reply["id"], 7);
    assert!(s.recv().is_none(), "hostd must hang up");
    assert_eq!(s.child.wait().unwrap().code(), Some(3));
}

#[test]
fn nothing_works_before_the_handshake() {
    let state = scratch("greet");
    let mut s = open(&state);
    s.send(json!({"type":"status","id":3,"runId":"r"}));
    let reply = s.recv().unwrap();
    assert_eq!(reply["code"], "hello_required");
    s.close();
}

#[test]
fn a_bad_frame_gets_an_error_and_the_connection_goes_on() {
    let state = scratch("bad");
    let mut s = open(&state);
    s.hello();
    writeln!(s.stdin, "not json").unwrap();
    assert_eq!(s.recv().unwrap()["code"], "bad_frame");
    s.send(json!({"type":"status","id":2,"runId":"nope"}));
    let reply = s.recv().unwrap();
    assert_eq!(reply["type"], "state");
    assert_eq!(reply["known"], false);
    s.close();
}

#[test]
fn terminals_are_reserved_but_not_available() {
    let state = scratch("pty");
    let mut s = open(&state);
    s.hello();
    s.send(json!({"type":"pty.open","id":2,"runId":"t","cols":80,"rows":24}));
    let reply = s.recv().unwrap();
    assert_eq!(reply["code"], "unsupported");
    s.close();
}

#[test]
fn a_run_is_started_followed_to_its_end_and_read_again_from_a_line_number() {
    let state = scratch("run");
    let mut s = open(&state);
    s.hello();
    spawn(&mut s, 2, "run-1", worker_cmd());
    let spawned = s.until("spawned");
    assert_eq!(spawned.last().unwrap()["runId"], "run-1");
    s.send(json!({"type":"attach","id":3,"runId":"run-1","after":{"stdout":0,"stderr":0}}));
    let frames = s.until("exit");
    let out: Vec<&Value> = frames.iter().filter(|f| f["type"] == "out").collect();
    assert_eq!(out.len(), 1, "{frames:?}");
    assert_eq!(out[0]["line"], 1);
    assert_eq!(out[0]["stream"], "stdout");
    assert!(out[0]["text"].as_str().unwrap().starts_with("hostd "));
    assert_eq!(frames.last().unwrap()["code"], 0);
    // Same spawn again: the id is taken.
    spawn(&mut s, 4, "run-1", worker_cmd());
    assert_eq!(s.until("error").last().unwrap()["code"], "run_exists");
    // A cursor past the end is refused, one at the end gives nothing and says eof.
    s.send(json!({"type":"read","id":5,"runId":"run-1","stream":"stdout","after":5,"max":10}));
    assert_eq!(s.until("error").last().unwrap()["code"], "cursor_ahead");
    s.send(json!({"type":"read","id":6,"runId":"run-1","stream":"stdout","after":1,"max":10}));
    let lines = s.until("lines").pop().unwrap();
    assert_eq!(lines["lines"], json!([]));
    assert_eq!(lines["eof"], true);
    s.close();
}

#[test]
fn a_second_connection_attaches_to_a_run_the_first_one_started() {
    let state = scratch("reattach");
    let mut first = open(&state);
    first.hello();
    spawn(&mut first, 2, "run-2", worker_cmd());
    first.until("spawned");
    // The first connection goes away without ever reading a line.
    first.close();
    let mut second = open(&state);
    second.hello();
    second.send(json!({"type":"attach","id":2,"runId":"run-2","after":{"stdout":0,"stderr":0}}));
    let frames = second.until("exit");
    let lines: Vec<u64> = frames
        .iter()
        .filter(|f| f["type"] == "out")
        .map(|f| f["line"].as_u64().unwrap())
        .collect();
    assert_eq!(lines, vec![1]);
    second.send(json!({"type":"status","id":3,"runId":"run-2"}));
    let state_frame = second.until("state").pop().unwrap();
    assert_eq!(state_frame["exit"]["code"], 0);
    second.send(json!({"type":"forget","id":4,"runId":"run-2"}));
    assert_eq!(second.until("ok").last().unwrap()["id"], 4);
    second.send(json!({"type":"status","id":5,"runId":"run-2"}));
    assert_eq!(second.until("state").pop().unwrap()["known"], false);
    second.close();
}

#[test]
fn a_command_that_cannot_start_ends_with_127() {
    let state = scratch("nocmd");
    let mut s = open(&state);
    s.hello();
    spawn(&mut s, 2, "run-3", json!(["definitely-not-a-program-xyz"]));
    s.until("spawned");
    s.send(json!({"type":"attach","id":3,"runId":"run-3","after":{"stdout":0,"stderr":0}}));
    let frames = s.until("exit");
    assert_eq!(frames.last().unwrap()["code"], 127);
    s.close();
}
