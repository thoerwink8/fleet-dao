#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # APP_UNITS、SHA 这些是给 source 进来的 release.sh 里的函数读写的
# deploy/release.sh 的来回：换版、健康检查不过自动退回、一键退回、不退到判过不健康的版本、只留最近几版。
# 取代码、构建、迁移、健康检查、往香港传文件换成桩（按提交号预先定好健康不健康）；切 current、记历史、挑上一版、
# 清旧版用的是 release.sh 里的真代码，目录落在临时目录，不碰 systemd、不连网、不用 root。
# 真机上的那一半（真起服务、真传文件、真健康检查）在法国、香港上实测，记录在引入本文件的 PR 里。
# 用法：bash deploy/test/release-flow.test.sh。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e # release.sh 开了 -e；这里自己判每一步
mkdir -p "$RELEASES"

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

# ── 桩 ──
declare -A GATE=() # 提交号 → ok / bad
APP_UNITS=()       # 不装、不停任何单元
FLEET_SERVICES=""
KEEP=3
fetch_code() {
  SHA=$1
  ON_MAIN=1
}
build_release() {
  if [[ -f "$RELEASES/$1/.fleet-release" ]]; then return 0; fi
  mkdir -p "$RELEASES/$1/web"
  printf 'commit=%s\nbuilt=%s\non_main=1\nweb=桩\n' "$1" "$(date -u +%FT%TZ)" >"$RELEASES/$1/.fleet-release"
  changed "构建 ${1:0:12}"
}
migrate() { :; }
api_report_before() { :; }
sync_web() { :; }
health_gate() {
  if [[ "${GATE[$1]:-ok}" == ok ]]; then return 0; fi
  red "桩：${1:0:12} 健康检查不过"
  return 1
}

A=$(printf 'a%.0s' {1..40})
B=$(printf 'b%.0s' {1..40})
C=$(printf 'c%.0s' {1..40})
D=$(printf 'd%.0s' {1..40})
E=$(printf 'e%.0s' {1..40})
events() { awk '{ printf "%s:%s ", substr($2, 1, 1), $3 }' "$HISTORY"; }
reset() {
  REDS=()
  CHANGES=()
  PENDING=()
}

echo "== 头一版、第二版：健康，照常切过去"
reset
do_release "$A" >/dev/null
check "发 A 之后在用 A" "$(current_sha)" "$A"
check "发 A 没有红" "${#REDS[@]}" 0
reset
do_release "$B" >/dev/null
check "发 B 之后在用 B" "$(current_sha)" "$B"
check "上一版是 A" "$(previous_sha)" "$A"

echo "== 同一个提交再发一遍：什么都不变"
reset
before=$(events)
do_release "$B" >/dev/null
check "再发 B：改动 0 处" "${#CHANGES[@]}" 0
check "再发 B：历史没变" "$(events)" "$before"

echo "== 新版健康检查不过：自动退回上一版，并报红"
GATE[$C]=bad
reset
do_release "$C" >/dev/null
check "C 不过之后在用的是 B" "$(current_sha)" "$B"
check "报了红" "$((${#REDS[@]} > 0))" 1
check "历史：C 记成不健康、B 是自动退回的" "$(events)" "a:release b:release c:release c:unhealthy b:auto-rollback "
check "上一版跳过不健康的 C，是 A" "$(previous_sha)" "$A"

echo "== 一键退回：退到 A；再退一次回到 B（B 健康）"
reset
do_rollback >/dev/null
check "退回后在用 A" "$(current_sha)" "$A"
check "退回没有红" "${#REDS[@]}" 0
check "这时的上一版是 B" "$(previous_sha)" "$B"

echo "== 在用的那版自己健康检查不过（没换版本）：不退，报红"
GATE[$A]=bad
reset
do_release "$A" >/dev/null
check "还在用 A" "$(current_sha)" "$A"
check "报了红" "$((${#REDS[@]} > 0))" 1
GATE[$A]=ok

echo "== 新版不过、退回的那版也不过：两个都记成不健康，报红"
GATE[$D]=bad
GATE[$A]=bad
reset
do_release "$D" >/dev/null
check "退回了 A" "$(current_sha)" "$A"
check "历史最后三件：D 不健康、A 自动退回、A 不健康" \
  "$(tail -3 "$HISTORY" | awk '{ printf "%s:%s ", substr($2, 1, 1), $3 }')" "d:unhealthy a:auto-rollback a:unhealthy "
check "上一版跳过 A、C、D，是 B" "$(previous_sha)" "$B"
GATE[$A]=ok

echo "== 只留最近 $KEEP 版：在用的、上一版一定留；没构建完的临时目录清掉"
mkdir -p "$RELEASES/.build-$E"
reset
do_release "$E" >/dev/null
check "在用 E" "$(current_sha)" "$E"
left=$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | cut -c1 | sort | tr -d '\n')
# 上一版是 B（A 在退回后又判过不健康，C、D 也是），再按最近用过的补一个 A；C、D 清掉
check "留下的版本：E 在用、B 是上一版、再补最近用过的 A" "$left" "abe"
check "没构建完的临时目录清掉了" "$([[ -e "$RELEASES/.build-$E" ]] && echo 在 || echo 没了)" "没了"

echo "== 头一版就不过：没有上一版可退，报红"
rm -rf "${RELEASES:?}"/* "$RELEASES"/.history
GATE[$B]=bad
reset
do_release "$B" >/dev/null
check "报了红" "$((${#REDS[@]} > 0))" 1
check "历史：B 发了、记成不健康" "$(events)" "b:release b:unhealthy "
reset
do_rollback >/dev/null
check "没有可退的：一键退回报红" "$((${#REDS[@]} > 0))" 1

echo "== 判过不健康的在用版本，后来健康检查过了：记回健康（又能当退回目标），再发一遍不再记"
GATE[$B]=ok
reset
do_release "$B" >/dev/null
check "记回健康" "$(events)" "b:release b:unhealthy b:recovered "
check "没有红" "${#REDS[@]}" 0
reset
do_release "$B" >/dev/null
check "再发一遍：改动 0 处" "${#CHANGES[@]}" 0
GATE[$C]=ok
reset
do_release "$C" >/dev/null
check "发 C 之后，上一版是记回健康的 B" "$(previous_sha)" "$B"

if ((fail)); then
  echo "release-flow：不通过"
  exit 1
fi
echo "release-flow：通过"
