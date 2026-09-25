#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034,SC2317 # ROOT 这些是给 source 进来的脚本读的；systemctl、journalctl 桩是被脚本里的函数调用的
# 香港的 fleet-gateway-deploy（deploy/hk/fleet-gateway-deploy.sh）：收下的文件核对 sha256、不留半截；配置不齐不起；
# 切版本后按「主进程在哪个目录」「环境文件改没改过」决定起、重启还是不动；只留最近几版；状态里如实报
# 「长连接现在连着没有、处理过几条消息、后端连不连得上、配置缺什么」；命令只认那几种。
# systemctl、journalctl 换成桩（服务的状态由各段自己摆好），主进程用真起的 sleep 进程代替（验 /proc/<pid>/cwd 那段真代码），
# 目录落在临时目录。要 root（收下时 install -o root）；不是 root 就整份记「没跑成」、退出 2。
# 用法：sudo bash deploy/test/gateway-deploy.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if ((EUID != 0)) || [[ ! -d /proc/self ]]; then
  echo "gateway-deploy：没跑成：要 root 和 /proc（sudo bash deploy/test/gateway-deploy.test.sh）"
  exit 2
fi
TMP=$(mktemp -d)
PIDS=()
trap 'if ((${#PIDS[@]})); then kill "${PIDS[@]}" 2>/dev/null; fi; rm -rf -- "$TMP"' EXIT
# shellcheck source=../hk/fleet-gateway-deploy.sh
source "$HERE/../hk/fleet-gateway-deploy.sh"
set +e # 脚本开了 -e；这里自己判每一步
ROOT=$TMP/gateway
FEISHU_ENV=$TMP/feishu.env
TOKEN_ENV=$TMP/gateway-token.env
KEEP=3

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

# ── 桩：服务的状态由各段摆好；脚本调了 systemctl 什么，一行一条记进 $TMP/calls（脚本多在子进程里跑，变量带不回来）──
# 只认香港 systemd 249 也认的写法：--timestamp=unix 那边会报 Invalid value（2026-09-25 真机撞到），这里照样报错
ACTIVE=inactive
ENABLED=disabled
PID=0
INVOCATION=0123456789abcdef0123456789abcdef # systemd 报的「这次启动」的编号
JOURNAL=""                                 # 日志里有的那些行……
JOURNAL_INV=$INVOCATION                    # ……属于哪次启动
systemctl() {
  printf '%s\n' "$*" >>"$TMP/calls"
  if [[ " $* " == *" --timestamp"* ]]; then
    echo "Invalid value: unix." >&2
    return 1
  fi
  case "$1" in
  is-active) echo "$ACTIVE" ;;
  is-enabled) echo "$ENABLED" ;;
  show)
    case "$*" in
    "show -p MainPID --value "*) echo "$PID" ;;
    "show -p NRestarts --value "*) echo 0 ;;
    "show -p InvocationID --value "*) echo "$INVOCATION" ;;
    *)
      echo "桩不认识：systemctl $*" >&2
      return 1
      ;;
    esac
    ;;
  esac
  return 0
}
# 只按启动编号给日志：按别的条件取（整个单元、按时间）拿不到东西，免得取错了范围照样「连上了」
journalctl() {
  if [[ " $* " == *" _SYSTEMD_INVOCATION_ID=$JOURNAL_INV "* ]]; then printf '%s\n' "$JOURNAL"; fi
}
calls() { grep -cE "^($1) " "$TMP/calls"; }
# 起一个当前目录在 $1 的进程当「主进程」，PID 记进 PID
main_process_in() { # 目录
  (cd -- "$1" && exec sleep 300) &
  PID=$!
  PIDS+=("$PID")
  local i
  for ((i = 0; i < 50; i++)); do
    if [[ "$(readlink "/proc/$PID/cwd" 2>/dev/null)" == "$1" ]]; then return 0; fi
    sleep 0.1
  done
  echo "  ✗ 起不了当主进程用的 sleep"
  fail=1
}
activate() { # 提交号：在子进程里切，输出落 $TMP/out，返回脚本的退出码
  : >"$TMP/calls"
  (cmd_activate "$1") >"$TMP/out" 2>&1
}

A=$(printf 'a%.0s' {1..40})
B=$(printf 'b%.0s' {1..40})
C=$(printf 'c%.0s' {1..40})
D=$(printf 'd%.0s' {1..40})
for s in "$A" "$B" "$C" "$D"; do printf 'console.log("%s")\n' "${s:0:1}" >"$TMP/${s:0:1}.mjs"; done
sum_of() { sha256sum <"$1" | cut -c1-64; }
receive() { # 提交号 文件 [sha256]
  local sum=${3:-}
  if [[ -z "$sum" ]]; then sum=$(sum_of "$2"); fi
  (cmd_receive "$1" "$sum") <"$2" >"$TMP/out" 2>&1
}

echo "== 收下：sha256 对上才落地；对不上、空的、太大的都不收、不留半截；同一版再收一遍不动，换了内容不收"
receive "$A" "$TMP/a.mjs" "$(sum_of "$TMP/b.mjs")"
check "sha256 对不上：拒收" "$?" 1
check "说了为什么" "$(grep -c 'sha256 对不上' "$TMP/out")" 1
check "拒收后什么都没留下" "$(find "$ROOT" -mindepth 1 | wc -l)" 0
receive "$A" /dev/null
check "空的：拒收" "$?" 1
MAX_BYTES=16
receive "$A" "$TMP/a.mjs"
check "超过上限：拒收" "$?" 1
check "说了为什么" "$(grep -c '超过' "$TMP/out")" 1
MAX_BYTES=$((64 * 1024 * 1024))
check "拒收后什么都没留下" "$(find "$ROOT" -mindepth 1 | wc -l)" 0
receive "$A" "$TMP/a.mjs"
check "对上了：收下" "$?" 0
check "收下的内容" "$(sum_of "$ROOT/$A/gateway.mjs")" "$(sum_of "$TMP/a.mjs")"
check "属主权限" "$(stat -c '%U:%G %a' "$ROOT/$A/gateway.mjs")" "root:root 644"
(cmd_has "$A")
check "has：收下了的，0" "$?" 0
(cmd_has "$B")
check "has：没收的，1" "$?" 1
receive "$A" "$TMP/a.mjs"
check "同一版再收一遍：不动" "$(<"$TMP/out")" "ok 已收下过 aaaaaaaaaaaa"
receive "$A" "$TMP/b.mjs"
check "同一个提交号换了内容：拒收" "$?" 1
check "原来那份还在" "$(sum_of "$ROOT/$A/gateway.mjs")" "$(sum_of "$TMP/a.mjs")"
(cmd_receive "$A" not-a-sum) </dev/null >/dev/null 2>&1
check "sha256 不像 sha256：拒收" "$?" 1

echo "== 切过去：配置不齐不起；齐了切 current、启用并起服务"
printf 'FEISHU_APP_ID=cli_x\nFEISHU_APP_SECRET=s\n' >"$FEISHU_ENV"
activate "$A"
check "配置不齐：不起" "$?" 1
check "说出缺哪几项" \
  "$(grep -c '缺 FEISHU_FOUNDERS FEISHU_TEAM_CHAT_ID FLEET_BACKEND_URL FLEET_PUBLIC_URL FLEET_FEISHU_GATEWAY_TOKEN' "$TMP/out")" 1
check "没切 current" "$(current_sha)" ""
check "没碰服务" "$(calls 'enable|start|restart')" 0
activate "$B"
check "没收下的版本：不切" "$?" 1
cat >>"$FEISHU_ENV" <<'EOF'
FEISHU_FOUNDERS=ou_x:甲
FEISHU_TEAM_CHAT_ID=oc_x
FLEET_BACKEND_URL=http://127.0.0.1:9
FLEET_PUBLIC_URL="https://example.invalid"
EOF
printf 'FLEET_FEISHU_GATEWAY_TOKEN=%s\n' "$(printf 'f%.0s' {1..64})" >"$TOKEN_ENV"
check "配置齐了：没有缺的" "$(missing_keys)" ""
activate "$A"
check "切过去：成" "$?" 0
check "current 指到 A" "$(current_sha)" "$A"
check "启用了" "$(calls enable)" 1
check "起了（没在跑就 start）" "$(calls start)" 1
check "历史记了一笔" "$(awk '{ print substr($2, 1, 1), $3 }' "$ROOT/.history")" "a activate"

echo "== 已在跑：主进程在这一版的目录里就不动；在别的版就重启；环境文件在它起来之后改过也重启"
ACTIVE=active
ENABLED=enabled
# 环境文件的修改时间摆到主进程起来之前；主进程是真进程，起来的时刻由脚本自己从 /proc 读
touch -d '-100 seconds' -- "$FEISHU_ENV" "$TOKEN_ENV"
main_process_in "$ROOT/$A"
check "读得出主进程起来的时刻（和现在差不到 5 秒）" "$(($(date +%s) - $(proc_start "$PID") < 5))" 1
activate "$A"
check "主进程就在 A：不起、不重启" "$(calls 'start|restart')" 0
check "没有改动" "$(grep -c '^changed' "$TMP/out")" 0
check "历史没多记" "$(wc -l <"$ROOT/.history")" 1
touch -d '+100 seconds' -- "$FEISHU_ENV"
activate "$A"
check "环境文件在主进程起来之后改过：重启" "$(calls restart)" 1
check "说了为什么" "$(grep -c '环境文件改过' "$TMP/out")" 1
touch -d '-100 seconds' -- "$FEISHU_ENV"
(proc_start 999999999) >/dev/null 2>&1
check "进程不在：读不出起来的时刻（返回失败，不给 0）" "$?" 1
receive "$B" "$TMP/b.mjs"
activate "$B"
check "切到 B、主进程还在 A：重启" "$(calls restart)" 1
check "current 指到 B" "$(current_sha)" "$B"
ACTIVE=failed
activate "$B"
check "服务没在跑（failed）：start" "$(calls start)" 1

echo "== 只留最近 $KEEP 版：在用的一定留，其余按最近切过的补"
ACTIVE=active
main_process_in "$ROOT/$B"
receive "$C" "$TMP/c.mjs"
activate "$C"
main_process_in "$ROOT/$C"
receive "$D" "$TMP/d.mjs"
activate "$D"
left=$(find "$ROOT" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | cut -c1 | sort | tr -d '\n')
check "留下 B、C、D（A 最早切过，清掉）" "$left" "bcd"
check "说了清掉哪版" "$(grep -c '清掉香港网关的旧版 aaaaaaaaaaaa' "$TMP/out")" 1
check "current 是 D" "$(current_sha)" "$D"
mkdir "$ROOT/.incoming.leftover"
activate "$D"
check "收了一半的临时目录也清掉" "$([[ -e "$ROOT/.incoming.leftover" ]] && echo 在 || echo 没了)" 没了

echo "== 状态：长连接看这次启动（InvocationID）的日志里最后一条；后端连不上照实报；配置缺的列出来"
main_process_in "$ROOT/$D"
JOURNAL='{"level":"warn","message":"盘面快照没取到，先用缓存"}'
st=$(cmd_status)
check "主进程跑的是 D" "$(grep '^running=' <<<"$st")" "running=$D"
check "还没打出「已连上」：no" "$(grep '^connected=' <<<"$st")" "connected=no"
JOURNAL='{"level":"info","message":"飞书网关已连上","bot":"x"}
{"level":"info","message":"消息处理完","path":"understand"}
{"level":"info","message":"消息处理完","path":"menu"}'
st=$(cmd_status)
check "打出「已连上」：yes" "$(grep '^connected=' <<<"$st")" "connected=yes"
check "处理过 2 条消息" "$(grep '^messages=' <<<"$st")" "messages=2"
JOURNAL+='
{"level":"warn","message":"飞书长连接断了，正在重连"}'
check "最后一条是「断了」：reconnecting" "$(cmd_status | grep '^connected=')" "connected=reconnecting"
JOURNAL+='
{"level":"info","message":"飞书长连接重连上了"}'
check "又重连上了：yes" "$(cmd_status | grep '^connected=')" "connected=yes"
check "后端（本机 9 号端口没人听）：refused" "$(grep '^backend=' <<<"$st")" "backend=refused"
check "配置齐了：ok" "$(grep '^config=' <<<"$st")" "config=ok"
check "current、enabled、active 都报了" "$(grep -cE '^(current|enabled|active|pid|restarts)=' <<<"$st")" 5
INVOCATION=fedcba9876543210fedcba9876543210
check "重启过（换了启动编号）：上一次的「已连上」不算" "$(cmd_status | grep '^connected=')" "connected=no"
INVOCATION=not-an-id
check "启动编号读不出：不去翻日志，connected=no" "$(cmd_status | grep '^connected=')" "connected=no"
INVOCATION=0123456789abcdef0123456789abcdef
PID=0
check "主进程没了：running 空、connected=no（不拿旧日志冒充）" "$(cmd_status | grep -E '^(running|connected)=' | tr '\n' ' ')" \
  "running= connected=no "
printf 'FLEET_BACKEND_URL=\n' >>"$FEISHU_ENV"
st=$(cmd_status)
check "后端地址空了：unknown，不冒充连得上" "$(grep '^backend=' <<<"$st")" "backend=unknown"
check "后端地址空了：config 列出缺的" "$(grep '^config=' <<<"$st")" "config=missing FLEET_BACKEND_URL"
rm -f -- "$FEISHU_ENV" "$TOKEN_ENV"
check "环境文件都没了：缺的全列出来" "$(cmd_status | grep '^config=')" \
  "config=missing FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_FOUNDERS FEISHU_TEAM_CHAT_ID FLEET_BACKEND_URL FLEET_PUBLIC_URL FLEET_FEISHU_GATEWAY_TOKEN"

echo "== 命令只认那几种：多了、少了、提交号不对、夹带别的，一律拒（64）"
for bad in "status; rm -rf /" "status extra" "has ../../etc" "has $D extra" "has ${D:0:12}" "activate" "receive $D" \
  "rm -rf /" "HAS $D" "cmd_has $D"; do
  (SSH_ORIGINAL_COMMAND=$bad main) >/dev/null 2>&1 </dev/null
  check "拒：「$bad」" "$?" 64
done
(main) >/dev/null 2>&1 </dev/null
check "什么都没给：拒" "$?" 64
(SSH_ORIGINAL_COMMAND="has $D" main) >/dev/null 2>&1 </dev/null
check "认：「has <提交号>」" "$?" 0
(main has "$D") >/dev/null 2>&1 </dev/null
check "本机 root 手动跑（从参数读）：认" "$?" 0

if ((fail)); then
  echo "gateway-deploy：不通过"
  exit 1
fi
echo "gateway-deploy：通过"
