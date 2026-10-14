#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 别家 self-proxy 程序目录的属主收口（#2235）：deploy/hk.sh 装机把 /opt/self-proxy/src 收成 root:root、组和其他人不可写，读回核对。
# - 有别人可写的文件 → 装机收回（chown + chmod go-w）并记一处改动；读回红；收回后读回绿；
# - 第二遍零改动（不再调 chown/chmod）；目录不在 → 什么都不做、读回绿；
# - 【故意造出的失败】装机后又被改成别人可写（模拟 self-proxy 重新部署）→ 读回红，点名一个路径。
# 不碰真机器、不用 root：路径换进临时目录；find 里的「属 root」换成「属当前用户」，chown 是桩（真属主只能在香港 --check 里看）。
# 用法：bash deploy/test/hk-self-proxy-owner.test.sh。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HK=$HERE/../hk.sh
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

echo "== hk.sh 真有收口和读回这两步，路径是 /opt/self-proxy/src"
check "收口在装机里调了一次" "$(grep -c '^ *fix_self_proxy_src_owner$' "$HK")" 1
check "读回在读回里调了一次" "$(grep -c '^ *readback_self_proxy_src$' "$HK")" 1
check "目录是 /opt/self-proxy/src" "$(grep -c '^SELF_PROXY_SRC=/opt/self-proxy/src$' "$HK")" 1

extract() { awk -v name="$1" '$0 == name "() {" { on = 1 } on { print } on && /^}$/ { exit }' "$HK"; }
FUNCS=$(
  extract self_proxy_src_loose
  extract fix_self_proxy_src_owner
  extract readback_self_proxy_src
)
check "摘到了那三个函数" "$(grep -c -e '^self_proxy_src_loose() {' -e '^fix_self_proxy_src_owner() {' -e '^readback_self_proxy_src() {' <<<"$FUNCS")" 3

REDS=()
LOG=()
red() { REDS+=("$1"); }
changed() { LOG+=("changed $1"); }
ok() { LOG+=("ok $1"); }
SELF_PROXY_SRC=$TMP/opt/self-proxy/src
CHOWNS=0
chown() { CHOWNS=$((CHOWNS + 1)); }
find() { # 「属 root」换成「属当前用户」（用数字 id，用户名在有的机器上查不到），别的原样
  local a=() x prev=""
  for x in "$@"; do
    if [[ "$prev" == -user && "$x" == root ]]; then
      a[-1]=-uid
      x=$(id -u)
    elif [[ "$prev" == -group && "$x" == root ]]; then
      a[-1]=-gid
      x=$(id -g)
    fi
    a+=("$x")
    prev=$x
  done
  command find "${a[@]}"
}
# shellcheck disable=SC1090 # 摘出来的函数
source <(printf '%s\n' "$FUNCS")

mkdir -p "$SELF_PROXY_SRC/hk"
printf '#!/bin/sh\n' >"$SELF_PROXY_SRC/hk/userinfo.sh"
printf 'x=1\n' >"$SELF_PROXY_SRC/lib.sh"
chmod 666 "$SELF_PROXY_SRC/hk/userinfo.sh"
chmod 664 "$SELF_PROXY_SRC/lib.sh"

reset() { REDS=(); LOG=(); CHOWNS=0; }

echo "== 1. 别人可写：读回红，装机收回，再读回绿"
reset
readback_self_proxy_src
check "读回红一项" "${#REDS[@]}" 1
check "点名了路径" "$([[ "${REDS[0]:-}" == *"$SELF_PROXY_SRC"* ]] && echo 有 || echo 无)" 有
check "说了 2 处" "$([[ "${REDS[0]:-}" == *"2 处"* ]] && echo 有 || echo 无)" 有
reset
fix_self_proxy_src_owner
check "记了一处改动" "$(printf '%s\n' "${LOG[@]}" | grep -c '^changed ')" 1
check "调了 chown" "$CHOWNS" 1
check "userinfo.sh 不再可写" "$(stat -c %a "$SELF_PROXY_SRC/hk/userinfo.sh")" 644
check "lib.sh 不再可写" "$(stat -c %a "$SELF_PROXY_SRC/lib.sh")" 644
reset
readback_self_proxy_src
check "读回绿" "${#REDS[@]}" 0

echo "== 2. 第二遍零改动"
reset
fix_self_proxy_src_owner
check "没有改动记录" "$(printf '%s\n' "${LOG[@]}" | grep -c '^changed ')" 0
check "没调 chown" "$CHOWNS" 0

echo "== 3. 【故意造出的失败】装机后又被改成别人可写（self-proxy 重新部署）"
reset
chmod 775 "$SELF_PROXY_SRC/hk"
readback_self_proxy_src
check "读回红，点名目录" "$([[ "${REDS[0]:-}" == *"$SELF_PROXY_SRC/hk"* ]] && echo 有 || echo 无)" 有
fix_self_proxy_src_owner
reset
readback_self_proxy_src
check "重跑收口后读回绿" "${#REDS[@]}" 0

echo "== 4. 目录不在：什么都不做，读回绿"
reset
SELF_PROXY_SRC=$TMP/nowhere
fix_self_proxy_src_owner
readback_self_proxy_src
check "没改动" "$(printf '%s\n' "${LOG[@]}" | grep -c '^changed ')" 0
check "没红" "${#REDS[@]}" 0
check "没调 chown" "$CHOWNS" 0

if ((fail)); then
  echo "不通过"
  exit 1
fi
echo "通过"
