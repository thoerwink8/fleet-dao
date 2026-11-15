# 幂等准备。逻辑在 magpie-bootstrap.mjs。--dry-run 不改配置。
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $here 'magpie-bootstrap.mjs') @args
exit $LASTEXITCODE
