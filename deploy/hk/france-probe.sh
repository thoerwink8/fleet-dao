#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 香港本机探法国驾驶舱 /healthz。fleet-hk-france-probe.timer 每分钟拉起一次，不依赖法国上的看门狗、飞书，也不依赖 Cloudflare。
# 经隧道打 http://10.99.0.2:8787/healthz。200 和 503 算通（后端答了，某一项不好交给健康页和法国自己的看门狗）；
# 连不上、超时、别的状态码算一次失败。连续 3 次失败才算失联，失联和恢复各推一次，中间不再重复推。
# 状态写 /var/lib/fleet-hk-france-probe/status.json（nginx 用 /health/france-link.json 指到它，不放进静态目录：发版 rsync --delete 会删掉）。
# 推送地址在 /etc/fleet-dao/hk-probe.env 的 FLEET_HK_PROBE_WEBHOOK。没配、读不到、地址不是 http(s)：只写状态和日志，退出 0。
# 下面几个环境变量只给测试换位置，单元里不设：FLEET_PROBE_URL、FLEET_PROBE_STATE、FLEET_PROBE_ENV、FLEET_PROBE_NOW。
# 用法：france-probe.sh（无参数）。退出码：状态写不进去 1，其余 0。
set -uo pipefail
umask 022
export LANG=${LANG:-C.UTF-8}

PROBE_FAILS=3
PROBE_URL=${FLEET_PROBE_URL:-http://10.99.0.2:8787/healthz}
PROBE_STATE=${FLEET_PROBE_STATE:-/var/lib/fleet-hk-france-probe/status.json}
PROBE_ENV=${FLEET_PROBE_ENV:-/etc/fleet-dao/hk-probe.env}

ST_FAILS=0
ST_DOWN=0
ST_SINCE=""
ST_SINCE_TEXT=""
ST_LAST_ERROR=""
ST_LAST_AT=""
PUSH_KIND=""
PUSH_TEXT=""
OBS_KIND=""
OBS_REASON=""
WEBHOOK=""

probe_now() {
  if [[ -n "${FLEET_PROBE_NOW:-}" ]]; then
    printf '%s' "$FLEET_PROBE_NOW"
  else
    date +%s
  fi
}

probe_hhmm() { TZ=Asia/Shanghai date -d "@$1" +%H:%M; }

probe_iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

probe_json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

probe_reset_state() {
  ST_FAILS=0
  ST_DOWN=0
  ST_SINCE=""
  ST_SINCE_TEXT=""
  ST_LAST_ERROR=""
  ST_LAST_AT=""
}

# 认得出返回 0。文件没有：当成还没探过，返回 0。读不到：返回 2（调用方这轮不覆盖）。认不出：清成从头计，返回 0。
probe_load_state() {
  probe_reset_state
  [[ -e "$PROBE_STATE" ]] || return 0
  if [[ ! -r "$PROBE_STATE" ]]; then
    echo "france-probe: 状态文件读不到（$PROBE_STATE），这轮不覆盖" >&2
    return 2
  fi
  local s=""
  s=$(<"$PROBE_STATE") || {
    echo "france-probe: 状态文件读不到（$PROBE_STATE），这轮不覆盖" >&2
    return 2
  }
  s=${s//$'\n'/}
  local re='^\{"schema":1,"down":(true|false),"downSince":"([0-9]*)","downSinceText":"([0-9:]*)","consecutiveFailures":([0-9]+),"lastCheckAt":"[^"]*","lastError":"([^"]*)"\}$'
  if [[ ! "$s" =~ $re ]]; then
    echo "france-probe: 状态文件认不出，这轮从头计（$PROBE_STATE）" >&2
    probe_reset_state
    return 0
  fi
  if [[ "${BASH_REMATCH[1]}" == true ]]; then ST_DOWN=1; else ST_DOWN=0; fi
  ST_SINCE=${BASH_REMATCH[2]}
  ST_SINCE_TEXT=${BASH_REMATCH[3]}
  ST_FAILS=${BASH_REMATCH[4]}
  ST_LAST_ERROR=${BASH_REMATCH[5]}
  ST_LAST_ERROR=${ST_LAST_ERROR//\\n/$'\n'}
  ST_LAST_ERROR=${ST_LAST_ERROR//\\\"/\"}
  ST_LAST_ERROR=${ST_LAST_ERROR//\\\\/\\}
}

probe_state_json() {
  local down=false err at
  if ((ST_DOWN)); then down=true; fi
  err=$(probe_json_escape "$ST_LAST_ERROR")
  at=$(probe_iso "$ST_LAST_AT")
  printf '{"schema":1,"down":%s,"downSince":"%s","downSinceText":"%s","consecutiveFailures":%s,"lastCheckAt":"%s","lastError":"%s"}' \
    "$down" "$ST_SINCE" "$ST_SINCE_TEXT" "$ST_FAILS" "$at" "$err"
}

# 写不进去返回 1。目录没有就建（手动跑、测试）；systemd 的 ReadWritePaths 要求目录先在，装机脚本会建。
probe_write_state() {
  local dir tmp json
  dir=${PROBE_STATE%/*}
  if ! mkdir -p -- "$dir"; then
    echo "france-probe: 状态目录建不了（$dir）" >&2
    return 1
  fi
  json=$(probe_state_json)
  tmp=$(mktemp "$dir/.status.XXXXXX") || {
    echo "france-probe: 状态文件写不了（$PROBE_STATE）" >&2
    return 1
  }
  if ! printf '%s\n' "$json" >"$tmp"; then
    rm -f -- "$tmp"
    echo "france-probe: 状态文件写不了（$PROBE_STATE）" >&2
    return 1
  fi
  chmod 644 -- "$tmp"
  if ! mv -f -- "$tmp" "$PROBE_STATE"; then
    rm -f -- "$tmp"
    echo "france-probe: 状态文件换不上（$PROBE_STATE）" >&2
    return 1
  fi
}

# $1 = up|down，$2 = 失败原因，$3 = 此刻的 epoch。失联时刻用这一串失败的第一次，不是第三次。
probe_apply() {
  local kind=$1 reason=$2 now=$3
  PUSH_KIND=""
  PUSH_TEXT=""
  ST_LAST_AT=$now
  if [[ "$kind" == up ]]; then
    if ((ST_DOWN)); then
      PUSH_KIND=up
      PUSH_TEXT="法国恢复了：香港经隧道又打得开 ${PROBE_URL}（失联自 ${ST_SINCE_TEXT}）。"
    fi
    ST_FAILS=0
    ST_DOWN=0
    ST_SINCE=""
    ST_SINCE_TEXT=""
    ST_LAST_ERROR=""
    return 0
  fi
  ST_LAST_ERROR=$reason
  if ((ST_FAILS == 0)); then
    ST_SINCE=$now
    ST_SINCE_TEXT=$(probe_hhmm "$now")
  fi
  ST_FAILS=$((ST_FAILS + 1))
  if ((ST_FAILS >= PROBE_FAILS && ST_DOWN == 0)); then
    ST_DOWN=1
    PUSH_KIND=down
    PUSH_TEXT="法国失联自 ${ST_SINCE_TEXT}：香港经隧道连续 ${PROBE_FAILS} 次打不开 ${PROBE_URL}（最近一次：${reason}）。看驾驶舱健康页 /health/。"
  fi
}

probe_observe() {
  if declare -F probe_observe_hook >/dev/null; then
    probe_observe_hook
    return 0
  fi
  local code="" rc=0 err
  err=$(mktemp)
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 --connect-timeout 5 "$PROBE_URL" 2>"$err") || rc=$?
  rm -f -- "$err"
  if [[ "$code" == 200 || "$code" == 503 ]]; then
    OBS_KIND=up
    OBS_REASON=""
    return 0
  fi
  OBS_KIND=down
  if [[ "$rc" == 28 ]]; then
    OBS_REASON=超时
  elif [[ "$code" =~ ^[1-9][0-9]{2}$ ]]; then
    OBS_REASON="HTTP $code"
  else
    OBS_REASON=连不上
  fi
}

# 等号后面的值：去首尾空白，再剥掉一对双引号。和 hk.sh 的 probe_env_value 同一套读法。
probe_env_value() {
  local val=$1
  val=${val#"${val%%[![:space:]]*}"}
  val=${val%"${val##*[![:space:]]}"}
  if [[ "$val" =~ ^\"(.*)\"$ ]]; then val=${BASH_REMATCH[1]}; fi
  val=${val#"${val%%[![:space:]]*}"}
  val=${val%"${val##*[![:space:]]}"}
  printf '%s' "$val"
}

probe_read_webhook() {
  WEBHOOK=""
  [[ -e "$PROBE_ENV" ]] || return 0
  if [[ ! -r "$PROBE_ENV" ]]; then
    echo "france-probe: 推送配置读不到（$PROBE_ENV），这轮只写状态" >&2
    return 0
  fi
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^FLEET_HK_PROBE_WEBHOOK=(.*)$ ]] || continue
    WEBHOOK=$(probe_env_value "${BASH_REMATCH[1]}")
  done <"$PROBE_ENV"
}

# 没配、地址不像、送不出去：都返回 0。状态文件已经写上，推送失败不让这一轮变成「探活脚本坏了」。
probe_push() {
  local text=$1 code="" rc=0 payload
  probe_read_webhook
  if [[ -z "$WEBHOOK" ]]; then
    echo "france-probe: 没配推送（${PROBE_ENV} 的 FLEET_HK_PROBE_WEBHOOK 空着），只写了状态"
    return 0
  fi
  if [[ ! "$WEBHOOK" =~ ^https?:// ]]; then
    echo "france-probe: 推送地址不是 http(s)，只写了状态" >&2
    return 0
  fi
  if declare -F probe_post_hook >/dev/null; then
    probe_post_hook "$WEBHOOK" "$text"
    echo "france-probe: 已推送（$PUSH_KIND）"
    return 0
  fi
  payload=$(printf '{"msg_type":"text","content":{"text":"%s"}}' "$(probe_json_escape "$text")")
  code=$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data "$payload" "$WEBHOOK") || rc=$?
  if ((rc != 0)) || [[ ! "$code" =~ ^2 ]]; then
    echo "france-probe: 推送没送成（HTTP ${code:-无}，curl $rc），状态已经写上" >&2
  else
    echo "france-probe: 已推送（$PUSH_KIND）"
  fi
  return 0
}

run_once() {
  local now load_rc=0
  now=$(probe_now)
  probe_load_state || load_rc=$?
  if ((load_rc == 2)); then return 0; fi
  probe_observe
  probe_apply "$OBS_KIND" "$OBS_REASON" "$now"
  probe_write_state || return 1
  if [[ -n "$PUSH_KIND" ]]; then
    echo "france-probe: ${PUSH_TEXT}"
    probe_push "$PUSH_TEXT"
  elif ((ST_DOWN)); then
    echo "france-probe: 仍失联（自 ${ST_SINCE_TEXT}，这轮 ${OBS_REASON:-通}），不再推"
  elif [[ "$OBS_KIND" == down ]]; then
    echo "france-probe: 失败 ${ST_FAILS}/${PROBE_FAILS}（${OBS_REASON}），还没到失联"
  else
    echo "france-probe: 通（${PROBE_URL}）"
  fi
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  run_once
fi
