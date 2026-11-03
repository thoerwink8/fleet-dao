use std::collections::BTreeMap;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

use crate::win::{self, Job, Reaped};

const DEFAULT_GRACE_MS: u64 = 2_000;
const POLL: Duration = Duration::from_millis(25);

/// One process that was ever seen inside the job. (pid, start) identifies it even if the pid is reused.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Descendant {
    pub pid: u32,
    /// Creation time, 100ns ticks since 1601-01-01.
    pub start: u64,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct Report {
    /// Exit code of the command; null when it never started.
    pub exit_code: Option<i32>,
    pub spawn_error: Option<String>,
    /// Every process seen in the job (including the root), for later verification.
    pub descendants: Vec<Descendant>,
    /// Processes still in the job when the root exited.
    pub stragglers: u32,
    /// Processes still in the job after the job was terminated; 0 means the tree is gone.
    pub leftovers: u32,
}

struct Args {
    name: Option<String>,
    report: Option<String>,
    grace_ms: u64,
    command: Vec<String>,
}

fn parse(args: &[String]) -> Result<Args, String> {
    let mut out = Args {
        name: None,
        report: None,
        grace_ms: DEFAULT_GRACE_MS,
        command: Vec::new(),
    };
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--" => {
                out.command = it.by_ref().cloned().collect();
            }
            "--name" => out.name = Some(it.next().ok_or("--name needs a value")?.clone()),
            "--report" => out.report = Some(it.next().ok_or("--report needs a value")?.clone()),
            "--grace-ms" => {
                out.grace_ms = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or("--grace-ms needs a number")?;
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(out)
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn usage(msg: &str) -> i32 {
    eprintln!("jobrun: {msg}");
    64
}

pub fn main() -> i32 {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some((verb, rest)) = argv.split_first() else {
        return usage("expected one of: run, kill, list, check, reap");
    };
    let args = match parse(rest) {
        Ok(a) => a,
        Err(e) => return usage(&e),
    };
    let name = || match args.name.as_deref() {
        Some(n) if valid_name(n) => Ok(n.to_string()),
        Some(_) => Err("--name may only hold letters, digits, - _ ."),
        None => Err("--name is required"),
    };
    match verb.as_str() {
        "run" => match (name(), args.report.as_deref()) {
            (Ok(n), Some(report)) if !args.command.is_empty() => {
                run(&n, report, &args.command, args.grace_ms)
            }
            (Err(e), _) => usage(e),
            _ => usage("run needs --report FILE and a command after --"),
        },
        "kill" => match name() {
            Ok(n) => kill(&n, args.grace_ms),
            Err(e) => usage(e),
        },
        "list" => match name() {
            Ok(n) => list(&n),
            Err(e) => usage(e),
        },
        "check" | "reap" => match args.report.as_deref() {
            Some(report) => sweep(report, verb == "reap"),
            None => usage("--report FILE is required"),
        },
        other => usage(&format!("unknown command {other}")),
    }
}

fn write_report(path: &str, report: &Report) {
    match serde_json::to_vec(report) {
        Ok(bytes) => {
            // Write then rename so a reader never sees a half-written report.
            let tmp = format!("{path}.tmp");
            if std::fs::write(&tmp, bytes)
                .and_then(|_| std::fs::rename(&tmp, path))
                .is_err()
            {
                eprintln!("jobrun: could not write report {path}");
            }
        }
        Err(e) => eprintln!("jobrun: could not encode report: {e}"),
    }
}

/// Adds every pid currently in the job that has not been recorded yet.
fn record(job: &Job, seen: &mut BTreeMap<u32, u64>) -> Vec<u32> {
    let pids = job.pids().unwrap_or_default();
    for pid in &pids {
        if !seen.contains_key(pid) {
            if let Some(start) = win::creation_time(*pid) {
                seen.insert(*pid, start);
            }
        }
    }
    pids
}

fn wait_empty(job: &Job, grace: Duration) -> u32 {
    let until = Instant::now() + grace;
    loop {
        let left = job.pids().map(|p| p.len() as u32).unwrap_or(0);
        if left == 0 || Instant::now() >= until {
            return left;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn run(name: &str, report_path: &str, command: &[String], grace_ms: u64) -> i32 {
    let mut report = Report::default();
    let job = match Job::create(name) {
        Ok(j) => j,
        Err(e) => {
            report.spawn_error = Some(format!("cannot create job: {e}"));
            write_report(report_path, &report);
            return if e.kind() == std::io::ErrorKind::AlreadyExists {
                4
            } else {
                127
            };
        }
    };
    // Suspended so the command cannot fork anything before it is inside the job.
    let spawned = Command::new(&command[0])
        .args(&command[1..])
        .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            eprintln!("jobrun: cannot start {}: {e}", command[0]);
            report.spawn_error = Some(e.to_string());
            write_report(report_path, &report);
            return 127;
        }
    };
    let started = job
        .assign(&child)
        .and_then(|_| win::resume_process(child.id()));
    if let Err(e) = started {
        let _ = child.kill();
        eprintln!("jobrun: cannot place {} in the job: {e}", command[0]);
        report.spawn_error = Some(format!("cannot place the command in the job: {e}"));
        write_report(report_path, &report);
        return 127;
    }

    let mut seen: BTreeMap<u32, u64> = BTreeMap::new();
    let status = loop {
        record(&job, &mut seen);
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => std::thread::sleep(POLL),
            Err(_) => break None,
        }
    };
    // The root is gone. Whatever is still in the job escaped its parent: count it, then stop it.
    let remaining = record(&job, &mut seen);
    report.stragglers = remaining.len() as u32;
    if !remaining.is_empty() {
        let _ = job.terminate();
    }
    report.leftovers = wait_empty(&job, Duration::from_millis(grace_ms));
    report.exit_code = status;
    report.descendants = seen
        .into_iter()
        .map(|(pid, start)| Descendant { pid, start })
        .collect();
    write_report(report_path, &report);
    status.unwrap_or(1)
}

fn kill(name: &str, grace_ms: u64) -> i32 {
    let Ok(job) = Job::open(name) else {
        eprintln!("jobrun: no job named {name}");
        return 3;
    };
    let _ = job.terminate();
    let left = wait_empty(&job, Duration::from_millis(grace_ms));
    println!("{{\"leftovers\":{left}}}");
    if left == 0 {
        0
    } else {
        1
    }
}

fn list(name: &str) -> i32 {
    let Ok(job) = Job::open(name) else {
        eprintln!("jobrun: no job named {name}");
        return 3;
    };
    match job.pids() {
        Ok(pids) => {
            println!("{}", serde_json::json!({ "pids": pids }));
            0
        }
        Err(e) => {
            eprintln!("jobrun: {e}");
            1
        }
    }
}

/// `check` counts recorded descendants that are still the same live process; `reap` also stops them.
/// A pid that now belongs to some other process is never touched.
fn sweep(report_path: &str, stop: bool) -> i32 {
    let report: Report = match std::fs::read(report_path)
        .map_err(|e| e.to_string())
        .and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string()))
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("jobrun: cannot read report {report_path}: {e}");
            return 1;
        }
    };
    let (mut alive, mut terminated, mut gone, mut reused) = (0u32, 0u32, 0u32, 0u32);
    for d in &report.descendants {
        if stop {
            match win::terminate_if_match(d.pid, d.start) {
                Reaped::Terminated => terminated += 1,
                Reaped::Gone => gone += 1,
                Reaped::Reused => reused += 1,
            }
        } else if win::alive_matching(d.pid, d.start) {
            alive += 1;
        }
    }
    println!(
        "{}",
        serde_json::json!({ "alive": alive, "terminated": terminated, "gone": gone, "reused": reused })
    );
    0
}
