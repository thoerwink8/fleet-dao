// Thin, safe-ish wrappers over the Win32 calls jobrun needs. Everything unsafe lives in this file.
//
// The Job Object technique (create the child suspended, assign it to a KILL_ON_JOB_CLOSE job before it
// runs, then resume it) follows the same approach as herdr's `src/platform/windows.rs`
// (https://github.com/ogulcancelik/herdr, Apache-2.0); this is an independent implementation.
use std::io;
use std::os::windows::io::AsRawHandle;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, FILETIME, HANDLE,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

// Job object access rights (winnt.h); the bindings do not export them under JobObjects.
const JOB_OBJECT_TERMINATE: u32 = 0x0008;
const JOB_OBJECT_QUERY: u32 = 0x0004;
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, OpenThread, ResumeThread, TerminateProcess,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
};

/// `Local\` keeps the name inside the current logon session, so it needs no extra privilege.
fn object_name(name: &str) -> Vec<u16> {
    format!("Local\\fleet-jobrun-{name}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

pub struct Job(HANDLE);

// A Job handle is just a kernel handle; nothing here is tied to the creating thread.
unsafe impl Send for Job {}

impl Job {
    /// Creates a new named job that kills every member when its last handle closes.
    /// Fails when a job of that name already exists, so two runs never share one job.
    pub fn create(name: &str) -> io::Result<Job> {
        let wide = object_name(name);
        let handle = unsafe { CreateJobObjectW(null(), wide.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Job(handle);
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "a job with this name already exists",
            ));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    pub fn open(name: &str) -> io::Result<Job> {
        let wide = object_name(name);
        let handle =
            unsafe { OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, 0, wide.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Job(handle))
    }

    pub fn assign(&self, process: &impl AsRawHandle) -> io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0, process.as_raw_handle() as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Process ids currently inside the job.
    pub fn pids(&self) -> io::Result<Vec<u32>> {
        // Header is two u32 counts, then the id array (usize-sized slots on the wire).
        const SLOTS: usize = 4096;
        let mut buf = vec![0usize; 2 + SLOTS];
        let ok = unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectBasicProcessIdList,
                buf.as_mut_ptr().cast(),
                (buf.len() * std::mem::size_of::<usize>()) as u32,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        // Layout: { u32 NumberOfAssignedProcesses; u32 NumberOfProcessIdsInList; usize ProcessIdList[] }
        let header = buf[0];
        let in_list = (header >> 32) as u32 as usize;
        let ids = &buf[1..1 + in_list.min(SLOTS)];
        Ok(ids.iter().map(|id| *id as u32).collect())
    }

    pub fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn filetime_to_u64(t: FILETIME) -> u64 {
    (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)
}

/// Creation time (100ns ticks since 1601) of a live process. A pid that is reused by another process
/// always gets a different creation time, so (pid, creation time) identifies one process for good.
pub fn creation_time(pid: u32) -> Option<u64> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
    let ok = unsafe { GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) };
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        return None;
    }
    // A process that has exited but is still held open by someone has an exit time.
    if filetime_to_u64(exit) != 0 {
        return None;
    }
    Some(filetime_to_u64(created))
}

/// True when `pid` is alive and is the same process that was recorded with `start`.
pub fn alive_matching(pid: u32, start: u64) -> bool {
    creation_time(pid) == Some(start)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reaped {
    Terminated,
    /// Not running any more.
    Gone,
    /// The pid now belongs to a different process: left alone.
    Reused,
}

/// Terminates `pid` only if it still is the process recorded with `start`.
pub fn terminate_if_match(pid: u32, start: u64) -> Reaped {
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        return Reaped::Gone;
    }
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
    let ok = unsafe { GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) };
    let result = if ok == 0 || filetime_to_u64(exit) != 0 {
        Reaped::Gone
    } else if filetime_to_u64(created) != start {
        Reaped::Reused
    } else if unsafe { TerminateProcess(handle, 1) } != 0 {
        Reaped::Terminated
    } else {
        Reaped::Gone
    };
    unsafe { CloseHandle(handle) };
    result
}

/// Resumes every thread of a process that was created with CREATE_SUSPENDED.
pub fn resume_process(pid: u32) -> io::Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut resumed = 0;
    let mut more = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread.is_null() {
                if unsafe { ResumeThread(thread) } != u32::MAX {
                    resumed += 1;
                }
                unsafe { CloseHandle(thread) };
            }
        }
        more = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    if resumed == 0 {
        return Err(io::Error::other(
            "no thread of the suspended process could be resumed",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn sleeper() -> std::process::Child {
        Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(Stdio::null())
            .spawn()
            .expect("ping")
    }

    #[test]
    fn a_reused_pid_is_not_touched() {
        let mut other = sleeper();
        let start = creation_time(other.id()).expect("creation time");
        // Same pid, different creation time: what a reused pid looks like to the recorded entry.
        assert_eq!(terminate_if_match(other.id(), start + 1), Reaped::Reused);
        assert!(
            other.try_wait().unwrap().is_none(),
            "unrelated process must survive"
        );
        assert!(!alive_matching(other.id(), start + 1));
        assert!(alive_matching(other.id(), start));
        assert_eq!(terminate_if_match(other.id(), start), Reaped::Terminated);
        other.wait().unwrap();
        assert_eq!(terminate_if_match(other.id(), start), Reaped::Gone);
    }

    #[test]
    fn job_lists_members_and_kills_them() {
        let job = Job::create(&format!("unit-{}", std::process::id())).expect("job");
        let mut child = sleeper();
        job.assign(&child).expect("assign");
        assert_eq!(job.pids().unwrap(), vec![child.id()]);
        assert!(
            Job::create(&format!("unit-{}", std::process::id())).is_err(),
            "name is taken"
        );
        job.terminate().unwrap();
        child.wait().unwrap();
        assert!(job.pids().unwrap().is_empty());
    }

    #[test]
    fn closing_the_job_kills_the_members() {
        let job = Job::create(&format!("close-{}", std::process::id())).expect("job");
        let mut child = sleeper();
        job.assign(&child).expect("assign");
        drop(job);
        child.wait().unwrap();
    }
}
