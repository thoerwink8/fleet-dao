#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 香港本机探法国驾驶舱 /healthz。fleet-hk-france-probe.timer 每分钟拉起一次，不依赖法国上的看门狗、飞书，也不依赖 Cloudflare。
# 经隧道打 http://10.99.0.2:8787/healthz。200 和 503 算通（后端答了，某一项不好交给健康页和法国自己的看门狗）；
# 连不上、超时、别的状态码算一次失败。连续 3 次失败才算失联，失联和恢复各推一次，中间不再重复推。
# 状态写 /var/lib/fleet-hk-france-probe/status.json（nginx 用 /health/france-link.json 指到它，不放进静态目录：发版 rsync --delete 会删掉）。
# 推送配置在香港本机 /etc/fleet-dao/hk-probe.env（不依赖法国）。两种通道，飞书应用优先：
#   飞书应用：FLEET_HK_PROBE_FEISHU_APP_ID / _APP_SECRET / _CHAT_ID 三项齐了，用驾驶舱同一个飞书应用往同一个团队群发；
#   群机器人：FLEET_HK_PROBE_WEBHOOK（http(s) 地址）。
# 都没配、读不到、配错：只写状态和日志，退出 0。送不出去：日志写原因，留在 push-pending 里下一轮再推（连试 60 次还不成才放弃），
# 不挡探活、不改退出码。凭据、地址不打进日志。
# 下面几个环境变量只给测试换位置，单元里不设：FLEET_PROBE_URL、FLEET_PROBE_STATE、FLEET_PROBE_ENV、FLEET_PROBE_NOW。
# 演练时用 systemd drop-in 临时设 FLEET_PROBE_URL（指到不通的地址）和 FLEET_PROBE_PREFIX（正文开头加「演练：」），步骤见 ops「香港探法国」。
# 用法：france-probe.sh（无参数）。退出码：状态写不进去 1，其余 0。
set -uo pipefail
umask 022
export LANG=${LANG:-C.UTF-8}

PROBE_FAILS=3
PROBE_URL=${FLEET_PROBE_URL:-http://10.99.0.2:8787/healthz}
PROBE_STATE=${FLEET_PROBE_STATE:-/var/lib/fleet-hk-france-probe/status.json}
PROBE_ENV=${FLEET_PROBE_ENV:-/etc/fleet-dao/hk-probe.env}
PROBE_PREFIX=${FLEET_PROBE_PREFIX:-}
# 没推成的那一条：和状态文件同目录（nginx 只指 status.json 这一个文件，它不对外）
PROBE_PENDING=${PROBE_STATE%/*}/push-pending
PROBE_PUSH_TRIES=60
PROBE_FEISHU_API=https://open.feishu.cn/open-apis

ST_FAILS=0
ST_DOWN=0
ST_SINCE=""
ST_SINCE_TEXT=""
ST_LAST_ERROR=""
ST_LAST_AT=""
PUSH_KIND=""
PUSH_TEXT=""
PUSH_ID=""
PUSH_CHANNEL=""
PUSH_ERR=""
OBS_KIND=""
OBS_REASON=""
WEBHOOK=""
CFG_APP_ID=""
CFG_APP_SECRET=""
CFG_CHAT_ID=""
P_KIND=""
P_ID=""
P_TRIES=0
P_TEXT=""

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
  PUSH_ID=""
  ST_LAST_AT=$now
  if [[ "$kind" == up ]]; then
    if ((ST_DOWN)); then
      PUSH_KIND=up
      PUSH_ID="hk-probe-up-${ST_SINCE}"
      PUSH_TEXT="${PROBE_PREFIX}法国恢复了：香港经隧道又打得开 ${PROBE_URL}（失联自 ${ST_SINCE_TEXT}）。"
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
    PUSH_ID="hk-probe-down-${ST_SINCE}"
    PUSH_TEXT="${PROBE_PREFIX}法国失联自 ${ST_SINCE_TEXT}：香港经隧道连续 ${PROBE_FAILS} 次打不开 ${PROBE_URL}（最近一次：${reason}）。看驾驶舱健康页 /health/。"
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

probe_read_push_config() {
  WEBHOOK=""
  CFG_APP_ID=""
  CFG_APP_SECRET=""
  CFG_CHAT_ID=""
  [[ -e "$PROBE_ENV" ]] || return 0
  if [[ ! -r "$PROBE_ENV" ]]; then
    echo "france-probe: 推送配置读不到（$PROBE_ENV），这轮只写状态" >&2
    return 0
  fi
  local line val
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^(FLEET_HK_PROBE_[A-Z_]+)=(.*)$ ]] || continue
    val=$(probe_env_value "${BASH_REMATCH[2]}")
    case "${BASH_REMATCH[1]}" in
    FLEET_HK_PROBE_WEBHOOK) WEBHOOK=$val ;;
    FLEET_HK_PROBE_FEISHU_APP_ID) CFG_APP_ID=$val ;;
    FLEET_HK_PROBE_FEISHU_APP_SECRET) CFG_APP_SECRET=$val ;;
    FLEET_HK_PROBE_FEISHU_CHAT_ID) CFG_CHAT_ID=$val ;;
    *) ;;
    esac
  done <"$PROBE_ENV"
}

# 定通道：飞书应用三项齐了走应用；应用一项都没配才看群机器人地址。返回 0 有通道（PUSH_CHANNEL=app|webhook），1 没配或配错（已写日志）。
probe_pick_channel() {
  PUSH_CHANNEL=""
  probe_read_push_config
  local missing=() have=0
  if [[ -n "$CFG_APP_ID" ]]; then have=1; else missing+=(FLEET_HK_PROBE_FEISHU_APP_ID); fi
  if [[ -n "$CFG_APP_SECRET" ]]; then have=1; else missing+=(FLEET_HK_PROBE_FEISHU_APP_SECRET); fi
  if [[ -n "$CFG_CHAT_ID" ]]; then have=1; else missing+=(FLEET_HK_PROBE_FEISHU_CHAT_ID); fi
  if ((${#missing[@]} == 0)); then
    PUSH_CHANNEL=app
    return 0
  fi
  if ((have)); then
    echo "france-probe: 飞书应用配了一半（${PROBE_ENV} 缺 ${missing[*]}），这条没推" >&2
    return 1
  fi
  if [[ -z "$WEBHOOK" ]]; then
    echo "france-probe: 没配推送（${PROBE_ENV} 的飞书应用三项和 FLEET_HK_PROBE_WEBHOOK 都空着），只写了状态"
    return 1
  fi
  if [[ ! "$WEBHOOK" =~ ^https?:// ]]; then
    echo "france-probe: 推送地址不是 http(s)，只写了状态" >&2
    return 1
  fi
  PUSH_CHANNEL=webhook
}

# 飞书回的 code（没有就空）。$1 = 回应正文。
probe_feishu_code() { jq -r 'if type == "object" then (.code // .StatusCode // "") else "" end' <<<"$1" 2>/dev/null; }
probe_feishu_msg() { jq -r 'if type == "object" then (.msg // .StatusMessage // "" | tostring | .[0:200]) else "" end' <<<"$1" 2>/dev/null; }

# 飞书应用：换 tenant_access_token，再按 chat_id 发一条文本。uuid 让飞书把重试的同一条去重（一小时内）。
# 密钥走标准输入、令牌走临时文件，不出现在命令行参数里。没成返回 1，原因在 PUSH_ERR。
probe_send_app() {
  local text=$1 uuid=$2 dir resp code token rc=0
  dir=$(mktemp -d) || {
    PUSH_ERR="临时目录建不了"
    return 1
  }
  resp=$(jq -n --arg id "$CFG_APP_ID" --arg s "$CFG_APP_SECRET" '{app_id: $id, app_secret: $s}' |
    curl -sS --max-time 6 --connect-timeout 4 -H 'Content-Type: application/json; charset=utf-8' \
      --data-binary @- "$PROBE_FEISHU_API/auth/v3/tenant_access_token/internal" 2>/dev/null) || rc=$?
  if ((rc != 0)); then
    rm -rf -- "$dir"
    PUSH_ERR="换令牌连不上飞书（curl $rc）"
    return 1
  fi
  code=$(probe_feishu_code "$resp")
  token=$(jq -r '.tenant_access_token // empty' <<<"$resp" 2>/dev/null)
  if [[ "$code" != 0 || -z "$token" ]]; then
    rm -rf -- "$dir"
    PUSH_ERR="飞书不给令牌（code=${code:-无} $(probe_feishu_msg "$resp")）"
    return 1
  fi
  printf 'Authorization: Bearer %s\n' "$token" >"$dir/auth"
  resp=$(jq -n --arg chat "$CFG_CHAT_ID" --arg text "$text" --arg uuid "$uuid" \
    '{receive_id: $chat, msg_type: "text", content: ({text: $text} | tojson), uuid: $uuid}' |
    curl -sS --max-time 6 --connect-timeout 4 -H 'Content-Type: application/json; charset=utf-8' -H @"$dir/auth" \
      --data-binary @- "$PROBE_FEISHU_API/im/v1/messages?receive_id_type=chat_id" 2>/dev/null) || rc=$?
  rm -rf -- "$dir"
  if ((rc != 0)); then
    PUSH_ERR="发消息连不上飞书（curl $rc）"
    return 1
  fi
  code=$(probe_feishu_code "$resp")
  if [[ "$code" != 0 ]]; then
    PUSH_ERR="飞书没收下（code=${code:-无} $(probe_feishu_msg "$resp")）"
    return 1
  fi
}

# 群机器人：HTTP 2xx 且回应里的 code（有的话）是 0 才算送到。地址不打进日志（curl 的报错也不转出来）。
probe_send_webhook() {
  local text=$1 resp code rc=0
  resp=$(jq -n --arg text "$text" '{msg_type: "text", content: {text: $text}}' |
    curl -sS --max-time 8 --connect-timeout 4 -w '\n%{http_code}' -H 'Content-Type: application/json' \
      --data-binary @- "$WEBHOOK" 2>/dev/null) || rc=$?
  if ((rc != 0)); then
    PUSH_ERR="连不上群机器人地址（curl $rc）"
    return 1
  fi
  code=${resp##*$'\n'}
  resp=${resp%$'\n'*}
  if [[ ! "$code" =~ ^2 ]]; then
    PUSH_ERR="群机器人回 HTTP ${code:-无}"
    return 1
  fi
  code=$(probe_feishu_code "$resp")
  if [[ -n "$code" && "$code" != 0 ]]; then
    PUSH_ERR="群机器人没收下（code=$code $(probe_feishu_msg "$resp")）"
    return 1
  fi
}

# 推一条。返回 0 送到，1 没送成（原因已写日志，调用方留着下一轮再推），2 没配或配错（不重试）。
probe_push() {
  local kind=$1 uuid=$2 text=$3 rc=0
  probe_pick_channel || return 2
  PUSH_ERR=""
  if declare -F probe_post_hook >/dev/null; then
    probe_post_hook "$PUSH_CHANNEL" "$text" "$uuid" || rc=$?
    [[ -n "$PUSH_ERR" ]] || PUSH_ERR="钩子回 $rc"
  elif [[ "$PUSH_CHANNEL" == app ]]; then
    probe_send_app "$text" "$uuid" || rc=$?
  else
    probe_send_webhook "$text" || rc=$?
  fi
  if ((rc != 0)); then
    echo "france-probe: 推送没送成（${kind}，${PUSH_CHANNEL}）：${PUSH_ERR}" >&2
    return 1
  fi
  echo "france-probe: 已推送（${kind}，${PUSH_CHANNEL}）"
  return 0
}

# 没推成的那一条：kind、uuid、已试次数、正文各一行。
probe_write_pending() {
  local tmp
  tmp=$(mktemp "${PROBE_PENDING%/*}/.push-pending.XXXXXX") || {
    echo "france-probe: 待推文件写不了（$PROBE_PENDING），下一轮不会重试这条" >&2
    return 1
  }
  if ! printf '%s\n%s\n%s\n%s\n' "$1" "$2" "$3" "$4" >"$tmp" || ! mv -f -- "$tmp" "$PROBE_PENDING"; then
    rm -f -- "$tmp"
    echo "france-probe: 待推文件写不了（$PROBE_PENDING），下一轮不会重试这条" >&2
    return 1
  fi
}

# 有待推的、认得出：返回 0，填 P_*。没有返回 1；认不出删掉、返回 1。
probe_read_pending() {
  [[ -e "$PROBE_PENDING" ]] || return 1
  local lines=()
  mapfile -t lines <"$PROBE_PENDING" 2>/dev/null || lines=()
  if ((${#lines[@]} < 4)) || [[ ! "${lines[0]}" =~ ^(up|down)$ || ! "${lines[2]}" =~ ^[0-9]+$ ]]; then
    echo "france-probe: 待推文件认不出，丢掉（$PROBE_PENDING）" >&2
    rm -f -- "$PROBE_PENDING"
    return 1
  fi
  P_KIND=${lines[0]}
  P_ID=${lines[1]}
  P_TRIES=${lines[2]}
  P_TEXT=${lines[3]}
}

# 推一条，没送成就记进待推、下一轮再来；连试 PROBE_PUSH_TRIES 次还不成就放弃（凭据错了别每分钟一直打飞书）。
probe_deliver() { # kind uuid 已试次数 正文
  local kind=$1 uuid=$2 tries=$3 text=$4 rc=0
  probe_push "$kind" "$uuid" "$text" || rc=$?
  if ((rc != 1)); then
    rm -f -- "$PROBE_PENDING"
    return 0
  fi
  tries=$((tries + 1))
  if ((tries >= PROBE_PUSH_TRIES)); then
    echo "france-probe: 这条（${kind}）连试 ${tries} 次都没推成，放弃：查 ${PROBE_ENV} 的推送配置和香港到飞书的网" >&2
    rm -f -- "$PROBE_PENDING"
    return 0
  fi
  probe_write_pending "$kind" "$uuid" "$tries" "$text" &&
    echo "france-probe: 下一轮再推（已试 ${tries} 次）" >&2
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
    # 新的一条顶掉还没推成的旧的（失联没推成又恢复了：只推「恢复了」，正文里写着失联自何时）
    echo "france-probe: ${PUSH_TEXT}"
    probe_deliver "$PUSH_KIND" "$PUSH_ID" 0 "$PUSH_TEXT"
    return 0
  fi
  if ((ST_DOWN)); then
    echo "france-probe: 仍失联（自 ${ST_SINCE_TEXT}，这轮 ${OBS_REASON:-通}），不再推"
  elif [[ "$OBS_KIND" == down ]]; then
    echo "france-probe: 失败 ${ST_FAILS}/${PROBE_FAILS}（${OBS_REASON}），还没到失联"
  else
    echo "france-probe: 通（${PROBE_URL}）"
  fi
  if probe_read_pending; then
    echo "france-probe: 上一条（${P_KIND}）还没推成，这轮再推（第 $((P_TRIES + 1)) 次）"
    probe_deliver "$P_KIND" "$P_ID" "$P_TRIES" "$P_TEXT"
  fi
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  run_once
fi
