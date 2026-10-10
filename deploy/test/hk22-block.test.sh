#!/usr/bin/env bash
# 会话用户不许直连香港 22（#1785）：核模板第三道规则、渲染换上 HK_ADDR、注释里钉着来源会话号与证据行。
# 不要 root、不连网、不碰宿主防火墙。用法：bash deploy/test/hk22-block.test.sh
#
# —— 单上留言正文（本会话无 gh 凭据，贴不上 #1785；引擎开 PR 后请原样贴到单上）——
#
# 来源：引擎任务 #1775 工作树 `1775-t01a1268d`、用户 `fleet-agent-carpool` 的两个 Cursor 会话。
# 法国本机无 adm/journalctl 权限，未读系统 journal；证据是 agent-transcripts 的工具调用行 + 文件 Birth/mtime。
#
# 第一轮（香港 sshd UTC 16:04–16:07 = CST 00:04–00:07）
#   会话 07ba73f0-9e5f-4f80-be1e-69a0c4b5a8ce
#   路径 …/1775-t01a1268d/agent-transcripts/07ba73f0-…/07ba73f0-….jsonl
#   Birth CST 2026-10-11 00:03:27；结束 mtime 00:17:04
#   证据行：
#     L9  `nc -vz -w3 10.99.0.1 22`（对应 banner exchange: invalid format）
#     L10 `ssh … root@10.99.0.1`
#     L18 `for u in root ubuntu debian admin fleet fleet-backup; do … ssh … ${u}@10.99.0.1 …`
#
# 第二轮（香港 sshd UTC 16:21–16:22 = CST 00:21–00:22）
#   会话 27b96b53-8dc8-4745-aa43-5d4ceed9324f
#   路径 …/1775-t01a1268d/agent-transcripts/27b96b53-…/27b96b53-….jsonl
#   Birth CST 2026-10-11 00:20:14；用户消息时间戳 12:20 AM UTC+8
#   证据行：
#     L8  `nc -vz 10.99.0.1 22` / `/dev/tcp/10.99.0.1/22`
#     L9  `for user in root ubuntu fleet-agent-carpool administrator; do … ssh … "$user@10.99.0.1" …`
#   旁证：`~/.ssh/known_hosts` mtime CST 00:22:28（L9 用了 StrictHostKeyChecking=accept-new）
#
# UTC 16:17 的 fleet-backup 成功登录是正经备份，不是这两轮。
# 改法：nft 第三道只拦 SESSION_UID → WG_HK_ADDR:22；root/fleet 不拦。
#
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$HERE/.." && pwd)
# shellcheck source=deploy/lib/common.sh
source "$DEPLOY/lib/common.sh"

NFT=$DEPLOY/france/fleet-dao.nft
fail=0
check() {
  local name=$1 got=$2 want=$3
  if [[ "$got" == "$want" ]]; then
    printf '  ✓ %s\n' "$name"
  else
    printf '  ✗ %s：得到「%s」，要「%s」\n' "$name" "$got" "$want"
    fail=1
  fi
}
has() {
  local name=$1 hay=$2 needle=$3
  if grep -Fq -- "$needle" <<<"$hay"; then
    printf '  ✓ %s\n' "$name"
  else
    printf '  ✗ %s：找不到「%s」\n' "$name" "$needle"
    fail=1
  fi
}

[[ -f "$NFT" ]] || {
  echo "hk22-block：没跑成：没有 $NFT"
  exit 2
}

echo "== 模板第三道：会话用户 → 香港 22"
body=$(<"$NFT")
has "有 skuid 拦香港 22 的规则" "$body" 'ip daddr @@HK_ADDR@@ tcp dport 22 meta skuid @@SESSION_UID@@ reject with tcp reset'
has "注释钉会话 07ba73f0" "$body" '07ba73f0-9e5f-4f80-be1e-69a0c4b5a8ce'
has "注释钉会话 27b96b53" "$body" '27b96b53-8dc8-4745-aa43-5d4ceed9324f'
has "注释钉第一轮用户名轮询" "$body" 'for u in root ubuntu debian admin fleet fleet-backup'
has "注释钉第二轮用户名轮询" "$body" 'for user in root ubuntu fleet-agent-carpool administrator'
has "注释钉任务 #1775" "$body" '#1775'

echo "== 渲染：HK_ADDR 换上、占位符清掉"
render "$NFT" PORTS=7243 FLEET_UID=1000 SESSION_UID=1001 HK_ADDR=10.99.0.1 >/dev/null || {
  echo "hk22-block：没跑成：模板渲染失败"
  exit 2
}
has "渲染后目的地址是 10.99.0.1" "$RENDERED" 'ip daddr 10.99.0.1 tcp dport 22 meta skuid 1001 reject with tcp reset'
check "渲染后没有 @@HK_ADDR@@" "$(grep -c '@@HK_ADDR@@' <<<"$RENDERED" || true)" 0
check "渲染后没有 @@SESSION_UID@@" "$(grep -c '@@SESSION_UID@@' <<<"$RENDERED" || true)" 0

if ((fail)); then
  echo "hk22-block：不通过"
  exit 1
fi
echo "hk22-block：通过"
exit 0
