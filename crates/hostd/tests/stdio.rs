// Drives the real binary over stdio the way the kernel does.
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hostd::frames::PROTOCOL_VERSION;
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
        self.send(json!({"type":"hello","id":1,"protocol":PROTOCOL_VERSION,"client":"test"}));
        let welcome = self.recv().unwrap();
        assert_eq!(welcome["type"], "welcome");
        assert_eq!(welcome["protocol"], PROTOCOL_VERSION);
        let caps = welcome["capabilities"].as_array().unwrap();
        assert!(caps.iter().any(|c| c == "pty"), "{welcome}");
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

/// Kills only this hostd if the test is still blocked after 45s. Drop clears the flag so a finished
/// test does not taskkill a pid the OS has already reused.
struct Watchdog {
    live: Arc<AtomicBool>,
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.live.store(false, Ordering::SeqCst);
    }
}

fn arm(session: &Session) -> Watchdog {
    let pid = session.child.id();
    let live = Arc::new(AtomicBool::new(true));
    let flag = live.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(45));
        if flag.load(Ordering::SeqCst) {
            kill_tree(pid);
        }
    });
    Watchdog { live }
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .expect("tasklist");
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines().any(|line| {
            line.split(',')
                .any(|col| col.trim().trim_matches('"') == pid.to_string())
        })
    }
    #[cfg(not(windows))]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

fn assert_dead(pid: u32) {
    for _ in 0..50 {
        if !process_alive(pid) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("pid {pid} is still running");
}

fn marker_input(pid_file: &Path) -> String {
    #[cfg(windows)]
    {
        let path = pid_file.display().to_string().replace('\'', "''");
        // The marker is not in the typed text, so the echo of the command cannot satisfy the test.
        format!(
            "Set-Content -LiteralPath '{path}' -Value $PID -Encoding ascii; Write-Output ('FLEET3927-' + [char]0x4E2D + [char]0x6587)\r"
        )
    }
    #[cfg(not(windows))]
    {
        let path = pid_file.display().to_string().replace('\'', "'\\''");
        format!("echo $$ > '{path}'; printf 'FLEET3927-\\344\\270\\255\\346\\226\\207\\n'\n")
    }
}

fn reply_for(s: &mut Session, id: u64) -> Value {
    loop {
        let frame = s
            .recv()
            .unwrap_or_else(|| panic!("eof waiting for id {id}"));
        if frame.get("id").and_then(Value::as_u64) == Some(id) {
            return frame;
        }
    }
}

#[test]
fn pty_rejects_a_bad_size_bad_bytes_and_an_unknown_run() {
    let state = scratch("pty-bad");
    let mut s = open(&state);
    let _watch = arm(&s);
    s.hello();
    s.send(json!({"type":"pty.open","id":2,"runId":"t","cwd":state,"cols":0,"rows":24}));
    let bad_size = s.recv().unwrap();
    assert_eq!(bad_size["code"], "bad_frame", "{bad_size}");
    s.send(json!({"type":"pty.input","id":3,"runId":"missing","data":"bHMK"}));
    assert_eq!(s.recv().unwrap()["code"], "run_not_found");
    let cwd = state.join("cwd");
    std::fs::create_dir(&cwd).unwrap();
    s.send(json!({"type":"pty.open","id":4,"runId":"t","cwd":&cwd,"cols":80,"rows":24}));
    let opened = reply_for(&mut s, 4);
    assert_eq!(opened["type"], "ok", "{opened}");
    s.send(json!({"type":"pty.input","id":5,"runId":"t","data":"!!!"}));
    let bad = reply_for(&mut s, 5);
    assert_eq!(bad["code"], "bad_input", "{bad}");
    assert!(!bad["message"].as_str().unwrap_or("").contains("!!!"));
    s.send(json!({"type":"pty.input","id":6,"runId":"t","data":""}));
    assert_eq!(reply_for(&mut s, 6)["type"], "ok");
    s.send(json!({"type":"pty.close","id":7,"runId":"t"}));
    assert_eq!(reply_for(&mut s, 7)["type"], "ok");
    s.close();
}

#[test]
fn a_pty_prints_utf8_resizes_and_the_shell_is_dead_after_close() {
    let state = scratch("pty-live");
    let cwd = state.join("cwd");
    std::fs::create_dir(&cwd).unwrap();
    let mut s = open(&state);
    let _watch = arm(&s);
    s.hello();
    s.send(json!({"type":"pty.open","id":2,"runId":"t","cwd":&cwd,"cols":80,"rows":24}));
    let opened = reply_for(&mut s, 2);
    assert_eq!(opened["type"], "ok", "{opened}");
    assert_ne!(opened["code"], "unsupported");

    let pid_file = cwd.join("shell-pid.txt");
    let input = marker_input(&pid_file);
    s.send(json!({
        "type": "pty.input",
        "id": 3,
        "runId": "t",
        "data": STANDARD.encode(input.as_bytes()),
    }));
    assert_eq!(reply_for(&mut s, 3)["type"], "ok");

    let marker = "FLEET3927-中文".as_bytes();
    let mut acc = Vec::new();
    while !acc.windows(marker.len()).any(|w| w == marker) {
        let frame = s.recv().unwrap_or_else(|| {
            panic!(
                "eof before the marker; decoded {}",
                String::from_utf8_lossy(&acc)
            )
        });
        if frame["type"] == "out" && frame["stream"] == "pty" {
            let text = frame["text"].as_str().expect("out text");
            let bytes = STANDARD
                .decode(text)
                .unwrap_or_else(|e| panic!("out is not base64: {e}"));
            assert!(frame["line"].as_u64().unwrap() >= 1);
            acc.extend(bytes);
        }
    }
    let shown = String::from_utf8_lossy(&acc);
    assert!(shown.contains("FLEET3927-中文"), "{shown}");

    s.send(json!({"type":"pty.resize","id":4,"runId":"t","cols":100,"rows":40}));
    let resized = reply_for(&mut s, 4);
    assert_eq!(resized["type"], "ok", "{resized}");
    assert_ne!(resized["code"], "unsupported");

    s.send(json!({"type":"pty.close","id":5,"runId":"t"}));
    let mut saw_ok = false;
    let mut saw_exit = false;
    while !(saw_ok && saw_exit) {
        let frame = s
            .recv()
            .unwrap_or_else(|| panic!("eof before close settled; ok={saw_ok} exit={saw_exit}"));
        if frame["type"] == "ok" && frame["id"] == 5 {
            saw_ok = true;
        }
        if frame["type"] == "exit" && frame["runId"] == "t" {
            saw_exit = true;
        }
    }

    let written = std::fs::read_to_string(&pid_file).unwrap_or_else(|e| panic!("no pid file: {e}"));
    let shell_pid: u32 = written
        .split_whitespace()
        .next()
        .unwrap_or_else(|| panic!("empty pid file: {written:?}"))
        .parse()
        .unwrap_or_else(|e| panic!("pid {written:?}: {e}"));
    assert_dead(shell_pid);
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
