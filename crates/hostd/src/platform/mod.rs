//! The operating-system part: start a worker detached from this process, tell whether it still runs,
//! read how it ended, stop it, and sweep what it left behind. Unix and Windows differ in how.
//!
//! Both start a small *supervisor* (a re-execution of this very program) that outlives hostd and the
//! connection: on Unix `hostd supervise` (own session, writes `exit.json`), on Windows `hostd jobrun run`
//! (the Job Object keeper from `crates/jobrun`, writes `report.json`). The worker is the supervisor's child
//! and writes straight into the log files, so nothing needs hostd to stay alive.
use std::collections::BTreeMap;

/// The environment variable that carries the session marker to the worker and everything it starts.
pub const MARKER_KEY: &str = "FLEET_RUN_ID";

pub struct SpawnSpec<'a> {
    pub run_id: &'a str,
    pub command: &'a [String],
    pub cwd: &'a str,
    pub env: &'a BTreeMap<String, String>,
    pub marker: &'a str,
}

pub struct ReapResult {
    pub found: u64,
    /// `None` when it could not be counted (never reported as "clean").
    pub leftovers: Option<u64>,
}

#[cfg(unix)]
mod procs;
#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

/// Marker for a run: the caller's own `FLEET_RUN_ID` when it sets one (so a kernel restart finds the
/// same marker), else the run id.
pub fn marker_for(run_id: &str, env: &BTreeMap<String, String>) -> String {
    env.get(MARKER_KEY)
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| run_id.to_string())
}
