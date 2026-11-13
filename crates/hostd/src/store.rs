//! What hostd keeps on disk. One directory per run under the state directory:
//!
//! ```text
//! <state>/runs/<name>/meta.json     who the supervisor is (pid, start time, session marker)
//!                     stdout.log    the worker's stdout, written by the OS (not by hostd)
//!                     stderr.log    the worker's stderr
//!                     exit.json     written by the supervisor when the worker ends (Unix); Windows uses report.json
//! ```
//!
//! The logs are plain files the worker writes itself, so they keep growing when the kernel, the ssh
//! connection and hostd are all gone. A line number is the count of `\n`-terminated lines before it (+1);
//! the unterminated tail of a finished run counts as one last line.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::frames::ReadStream;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Meta {
    pub run_id: String,
    /// Value of `FLEET_RUN_ID` in the worker's environment: the session marker its descendants inherit.
    pub marker: String,
    /// The supervisor (the process hostd started); the worker is its child.
    pub pid: u32,
    /// Start time of the supervisor in the platform's own unit; with the pid it identifies one process for good.
    pub pid_start: Option<u64>,
    /// Name of the Windows Job Object (empty elsewhere).
    pub job: String,
    pub command: Vec<String>,
    pub cwd: String,
}

pub struct Store {
    root: PathBuf,
}

/// Directory-safe name for a run id: readable prefix plus a hash, so two ids never share a directory.
pub fn dir_name(run_id: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in run_id.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let readable: String = run_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    format!("{readable}-{hash:016x}")
}

pub fn default_state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("FLEET_HOSTD_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        base.join("fleet-hostd")
    }
    #[cfg(not(windows))]
    {
        if let Some(dir) = std::env::var_os("XDG_STATE_HOME").filter(|v| !v.is_empty()) {
            return PathBuf::from(dir).join("fleet-hostd");
        }
        match std::env::var_os("HOME").filter(|v| !v.is_empty()) {
            Some(home) => PathBuf::from(home).join(".local/state/fleet-hostd"),
            None => std::env::temp_dir().join("fleet-hostd"),
        }
    }
}

impl Store {
    pub fn open(root: impl Into<PathBuf>) -> io::Result<Store> {
        let root = root.into();
        fs::create_dir_all(root.join("runs"))?;
        Ok(Store { root })
    }

    pub fn run_dir(&self, run_id: &str) -> PathBuf {
        self.root.join("runs").join(dir_name(run_id))
    }

    /// Creates the run directory; `AlreadyExists` when the id was used before (and not forgotten).
    pub fn create_run(&self, run_id: &str) -> io::Result<PathBuf> {
        let dir = self.run_dir(run_id);
        fs::create_dir(&dir)?;
        Ok(dir)
    }

    pub fn meta(&self, run_id: &str) -> Option<Meta> {
        read_json(&self.run_dir(run_id).join("meta.json"))
    }

    pub fn forget(&self, run_id: &str) -> io::Result<()> {
        fs::remove_dir_all(self.run_dir(run_id))
    }
}

pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Write then rename, so a reader never sees half a file.
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec(value).map_err(io::Error::other)?)?;
    fs::rename(&tmp, path)
}

pub fn log_path(dir: &Path, stream: ReadStream) -> PathBuf {
    dir.join(match stream {
        ReadStream::Stdout => "stdout.log",
        ReadStream::Stderr => "stderr.log",
    })
}

pub fn create_log(dir: &Path, stream: ReadStream) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path(dir, stream))
}

/// Reads a log line by line from a line number. Keeps its byte offset, so following a growing file is cheap.
pub struct LogReader {
    path: PathBuf,
    offset: u64,
    /// Lines already handed out (the cursor).
    pub line: u64,
}

pub struct Chunk {
    pub lines: Vec<String>,
    /// Everything up to the end of the file was read (and the run is over, so no more will come).
    pub drained: bool,
}

fn text_of(bytes: &[u8]) -> String {
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

impl LogReader {
    /// Positions after the first `after` lines. `Err(have)` when the log holds fewer than that many lines.
    pub fn open(path: PathBuf, after: u64, finished: bool) -> Result<LogReader, u64> {
        let mut reader = LogReader {
            path,
            offset: 0,
            line: 0,
        };
        if after == 0 {
            return Ok(reader);
        }
        let mut file = match File::open(&reader.path) {
            Ok(f) => f,
            Err(_) => return Err(0),
        };
        let mut buf = vec![0u8; 64 * 1024];
        let mut seen = 0u64;
        let mut pos = 0u64;
        let mut tail_start = 0u64;
        loop {
            let n = file.read(&mut buf).unwrap_or(0);
            if n == 0 {
                break;
            }
            for (i, b) in buf[..n].iter().enumerate() {
                if *b == b'\n' {
                    seen += 1;
                    tail_start = pos + i as u64 + 1;
                    if seen == after {
                        reader.offset = tail_start;
                        reader.line = after;
                        return Ok(reader);
                    }
                }
            }
            pos += n as u64;
        }
        // The unterminated tail of a finished run is the last line.
        if finished && pos > tail_start && seen + 1 == after {
            reader.offset = pos;
            reader.line = after;
            return Ok(reader);
        }
        Err(seen + u64::from(finished && pos > tail_start))
    }

    /// Next whole lines (at most `max`). With `finished` true an unterminated tail is a line too.
    pub fn next(&mut self, finished: bool, max: usize) -> Chunk {
        let mut lines = Vec::new();
        let Ok(mut file) = File::open(&self.path) else {
            return Chunk {
                lines,
                drained: finished,
            };
        };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Chunk {
                lines,
                drained: false,
            };
        }
        let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
        // Read a bounded piece so a huge backlog is handed out in parts; grow it when one line is bigger.
        let mut cap: u64 = 8 * 1024 * 1024;
        let mut data = Vec::new();
        loop {
            data.clear();
            let _ = file.seek(SeekFrom::Start(self.offset));
            let _ = file.by_ref().take(cap).read_to_end(&mut data);
            let whole_rest = self.offset + data.len() as u64 >= file_len;
            if whole_rest || data.contains(&b'\n') {
                break;
            }
            cap = cap.saturating_mul(2);
        }
        let reached_eof = self.offset + data.len() as u64 >= file_len;
        let mut start = 0usize;
        while lines.len() < max {
            match data[start..].iter().position(|b| *b == b'\n') {
                Some(nl) => {
                    lines.push(text_of(&data[start..start + nl]));
                    start += nl + 1;
                }
                None => break,
            }
        }
        if lines.len() < max && reached_eof && finished && start < data.len() {
            lines.push(text_of(&data[start..]));
            start = data.len();
        }
        self.offset += start as u64;
        self.line += lines.len() as u64;
        Chunk {
            lines,
            drained: finished && reached_eof && start == data.len(),
        }
    }
}

/// How many lines a log holds (counting the unterminated tail only when `finished`).
pub fn count_lines(path: &Path, finished: bool) -> u64 {
    let Ok(mut file) = File::open(path) else {
        return 0;
    };
    let mut buf = vec![0u8; 64 * 1024];
    let (mut lines, mut last) = (0u64, b'\n');
    loop {
        let n = file.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        lines += buf[..n].iter().filter(|b| **b == b'\n').count() as u64;
        last = buf[n - 1];
    }
    if finished && last != b'\n' {
        lines += 1;
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hostd-store-{}-{tag}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn dir_names_are_safe_and_distinct() {
        assert_ne!(dir_name("a/b"), dir_name("a_b"));
        assert!(!dir_name("../x:y").contains(['/', ':']));
    }

    #[test]
    fn lines_resume_from_a_line_number_without_gaps_or_repeats() {
        let path = tmp("resume").join("out.log");
        fs::write(&path, "one\r\ntwo\nthree\npart").unwrap();
        let mut r = LogReader::open(path.clone(), 0, false).unwrap();
        let c = r.next(false, 100);
        assert_eq!(c.lines, vec!["one", "two", "three"]);
        assert!(!c.drained);
        // From line 2 on: three, then (once finished) the unterminated tail.
        let mut r = LogReader::open(path.clone(), 2, true).unwrap();
        let c = r.next(true, 100);
        assert_eq!(c.lines, vec!["three", "part"]);
        assert!(c.drained);
        assert_eq!(r.line, 4);
        // The tail counts as line 4 only after the run is finished.
        assert!(LogReader::open(path.clone(), 4, false).is_err());
        assert!(LogReader::open(path.clone(), 4, true).is_ok());
        assert_eq!(count_lines(&path, false), 3);
        assert_eq!(count_lines(&path, true), 4);
    }

    #[test]
    fn utf8_chinese_line_is_not_read_as_gbk() {
        let path = tmp("zh").join("out.log");
        fs::write(&path, "收到：请回一句收到\n").unwrap();
        let mut r = LogReader::open(path, 0, true).unwrap();
        let c = r.next(true, 8);
        assert_eq!(c.lines, vec!["收到：请回一句收到"]);
        assert!(c.drained);
    }

    #[test]
    fn a_cursor_ahead_of_the_log_is_refused() {
        let path = tmp("ahead").join("out.log");
        fs::write(&path, "one\n").unwrap();
        assert_eq!(LogReader::open(path, 5, true).err(), Some(1));
    }

    #[test]
    fn a_growing_file_is_followed() {
        let path = tmp("grow").join("out.log");
        fs::write(&path, "a\nb").unwrap();
        let mut r = LogReader::open(path.clone(), 0, false).unwrap();
        assert_eq!(r.next(false, 10).lines, vec!["a"]);
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        std::io::Write::write_all(&mut f, b"c\nd\n").unwrap();
        assert_eq!(r.next(false, 10).lines, vec!["bc", "d"]);
        assert_eq!(r.line, 3);
    }

    #[test]
    fn max_limits_a_batch() {
        let path = tmp("max").join("out.log");
        fs::write(&path, "1\n2\n3\n").unwrap();
        let mut r = LogReader::open(path, 0, true).unwrap();
        let c = r.next(true, 2);
        assert_eq!(c.lines, vec!["1", "2"]);
        assert!(!c.drained);
        let c = r.next(true, 2);
        assert_eq!(c.lines, vec!["3"]);
        assert!(c.drained);
    }
}
