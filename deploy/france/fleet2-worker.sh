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
  /home/fleet-agent-carpool/.local/bin/reclaude) ;;
  /home/fleet-agent-carpool/.grok/bin/grok)
    # grok 靠环境变量认配置（GROK_HOME 里挂着内核的 MCP、关统计上报、免目录信任），可 sudo 的 env_keep 和 fleet-agent-scope
    # 的白名单只放 FLEET_* 等几类，其余会被擦掉：不带过去 grok 就读不到 MCP（法国 2026-10-31 第四批 grok 全程「No MCP tools
    # are available」、统计上报被出网关拒了上万次，#3842）。这几个变量的值只是路径和 0/1/false，不是密钥（令牌在 GROK_HOME
    # 里的 config.toml 文件里），所以经 /usr/bin/env 放在执行体前面带过去；名字写死，值里有控制字符或空的不带。
    grok_env=()
    for k in GROK_HOME GROK_AUTH_PATH GROK_DISABLE_AUTOUPDATER GROK_FOLDER_TRUST GROK_ASK_USER_QUESTION \
      GROK_TELEMETRY_ENABLED GROK_TELEMETRY_TRACE_UPLOAD DISABLE_TELEMETRY DISABLE_ERROR_REPORTING; do
      v=${!k:-}
      [[ -n "$v" ]] || continue
      [[ "$v" != *[[:cntrl:]]* ]] || {
        echo "fleet2-worker：$k 的值里有控制字符" >&2
        exit 2
      }
      grok_env+=("$k=$v")
    done
    set -- /usr/bin/env "${grok_env[@]}" "$@"
    ;;
  *)
    echo "fleet2-worker：执行体只认会话用户家里的 reclaude 或 grok：「${1:-}」" >&2
    exit 2
    ;;
esac
exec /usr/bin/sudo -n /usr/local/sbin/fleet-agent-scope run "fleet2-$FLEET_RUN_ID" --slice fleet2-shadow \
  --user fleet-agent-carpool --cwd "$PWD" -- "$@"
