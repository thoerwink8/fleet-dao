//! Windows: the supervisor is `hostd jobrun run` (crates/jobrun): it creates a named Job Object that kills its
//! members when the supervisor goes, starts the worker suspended, puts it in the job, resumes it, and writes
//! `report.json` when the worker ends. The supervisor runs detached from hostd (new process group, no console,
//! broken away from any job hostd itself is in), so it survives the connection, hostd and the kernel.
use std::io;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use jobrun::app::{wait_empty, Report};
use jobrun::win::{self, Job};
use windows_sys::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
};

use super::{ReapResult, SpawnSpec, MARKER_KEY};
use crate::frames::{Exit, ReadStream, StopMode};
use crate::store::{create_log, dir_name, read_json, Meta};

const POLL: Duration = Duration::from_millis(25);

fn report_path(dir: &Path) -> std::path::PathBuf {
    dir.join("report.json")
}

pub fn spawn(dir: &Path, spec: &SpawnSpec) -> io::Result<(Meta, Child)> {
    let stdout = create_log(dir, ReadStream::Stdout)?;
    let stderr = create_log(dir, ReadStream::Stderr)?;
    let job = format!("hostd-{}", dir_name(spec.run_id));
    let exe = std::env::current_exe()?;
    // Windows programs (node among them) fail to start without SystemRoot; the caller's environment is otherwise
    // taken as given, which is why it is added only when missing (the way Node's own spawn does).
    let has_system_root = spec
        .env
        .keys()
        .any(|k| k.eq_ignore_ascii_case("SYSTEMROOT"));
    let start = |flags: u32| {
        let mut cmd = Command::new(&exe);
        cmd.args(["jobrun", "run", "--name", &job, "--report"])
            .arg(report_path(dir))
            .arg("--")
            .args(spec.command)
            .env_clear()
            .envs(spec.env)
            .env(MARKER_KEY, spec.marker)
            .current_dir(spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::from(stdout.try_clone()?))
            .stderr(Stdio::from(stderr.try_clone()?))
            .creation_flags(flags);
        if !has_system_root {
            if let Some(root) = std::env::var_os("SYSTEMROOT") {
                cmd.env("SYSTEMROOT", root);
            }
        }
        cmd.spawn()
    };
    let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
    // Leave a job we ourselves are in (e.g. the one a launcher put us in); when that job forbids breakaway, stay put.
    let child = match start(base | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(c) => c,
        Err(_) => start(base)?,
    };
    let pid = child.id();
    let meta = Meta {
        run_id: spec.run_id.to_string(),
        marker: spec.marker.to_string(),
        pid,
        pid_start: win::creation_time(pid),
        job,
        command: spec.command.to_vec(),
        cwd: spec.cwd.to_string(),
    };
    Ok((meta, child))
}

pub fn alive(meta: &Meta) -> Option<bool> {
    meta.pid_start
        .map(|start| win::alive_matching(meta.pid, start))
}

pub fn read_exit(dir: &Path) -> Option<Exit> {
    let report: Report = read_json(&report_path(dir))?;
    if report.spawn_error.is_some() {
        return Some(Exit {
            code: Some(127),
            signal: None,
        });
    }
    report.exit_code.map(|c| Exit {
        code: Some(i64::from(c)),
        signal: None,
    })
}

pub fn stop(meta: &Meta, _mode: StopMode) {
    // Windows has no "polite" signal: both modes end the whole job at once.
    let until = Instant::now() + Duration::from_millis(1_000);
    loop {
        if let Ok(job) = Job::open(&meta.job) {
            let _ = job.terminate();
            return;
        }
        if alive(meta) != Some(true) || Instant::now() >= until {
            break;
        }
        std::thread::sleep(POLL);
    }
    // The job was not there (yet, or any more): end the supervisor itself; its job handle closing takes the tree along.
    if let Some(start) = meta.pid_start {
        let _ = win::terminate_if_match(meta.pid, start);
    }
}

/// Count and end whatever is left: the live job if there is one, else the supervisor's report
/// (every process it saw, by pid and creation time, so a reused pid is never touched).
pub fn reap(meta: &Meta, dir: &Path, grace: Duration) -> ReapResult {
    let until = Instant::now() + grace;
    loop {
        if let Ok(job) = Job::open(&meta.job) {
            let found = job.pids().map(|p| p.len() as u64).unwrap_or(0);
            let _ = job.terminate();
            let left = wait_empty(&job, grace.max(Duration::from_millis(500)));
            return ReapResult {
                found,
                leftovers: Some(u64::from(left)),
            };
        }
        if let Some(report) = read_json::<Report>(&report_path(dir)) {
            for d in &report.descendants {
                // The count below tells whether it is really gone.
                let _ = win::terminate_if_match(d.pid, d.start);
            }
            let still = report
                .descendants
                .iter()
                .filter(|d| win::alive_matching(d.pid, d.start))
                .count() as u64;
            return ReapResult {
                found: u64::from(report.stragglers),
                leftovers: Some(still.max(u64::from(report.leftovers))),
            };
        }
        if alive(meta) != Some(true) || Instant::now() >= until {
            return ReapResult {
                found: 0,
                leftovers: None,
            };
        }
        std::thread::sleep(POLL);
    }
}
