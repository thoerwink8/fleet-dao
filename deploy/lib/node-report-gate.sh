#!/usr/bin/env bash
# shellcheck disable=SC2034 # NODE_REPORT_FAKE_TOKEN 是给 france.sh 用的
# 看板多机的收件口（POST /api/nodes/report）有没有挡住假通行证（france.sh 的读回用）。要先 source common.sh（ok、pending、red）。
# deploy/test/node-report-gate.test.sh 拿各种回答喂它，每种都造一次。
#
# france.sh 从公网（经香港）带一把假的 X-Fleet-Node-Token POST 一个空载荷，把 HTTP 状态码和回的正文交给这里判。后端对这个口的回答
# （packages/api/src/node-report.ts）只有几种，分得清才不会把「没配」当成「挡住了」：
#   401 且是 node_token_invalid：配了钥匙、假通行证被拒——通过，只有这一种算通过；
#   503 且是 node_keys_not_wired：法国还没配 FLEET_NODE_KEYS，写口关着、什么都不收——待配，提示去配，不算通过；
#   200、400、413、429（这几个都发生在通行证认下之后：校验载荷、限大小、限频）：假通行证被放进来了——判红；
#   其余（401 但不是这个口的原因、404、502、连不上……）：请求没走到后端的这个口（后端没起、香港没转），没查成——待配，不判红也不算通过。
# 不带真通行证：这里只发一把谁也不会发的假值。

NODE_REPORT_FAKE_TOKEN=fleet-dao-probe

judge_node_report_gate() { # HTTP 状态码 回的正文
  local code=$1 body=$2
  case "$code" in
  401)
    if [[ "$body" == *'"node_token_invalid"'* ]]; then
      ok "从公网带一把假的 X-Fleet-Node-Token POST /api/nodes/report：回 401（通行证不对），写口挡得住假通行证"
    elif [[ "$body" == *'"node_token_missing"'* ]]; then
      red "从公网带了 X-Fleet-Node-Token，后端却回「没带通行证」：香港 nginx 把这个头清掉了，别的环境推不进来"
    else
      pending "从公网 POST /api/nodes/report 回 401，但不是收件口的回答（${body:0:120}），挡没挡住假通行证这项没查成"
    fi
    ;;
  503)
    if [[ "$body" == *'"node_keys_not_wired"'* ]]; then
      pending "收件口关着：法国的 api.env 还没配 FLEET_NODE_KEYS（后端回 503，不收任何快照）；假通行证挡没挡住这项没查：按 docs/ops.md「接上法国看板」配钥匙、发版后再读回"
    else
      pending "从公网 POST /api/nodes/report 回 503，但不是收件口的回答（${body:0:120}），挡没挡住假通行证这项没查成"
    fi
    ;;
  200 | 400 | 413 | 429)
    red "从公网带一把假的 X-Fleet-Node-Token POST /api/nodes/report，后端没拒（HTTP $code）：假通行证被放进来了，收件口没有认人"
    ;;
  *)
    pending "从公网 POST /api/nodes/report 没走到后端的收件口（HTTP ${code:-没回}，${body:0:120}），挡没挡住假通行证这项没查成"
    ;;
  esac
}
