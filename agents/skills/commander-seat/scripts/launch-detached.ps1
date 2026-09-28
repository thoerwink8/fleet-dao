# Launches one detached, hidden background process from a JSON spec file (worker.mjs's spawnDetached).
# Called as: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File launch-detached.ps1
#              -Spec <spec-path> -Result <result-path>
#
# Must-know before touching this file:
# - Keep this file pure ASCII, no BOM. Plain (no-BOM) UTF-8 files with non-ASCII bytes get misread as GBK by
#   Windows PowerShell 5.1 on this machine (confirmed 2026-09-28: a Chinese comment here produced a confusing
#   "unexpected token" parse error pointing at unrelated later lines). Put any prose explanation in the caller
#   (worker.mjs, which is plain UTF-8 without this problem) instead of here.
# - $cfg.argumentLine is ONE pre-quoted, pre-escaped string built by worker.mjs (cmd.exe /d /s /c "...").
#   It must be passed to -ArgumentList as a single string, not an array: on Windows PowerShell 5.1,
#   Start-Process -ArgumentList with an array just does `$ArgumentList -join ' '` with NO per-element
#   quoting, so any embedded space inside one logical argument becomes a stray argument boundary
#   (confirmed 2026-09-28: a one-line JS snippet passed as an array element got truncated at its first space).
# - Why go through cmd.exe at all: Start-Process needs UseShellExecute=$false to support the
#   -RedirectStandardOutput/-Error/-Input parameters, and CreateProcess (which that path uses) cannot launch
#   a .cmd/.bat file directly (pnpm/grok/codex/kimi on this machine all resolve to npm-installed .cmd shims).
#   cmd.exe /c can launch anything, including a real .exe, so worker.mjs always wraps through it.
# - Why PowerShell Start-Process at all, instead of Node's own child_process.spawn(..., {detached:true}):
#   confirmed 2026-09-28 that processes spawned directly by Node in this machine's Claude Code sandbox get
#   killed as soon as the spawning Node process exits, regardless of detached/unref (looks like Windows Job
#   Object containment that `detached` does not escape). Processes launched via Start-Process (which uses a
#   different underlying Win32 path) survive the launcher's exit correctly; see worker.mjs's own header.
# - RedirectStandardOutput and RedirectStandardError must be two different files (Start-Process rejects the
#   same path for both).
# - $cfg.env is a JSON ARRAY of {name, value} pairs, not a plain object: ConvertFrom-Json on this machine's
#   Windows PowerShell 5.1 builds a case-INSENSITIVE PSCustomObject, so a plain object with both "NO_PROXY"
#   and "no_proxy" keys throws "duplicate keys" (confirmed 2026-09-28). An array of pairs has no such
#   collision, since env var names ARE case-insensitive on Windows anyway (setting both casings is only
#   meaningful cross-platform); worker.mjs still sends both, this script just applies them in order.
# - $Result is a SEPARATE CLI parameter, not a field inside the spec JSON (confirmed 2026-09-28, same day as
#   the stdio fix below): if $Spec itself fails to parse, this script still knows where to report that,
#   because knowing $Result never depended on parsing $Spec succeeding. Always write SOMETHING to $Result
#   before exiting, success or failure -- worker.mjs calls this with stdio:'ignore' (see spawn-detached-
#   support.mjs's header for why), so this result file is the ONLY way it learns what happened; if nothing
#   is written, worker.mjs correctly treats that as "unconfirmed, do not say it failed" rather than crashing,
#   but a written result (even an error one) is strictly more useful to whoever's debugging it later.
param(
  [Parameter(Mandatory=$true)][string]$Spec,
  [Parameter(Mandatory=$true)][string]$Result
)

function Write-Result([object]$obj) {
  $json = $obj | ConvertTo-Json -Compress
  # .NET's parameterless WriteAllText(path, text) overload uses UTF8 WITHOUT a BOM by default -- unlike
  # PowerShell's own Set-Content/Out-File -Encoding utf8, which DOES add one on Windows PowerShell 5.1.
  # A BOM here would break worker.mjs's JSON.parse (Node's JSON.parse rejects a leading BOM byte).
  [System.IO.File]::WriteAllText($Result, $json)
}

try {
  $ErrorActionPreference = 'Stop'
  $cfg = Get-Content -Raw -Path $Spec | ConvertFrom-Json

  if ($cfg.env) {
    foreach ($item in $cfg.env) {
      Set-Item -Path ("Env:" + $item.name) -Value ([string]$item.value)
    }
  }

  $psParams = @{
    FilePath = $cfg.command
    ArgumentList = $cfg.argumentLine
    WorkingDirectory = $cfg.cwd
    WindowStyle = 'Hidden'
    RedirectStandardOutput = $cfg.outFile
    RedirectStandardError = $cfg.errFile
    PassThru = $true
  }
  if ($cfg.stdinFile) {
    $psParams['RedirectStandardInput'] = $cfg.stdinFile
  }

  $p = Start-Process @psParams
  Write-Result @{ pid = $p.Id; error = $null }
}
catch {
  Write-Result @{ pid = $null; error = $_.Exception.Message }
  exit 1
}
