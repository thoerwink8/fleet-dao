//! Finding the members of one run's session on Unix: everything in the supervisor's process group, plus
//! anything (even in its own session) whose environment still carries the run's marker.
//! Linux reads /proc; elsewhere only the process group is known (via `ps`).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Member {
    pub pid: i32,
}

/// Start time of a process in clock ticks since boot (Linux), used with the pid to tell reused pids apart.
pub fn start_time(pid: i32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let rest = &stat[stat.rfind(')')? + 1..];
        // Fields after the command name: state(3) ppid(4) ... starttime is the 22nd overall, the 20th here.
        rest.split_whitespace().nth(19)?.parse().ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

/// False for a zombie (already dead, waiting to be reaped by its parent).
pub fn is_running(pid: i32) -> Option<bool> {
    // SAFETY: signal 0 only checks that the process exists.
    let exists = unsafe { libc::kill(pid, 0) } == 0
        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    if !exists {
        return Some(false);
    }
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok();
        let state = stat
            .as_deref()
            .and_then(|s| s.get(s.rfind(')')? + 2..)?.chars().next());
        Some(!matches!(state, Some('Z' | 'X') | None))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Some(true)
    }
}

#[cfg(target_os = "linux")]
fn has_marker(pid: i32, needle: &[u8]) -> bool {
    let Ok(env) = std::fs::read(format!("/proc/{pid}/environ")) else {
        return false;
    };
    env.split(|b| *b == 0).any(|entry| entry == needle)
}

/// Live members of the session, excluding `exclude` (the supervisor) and this process.
/// `None` when the process table could not be read at all.
#[cfg(target_os = "linux")]
pub fn members(marker: &str, pgid: i32, exclude: i32) -> Option<Vec<Member>> {
    let needle = format!("{}={marker}", super::MARKER_KEY).into_bytes();
    let me = std::process::id() as i32;
    let mut out = Vec::new();
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<i32>().ok())
        else {
            continue;
        };
        if pid == exclude || pid == me {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some(close) = stat.rfind(')') else {
            continue;
        };
        let mut fields = stat[close + 1..].split_whitespace();
        let state = fields.next().unwrap_or("");
        let pgrp: i32 = fields.nth(1).and_then(|v| v.parse().ok()).unwrap_or(-1);
        if state.starts_with('Z') || state.starts_with('X') {
            continue;
        }
        if pgrp == pgid || has_marker(pid, &needle) {
            out.push(Member { pid });
        }
    }
    Some(out)
}

#[cfg(not(target_os = "linux"))]
pub fn members(_marker: &str, pgid: i32, exclude: i32) -> Option<Vec<Member>> {
    let out = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,pgid=,stat="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let me = std::process::id() as i32;
    let mut members = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut f = line.split_whitespace();
        let (Some(pid), Some(group), Some(stat)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        let (Ok(pid), Ok(group)) = (pid.parse::<i32>(), group.parse::<i32>()) else {
            continue;
        };
        if group == pgid && pid != exclude && pid != me && !stat.starts_with('Z') {
            members.push(Member { pid });
        }
    }
    Some(members)
}
