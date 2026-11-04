//! Unix: the supervisor is `hostd supervise`, started in its own session (setsid), so it is not touched when the
//! connection, hostd or the kernel go away. It runs the worker as its child with the log files as stdout/stderr,
//! waits, and writes `exit.json`. Stopping and sweeping go through the session's members (see `procs`).
use std::io;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use super::procs::{self, Member};
use super::{ReapResult, SpawnSpec, MARKER_KEY};
use crate::frames::{Exit, StopMode};
use crate::store::{read_json, write_json_atomic, Meta};

const POLL: Duration = Duration::from_millis(20);

pub fn spawn(dir: &Path, spec: &SpawnSpec) -> io::Result<(Meta, Child)> {
    let stdout = crate::store::create_log(dir, crate::frames::ReadStream::Stdout)?;
    let stderr = crate::store::create_log(dir, crate::frames::ReadStream::Stderr)?;
    let mut cmd = Command::new(std::env::current_exe()?);
    cmd.arg("supervise")
        .arg("--dir")
        .arg(dir)
        .arg("--")
        .args(spec.command)
        .env_clear()
        .envs(spec.env)
        .env(MARKER_KEY, spec.marker)
        .current_dir(spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    // SAFETY: setsid is async-signal-safe and touches no memory of ours.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    let pid = child.id();
    let meta = Meta {
        run_id: spec.run_id.to_string(),
        marker: spec.marker.to_string(),
        pid,
        pid_start: procs::start_time(pid as i32),
        job: String::new(),
        command: spec.command.to_vec(),
        cwd: spec.cwd.to_string(),
    };
    Ok((meta, child))
}

/// Is the supervisor still there? `None` when it cannot be told.
pub fn alive(meta: &Meta) -> Option<bool> {
    let pid = meta.pid as i32;
    if let (Some(then), Some(now)) = (meta.pid_start, procs::start_time(pid)) {
        if then != now {
            return Some(false); // the pid belongs to someone else now
        }
    }
    procs::is_running(pid)
}

pub fn read_exit(dir: &Path) -> Option<Exit> {
    read_json(&dir.join("exit.json"))
}

fn signal(members: &[Member], sig: i32) {
    for m in members {
        // SAFETY: plain kill(2) on a pid we just listed; a stale pid at worst gets ESRCH.
        unsafe { libc::kill(m.pid, sig) };
    }
}

fn list(meta: &Meta) -> Option<Vec<Member>> {
    procs::members(&meta.marker, meta.pid as i32, meta.pid as i32)
}

pub fn stop(meta: &Meta, mode: StopMode) {
    match mode {
        StopMode::Term => {
            if let Some(m) = list(meta) {
                signal(&m, libc::SIGTERM);
            }
            // The supervisor ignores this one (it waits for its child and reports); the group gets it too, so
            // anything forked between the listing and now does not escape.
            // SAFETY: killpg on the supervisor's own session.
            unsafe { libc::killpg(meta.pid as i32, libc::SIGTERM) };
        }
        StopMode::Kill => {
            // Kill the members, not the supervisor: it has to live long enough to record how the worker ended.
            for _ in 0..3 {
                match list(meta) {
                    Some(m) if !m.is_empty() => signal(&m, libc::SIGKILL),
                    _ => break,
                }
                std::thread::sleep(POLL);
            }
        }
    }
}

/// Sweep what the worker left in the session: count, ask politely, wait up to `grace`, force, count again.
pub fn reap(meta: &Meta, _dir: &Path, grace: Duration) -> ReapResult {
    let Some(first) = list(meta) else {
        return ReapResult {
            found: 0,
            leftovers: None,
        };
    };
    let found = first.len() as u64;
    if first.is_empty() {
        return ReapResult {
            found,
            leftovers: Some(0),
        };
    }
    signal(&first, libc::SIGTERM);
    let until = Instant::now() + grace;
    let mut left = wait_gone(meta, until);
    if left != Some(0) {
        if let Some(m) = list(meta) {
            signal(&m, libc::SIGKILL);
        }
        left = wait_gone(meta, Instant::now() + Duration::from_millis(1_000));
    }
    ReapResult {
        found,
        leftovers: left,
    }
}

fn wait_gone(meta: &Meta, until: Instant) -> Option<u64> {
    loop {
        let n = list(meta).map(|m| m.len() as u64);
        if n == Some(0) || Instant::now() >= until {
            return n;
        }
        std::thread::sleep(POLL);
    }
}

/// Swallows the signal: being signalled must not stop the supervisor.
extern "C" fn on_signal(_: libc::c_int) {}

fn signal_name(n: i32) -> String {
    match n {
        1 => "SIGHUP".into(),
        2 => "SIGINT".into(),
        3 => "SIGQUIT".into(),
        6 => "SIGABRT".into(),
        9 => "SIGKILL".into(),
        11 => "SIGSEGV".into(),
        13 => "SIGPIPE".into(),
        14 => "SIGALRM".into(),
        15 => "SIGTERM".into(),
        other => format!("SIG{other}"),
    }
}

/// `hostd supervise --dir DIR -- CMD ARGS...`: run CMD (stdio, cwd and environment inherited from hostd's
/// spawn), wait for it, record how it ended. SIGTERM/SIGHUP/SIGINT are noted but do not stop the supervisor:
/// the group is signalled together with the worker, and the supervisor must outlive it to write the result.
pub fn supervise(args: &[String]) -> i32 {
    let (Some(dir_at), Some(sep)) = (
        args.iter().position(|a| a == "--dir"),
        args.iter().position(|a| a == "--"),
    ) else {
        eprintln!("hostd supervise: expected --dir DIR -- CMD ARGS...");
        return 64;
    };
    let (Some(dir), true) = (args.get(dir_at + 1), sep + 1 < args.len()) else {
        eprintln!("hostd supervise: expected --dir DIR -- CMD ARGS...");
        return 64;
    };
    let dir = Path::new(dir);
    let command = &args[sep + 1..];
    // SAFETY: the handler only stores into an atomic. Handlers are reset to default in the exec'ed worker.
    unsafe {
        for sig in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
            libc::signal(
                sig,
                on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
            );
        }
    }
    let record = |exit: &Exit| {
        if write_json_atomic(&dir.join("exit.json"), exit).is_err() {
            eprintln!("hostd supervise: could not write exit.json");
        }
    };
    let mut child = match Command::new(&command[0]).args(&command[1..]).spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("hostd: cannot start {}: {e}", command[0]);
            record(&Exit {
                code: Some(127),
                signal: None,
            });
            return 127;
        }
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => std::thread::sleep(POLL),
            Err(_) => break None,
        }
    };
    let exit = match status {
        Some(s) => Exit {
            code: s.code().map(i64::from),
            signal: s.signal().map(signal_name),
        },
        None => Exit {
            code: None,
            signal: Some("lost".into()),
        },
    };
    record(&exit);
    exit.code.map(|c| c as i32).unwrap_or(1)
}
