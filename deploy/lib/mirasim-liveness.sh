#!/usr/bin/env bash
# 会话用户的 Mirasim 本地服务（fleet-mirasim-session.service）活着但卡死时自动重启（#1676）。
# 2026-10-10 11:47 它进程在、单元 active、不再处理请求，Restart=on-failure 管不到「活着不干活」，
# 引擎经桥接连它一律超时，直到 12:21 有人手动 systemctl restart。这个脚本由 fleet-mirasim-liveness.timer 每 2 分钟
# 拉起一次（fleet-mirasim-liveness.service，root，参数是会话用户）：读 <家>/.mirasim/run/local-<端口>.token 认端口，
# curl --max-time 70 请求 /api/health（服务单线程，起会话能堵几十秒，10 秒会把忙当成死），回 "ok":true 就清零；
# 连不上、超时、不是 ok:true 记一次失败，连续 3 次才重启单元，重启后清零，并往 journal 写一行带原因的 fleet-mirasim-liveness。
# 健康检查超时（curl 退出 28）并且 <家>/.mirasim/sessions/<执行体>/<id>/record.json 里有 runState 为 running 或 queued
# 的会话：只记一行、不计数、不重启（#2186：忙的时候连续超时把正在跑的会话重启杀掉，引擎认不出原因把单挂起）。
# 连接被拒、回的不是 ok：照旧计数，满 3 次仍重启——那是服务真不干活，不是在忙。
# 不管的情况（退出 0、不重启、计数清零）：单元没装、单元没在 active（停着是有人停的，崩了归 Restart=on-failure，
# 重启中也别叠一刀）。令牌不是恰好一份认不出端口：写一行 journal、退出 0、计数不动（那是 check_mirasim 判红的事）。
# 退出 1：计数文件写不了、systemctl restart 失败——不装没事。
# 用法：mirasim-liveness.sh <会话用户>。下面几个环境变量只给测试换位置，单元里不设。
set -uo pipefail

user=${1:-}
if [[ -z "$user" ]]; then
  echo "mirasim-liveness：没给会话用户（用法：mirasim-liveness.sh <会话用户>）" >&2
  exit 2
fi
UNIT=${MIRASIM_LIVENESS_UNIT:-fleet-mirasim-session.service}
UNIT_FILE=${MIRASIM_LIVENESS_UNIT_FILE:-/etc/systemd/system/$UNIT}
RUN_DIR=${MIRASIM_LIVENESS_RUN_DIR:-/home/$user/.mirasim/run}
# 在跑的会话档案。默认在会话用户家里；测试换成临时目录。
SESSIONS_DIR=${MIRASIM_LIVENESS_SESSIONS_DIR:-/home/$user/.mirasim/sessions}
COUNT_FILE=${MIRASIM_LIVENESS_COUNT_FILE:-/var/lib/fleet-dao/mirasim-liveness.count}
THRESHOLD=3
# 盖住忙：起一个 codex 会话能把服务端单线程堵 40–58 秒，准备会话号实测 23 秒。
HEALTH_MAX_TIME=70
TAG=fleet-mirasim-liveness

note() { logger -t "$TAG" -- "$*"; }

# 有没有在跑的会话。判法和 packages/mirasim-reclaude 数在途回合同一份：runState 为 running 或 queued。
# 目录不在、读不了、状态不认识：当没有，超时仍按失败计，看门狗不因此停摆。
has_live_session() {
  [[ -d "$SESSIONS_DIR" ]] || return 1
  local f
  local -a files=()
  shopt -s nullglob
  files=("$SESSIONS_DIR"/*/*/record.json)
  shopt -u nullglob
  for f in "${files[@]}"; do
    if [[ -f "$f" ]] && grep -Eqz '"runState"[[:space:]]*:[[:space:]]*"(running|queued)"' -- "$f"; then
      return 0
    fi
  done
  return 1
}

clear_count() { rm -f -- "$COUNT_FILE"; }

save_count() { # 次数；写不了返回非 0
  if ! mkdir -p -- "${COUNT_FILE%/*}"; then return 1; fi
  printf '%s\n' "$1" >"$COUNT_FILE"
}

if [[ ! -f "$UNIT_FILE" ]]; then
  clear_count
  exit 0
fi
if ! systemctl is-active --quiet "$UNIT"; then
  clear_count
  exit 0
fi

tokens=("$RUN_DIR"/local-*.token)
if [[ ${#tokens[@]} -ne 1 || ! -e "${tokens[0]}" ]]; then
  note "$UNIT 在跑，但 $RUN_DIR 下的 local-<端口>.token 不是恰好一份，认不出端口，这轮不查"
  exit 0
fi
port=${tokens[0]##*/local-}
port=${port%.token}
if [[ ! "$port" =~ ^[0-9]+$ ]]; then
  note "$UNIT 在跑，但令牌文件名 ${tokens[0]} 里的端口不是数字，这轮不查"
  exit 0
fi

rc=0
body=$(curl -fsS --max-time "$HEALTH_MAX_TIME" "http://127.0.0.1:$port/api/health" 2>&1) || rc=$?
reason=""
if ((rc != 0)); then
  reason="curl 退出 $rc（28＝超时，7＝连接被拒）：$(tail -c 200 <<<"$body")"
elif ! grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$body"; then
  reason="/api/health 回了但不是 ok:true：$(tail -c 200 <<<"$body")"
fi

if [[ -z "$reason" ]]; then
  clear_count
  exit 0
fi

# 超时且有会话在跑：服务是忙，不是死。计数不动，免得会话一结束下一轮就凑满次数重启。
if ((rc == 28)) && has_live_session; then
  note "$UNIT 健康检查超时，但 $SESSIONS_DIR 下有在跑的会话（runState 为 running 或 queued），这轮只记不重启，计数不动（端口 $port）：$reason"
  exit 0
fi

count=0
if [[ -f "$COUNT_FILE" ]]; then
  count=$(<"$COUNT_FILE")
  if [[ ! "$count" =~ ^[0-9]+$ ]]; then count=0; fi
fi
count=$((count + 1))

if ((count < THRESHOLD)); then
  if ! save_count "$count"; then
    echo "mirasim-liveness：写不了计数文件 $COUNT_FILE" >&2
    exit 1
  fi
  note "$UNIT 健康检查失败（连续第 $count 次，满 $THRESHOLD 次才重启，端口 $port）：$reason"
  exit 0
fi

note "$UNIT 连续 $count 次健康检查失败，重启（端口 $port）：$reason"
if ! systemctl restart "$UNIT"; then
  note "$UNIT 重启失败，计数保留，下一轮再试"
  save_count "$count" || true
  echo "mirasim-liveness：systemctl restart $UNIT 失败" >&2
  exit 1
fi
clear_count
exit 0
