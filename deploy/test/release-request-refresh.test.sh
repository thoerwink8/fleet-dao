#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034,SC2317,SC2329 # 桩和被 eval 进来的 france.sh 函数用到的变量，shellcheck 看不出
# 发布接活的脚本副本（#2032）：path 单元已经在跑时，自动档只换字节，不 enable、不建目录。
# 第一次开这个口子仍是整套 france.sh 的 setup_release_request。
# 用法：bash deploy/test/release-request-refresh.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"

FRANCE_SH=$HERE/../france.sh
fn_text() { tr -d '\r' <"$FRANCE_SH" | sed -n "/^$1() {/,/^}/p"; }
for f in refresh_release_request_copies readback_release_request_copies; do
  if [[ -z "$(fn_text "$f")" ]]; then
    echo "release-request-refresh：没跑成：在 deploy/france.sh 里没取到 $f"
    exit 2
  fi
done

fail=0
check() {
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

PATH_ACTIVE=0
CALLS=()
systemctl() {
  if [[ "$1" == is-active && "$2" == fleet-release-request.path ]]; then
    if ((PATH_ACTIVE)); then
      echo active
      return 0
    fi
    echo inactive
    return 3
  fi
  CALLS+=("systemctl $*")
}
put_file() {
  local dest=$1 content=$4
  WROTE=0
  if [[ -f "$dest" ]] && cmp -s -- "$dest" <(printf '%s\n' "$content"); then return 0; fi
  printf '%s\n' "$content" >"$dest"
  changed "写 $dest"
}

RELEASE_REQUEST_LIB=$TMP/lib
RELEASE_REQUEST_FILES=(lib.mjs fleet-release-request.mjs)
RELEASE_REQUEST_UNITS=(fleet-release-request.service fleet-release-request.path)
DEPLOY_DIR=$TMP/deploy
mkdir -p "$DEPLOY_DIR/france/release-request" "$RELEASE_REQUEST_LIB" "$TMP/unit"
# 单元文件的安装位置在函数里写死成 /etc。测试把这一段换成临时目录：只替换函数体里的这一处路径。
UNIT_DIR=$TMP/unit

eval "$(fn_text refresh_release_request_copies | sed "s|/etc/systemd/system/|$UNIT_DIR/|")"
eval "$(fn_text readback_release_request_copies | sed "s|/etc/systemd/system/|$UNIT_DIR/|")"

write_src() {
  printf '%s\n' "$2" >"$DEPLOY_DIR/france/release-request/$1"
}
write_unit() {
  printf '%s\n' "$2" >"$DEPLOY_DIR/france/$1"
}

echo "== 1. path 单元没在跑：不写文件、不 daemon-reload、记待配、没有红"
fresh
PATH_ACTIVE=0
refresh_release_request_copies >/dev/null
check "记一笔待配、没有红" "${#PENDING[@]} ${#REDS[@]}" "1 0"
check "没有 systemctl（除了 is-active）" "${#CALLS[@]}" "0"
check "没写脚本" "$(find "$RELEASE_REQUEST_LIB" -type f | wc -l | tr -d ' ')" "0"

echo "== 2. 【故意造出的失败】path 在跑但仓里没有脚本：红，不写"
fresh
PATH_ACTIVE=1
refresh_release_request_copies >/dev/null
check "有红、没有待配" "${#REDS[@]} ${#PENDING[@]}" "1 0"
check "没写脚本" "$(find "$RELEASE_REQUEST_LIB" -type f | wc -l | tr -d ' ')" "0"

echo "== 3. path 在跑、内容变了：换脚本；单元没变就不 daemon-reload"
fresh
PATH_ACTIVE=1
write_src lib.mjs 'new-lib'
write_src fleet-release-request.mjs 'new-main'
write_unit fleet-release-request.service 'unit-svc'
write_unit fleet-release-request.path 'unit-path'
printf '%s\n' 'old-lib' >"$RELEASE_REQUEST_LIB/lib.mjs"
printf '%s\n' 'new-main' >"$RELEASE_REQUEST_LIB/fleet-release-request.mjs"
printf '%s\n' 'unit-svc' >"$UNIT_DIR/fleet-release-request.service"
printf '%s\n' 'unit-path' >"$UNIT_DIR/fleet-release-request.path"
refresh_release_request_copies >/dev/null
check "没有红" "${#REDS[@]}" "0"
check "lib 换成仓里的" "$(cat "$RELEASE_REQUEST_LIB/lib.mjs")" "new-lib"
check "没变的脚本没被记成改动" "$(printf '%s\n' "${CHANGES[@]}")" "写 $RELEASE_REQUEST_LIB/lib.mjs"
check "没有 daemon-reload" "${#CALLS[@]}" "0"

echo "== 4. 单元文件变了才 daemon-reload"
fresh
PATH_ACTIVE=1
write_unit fleet-release-request.service 'unit-svc-2'
refresh_release_request_copies >/dev/null
check "没有红" "${#REDS[@]}" "0"
check "daemon-reload 一次" "${CALLS[*]}" "systemctl daemon-reload"
check "单元换成仓里的" "$(cat "$UNIT_DIR/fleet-release-request.service")" "unit-svc-2"

echo "== 5. 读回：没在跑不红；在跑且不一致红；一致不红"
fresh
PATH_ACTIVE=0
readback_release_request_copies >/dev/null
check "没在跑：没有红" "${#REDS[@]}" "0"
fresh
PATH_ACTIVE=1
printf '%s\n' 'stale' >"$RELEASE_REQUEST_LIB/lib.mjs"
readback_release_request_copies >/dev/null
check "不一致：有红" "${#REDS[@]}" "1"
fresh
PATH_ACTIVE=1
printf '%s\n' 'new-lib' >"$RELEASE_REQUEST_LIB/lib.mjs"
readback_release_request_copies >/dev/null
check "一致：没有红" "${#REDS[@]}" "0"

echo "== 6. 自动档入口调用刷新，不调用会 enable 的 setup_release_request"
auto=$(sed -n '/^setup_auto_tier() {/,/^}/p' "$FRANCE_SH")
check "入口里有刷新" "$(grep -c 'refresh_release_request_copies' <<<"$auto")" "1"
check "入口里没有 setup_release_request" "$(grep -c 'setup_release_request' <<<"$auto")" "0"

if ((fail)); then
  echo "release-request-refresh：不通过"
  exit 1
fi
echo "release-request-refresh：通过"
