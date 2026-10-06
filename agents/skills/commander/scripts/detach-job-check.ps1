# Harness for detach-job-check.mjs (see that file's header). Pure ASCII, no BOM (Windows PowerShell 5.1 reads
# BOM-less files as the ANSI code page).
#
# Creates a REAL Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, starts the child command line inside
# it (the way a Claude Code session's tree sits inside Mirasim's Job), waits for the child to write its result file
# (the launched worker's pid), then kills the session the two ways Mirasim can:
#   -Kill job  : close the Job handle (kill-on-close takes down every process still in the Job)
#   -Kill tree : taskkill /T /F on the child (the whole parent-child tree)
# and samples the marker file (grown by the launched worker) before and after the kill. Prints one JSON line.
param(
  [Parameter(Mandatory=$true)][string]$ChildExe,
  [Parameter(Mandatory=$true)][string]$ChildArgs,
  [Parameter(Mandatory=$true)][string]$ResultFile,
  [Parameter(Mandatory=$true)][string]$Marker,
  [ValidateSet('job','tree')][string]$Kill = 'job'
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JobNative {
  [StructLayout(LayoutKind.Sequential)] public struct BASIC {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IOC {
    public ulong a; public ulong b; public ulong c; public ulong d; public ulong e; public ulong f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED {
    public BASIC Basic; public IOC Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXTENDED info, int len);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  // Done in C# on purpose: PowerShell copies a nested struct on property access, so setting
  // $info.Basic.LimitFlags from PowerShell silently sets nothing.
  public static IntPtr CreateKillOnCloseJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;
    EXTENDED info = new EXTENDED();
    info.Basic.LimitFlags = 0x2000;   // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(EXTENDED)))) return IntPtr.Zero;
    return job;
  }
}
'@

$job = [JobNative]::CreateKillOnCloseJob()
if ($job -eq [IntPtr]::Zero) { throw 'creating the kill-on-close Job Object failed' }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $ChildExe
$psi.Arguments = $ChildArgs
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$child = [System.Diagnostics.Process]::Start($psi)
if (-not [JobNative]::AssignProcessToJobObject($job, $child.Handle)) { throw 'AssignProcessToJobObject failed' }

# wait for the launched worker pid
$workerPid = $null
for ($i = 0; $i -lt 240 -and -not $workerPid; $i++) {
  Start-Sleep -Milliseconds 250
  if (Test-Path $ResultFile) {
    try { $workerPid = [int]((Get-Content -Raw $ResultFile | ConvertFrom-Json).pid) } catch { $workerPid = $null }
  }
}
if (-not $workerPid) {
  [void]$child.Kill()
  throw 'launcher did not report a worker pid within 60s'
}

function Marker-Size { if (Test-Path $Marker) { (Get-Item $Marker).Length } else { 0 } }
function Pid-Alive([int]$p) { [bool](Get-Process -Id $p -ErrorAction SilentlyContinue) }

$inJob = $false
$h = [JobNative]::OpenProcess(0x400, $false, $workerPid)   # PROCESS_QUERY_INFORMATION
if ($h -ne [IntPtr]::Zero) { [void][JobNative]::IsProcessInJob($h, $job, [ref]$inJob); [void][JobNative]::CloseHandle($h) }

Start-Sleep -Milliseconds 2500
$s0 = Marker-Size
$aliveBefore = Pid-Alive $workerPid
Start-Sleep -Milliseconds 1500
$s1 = Marker-Size

if ($Kill -eq 'job') {
  [void][JobNative]::CloseHandle($job)
} else {
  & taskkill.exe /PID $child.Id /T /F | Out-Null
}
Start-Sleep -Milliseconds 1500
$s2 = Marker-Size
$aliveAfter = Pid-Alive $workerPid
Start-Sleep -Milliseconds 3500
$s3 = Marker-Size
$childGone = $child.HasExited

# clean up: the launched worker (and whatever is under it) if it survived
if (Pid-Alive $workerPid) { & taskkill.exe /PID $workerPid /T /F | Out-Null }
if (-not $child.HasExited) { [void]$child.Kill() }
if ($Kill -eq 'tree') { [void][JobNative]::CloseHandle($job) }

@{
  kill = $Kill
  workerPid = $workerPid
  workerPidInsideJob = $inJob
  childGone = $childGone
  markerBytesBeforeKill = @($s0, $s1)
  markerBytesAfterKill = @($s2, $s3)
  workerPidAliveBefore = $aliveBefore
  workerPidAliveAfterKill = $aliveAfter
  workerSurvived = ($s3 -gt $s2)
} | ConvertTo-Json -Compress
