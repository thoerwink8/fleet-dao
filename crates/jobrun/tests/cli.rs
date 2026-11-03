#![cfg(windows)]
// End-to-end: drive the real binary the way the Node side does.
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_jobrun")
}

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("jobrun-test-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn read_report(path: &PathBuf) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(path).expect("report written")).expect("report is json")
}

fn alive(report: &serde_json::Value) -> u64 {
    let path = scratch("check").join("copy.json");
    std::fs::write(&path, serde_json::to_vec(report).unwrap()).unwrap();
    let out = Command::new(bin())
        .args(["check", "--report"])
        .arg(&path)
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    v["alive"].as_u64().unwrap()
}

#[test]
fn exit_code_passes_through_and_the_report_lists_the_root() {
    let report = scratch("exit").join("r.json");
    let status = Command::new(bin())
        .args([
            "run",
            "--name",
            &format!("exit-{}", std::process::id()),
            "--report",
        ])
        .arg(&report)
        .args(["--", "cmd", "/c", "exit 7"])
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(7));
    let r = read_report(&report);
    assert_eq!(r["exit_code"], 7);
    assert_eq!(r["stragglers"], 0);
    assert_eq!(r["leftovers"], 0);
    assert!(
        !r["descendants"].as_array().unwrap().is_empty(),
        "the root is recorded"
    );
}

#[test]
fn a_detached_grandchild_left_behind_is_counted_and_reaped() {
    let report = scratch("left").join("r.json");
    // cmd starts a background ping and exits at once: the ping outlives its parent.
    let status = Command::new(bin())
        .args([
            "run",
            "--name",
            &format!("left-{}", std::process::id()),
            "--report",
        ])
        .arg(&report)
        .args(["--", "cmd", "/c", "start /b ping -n 60 127.0.0.1 >nul"])
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(0));
    let r = read_report(&report);
    assert!(r["stragglers"].as_u64().unwrap() >= 1, "report: {r}");
    assert_eq!(r["leftovers"], 0);
    let t = Instant::now();
    while alive(&r) > 0 && t.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(alive(&r), 0, "every recorded process is gone");
}

#[test]
fn kill_by_name_stops_the_whole_tree() {
    let report = scratch("kill").join("r.json");
    let name = format!("kill-{}", std::process::id());
    let mut sup = Command::new(bin())
        .args(["run", "--name", &name, "--report"])
        .arg(&report)
        .args([
            "--",
            "cmd",
            "/c",
            "start /b ping -n 60 127.0.0.1 >nul & ping -n 60 127.0.0.1 >nul",
        ])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let t = Instant::now();
    loop {
        let out = Command::new(bin())
            .args(["list", "--name", &name])
            .output()
            .unwrap();
        if out.status.success() && String::from_utf8_lossy(&out.stdout).matches(',').count() >= 2 {
            break;
        }
        assert!(t.elapsed() < Duration::from_secs(10), "tree never came up");
        std::thread::sleep(Duration::from_millis(50));
    }
    let killed = Command::new(bin())
        .args(["kill", "--name", &name])
        .output()
        .unwrap();
    assert!(
        killed.status.success(),
        "{}",
        String::from_utf8_lossy(&killed.stdout)
    );
    let waited = Instant::now();
    sup.wait().unwrap();
    assert!(waited.elapsed() < Duration::from_secs(2));
    let r = read_report(&report);
    assert_eq!(r["leftovers"], 0);
    assert_eq!(alive(&r), 0);
    let gone = Command::new(bin())
        .args(["kill", "--name", &name])
        .output()
        .unwrap();
    assert_eq!(
        gone.status.code(),
        Some(3),
        "no such job once the supervisor is gone"
    );
}

#[test]
fn reap_leaves_a_reused_pid_alone() {
    let mut other = Command::new("ping")
        .args(["-n", "30", "127.0.0.1"])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let report = scratch("reuse").join("r.json");
    // A record that names the live process' pid with a creation time that is not its own.
    let fake = serde_json::json!({
        "exit_code": 0, "spawn_error": null, "stragglers": 0, "leftovers": 0,
        "descendants": [{ "pid": other.id(), "start": 1 }]
    });
    std::fs::write(&report, serde_json::to_vec(&fake).unwrap()).unwrap();
    let out = Command::new(bin())
        .args(["reap", "--report"])
        .arg(&report)
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["reused"], 1);
    assert_eq!(v["terminated"], 0);
    assert!(
        other.try_wait().unwrap().is_none(),
        "the unrelated process is still running"
    );
    other.kill().unwrap();
}
