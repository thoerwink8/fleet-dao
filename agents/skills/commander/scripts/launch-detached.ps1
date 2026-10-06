# Launches one hidden background process OUTSIDE the caller's Job Object and process tree, from a JSON spec file
# (spawn-detached.mjs's spawnDetached). Called as:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File launch-detached.ps1
#     -Spec <spec-path> -Result <result-path>
#
# Must-know before touching this file:
# - Keep this file pure ASCII, no BOM. Plain (no-BOM) UTF-8 files with non-ASCII bytes get misread as GBK by
#   Windows PowerShell 5.1 on this machine (confirmed 2026-09-28: a Chinese comment here produced a confusing
#   "unexpected token" parse error pointing at unrelated later lines). Put any prose explanation in the caller
#   (spawn-detached.mjs, which is plain UTF-8 without this problem) instead of here.
# - Why Win32_Process.Create (WMI/CIM) and not Start-Process: Start-Process (CreateProcess) children stay inside the
#   caller's Job Object and parent-child tree. Mirasim ends a Claude Code session by closing its Job Object
#   (kill-on-close) or taskkill /T on the tree, and a "detached" worker started with Start-Process died with it
#   (2026-10-06: two overnight workers stopped dead at the exact second the founder sent the next message).
#   A process created through WMI is spawned by the WMI service host (WmiPrvSE.exe): it is in no Job of ours and
#   its parent is not our session, so neither kill reaches it. agents/skills/commander/scripts/detach-job-check.mjs
#   proves this against a real kill-on-close Job Object.
# - $cfg.commandLine is the payload that goes inside `cmd.exe /d /s /c "<payload>"`, already quoted/escaped and
#   already carrying the > out 2> err < in redirections (built by spawn-detached.mjs). WMI cannot redirect by
#   itself, which is also why we go through cmd.exe: it can run .cmd shims (pnpm/grok/codex/kimi) as well as .exe.
# - $cfg.env is a JSON ARRAY of {name, value} pairs, not a plain object: ConvertFrom-Json on Windows PowerShell 5.1
#   builds a case-INSENSITIVE PSCustomObject, so a plain object with both "NO_PROXY" and "no_proxy" keys throws
#   "duplicate keys" (confirmed 2026-09-28). The pairs become the Win32_ProcessStartup EnvironmentVariables
#   "NAME=value" array. WMI REPLACES the environment with exactly this list (plus COMSPEC/PATHEXT/PROMPT defaults),
#   so the child gets the whitelisted env only and never inherits our session's tokens.
# - $Result is a SEPARATE CLI parameter, not a field inside the spec JSON: if $Spec itself fails to parse, this
#   script still knows where to report that. Always write SOMETHING to $Result before exiting, success or failure.
#   The caller runs us with stdio:'ignore', so this file is the only way it learns what happened; if nothing is
#   written, the caller treats that as "unconfirmed, do not say it failed".
# - Result protocol (unchanged): {"pid":<n>,"error":null} = confirmed started; {"pid":null,"error":"..."} =
#   confirmed NOT started (Win32_Process.Create returned a non-zero code or threw before creating anything).
param(
  [Parameter(Mandatory=$true)][string]$Spec,
  [Parameter(Mandatory=$true)][string]$Result
)

function Write-Result([object]$obj) {
  $json = $obj | ConvertTo-Json -Compress
  # .NET's parameterless WriteAllText(path, text) overload uses UTF8 WITHOUT a BOM by default -- unlike
  # PowerShell's own Set-Content/Out-File -Encoding utf8, which DOES add one on Windows PowerShell 5.1.
  # A BOM here would break the caller's JSON.parse (Node's JSON.parse rejects a leading BOM byte).
  [System.IO.File]::WriteAllText($Result, $json)
}

try {
  $ErrorActionPreference = 'Stop'
  $cfg = Get-Content -Raw -Path $Spec | ConvertFrom-Json

  $envLines = @()
  if ($cfg.env) {
    foreach ($item in $cfg.env) {
      $envLines += ([string]$item.name + '=' + [string]$item.value)
    }
  }

  $cmdExe = Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe'
  $commandLine = '"' + $cmdExe + '" /d /s /c "' + [string]$cfg.commandLine + '"'

  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
    ShowWindow = [uint16]0
    EnvironmentVariables = [string[]]$envLines
  }
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $commandLine
    CurrentDirectory = [string]$cfg.cwd
    ProcessStartupInformation = $startup
  }

  if ($r.ReturnValue -ne 0 -or -not $r.ProcessId) {
    Write-Result @{ pid = $null; error = ('Win32_Process.Create returned ' + $r.ReturnValue) }
    exit 1
  }
  Write-Result @{ pid = [int]$r.ProcessId; error = $null }
}
catch {
  Write-Result @{ pid = $null; error = $_.Exception.Message }
  exit 1
}
