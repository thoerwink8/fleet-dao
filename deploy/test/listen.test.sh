#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 「只听回环」的判定（deploy/lib/listen.sh，france.sh 读回库的监听用）：
#   1. 两个回环、只有 IPv4 回环（WSL 没有 ::1 上的监听）、只有 IPv6 回环：都是只听本机
#   2. 故意造错：多了 0.0.0.0、多了网卡地址、只听 0.0.0.0、别的端口的回环、一个监听都没读到、点号不当通配：都判不是
# 用法：bash deploy/test/listen.test.sh。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$HERE/.." && pwd)
# shellcheck source=../lib/listen.sh
source "$DEPLOY/lib/listen.sh"

fail=0
check() { # 说明 监听 期望（yes/no）
  local got=no
  if listens_loopback_only_on 5432 "$2"; then got=yes; fi
  if [[ "$got" == "$3" ]]; then
    echo "  ✓ $1"
  else
    echo "  ✗ $1：实际「$got」，应为「$3」"
    fail=1
  fi
}

echo "== 只听本机的几种样子"
check "两个回环" "127.0.0.1:5432 [::1]:5432 " yes
check "只有 IPv4 回环（WSL）" "127.0.0.1:5432 " yes
check "只有 IPv6 回环" "[::1]:5432 " yes
echo "== 故意造错：都判不是"
check "【故意造出的失败】多了 0.0.0.0" "0.0.0.0:5432 127.0.0.1:5432 " no
check "【故意造出的失败】多了网卡地址" "127.0.0.1:5432 10.99.0.2:5432 " no
check "【故意造出的失败】只听 0.0.0.0" "0.0.0.0:5432 " no
check "【故意造出的失败】一个监听都没读到（空）" "" no
check "【故意造出的失败】只有空格" " " no
check "【故意造出的失败】别的端口的回环" "127.0.0.1:5433 " no
check "【故意造出的失败】点号不当通配" "127x0.0.1:5432 " no

if ((fail)); then
  echo "listen：不通过"
  exit 1
fi
echo "listen：通过"
