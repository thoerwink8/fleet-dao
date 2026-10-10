#!/usr/bin/env bash
# 会话用户的 Mirasim 本地服务（fleet-mirasim-session.service）活着但卡死时自动重启（#1676）。
# 2026-10-10 11:47 它进程在、单元 active、不再处理请求，Restart=on-failure 管不到「活着不干活」，
# 引擎经桥接连它一律超时，直到 12:21 有人手动 systemctl restart。这个脚本由 fleet-mirasim-liveness.timer 每 2 分钟
# 拉起一次（fleet-mirasim-liveness.service，root，参数是会话用户）：读 <家>/.mirasim/run/local-<端口>.token 认端口，
# curl --max-time 10 请求 /api/health，回 "ok":true 就清零；连不上、超时、不是 ok:true 记一次失败，连续 3 次才重启单元，
# 重启后清零，并往 journal 写一行带原因的 fleet-mirasim-liveness。
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
COUNT_FILE=${MIRASIM_LIVENESS_COUNT_FILE:-/var/lib/fleet-dao/mirasim-liveness.count}
THRESHOLD=3
TAG=fleet-mirasim-liveness

note() { logger -t "$TAG" -- "$*"; }

clear_count() { rm -f -- "$COUNT_FILE"; }

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
body=$(curl -fsS --max-time 10 "http://127.0.0.1:$port/api/health" 2>&1) || rc=$?
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

count=0
if [[ -f "$COUNT_FILE" ]]; then
  count=$(<"$COUNT_FILE")
  if [[ ! "$count" =~ ^[0-9]+$ ]]; then count=0; fi
fi
count=$((count + 1))

if ((count < THRESHOLD)); then
  mkdir -p -- "${COUNT_FILE%/*}" && printf '%s\n' "$count" >"$COUNT_FILE" || {
    echo "mirasim-liveness：写不了计数文件 $COUNT_FILE" >&2
    exit 1
  }
  note "$UNIT 健康检查失败（连续第 $count 次，满 $THRESHOLD 次才重启，端口 $port）：$reason"
  exit 0
fi

note "$UNIT 连续 $count 次健康检查失败，重启（端口 $port）：$reason"
if ! systemctl restart "$UNIT"; then
  note "$UNIT 重启失败，计数保留，下一轮再试"
  mkdir -p -- "${COUNT_FILE%/*}" && printf '%s\n' "$count" >"$COUNT_FILE" || true
  echo "mirasim-liveness：systemctl restart $UNIT 失败" >&2
  exit 1
fi
clear_count
exit 0
