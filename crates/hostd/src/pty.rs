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
    let exe = shell_program();
    let mut cmd = CommandBuilder::new(&exe);
    // Read PATH after `CommandBuilder::new`: on Windows it merges the registry
    // and that can differ from this process. The git launcher check has to use
    // the environment the shell will actually see.
    let path = cmd.get_env("PATH").map(|value| value.to_owned());
    for arg in shell_args(path.as_deref()) {
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

const WINDOWS_UTF8: &str =
    "[Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false";

/// `IMAGE_SUBSYSTEM_WINDOWS_GUI`. A console-subsystem `git.exe` is 3.
const WINDOWS_GUI_SUBSYSTEM: u16 = 2;

/// First `git.exe` on `path`, when that file is a GUI-subsystem stand-in.
/// Some installs replace `cmd\git.exe` with a GUI-subsystem launcher so a
/// program without a console can run git without a window flashing. The
/// launcher starts the real git detached, then `AttachConsole`. ConPTY emits
/// that child's frame after PowerShell has already drawn the next prompt, so
/// the prompt and the first output line share a row. The `cmd\git.exe`
/// shipped with Git for Windows is a console-subsystem binary and stays in
/// order (PortableGit 2.56.1, three runs, `##` on its own line). Return
/// `bin\git.exe` from the same install only for subsystem 2. Any other first
/// hit is left alone. There is no console API that waits for the late frame.
fn terminal_git(path: Option<&std::ffi::OsStr>) -> Option<std::path::PathBuf> {
    let path = path?;
    for dir in std::env::split_paths(path) {
        let found = dir.join("git.exe");
        if !found.is_file() {
            continue;
        }
        let name = dir.file_name().and_then(|name| name.to_str());
        if !name.is_some_and(|name| name.eq_ignore_ascii_case("cmd")) {
            return None;
        }
        let bin = dir.parent()?.join("bin").join("git.exe");
        if bin.is_file() && bin != found && gui_subsystem(&found) {
            return Some(bin);
        }
        return None;
    }
    None
}

/// PE optional-header `Subsystem` is 2. Anything that is not a readable GUI
/// image, including the stock console `git.exe`, is left alone.
fn gui_subsystem(path: &std::path::Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let mut dos = [0u8; 64];
    if file.read(&mut dos).ok() != Some(dos.len()) || &dos[0..2] != b"MZ" {
        return false;
    }
    let Ok(e_lfanew) = dos[0x3C..0x40].try_into().map(u32::from_le_bytes) else {
        return false;
    };
    if file.seek(SeekFrom::Start(u64::from(e_lfanew))).is_err() {
        return false;
    }
    // Signature, COFF header, then Subsystem at offset 68 of the optional header.
    let mut pe = [0u8; 4 + 20 + 70];
    if file.read(&mut pe).ok() != Some(pe.len()) || &pe[0..4] != b"PE\0\0" {
        return false;
    }
    let subsystem = u16::from_le_bytes([pe[92], pe[93]]);
    subsystem == WINDOWS_GUI_SUBSYSTEM
}

fn windows_shell_command(path: Option<&std::ffi::OsStr>) -> String {
    let mut command = WINDOWS_UTF8.to_string();
    if let Some(bin) = terminal_git(path) {
        let quoted = bin.to_string_lossy().replace('\'', "''");
        command.push_str(&format!("; function global:git {{ & '{quoted}' @args }}"));
    }
    command
}

/// Windows: PowerShell (`pwsh` if it is on PATH, otherwise Windows PowerShell) with a UTF-8 console.
/// Unix: `$SHELL`, or `/bin/sh`.
fn shell_program() -> String {
    if cfg!(windows) {
        if exe_on_path("pwsh.exe") {
            "pwsh.exe".into()
        } else {
            "powershell.exe".into()
        }
    } else {
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".into())
    }
}

fn shell_args(path: Option<&std::ffi::OsStr>) -> Vec<String> {
    if cfg!(windows) {
        vec![
            "-NoLogo".into(),
            "-NoExit".into(),
            "-Command".into(),
            windows_shell_command(path),
        ]
    } else {
        vec!["-i".into()]
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
    fn windows_shell_command_does_not_sleep() {
        let command = windows_shell_command(None);
        assert!(command.contains("UTF8Encoding $false"));
        assert!(!command.contains("Start-Sleep"));
        assert!(!command.contains("Set-PSBreakpoint"));
        assert!(!command.contains("-NoProfile"));
    }

    fn write_pe(path: &std::path::Path, subsystem: u16) {
        let mut bytes = vec![0u8; 64 + 4 + 20 + 70];
        bytes[0] = b'M';
        bytes[1] = b'Z';
        bytes[0x3C..0x40].copy_from_slice(&64u32.to_le_bytes());
        bytes[64..68].copy_from_slice(b"PE\0\0");
        let at = 64 + 4 + 20 + 68;
        bytes[at..at + 2].copy_from_slice(&subsystem.to_le_bytes());
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn terminal_git_replaces_only_a_gui_cmd_launcher() {
        let root = std::env::temp_dir().join(format!("hostd-git-{}", std::process::id()));
        let cui = std::env::temp_dir().join(format!("hostd-git-cui-{}", std::process::id()));
        let bare = std::env::temp_dir().join(format!("hostd-git-bare-{}", std::process::id()));
        for dir in [&root, &cui, &bare] {
            let _ = std::fs::remove_dir_all(dir);
        }
        std::fs::create_dir_all(root.join("cmd")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        write_pe(&root.join("cmd").join("git.exe"), WINDOWS_GUI_SUBSYSTEM);
        std::fs::write(root.join("bin").join("git.exe"), b"real").unwrap();
        let path = std::env::join_paths([root.join("cmd")]).unwrap();
        let found = terminal_git(Some(path.as_os_str())).expect("bin git");
        assert_eq!(found, root.join("bin").join("git.exe"));
        assert!(gui_subsystem(&root.join("cmd").join("git.exe")));
        let command = windows_shell_command(Some(path.as_os_str()));
        assert!(command.contains("function global:git"));
        assert!(command.contains(&found.to_string_lossy().replace('\'', "''")));
        assert!(!command.contains("Start-Sleep"));

        let direct = std::env::join_paths([root.join("bin")]).unwrap();
        assert!(terminal_git(Some(direct.as_os_str())).is_none());

        std::fs::create_dir_all(cui.join("cmd")).unwrap();
        std::fs::create_dir_all(cui.join("bin")).unwrap();
        write_pe(&cui.join("cmd").join("git.exe"), 3);
        std::fs::write(cui.join("bin").join("git.exe"), b"real").unwrap();
        let cui_path = std::env::join_paths([cui.join("cmd")]).unwrap();
        assert!(terminal_git(Some(cui_path.as_os_str())).is_none());
        assert!(!windows_shell_command(Some(cui_path.as_os_str())).contains("function global:git"));

        std::fs::create_dir_all(bare.join("cmd")).unwrap();
        write_pe(&bare.join("cmd").join("git.exe"), WINDOWS_GUI_SUBSYSTEM);
        let bare_path = std::env::join_paths([bare.join("cmd")]).unwrap();
        assert!(terminal_git(Some(bare_path.as_os_str())).is_none());

        for dir in [&root, &cui, &bare] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_installs_utf8_without_a_prompt_sleep() {
        let exe = shell_program();
        let args = shell_args(None);
        assert!(exe == "pwsh.exe" || exe == "powershell.exe");
        assert_eq!(args[..3], ["-NoLogo", "-NoExit", "-Command"]);
        let command = args.last().expect("command");
        assert!(command.contains("UTF8Encoding $false"));
        assert!(!command.contains("Start-Sleep"));
        assert!(!args.iter().any(|arg| arg == "-NoProfile"));
    }
}
