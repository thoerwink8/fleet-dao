#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 演示版已删（创始人 2026-10-07，#1223）：发布脚本、装机脚本里不再有演示版，仓里不再有推可见范围的单元和脚本。
# - deploy/release.sh、deploy/france.sh 里提到 demo 的行，每一行都要带 #1223——只剩「清掉老机器上留下的东西」那几处（老单元名、
#   老目录、老配置键），新写的代码里不许再冒出一个 demo；
# - deploy/france/fleet-demo-scopes.{sh,service,path,timer}、deploy/test/demo-scopes.test.sh 不在仓里；
# - deploy/france/desired-config.json 里没有演示版的键；
# - france.sh 真有「停掉并删掉老单元、读回核对它们不在」那两步。
# 【故意造出的失败】查法本身也要查得出：往一份副本里种一行没带 #1223 的 demo、种一个老名字的文件，查法必须报出来；
# 种的是带 #1223 的那种，查法必须放过——查法坏了（什么都查不出）这里就红，不会悄悄过。
# 用法：bash deploy/test/no-demo.test.sh（不用 root）。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$HERE/.." && pwd)
REPO=$(cd -- "$DEPLOY/.." && pwd)
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

# 一份文件里提到 demo（不分大小写）、却没带 #1223 的行：「行号:内容」，没有就什么都不打印
untagged_demo_lines() { # 文件
  { grep -n -i demo -- "$1" || true; } | { grep -v '#1223' || true; }
}
# 一棵目录里叫 fleet-demo-scopes* 的文件：一行一个，没有就什么都不打印
old_unit_files() { # 目录
  find "$1" \( -name node_modules -o -name .git -o -name .claude \) -prune -o -name 'fleet-demo-scopes*' -print
}

echo "== 查法本身：种进去的要查得出、带标记的要放过、什么都没有的要放过（【故意造出的失败】）"
printf 'echo 新写的 demo 步骤\n' >"$TMP/planted.sh"
check "【故意造出的失败】没带 #1223 的 demo 行：查得出" "$(untagged_demo_lines "$TMP/planted.sh" | grep -c 'demo')" 1
printf 'FLEET_DEMO_PATH="" # #1223\n' >"$TMP/tagged.sh"
check "带 #1223 的：放过" "$(untagged_demo_lines "$TMP/tagged.sh")" ""
printf 'echo 干净\n' >"$TMP/clean.sh"
check "没有 demo 的：放过" "$(untagged_demo_lines "$TMP/clean.sh")" ""
printf 'FLEET_DEMO_PATH=/x/\n' >"$TMP/upper.sh"
check "【故意造出的失败】大写的 DEMO 也查得出" "$(untagged_demo_lines "$TMP/upper.sh" | grep -c 'DEMO')" 1
mkdir -p "$TMP/tree/deploy/france" "$TMP/tree/node_modules/x"
: >"$TMP/tree/deploy/france/fleet-demo-scopes.timer"
: >"$TMP/tree/node_modules/x/fleet-demo-scopes.sh"
check "【故意造出的失败】种进去的老单元文件：查得出（node_modules 里的不算）" "$(old_unit_files "$TMP/tree" | tr '\n' ' ')" "$TMP/tree/deploy/france/fleet-demo-scopes.timer "
check "没种的目录：放过" "$(old_unit_files "$TMP/clean-tree" 2>/dev/null)" ""

echo "== 发布脚本、装机脚本：提到 demo 的行都带 #1223"
for f in release.sh france.sh lib/common.sh lib/snapshot.sh hk.sh; do
  check "deploy/$f：没有没带 #1223 的 demo" "$(untagged_demo_lines "$DEPLOY/$f")" ""
done
check "release.sh 在读到的行里确实还有老名字（清香港老目录用），没读空" "$(grep -c -i demo "$DEPLOY/release.sh" | awk '{ print ($1 > 0) ? "有" : "没有" }')" 有
check "france.sh 在读到的行里确实还有老单元名（清老机器用），没读空" "$(grep -c -i demo "$DEPLOY/france.sh" | awk '{ print ($1 > 0) ? "有" : "没有" }')" 有

echo "== 仓里不再有推可见范围的单元、脚本和它的测试"
check "没有 fleet-demo-scopes* 文件" "$(old_unit_files "$REPO")" ""
check "没有 deploy/test/demo-scopes.test.sh" "$([[ -e "$HERE/demo-scopes.test.sh" ]] && echo 在 || echo 没有)" 没有

echo "== 法国的期望配置里没有演示版的键"
check "desired-config.json 不再有 demo（FLEET_DEMO_DIR、FLEET_HK_PARTS 里的 demo）" "$(grep -c -i demo "$DEPLOY/france/desired-config.json")" 0
check "FLEET_HK_PARTS 的值只有 gateway、web" \
  "$(grep -A1 '"FLEET_HK_PARTS"' "$DEPLOY/france/desired-config.json" | grep -o '"value": "[^"]*"')" '"value": "gateway web"'

echo "== france.sh 真有清老单元、读回核对它们不在"
check "retire_old_units 在整套装机里调了、在自动档里也调了" "$(grep -c '^ *retire_old_units$' "$DEPLOY/france.sh")" 2
check "readback_retired_units 在整套读回、自动档读回里都调了" "$(grep -c '^ *readback_retired_units$' "$DEPLOY/france.sh")" 2
for u in fleet-demo-scopes.path fleet-demo-scopes.timer fleet-demo-scopes.service; do
  check "老单元 $u 在清单里" "$(grep -c "^RETIRED_UNITS=.*$u" "$DEPLOY/france.sh")" 1
done

echo "== 老机器上装过的单元：停掉、删掉；已经没有就什么都不动；停不掉、留着都判红（france.sh 里的真函数，systemctl 换成桩）"
# france.sh 末尾直接 main，不能 source；把那两个函数和它们用的变量行原样摘出来
extract() { awk -v name="$1" '$0 ~ "^" name "\\(\\) \\{$" { on = 1 } on { print } on && /^}$/ { exit }' "$DEPLOY/france.sh"; }
FUNCS=$(
  extract retire_old_units
  extract readback_retired_units
)
check "摘到了那两个函数" "$(grep -c -e '^retire_old_units() {' -e '^readback_retired_units() {' <<<"$FUNCS")" 2
REDS=()
LOG=()
step() { :; }
red() { REDS+=("$1"); }
changed() { LOG+=("changed $1"); }
ok() { LOG+=("ok $1"); }
RETIRED_UNITS=(fleet-demo-scopes.path fleet-demo-scopes.timer fleet-demo-scopes.service)
RETIRED_UNIT_DIR=$TMP/units
RETIRED_BIN=$TMP/sbin/fleet-demo-scopes
STATE=$TMP/state # 每个单元一个文件，里面写 active / inactive
RELOADS=0
STUCK=0 # 1 = 停不掉
systemctl() {
  case $1 in
  is-active)
    if [[ -f "$STATE/$2" ]]; then cat -- "$STATE/$2"; else echo inactive; fi
    ;;
  disable)
    if ((STUCK)); then return 1; fi
    if [[ -f "$STATE/$3" ]]; then echo inactive >"$STATE/$3"; fi
    ;;
  daemon-reload) RELOADS=$((RELOADS + 1)) ;;
  esac
}
# shellcheck disable=SC1090 # 摘出来的函数
source <(printf '%s\n' "$FUNCS")
install_old() { # 把老机器的样子摆出来：三个单元文件、都在跑，加脚本
  rm -rf -- "$RETIRED_UNIT_DIR" "$STATE" "$TMP/sbin"
  mkdir -p "$RETIRED_UNIT_DIR" "$STATE" "$TMP/sbin"
  local u
  for u in "${RETIRED_UNITS[@]}"; do
    : >"$RETIRED_UNIT_DIR/$u"
    echo active >"$STATE/$u"
  done
  : >"$RETIRED_BIN"
  REDS=()
  LOG=()
  RELOADS=0
  STUCK=0
}
left() { # 还剩下什么：单元文件、脚本、还在跑的
  local u out=""
  for u in "${RETIRED_UNITS[@]}"; do
    if [[ -e "$RETIRED_UNIT_DIR/$u" ]]; then out+="文件:$u "; fi
    if [[ "$(cat "$STATE/$u" 2>/dev/null)" == active ]]; then out+="在跑:$u "; fi
  done
  if [[ -e "$RETIRED_BIN" ]]; then out+="脚本 "; fi
  printf '%s' "$out"
}
install_old
retire_old_units
check "老机器：三个单元、脚本都清掉了，没有红" "$(left):${#REDS[@]}" ":0"
check "老机器：记了四笔改动（三个单元、一个脚本），daemon-reload 一次" "${#LOG[@]}:$RELOADS" "4:1"
REDS=()
LOG=()
readback_retired_units
check "读回：都不在了，通过、没有红" "${#REDS[@]}:${LOG[0]%%（*}" "0:ok 已删的演示版单元和脚本都不在了"
RELOADS=0
LOG=()
retire_old_units
check "再来一遍：幂等，什么都不动、不 reload、没有红" "${#LOG[@]}:$RELOADS:${#REDS[@]}" "0:0:0"
install_old
STUCK=1
retire_old_units
check "停不掉（还在跑）：判红，不删文件、不当成没事" "$(grep -c '停不掉' <<<"$(printf '%s\n' "${REDS[@]}")"):$([[ -e "$RETIRED_UNIT_DIR/fleet-demo-scopes.path" ]] && echo 文件在 || echo 文件没了)" "3:文件在"
REDS=()
readback_retired_units
check "读回：还在的判红（三个单元，脚本上一步已经删了）（【故意造出的失败】）" "$(grep -c '还在' <<<"$(printf '%s\n' "${REDS[@]}")")" 3
install_old
rm -f -- "$RETIRED_UNIT_DIR/fleet-demo-scopes.service"
echo inactive >"$STATE/fleet-demo-scopes.service"
retire_old_units
check "只剩一部分（另一个单元早就没了）：剩下的照清，没有红" "$(left):${#REDS[@]}" ":0"

if ((fail)); then
  echo "no-demo：不通过"
  exit 1
fi
echo "no-demo：通过"
