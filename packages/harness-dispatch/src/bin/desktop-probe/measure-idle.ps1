# 桌面第 0 片实测 ③（#3868）：启动一个桌面壳，闲置 N 秒后量整棵进程树的内存，再杀掉。
# 用法：pwsh -File（要 PowerShell 7；5.1 读不了无 BOM 的 UTF-8 中文） packages/harness-dispatch/src/bin/desktop-probe/measure-idle.ps1 -Exe <壳 exe> [-Seconds 30] [-Sidecar <附带进程目录>]
# 量法：Win32_PerfFormattedData_PerfProc_Process 的 WorkingSetPrivate（进程私有工作集，不重复计共享页）和 WorkingSet；
# 进程树＝壳 exe 的所有后代（含 WebView2 / Chromium 子进程、附带的 node.exe）。
# 给 -Sidecar 时设 PROBE_SIDECAR=1，壳会起附带的内核（node.exe + kernel.mjs）。只在本机用户态起停，不改系统设置。
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Seconds = 30,
  [string]$Sidecar = ''
)
$ErrorActionPreference = 'Stop'
if ($Sidecar) { $env:PROBE_SIDECAR = '1'; $env:PROBE_SIDECAR_DIR = $Sidecar } else { Remove-Item Env:PROBE_SIDECAR -ErrorAction SilentlyContinue }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue # 有些环境全局设了它，Electron 会当 node 跑然后秒退
$p = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds $Seconds
function Get-Tree([int]$rootPid) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
  $ids = [System.Collections.Generic.List[int]]::new(); $ids.Add($rootPid)
  for ($i = 0; $i -lt $ids.Count; $i++) {
    foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $ids[$i] }) { $ids.Add([int]$c.ProcessId) }
  }
  return $ids
}
$ids = Get-Tree $p.Id
$perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids -contains [int]$_.IDProcess }
$names = @{}
Get-CimInstance Win32_Process | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { $names[[int]$_.ProcessId] = $_.Name }
$rows = $perf | ForEach-Object { [pscustomobject]@{ Pid = $_.IDProcess; Name = $names[[int]$_.IDProcess]; PrivateMB = [math]::Round($_.WorkingSetPrivate / 1MB, 1); WorkingSetMB = [math]::Round($_.WorkingSet / 1MB, 1) } }
$rows | Sort-Object PrivateMB -Descending | Format-Table -AutoSize | Out-String | Write-Host
$sumPrivate = [math]::Round(($rows | Measure-Object PrivateMB -Sum).Sum, 1)
$sumWs = [math]::Round(($rows | Measure-Object WorkingSetMB -Sum).Sum, 1)
Write-Host ("RESULT exe={0} sidecar={1} idle={2}s procs={3} privateMB={4} workingSetMB={5}" -f (Split-Path $Exe -Leaf), [bool]$Sidecar, $Seconds, $rows.Count, $sumPrivate, $sumWs)
foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
