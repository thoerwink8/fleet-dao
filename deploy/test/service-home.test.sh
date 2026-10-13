#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy/lib/service-home.sh：root 身份的单元写进服务用户目录的文件，装机时改回所在目录的属主（法国读回红：
# /var/lib/fleet-dao/cli-upgrade/state.json 是 root:root，读回判红，装机不记「已装到哪一版」）。
#   1. 目录归别人（造一个数字 uid/gid）、里面有 root 属主的文件：改回目录属主，记一条 changed；
#   2. 再跑一遍零改动、读回不再报红；
#   3. 所在目录自己就归 root 的文件不碰（留给读回报红）。
# 要 root（chown 到别的 uid）。用法：sudo bash deploy/test/service-home.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/service-home.sh
source "$HERE/../lib/service-home.sh"
if ((EUID != 0)); then
  echo "没跑成：要 root（chown 到别的 uid）"
  exit 2
fi
T=$(mktemp -d /var/tmp/fleet-dao-service-home-test.XXXXXX)
trap 'rm -rf -- "$T"' EXIT
fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then printf '  ✓ %s\n' "$1"; else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
# 造出这台上没有的 uid:gid，不依赖真用户
U=61234:61235
mkdir -p "$T/state/sub" "$T/rootdir"
chown "$U" "$T/state" "$T/state/sub"
echo '{}' >"$T/state/state.json"
echo '{}' >"$T/state/sub/deep.json"
echo '{}' >"$T/rootdir/keep.json"
PILOT_HOME=$T/state
SESSION_USERS=()
service_home_dirs() { printf '%s\n' "$T/state" "$T/rootdir" "$T/missing"; } # 顶替真目录表

CHANGES=()
fix_service_home_owners >/dev/null
check "目录下的 root 文件改回目录属主" "$(stat -c %u:%g "$T/state/state.json")" "$U"
check "子目录里的也改" "$(stat -c %u:%g "$T/state/sub/deep.json")" "$U"
check "归 root 的目录里的文件不碰" "$(stat -c %u:%g "$T/rootdir/keep.json")" "0:0"
check "记了一条改动" "${#CHANGES[@]}" "1"
CHANGES=()
fix_service_home_owners >/dev/null
check "第二遍零改动" "${#CHANGES[@]}" "0"
if ((fail)); then
  echo "service-home：不通过"
  exit 1
fi
echo "service-home：通过"
