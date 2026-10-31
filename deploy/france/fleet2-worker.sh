#!/usr/bin/env bash
# 新内核影子工人的执行体前缀（#3814）：内核以 fleet 跑，把它当 FLEET2_WORKER_COMMAND 的第一项，后面接执行体和它的参数。
# 经 fleet-agent-scope 以会话用户 fleet-agent-carpool 跑进 fleet2-shadow.slice（nft 表 inet fleet2_shadow 按它收紧出网），
# scope 编号是 fleet2-<FLEET_RUN_ID>（运行层写进环境的会话标记；sudo 的 env_keep 放过 FLEET_*），
# 和 packages/harness-dispatch/src/scope-sandbox.ts 的 SHADOW_SCOPE_PREFIX 一致：内核跑完按它收 scope。
# 工作目录取当前目录（内核起进程时的 cwd，已经经 adopt 交给会话用户）。不在发布目录里改：它跟着这一版走。
set -euo pipefail
[[ "${FLEET_RUN_ID:-}" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$ ]] || {
  echo "fleet2-worker：FLEET_RUN_ID 不合法或没给：「${FLEET_RUN_ID:-}」" >&2
  exit 2
}
# 后面第一个参数是执行体（reclaude 或 grok 的绝对路径，#3842 起写在单元的 FLEET2_WORKER_COMMAND 里），只认会话用户家里这两个。
case "${1:-}" in
  /home/fleet-agent-carpool/.local/bin/reclaude | /home/fleet-agent-carpool/.grok/bin/grok) ;;
  *)
    echo "fleet2-worker：执行体只认会话用户家里的 reclaude 或 grok：「${1:-}」" >&2
    exit 2
    ;;
esac
exec /usr/bin/sudo -n /usr/local/sbin/fleet-agent-scope run "fleet2-$FLEET_RUN_ID" --slice fleet2-shadow \
  --user fleet-agent-carpool --cwd "$PWD" -- "$@"
