#!/usr/bin/env bash
# 监督经 fleet-fr-carpool 登入后只能 sudo 跑 fleet-api 的 engine 子命令（#1775），fleet → fleet-agent-scope 仍在。
# 用法：bash deploy/test/sudoers-carpool-engine.test.sh
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
FILE=$HERE/../france/sudoers-fleet-dao
fail=0
check() {
  if grep -qE -- "$2" "$FILE"; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：%s 里没有 /%s/\n' "$1" "$FILE" "$2"
    fail=1
  fi
}
echo "== sudoers-fleet-dao（#1775）"
check "fleet 仍只能跑 fleet-agent-scope" '^fleet ALL=\(root\) NOPASSWD: /usr/local/sbin/fleet-agent-scope$'
check "carpool 可跑 engine status" 'fleet-agent-carpool ALL=\(root\) NOPASSWD:.*fleet-api engine status'
check "carpool 可跑 engine on" 'fleet-api engine on \*'
check "carpool 可跑 engine off" 'fleet-api engine off \*'
if grep -q 'set-password' "$FILE"; then
  printf '  ✗ 不该出现 set-password\n'
  fail=1
else
  printf '  ✓ 没有 set-password\n'
fi
if ((fail)); then
  echo "sudoers-carpool-engine：不通过"
  exit 1
fi
echo "sudoers-carpool-engine：通过"
