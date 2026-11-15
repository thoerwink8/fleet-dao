# 只读核对。逻辑在 magpie-verify.mjs。
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $here 'magpie-verify.mjs') @args
exit $LASTEXITCODE
