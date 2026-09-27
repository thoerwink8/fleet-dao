#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy/lib/auto-release-state.sh（france.sh 读回自动发布跑得怎么样）的判据，每种情况各造一次：
#   1. 状态文件不在：待配「还一轮都没跑过」，不判红；
#   2. 读不了（是个目录）、不是 JSON、格式版本不对、ranAt 认不出、读格式的 lib.mjs 载不进来、node 起不来：
#      都判红写明原因，不当成没跑过；
#   3. 读到了：写上一轮跑的时间和这一轮干了什么（状态由 lib.mjs 真的 carryOver 造，和写方同一个样子）；
#   4. 单元最近一轮崩了（ActiveState=failed）判红；正在跑（activating）、跑完没崩（inactive）不判。
# 不碰真的 /srv：状态文件放在临时目录里。用法：bash deploy/test/auto-release-state.test.sh。
# 退出码：0 通过，1 不通过，2 没跑成（这台找不到 node）。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/auto-release-state.sh
source "$HERE/../lib/auto-release-state.sh"
LIB=$HERE/../france/auto-release/lib.mjs

# sudo 会换掉 PATH，CI 里 setup-node 装的那个不在上面，去它的缓存目录找
NODE=""
for n in "$(command -v node 2>/dev/null || true)" /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node /usr/local/bin/node; do
  if [[ -x "$n" ]]; then
    NODE=$n
    break
  fi
done
if [[ -z "$NODE" ]]; then
  echo "auto-release-state：没跑成：这台找不到 node"
  exit 2
fi
AUTO_STATE_NODE=$NODE

T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
STATE=$T/state.json

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
has() { # 说明 文本 要有的一段
  if [[ "$2" == *"$3"* ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：「%s」里没有「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
# 跑一次读状态文件：退出码进 RC，输出进 OUT，红、待配各几条进 NRED、NPENDING（在本 shell 里跑，REDS 这些才留得下）
run_state() { # 状态文件 [lib.mjs]
  REDS=()
  PENDING=()
  check_auto_release_state "$1" "${2:-$LIB}" >"$T/out" 2>&1
  RC=$?
  OUT=$(<"$T/out")
  NRED=${#REDS[@]}
  NPENDING=${#PENDING[@]}
}
# 照写方的样子造一份状态：lib.mjs 的 carryOver，再按参数改几样（JSON 片段，合进去）
make_state() { # 要改的字段（JSON 对象）
  "$NODE" --input-type=module -e '
    const [lib, patch] = process.argv.slice(1);
    const { carryOver } = await import((await import("node:url")).pathToFileURL(lib).href);
    console.log(JSON.stringify({ ...carryOver(null), ...JSON.parse(patch) }, null, 1));
  ' "$LIB" "$1" >"$STATE"
}

echo "== 1. 状态文件不在：还一轮都没跑过（待配），不判红"
run_state "$T/nope.json"
check "返回 0" "$RC" 0
check "没有红" "$NRED" 0
check "一条待配" "$NPENDING" 1
has "说还一轮都没跑过" "$OUT" "还一轮都没跑过"

echo "== 2. 读不了、格式坏了：判红写明原因，不当成没跑过"
mkdir "$T/dir.json"
run_state "$T/dir.json"
check "是个目录：返回 1" "$RC" 1
check "是个目录：一条红、没有待配" "$NRED/$NPENDING" "1/0"
has "是个目录：写明读不了" "$OUT" "读不了"

printf '{"schema":1,"ranAt":' >"$STATE"
run_state "$STATE"
check "写了半截：返回 1" "$RC" 1
check "写了半截：一条红、没有待配" "$NRED/$NPENDING" "1/0"
has "写了半截：写明不是 JSON" "$OUT" "不是 JSON"

make_state '{"schema":2,"ranAt":"2026-09-27T01:50:20.438Z"}'
run_state "$STATE"
check "格式版本不对：返回 1" "$RC" 1
has "格式版本不对：写明认不出、应为几" "$OUT" "格式认不出（schema 2，应为 1）"

make_state '{"ranAt":null}'
run_state "$STATE"
check "ranAt 是空的（carryOver 刚造、还没跑完一轮的样子）：返回 1" "$RC" 1
has "ranAt 是空的：写明认不出什么时候跑的" "$OUT" "认不出上一轮是什么时候跑的"

make_state '{"ranAt":"昨天"}'
run_state "$STATE"
check "ranAt 不是时间：返回 1" "$RC" 1
has "ranAt 不是时间：原样写出来" "$OUT" '（ranAt 是 "昨天"）'

make_state '{"ranAt":"2026-09-27T01:50:20.438Z"}'
run_state "$STATE" "$T/no-lib.mjs"
check "认格式的 lib.mjs 载不进来：返回 1" "$RC" 1
has "认格式的 lib.mjs 载不进来：写明是哪个" "$OUT" "no-lib.mjs 载不进来"

AUTO_STATE_NODE=$T/no-node
run_state "$STATE"
AUTO_STATE_NODE=$NODE
check "node 起不来：返回 1" "$RC" 1
check "node 起不来：一条红" "$NRED" 1

echo "== 3. 读到了：写上一轮跑的时间和这一轮干了什么"
AGO=$("$NODE" -e 'console.log(new Date(Date.now() - 3 * 60000).toISOString())')
make_state "{\"ranAt\":\"$AGO\",\"last\":{\"action\":\"released\",\"detail\":\"发了 0123456789ab（退出码 0）\",\"at\":\"$AGO\"}}"
run_state "$STATE"
check "返回 0" "$RC" 0
check "没有红、没有待配" "$NRED/$NPENDING" "0/0"
has "写上一轮的时间、几分钟前" "$OUT" "自动发布上一轮跑在 $AGO（3 分钟前）"
has "写这一轮干了什么" "$OUT" "这轮：released（发了 0123456789ab（退出码 0））"

make_state "{\"ranAt\":\"$AGO\",\"last\":{\"action\":\"up-to-date\",\"detail\":\"\",\"at\":\"$AGO\"}}"
run_state "$STATE"
has "没有细节的只写动作" "$OUT" "这轮：up-to-date（全部读数"

make_state "{\"ranAt\":\"$AGO\"}"
run_state "$STATE"
check "这一轮没记干了什么：照样算跑过、返回 0" "$RC" 0
has "这一轮没记干了什么：写明" "$OUT" "这轮：没记这一轮干了什么"

echo "== 4. 单元：最近一轮崩了判红；正在跑、跑完没崩不判"
REDS=()
check_auto_release_unit failed 1 >"$T/out" 2>&1
RC=$?
check "failed：返回 1、一条红" "$RC/${#REDS[@]}" "1/1"
has "failed：写退出码、去哪看" "$(<"$T/out")" "崩了（退出码 1）"
REDS=()
for state in activating inactive ""; do
  check_auto_release_unit "$state" "" >"$T/out" 2>&1
  RC=$?
  check "「${state:-读不到}」：返回 0、不判红" "$RC/${#REDS[@]}" "0/0"
done

if ((fail)); then
  echo "auto-release-state：不通过"
  exit 1
fi
echo "auto-release-state：通过"
