#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034,SC2317,SC2329 # 桩函数和被 eval 进来的 france.sh 函数用到的变量，shellcheck 看不出
# root 的 ssh 会话（user-0.slice）的内存上限（#2842）：france.sh 的自动档装一个 drop-in，MemoryHigh=2G、MemoryMax=3G。
# 不需要 root、systemd：把 france.sh 里的 setup_user_slice_cap / readback_user_slice_cap / setup_auto_tier 原文取出来，
# put_file 之外的 systemctl、ensure_dir 换成桩，只看流程和判据：
#   1. 仓里的 drop-in 文件内容：[Slice]、MemoryHigh=2G、MemoryMax=3G（别的键不许有）
#   2. setup_auto_tier 和整套装机 main 都调 setup_user_slice_cap；readback_auto_tier 读回它
#   3. 第一次装：写文件、daemon-reload 一次；再跑一遍内容没变：不写、不 daemon-reload；仓里内容改了：写、reload
#   4. 读回：装着的和仓里一样、systemctl show 读到 3G 判绿；文件缺、内容被改、生效值不对判红【故意造出的失败】
# 用法：bash deploy/test/user-slice-cap.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"

FRANCE_SH=$HERE/../france.sh
CONF=$HERE/../france/user-0-slice-memory.conf
fn_text() { tr -d '\r' <"$FRANCE_SH" | sed -n "/^$1() {/,/^}/p"; }
for f in setup_user_slice_cap readback_user_slice_cap setup_auto_tier readback_auto_tier main; do
  if [[ -z "$(fn_text "$f")" ]]; then
    echo "user-slice-cap：没跑成：在 deploy/france.sh 里没取到 $f"
    exit 2
  fi
done
if [[ ! -f "$CONF" ]]; then
  echo "user-slice-cap：不通过：仓里没有 deploy/france/user-0-slice-memory.conf"
  exit 1
fi

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
fresh() { CHANGES=() REDS=() PENDING=() CALLS=(); }

TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT

CALLS=()
LIVE="MemoryHigh=2147483648
MemoryMax=3221225472"
systemctl() {
  if [[ "$1" == show ]]; then
    printf '%s\n' "$LIVE"
    return 0
  fi
  CALLS+=("systemctl $*")
}
ensure_dir() { mkdir -p -- "$1"; }
# 和 common.sh 的 put_file 同一个判法，只是不 chown/chmod（不要 root）
put_file() { # 目标 属主:组 权限 内容
  local dest=$1 content=$4
  WROTE=0
  if [[ -f "$dest" ]] && cmp -s -- "$dest" <(printf '%s\n' "$content"); then return 0; fi
  printf '%s\n' "$content" >"$dest"
  changed "写 $dest"
}

DEPLOY_DIR=$TMP/deploy
mkdir -p "$DEPLOY_DIR/france"
cp -- "$CONF" "$DEPLOY_DIR/france/user-0-slice-memory.conf"
USER_SLICE_DROPIN_DIR=$TMP/user-0.slice.d
USER_SLICE_DROPIN=$USER_SLICE_DROPIN_DIR/50-fleet-dao-memory.conf
eval "$(fn_text setup_user_slice_cap)"
eval "$(fn_text readback_user_slice_cap)"

echo "== 1. 仓里的 drop-in 内容"
keys=$(grep -vE '^[[:space:]]*(#|$)' "$CONF" | tr -d '\r' | tr '\n' ' ')
check "只有 [Slice]、MemoryHigh=2G、MemoryMax=3G" "$keys" "[Slice] MemoryHigh=2G MemoryMax=3G "

echo "== 2. 自动档和整套装机都装它，自动档读回它"
check "setup_auto_tier 调 setup_user_slice_cap" "$(fn_text setup_auto_tier | grep -c '^  setup_user_slice_cap$')" "1"
check "main 调 setup_user_slice_cap" "$(fn_text main | grep -c '^    setup_user_slice_cap$')" "1"
check "readback_auto_tier 读回它" "$(fn_text readback_auto_tier | grep -c '^  readback_user_slice_cap$')" "1"

echo "== 3. 装：首次写 + reload；没变不动；仓里改了再装"
fresh
setup_user_slice_cap >/dev/null
check "首次：写了文件" "$(cmp -s "$USER_SLICE_DROPIN" "$CONF" && echo 一样 || echo 不一样)" "一样"
check "首次：daemon-reload 一次" "$(printf '%s\n' "${CALLS[@]}" | grep -c 'daemon-reload')" "1"
fresh
setup_user_slice_cap >/dev/null
check "再跑：没有改动、没有 daemon-reload" "${#CHANGES[@]} ${#CALLS[@]}" "0 0"
printf '%s\n' '[Slice]' 'MemoryHigh=1G' 'MemoryMax=2G' >"$DEPLOY_DIR/france/user-0-slice-memory.conf"
fresh
setup_user_slice_cap >/dev/null
check "仓里改了：重写并 daemon-reload" "${#CHANGES[@]} ${#CALLS[@]}" "1 1"
cp -- "$CONF" "$DEPLOY_DIR/france/user-0-slice-memory.conf"
setup_user_slice_cap >/dev/null

echo "== 4. 读回"
fresh
readback_user_slice_cap >/dev/null 2>&1
check "装着的和仓里一样、生效值是 2G/3G：没有红" "${#REDS[@]}" "0"
printf '%s\n' '[Slice]' 'MemoryMax=infinity' >"$USER_SLICE_DROPIN"
fresh
readback_user_slice_cap >/dev/null 2>&1
check "【故意造出的失败】装着的文件被改：判红" "${#REDS[@]}" "1"
cp -- "$CONF" "$USER_SLICE_DROPIN"
LIVE="MemoryHigh=infinity
MemoryMax=infinity"
fresh
readback_user_slice_cap >/dev/null 2>&1
check "【故意造出的失败】文件对、生效值不是 2G/3G：判红" "${#REDS[@]}" "1"
LIVE="MemoryHigh=2147483648
MemoryMax=3221225472"
rm -f -- "$USER_SLICE_DROPIN"
fresh
readback_user_slice_cap >/dev/null 2>&1
check "【故意造出的失败】文件不存在：判红" "$((${#REDS[@]} >= 1))" "1"

if ((fail)); then
  echo "user-slice-cap：不通过"
  exit 1
fi
echo "user-slice-cap：通过"
