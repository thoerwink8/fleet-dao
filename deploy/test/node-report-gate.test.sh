#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy/lib/node-report-gate.sh（france.sh 读回：假通行证 POST /api/nodes/report 要回 401）的判据，每种回答各造一次：
#   1. 401 且是 node_token_invalid：通过（ok），没有红、没有待配；
#   2. 503 且是 node_keys_not_wired（法国还没配 FLEET_NODE_KEYS）：待配、写明去配，不是通过，也不判红——故意造出：
#      这一条不许长得像通过；
#   3. 200、400、413、429（通行证认下之后才会有的回答）：判红，写明假通行证被放进来了；
#   4. 401 但是「没带通行证」（香港把头清了）：判红；401 但认不出原因、别的 503、404、502、连不上（000）、没回：待配、没查成，
#      不判红也不算通过。
# 不连网：回答是喂进去的。用法：bash deploy/test/node-report-gate.test.sh。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/node-report-gate.sh
source "$HERE/../lib/node-report-gate.sh"

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
# 判一次（在本 shell 里，REDS、PENDING 才留得下）：结果进 NOK、NRED、NPENDING 和 LAST（红或待配那一条的原文）
judge() { # HTTP 状态码 正文
  REDS=()
  PENDING=()
  NOK=$(judge_node_report_gate "$1" "$2" | grep -c '✓' || true)
  judge_node_report_gate "$1" "$2" >/dev/null
  NRED=${#REDS[@]}
  NPENDING=${#PENDING[@]}
  LAST="${REDS[0]:-${PENDING[0]:-}}"
}

echo "== 1. 配了钥匙、假通行证被拒：401 + node_token_invalid 才算通过"
judge 401 '{"error":{"code":"node_token_invalid","message":"通行证不对"}}'
check "一条通过、没有红、没有待配" "$NOK/$NRED/$NPENDING" "1/0/0"

echo "== 2. 没配 FLEET_NODE_KEYS：503，待配、提示去配，不是通过也不是红"
judge 503 '{"error":{"code":"node_keys_not_wired","message":"这台没配 FLEET_NODE_KEYS"}}'
check "没有通过、没有红、一条待配" "$NOK/$NRED/$NPENDING" "0/0/1"
has "待配里写明是没配 FLEET_NODE_KEYS" "$LAST" "还没配 FLEET_NODE_KEYS"
has "待配里写明去哪看怎么配" "$LAST" "接上法国看板"

echo "== 3. 假通行证被放进来：判红"
for c in 200 400 413 429; do
  judge "$c" '{"ok":true}'
  check "HTTP $c：没有通过、一条红、没有待配" "$NOK/$NRED/$NPENDING" "0/1/0"
  has "HTTP $c：写明假通行证被放进来了" "$LAST" "假通行证被放进来了"
done

echo "== 4. 没走到收件口、认不出：待配（没查成），不判红也不算通过"
judge 401 '{"error":{"code":"node_token_missing","message":"要带通行证"}}'
check "401 没带通行证（香港清了头）：判红" "$NOK/$NRED/$NPENDING" "0/1/0"
has "写明头被清了" "$LAST" "香港 nginx 把这个头清掉了"
judge 401 '{"error":{"code":"unauthenticated"}}'
check "401 但不是收件口的原因：没查成" "$NOK/$NRED/$NPENDING" "0/0/1"
judge 503 '<html>503 Service Unavailable</html>'
check "503 但不是收件口的回答（香港的 503）：没查成" "$NOK/$NRED/$NPENDING" "0/0/1"
for c in 404 502 000 ''; do
  judge "$c" ''
  check "HTTP「$c」：没查成、不判红、不算通过" "$NOK/$NRED/$NPENDING" "0/0/1"
  has "HTTP「$c」：写明挡没挡住这项没查成" "$LAST" "这项没查成"
done

if ((fail)); then
  echo "node-report-gate：有不通过的"
  exit 1
fi
echo "node-report-gate：通过"
