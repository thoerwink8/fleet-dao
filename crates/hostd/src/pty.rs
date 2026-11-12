//! Interactive terminals. One `pty.*` run is a real pseudoterminal in the requested directory:
//! ConPTY on Windows (PowerShell), the user's shell on Unix. Output bytes go back as `out` frames
//! with `stream: "pty"` and base64 `text`. The process environment is inherited and is never logged.
//! Closing the hostd connection kills these processes. A later connection does not reattach them.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::frames::{Frame, OutStream};
use crate::server::{send, Output};

const MAX_INPUT: usize = 256 * 1024;

pub(crate) struct Slot {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    #[cfg(windows)]
    job: Mutex<Option<jobrun::win::Job>>,
}

pub(crate) type Ptys = Arc<Mutex<HashMap<String, Arc<Slot>>>>;

pub(crate) enum StartError {
    Exists,
    Failed(String),
}

pub(crate) enum InputError {
    /// Base64 is invalid or the decoded payload is over 256KB. The message does not quote the bytes.
    Rejected(&'static str),
    Failed(String),
}

/// Starts a shell and inserts the slot. The reader removes it after the shell exits.
pub(crate) fn start(
    out: Output,
    ptys: Ptys,
    run_id: String,
    cwd: &str,
    cols: u64,
    rows: u64,
) -> Result<(), StartError> {
    if ptys.lock().unwrap().contains_key(&run_id) {
        return Err(StartError::Exists);
    }
    if !Path::new(cwd).is_dir() {
        return Err(StartError::Failed(format!("cwd is not a directory: {cwd}")));
    }
    let cols = u16::try_from(cols).map_err(|_| StartError::Failed("cols do not fit".into()))?;
    let rows = u16::try_from(rows).map_err(|_| StartError::Failed("rows do not fit".into()))?;
    let (exe, args) = shell();
    let mut cmd = CommandBuilder::new(exe);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.cwd(cwd);
    // `CommandBuilder::new` copies the parent environment. `env` only overlays one key; do not call `env_clear`.
    #[cfg(unix)]
    cmd.env("TERM", "xterm-256color");
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| StartError::Failed(format!("cannot open a pty: {e}")))?;
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| StartError::Failed(format!("cannot start the terminal: {e}")))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| StartError::Failed(format!("cannot read the terminal: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| StartError::Failed(format!("cannot write the terminal: {e}")))?;
    #[cfg(windows)]
    let job = track_job(child.as_ref());
    let slot = Arc::new(Slot {
        writer: Mutex::new(Some(writer)),
        master: Mutex::new(Some(pair.master)),
        child: Mutex::new(Some(child)),
        #[cfg(windows)]
        job: Mutex::new(job),
    });
    {
        let mut map = ptys.lock().unwrap();
        if map.contains_key(&run_id) {
            kill(&slot);
            return Err(StartError::Exists);
        }
        map.insert(run_id.clone(), slot.clone());
    }
    thread::spawn(move || pump(out, ptys, run_id, reader, slot));
    Ok(())
}

pub(crate) fn write_input(slot: &Slot, data: &str) -> Result<(), InputError> {
    if data.len() > MAX_INPUT * 2 {
        return Err(InputError::Rejected("terminal input is too large"));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| InputError::Rejected("terminal input is not base64"))?;
    if bytes.len() > MAX_INPUT {
        return Err(InputError::Rejected("terminal input is too large"));
    }
    if bytes.is_empty() {
        return Ok(());
    }
    let mut guard = slot.writer.lock().unwrap();
    let Some(writer) = guard.as_mut() else {
        return Err(InputError::Failed("the terminal is closed".into()));
    };
    writer
        .write_all(&bytes)
        .and_then(|_| writer.flush())
        .map_err(|e| InputError::Failed(format!("cannot write the terminal: {e}")))
}

pub(crate) fn resize(slot: &Slot, cols: u64, rows: u64) -> Result<(), String> {
    let cols = u16::try_from(cols).map_err(|_| "cols do not fit".to_string())?;
    let rows = u16::try_from(rows).map_err(|_| "rows do not fit".to_string())?;
    let guard = slot.master.lock().unwrap();
    let Some(master) = guard.as_ref() else {
        return Err("the terminal is closed".into());
    };
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("cannot resize the terminal: {e}"))
}

/// Kills the shell. Safe to call more than once. Does not wait; the reader thread waits and emits `exit`.
pub(crate) fn kill(slot: &Slot) {
    #[cfg(windows)]
    if let Some(job) = slot.job.lock().unwrap().take() {
        let _ = job.terminate();
    }
    if let Some(child) = slot.child.lock().unwrap().as_mut() {
        let _ = child.kill();
    }
    // Dropping the writer is not enough on ConPTY: the reader stays blocked until the master is dropped.
    drop(slot.writer.lock().unwrap().take());
    drop(slot.master.lock().unwrap().take());
}

fn pump(
    out: Output,
    ptys: Ptys,
    run_id: String,
    mut reader: Box<dyn Read + Send>,
    slot: Arc<Slot>,
) {
    let mut seq = 0u64;
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                seq += 1;
                let Some(line_no) = std::num::NonZeroU64::new(seq) else {
                    break;
                };
                let frame = Frame::Out {
                    run_id: run_id.clone(),
                    stream: OutStream::Pty,
                    line: line_no,
                    text: STANDARD.encode(&buf[..n]),
                };
                if !send(&out, &frame) {
                    break;
                }
            }
        }
    }
    // Kill before taking the child so a close that arrives during `wait` is not required.
    // The lock is not held across `wait` (the reader has already left `read`).
    kill(&slot);
    let taken = slot.child.lock().unwrap().take();
    let (code, signal) = match taken {
        Some(mut child) => match child.wait() {
            Ok(st) => (Some(i64::from(st.exit_code())), None),
            Err(_) => (None, Some("lost".to_string())),
        },
        None => (None, Some("lost".to_string())),
    };
    let _ = send(
        &out,
        &Frame::ExitEvent {
            run_id: run_id.clone(),
            code,
            signal,
        },
    );
    ptys.lock().unwrap().remove(&run_id);
}

/// ConPTY emits a fast native command's last frame after the shell has already
/// continued, so the next prompt and the first output line share a row.
/// Sleeping at the start of `prompt` lets that frame land on its own row.
/// A breakpoint is used so this still runs after the user replaces `prompt`.
/// 20ms still lost the race; 80ms cleared it.
const WINDOWS_SHELL_COMMAND: &str = "[Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; Set-PSBreakpoint -Command prompt -Action { Start-Sleep -Milliseconds 80 } | Out-Null";

/// Windows: PowerShell (`pwsh` if it is on PATH, otherwise Windows PowerShell) with a UTF-8 console.
/// Unix: `$SHELL`, or `/bin/sh`.
fn shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        let exe = if exe_on_path("pwsh.exe") {
            "pwsh.exe"
        } else {
            "powershell.exe"
        };
        (
            exe.to_string(),
            vec![
                "-NoLogo".into(),
                "-NoExit".into(),
                "-Command".into(),
                WINDOWS_SHELL_COMMAND.into(),
            ],
        )
    } else {
        let exe = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".into());
        (exe, vec!["-i".into()])
    }
}

fn exe_on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(name).is_file())
}

/// Puts the shell in a kill-on-close job. Assign can fail when ConPTY already placed it in a job
/// that refuses nesting; the caller still kills the root process. The handle belongs to the child.
#[cfg(windows)]
fn track_job(child: &dyn Child) -> Option<jobrun::win::Job> {
    use std::os::windows::io::{AsRawHandle, RawHandle};
    let raw = child.as_raw_handle()?;
    let pid = child.process_id().unwrap_or(0);
    let job = jobrun::win::Job::create(&format!("pty-{pid}-{}", std::process::id())).ok()?;
    struct Borrowed(RawHandle);
    impl AsRawHandle for Borrowed {
        fn as_raw_handle(&self) -> RawHandle {
            self.0
        }
    }
    if job.assign(&Borrowed(raw)).is_err() {
        return None;
    }
    Some(job)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_shell_command_waits_before_the_prompt() {
        assert!(WINDOWS_SHELL_COMMAND
            .contains("Set-PSBreakpoint -Command prompt -Action { Start-Sleep -Milliseconds 80 }"));
        assert!(WINDOWS_SHELL_COMMAND.contains("UTF8Encoding $false"));
        assert!(!WINDOWS_SHELL_COMMAND.contains("-NoProfile"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_installs_the_prompt_wait() {
        let (exe, args) = shell();
        assert!(exe == "pwsh.exe" || exe == "powershell.exe");
        assert_eq!(args.last().map(String::as_str), Some(WINDOWS_SHELL_COMMAND));
        assert!(!args.iter().any(|arg| arg == "-NoProfile"));
    }
}
