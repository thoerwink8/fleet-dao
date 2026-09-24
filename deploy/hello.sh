#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 「你好」工作流（P0 验收）：在法国让引擎工人跑一次 helloWorkflow，再查它的耗时。Temporal 把每次执行的起止时间和
# 耗时记在本机 Postgres（库 temporal_visibility 的表 executions_visibility），以后随时查得到。以 root 跑：
#   bash deploy/hello.sh
# 前提：引擎工人在跑（/etc/fleet-dao/release.env 的 FLEET_SERVICES 含 fleet-engine，发布过），且引擎代码注册了
# helloWorkflow(name: string) => string。缺哪一样就停在那一步、说清楚，不假装跑过。退出码：0 跑完，1 有红，2 前提还不齐。
set -Eeuo pipefail
umask 022

DEPLOY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
source "$DEPLOY_DIR/lib/common.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

TASK_QUEUE=fleet
WORKFLOW_TYPE=helloWorkflow
NAMESPACE=fleet

tcli() { env -i HOME=/root PATH=/usr/bin:/bin /usr/local/bin/fleet-temporal "$@"; }
pg_admin() { (cd / && runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -tA "$@"); }

# 任务队列上取工作流任务的有几个（引擎工人的身份是「进程号@主机名」；Temporal 自己的系统工人不在这个队列上）
workflow_pollers() {
  printf '%s' "$1" | /usr/bin/node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let r; try { r = JSON.parse(s); } catch { process.exit(1); }
      const ids = (r.pollers || []).filter((p) => p.taskQueueType === "workflow").map((p) => p.identity);
      console.log(ids.join(" "));
    });'
}

main() {
  local json pollers id out row ns i
  if ((EUID != 0)); then
    echo "要 root：sudo bash $0" >&2
    exit 64
  fi

  step "引擎工人在不在接活（任务队列 $TASK_QUEUE）"
  if ! json=$(tcli task-queue describe --task-queue "$TASK_QUEUE" -o json 2>&1); then
    red "查不了任务队列 $TASK_QUEUE（Temporal 在吗？fleet-temporal operator cluster health）：$(tail -1 <<<"$json")"
    finish
  fi
  if ! pollers=$(workflow_pollers "$json"); then
    red "任务队列的回答认不出：$(head -c 200 <<<"$json")"
    finish
  fi
  if [[ -z "$pollers" ]]; then
    pending "没有引擎工人在任务队列 $TASK_QUEUE 上取活：引擎合进主线、发布（bash deploy/release.sh），并在 /etc/fleet-dao/release.env 的 FLEET_SERVICES 里加上 fleet-engine 之后再跑"
    finish
  fi
  ok "在取活的：$pollers"

  step "跑一次 $WORKFLOW_TYPE"
  id=hello-$(date -u +%Y%m%dT%H%M%SZ)
  if ! out=$(timeout 90 env -i HOME=/root PATH=/usr/bin:/bin /usr/local/bin/fleet-temporal workflow execute \
    --type "$WORKFLOW_TYPE" --task-queue "$TASK_QUEUE" --workflow-id "$id" --input '"法国"' --execution-timeout 60s 2>&1); then
    red "$id 没跑完（引擎里注册了 $WORKFLOW_TYPE 吗？）：$(tail -3 <<<"$out" | tr '\n' ' ')"
    tcli workflow terminate --workflow-id "$id" --reason "deploy/hello.sh 没等到结果" >/dev/null 2>&1 || true
    finish
  fi
  ok "$id 跑完了：$(grep -m1 -i 'result' <<<"$out" || tail -1 <<<"$out")"

  step "耗时（本机 Postgres：temporal_visibility.executions_visibility）"
  ns=$(tcli operator namespace describe --namespace "$NAMESPACE" -o json 2>/dev/null |
    /usr/bin/node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { process.stdout.write(JSON.parse(s).namespaceInfo.id); } catch {} });') || ns=""
  if [[ ! "$ns" =~ ^[0-9a-f-]{36}$ ]]; then
    red "读不到命名空间 $NAMESPACE 的编号"
    finish
  fi
  # 可见性记录是结束后异步写的：有界地等一会儿
  for ((i = 0; i < 10; i++)); do
    row=$(pg_admin -d temporal_visibility -F ' | ' -c "select workflow_type_name, status, start_time, close_time, round(execution_duration / 1e6, 1) || ' 毫秒' from executions_visibility where namespace_id = '$ns' and workflow_id = '$id' and close_time is not null") || row=""
    if [[ -n "$row" ]]; then break; fi
    sleep 1
  done
  if [[ -z "$row" ]]; then
    red "10 秒了库里还没有 $id 的结束记录"
    finish
  fi
  ok "类型 | 状态（2 = 完成）| 开始 | 结束 | 耗时：$row"
  echo "  以后再查：fleet-temporal workflow describe --workflow-id $id；或以 postgres 在库 temporal_visibility 里"
  echo "  select workflow_id, start_time, close_time, execution_duration / 1e6 as ms from executions_visibility where workflow_type_name = '$WORKFLOW_TYPE' order by start_time desc;"
  finish
}

main "$@"
