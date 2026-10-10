#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy/lib/mirasim.sh 的会话用户 Mirasim 常驻单元这一层（mirasim_server_installed、check_mirasim_session_unit，
# #424）；和 mirasim.test.sh（认令牌）分开测——那份管「引擎连哪个端口」，这份管「该不该有常驻单元、单元活没活」。
#   0. deploy/france/fleet-mirasim-session.service 渲染出来的样子钉住：User、Group、端口、--host 127.0.0.1、
#      --no-open、--no-im 都要在（改坏了这条先炸，不用真起服务就测得出）
#   1. 服务端本体不在（最常见的起始状态，装机脚本还没装过服务端）：mirasim_server_installed 返回假、
#      check_mirasim_session_unit 记一笔待配，不判红——【故意造出的失败】照 france.sh 挂上 ERR 陷阱再跑一遍，
#      陷阱不许响、返回 0（同一个坑 mirasim.test.sh 已经钉过一次，check_mirasim_session_unit 是新函数，重新钉一遍）
#   2. 服务端本体在、但单元没在跑（本体已装、常驻这层还没起来，或者单元名根本不存在）：判红，带着 journalctl 提示
#   3. 服务端本体在、单元在跑、但 /api/health 连不上：判红
#   4. 服务端本体在、单元在跑、/api/health 回 ok:true：判绿——用 systemd-run 起一个真的 transient 单元、配一个假
#      server.cjs（node 起的最小 http 服务）验证这条真走得通，不是只测「本该红」的那几条
#   5. 健康检查脚本 deploy/lib/mirasim-liveness.sh（#1676）：curl、systemctl、logger 换成桩，不要 root、不要 systemd：
#      ①健康清零不重启 ②连续失败 2 次不重启、第 3 次重启且清零 ③健康检查超时算失败 ④单元没装退出 0、不重启；
#      另钉：单元没在跑不重启、令牌不是恰好一份不重启、重启失败退出 1 且计数保留、定时器和单元文件的样子
# 第 0、5 步不要 root；1～4 步要 root（建临时用户、用 systemd-run 起 transient 单元）、要这台机器有 systemd 和 node，
# 不满足就在跑完第 5 步之后以 2 退出。
# 用法：sudo bash deploy/test/mirasim-session.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/mirasim.sh
source "$HERE/../lib/mirasim.sh"

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
has() { # 说明 文本 要有的（grep -E）
  if grep -qE -- "$3" <<<"$2"; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：「%s」里没有「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
last() { # 数组名：最后一条
  local -n arr=$1
  if ((${#arr[@]})); then printf '%s' "${arr[-1]}"; fi
}
fresh() { CHANGES=() REDS=() PENDING=(); }

echo "== 0. fleet-mirasim-session.service 渲染出来的样子钉住"
render "$HERE/../france/fleet-mirasim-session.service" SESSION_USER=fleet-mirasim-fake MIRASIM_SESSION_PORT=54321
has "User 是渲染进去的会话用户" "$RENDERED" '^User=fleet-mirasim-fake$'
has "Group 跟着同一个用户" "$RENDERED" '^Group=fleet-mirasim-fake$'
has "ExecStart 带上端口、只听回环、不开浏览器、不进 IM" "$RENDERED" \
  'ExecStart=.*--port 54321 --host 127\.0\.0\.1 --no-open --no-im --workdir /home/fleet-mirasim-fake'
has "经它起的 grok 不认目录信任（不然不加载 AGENTS.md、还弹「信不信」）" "$RENDERED" '^Environment=GROK_FOLDER_TRUST=0$'
has "经它起的 grok 不给反问选择题（没人答会干等）" "$RENDERED" '^Environment=GROK_ASK_USER_QUESTION=0$'
has "Mirasim 出网不借 agent 的代理（settings 里的 reclaude 代理口一死就全断，#1274；P39、Q21）" "$RENDERED" '^Environment=MIRASIM_NO_AGENT_EGRESS=1$'
has "Mirasim 不跑它自带的账号额度探针（Q21）" "$RENDERED" '^Environment=MIRASIM_ACCOUNT_USAGE_PROBE=0$'
has "起不来会重试（on-failure）" "$RENDERED" '^Restart=on-failure$'
has "不进 fleet-agents.slice（平台常驻服务，不占会话额度）" "$RENDERED" 'MemoryHigh=|MemoryMax='

echo "== 5. 健康检查脚本 deploy/lib/mirasim-liveness.sh（#1676）：curl、systemctl、logger 换成桩"
LIVE=$HERE/../lib/mirasim-liveness.sh
LT=$(mktemp -d)
mkdir -p "$LT/bin" "$LT/run"
printf 'unit\n' >"$LT/unit.service"
touch "$LT/run/local-54321.token"
# 桩只记调用：curl 看 STUB_CURL（ok 回 ok:true；refused 退出 7；timeout 退出 28；notok 回 ok:false；空白 回 {"ok" : true}）
cat >"$LT/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >>"$STUB_LOG"
case "${STUB_CURL:-ok}" in
  ok) echo '{"ok":true}' ;;
  spaced) echo '{"ok" : true}' ;;
  notok) echo '{"ok":false}' ;;
  refused) echo 'curl: (7) Failed to connect' >&2; exit 7 ;;
  timeout) echo 'curl: (28) Operation timed out' >&2; exit 28 ;;
esac
STUB
cat >"$LT/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_LOG"
case "$1" in
  is-active) [[ "${STUB_ACTIVE:-1}" == 1 ]] ;;
  restart) [[ "${STUB_RESTART_FAIL:-0}" != 1 ]] ;;
esac
STUB
cat >"$LT/bin/logger" <<'STUB'
#!/usr/bin/env bash
echo "logger $*" >>"$STUB_LOG"
STUB
chmod +x "$LT/bin/curl" "$LT/bin/systemctl" "$LT/bin/logger"
live() { # 退出码放 LIVE_RC，调用记录放 $LT/log（每次清空）
  : >"$LT/log"
  LIVE_RC=0
  PATH="$LT/bin:$PATH" STUB_LOG="$LT/log" \
    MIRASIM_LIVENESS_UNIT=fleet-mirasim-session.service MIRASIM_LIVENESS_UNIT_FILE="$LT/unit.service" \
    MIRASIM_LIVENESS_RUN_DIR="$LT/run" MIRASIM_LIVENESS_COUNT_FILE="$LT/count" \
    bash "$LIVE" fleet-mirasim-fake >"$LT/out" 2>&1 || LIVE_RC=$?
}
restarts() { grep -c '^systemctl restart ' "$LT/log" || true; }
count_now() { if [[ -f "$LT/count" ]]; then tr -d '\n' <"$LT/count"; else printf 无; fi; }

echo "-- ①健康：计数清零、不重启"
printf '2\n' >"$LT/count"
STUB_CURL=ok live
check "退出 0" "$LIVE_RC" "0"
check "计数清零（文件没了）" "$(count_now)" "无"
check "没重启" "$(restarts)" "0"
has "请求的是令牌里的端口的 /api/health，带 --max-time 10" "$(<"$LT/log")" 'curl .*--max-time 10 http://127\.0\.0\.1:54321/api/health'
printf '2\n' >"$LT/count"
STUB_CURL=spaced live
check "回 {\"ok\" : true}（带空格）也算健康" "$(count_now) $(restarts)" "无 0"

echo "-- ②连续失败：第 1、2 次只记数不重启，第 3 次重启且计数清零、journal 带原因"
rm -f -- "$LT/count"
STUB_CURL=refused live
check "第 1 次：退出 0、计数 1、没重启" "$LIVE_RC $(count_now) $(restarts)" "0 1 0"
STUB_CURL=notok live
check "第 2 次（回了但不是 ok:true）：计数 2、没重启" "$LIVE_RC $(count_now) $(restarts)" "0 2 0"
STUB_CURL=refused live
check "第 3 次：重启一次、计数清零" "$LIVE_RC $(count_now) $(restarts)" "0 无 1"
has "重启的是 fleet-mirasim-session.service" "$(<"$LT/log")" '^systemctl restart fleet-mirasim-session\.service$'
has "journal 写了带原因的一行（tag fleet-mirasim-liveness）" "$(<"$LT/log")" 'logger -t fleet-mirasim-liveness -- .*连续 3 次健康检查失败，重启.*curl 退出 7'
STUB_CURL=ok live
check "重启后下一轮健康：仍是清零、不再重启" "$(count_now) $(restarts)" "无 0"
printf '1\n' >"$LT/count"
STUB_CURL=ok live
STUB_CURL=refused live
check "中间健康过一次就从头数：失败后计数是 1 不是 2" "$(count_now) $(restarts)" "1 0"

echo "-- ③健康检查超时算失败"
rm -f -- "$LT/count"
STUB_CURL=timeout live
check "超时 1 次：计数 1" "$(count_now) $(restarts)" "1 0"
STUB_CURL=timeout live
STUB_CURL=timeout live
check "连续超时 3 次：重启、清零" "$(count_now) $(restarts)" "无 1"
has "journal 里带超时的退出码 28" "$(<"$LT/log")" 'curl 退出 28'

echo "-- ④单元没装：退出 0、不调 systemctl restart（连 is-active 都不问）"
printf '2\n' >"$LT/count"
: >"$LT/log"
LIVE_RC=0
PATH="$LT/bin:$PATH" STUB_LOG="$LT/log" STUB_CURL=refused \
  MIRASIM_LIVENESS_UNIT_FILE="$LT/没装.service" MIRASIM_LIVENESS_RUN_DIR="$LT/run" MIRASIM_LIVENESS_COUNT_FILE="$LT/count" \
  bash "$LIVE" fleet-mirasim-fake >"$LT/out" 2>&1 || LIVE_RC=$?
check "退出 0、没重启、没请求、计数清掉" "$LIVE_RC $(restarts) $(grep -c '^curl ' "$LT/log" || true) $(count_now)" "0 0 0 无"

echo "-- 另：单元没在跑（有人停的、或崩了归 Restart=on-failure）：不重启、不请求"
printf '2\n' >"$LT/count"
STUB_CURL=refused STUB_ACTIVE=0 live
check "退出 0、没重启、没请求、计数清掉" "$LIVE_RC $(restarts) $(grep -c '^curl ' "$LT/log" || true) $(count_now)" "0 0 0 无"

echo "-- 另：令牌不是恰好一份，认不出端口：不请求、不重启、计数不动、journal 留一行"
touch "$LT/run/local-54399.token"
printf '2\n' >"$LT/count"
STUB_CURL=refused live
check "退出 0、没重启、没请求、计数还是 2" "$LIVE_RC $(restarts) $(grep -c '^curl ' "$LT/log" || true) $(count_now)" "0 0 0 2"
has "journal 说认不出端口" "$(<"$LT/log")" 'logger .*不是恰好一份'
rm -f -- "$LT/run/local-54399.token"

echo "-- 另：【故意造出的失败】重启本身失败：退出 1、计数保留（下一轮再试），不当成没事"
printf '2\n' >"$LT/count"
STUB_CURL=refused STUB_RESTART_FAIL=1 live
check "退出 1、计数保留 3" "$LIVE_RC $(count_now)" "1 3"

echo "-- 另：没给会话用户：退出 2"
LIVE_RC=0
bash "$LIVE" >/dev/null 2>&1 || LIVE_RC=$?
check "退出 2" "$LIVE_RC" "2"

echo "-- 另：单元和定时器文件的样子钉住"
render "$HERE/../france/fleet-mirasim-liveness.service" SESSION_USER=fleet-mirasim-fake
has "service 是 oneshot" "$RENDERED" '^Type=oneshot$'
has "service 以会话用户为参数跑安装位置的脚本（没设 User=，root 跑）" "$RENDERED" '^ExecStart=/usr/local/lib/fleet-dao/mirasim-liveness\.sh fleet-mirasim-fake$'
check "service 没设 User=" "$(grep -c '^User=' <<<"$RENDERED" || true)" "0"
has "service 单元没装就不跑（ConditionPathExists）" "$RENDERED" '^ConditionPathExists=/etc/systemd/system/fleet-mirasim-session\.service$'
TIMER=$(<"$HERE/../france/fleet-mirasim-liveness.timer")
has "timer 开机 5 分钟后" "$TIMER" '^OnBootSec=5min$'
has "timer 跑完 2 分钟再来" "$TIMER" '^OnUnitInactiveSec=2min$'
has "timer 精度 10 秒" "$TIMER" '^AccuracySec=10s$'
has "timer 拉起 liveness 单元" "$TIMER" '^Unit=fleet-mirasim-liveness\.service$'
rm -rf -- "$LT"

if ((EUID != 0)); then
  echo "mirasim-session：没跑成：要 root（得建临时用户、用 systemd-run 起 transient 单元）"
  exit $((fail ? 1 : 2))
fi
if ! command -v systemctl >/dev/null || ! command -v systemd-run >/dev/null; then
  echo "mirasim-session：没跑成：这台没有 systemd（systemctl / systemd-run）"
  exit $((fail ? 1 : 2))
fi
if ! command -v node >/dev/null; then
  echo "mirasim-session：没跑成：这台没有 node（假 server.cjs 要用它起）"
  exit $((fail ? 1 : 2))
fi

U=fleet-mirasim-session-test-$$
H=/var/tmp/mirasim-session-test-$$
# 家目录不在真的 /home 下（不碰真机），所以把 lib/mirasim.sh 的模板也指到这儿——
# 和 mirasim.test.sh 覆盖 MIRASIM_RUN_DIR 是同一个道理（该文件顶上的 shellcheck 注释就是为这个留的）
MIRASIM_SERVER_BIN="$H/.mirasim-remote/current/server.cjs"
# 1、1b 两步服务端本体都还没装，check_mirasim_session_unit 在看 systemctl 之前就已经因为「没装」提前返回了——
# 这个名字不会真被 systemd-run 起过，只是占位。2、3、4 各用一个没起过的单元名（不复用同一个）：transient 单元被
# systemd-run 的 --collect 标了自动收，stop + reset-failed 之后是不是已经收干净、能不能马上拿同一个名字重开一个
# 新的，没在真机上验证过；各起各的名字，不管收得快不快，后一个都是全新的单元，不会撞上前一个还没收完
UNIT1=fleet-mirasim-session-test-$$-1.service
UNIT2=fleet-mirasim-session-test-$$-2.service
UNIT3=fleet-mirasim-session-test-$$-3.service
UNIT4=fleet-mirasim-session-test-$$-4.service
cleanup() {
  local u
  for u in "$UNIT2" "$UNIT3" "$UNIT4"; do
    systemctl stop "$u" >/dev/null 2>&1 || true
    systemctl reset-failed "$u" >/dev/null 2>&1 || true
  done
  pkill -KILL -u "$U" >/dev/null 2>&1
  userdel "$U" >/dev/null 2>&1
  rm -rf -- "$H"
}
trap cleanup EXIT
if ! useradd --system --user-group --home-dir "$H" --create-home --shell /bin/bash "$U" >/dev/null 2>&1; then
  echo "mirasim-session：没跑成：建不了临时用户 $U"
  exit 2
fi

echo "== 1. 服务端本体不在（最常见的起始状态）：待配，不判红"
fresh
check "mirasim_server_installed 判假" "$(mirasim_server_installed "$U" && echo 真 || echo 假)" "假"
check_mirasim_session_unit "$U" "$UNIT1" 54321
check "记一笔待配、没有红" "${#PENDING[@]} ${#REDS[@]}" "1 0"
has "待配写清没装服务端本体、去哪装" "$(last PENDING)" "还没有 Mirasim 服务端本体.*docs/ops.md 第五节「会话用户的 Mirasim」"

echo "== 1b.【故意造出的失败】挂上 ERR 陷阱再跑一遍：陷阱不许响，照样待配、返回 0"
fresh
trapped=$(
  trap 'echo 陷阱响了' ERR
  set -E
  check_mirasim_session_unit "$U" "$UNIT1" 54321 >/dev/null
  echo "返回 $? 待配 ${#PENDING[@]} 红 ${#REDS[@]}"
)
check "挂着 ERR 陷阱：陷阱没响、记一笔待配" "$trapped" "返回 0 待配 1 红 0"

echo "== 2. 服务端本体在、单元没在跑：判红，带 journalctl 提示"
install -d -o "$U" -g "$U" -m 755 "$H/.mirasim-remote/current"
install -o "$U" -g "$U" -m 755 /dev/null "$H/.mirasim-remote/current/server.cjs"
fresh
check "mirasim_server_installed 判真" "$(mirasim_server_installed "$U" && echo 真 || echo 假)" "真"
check_mirasim_session_unit "$U" "$UNIT2" 54321
check "判红、不是待配" "${#REDS[@]} ${#PENDING[@]}" "1 0"
has "红里带 journalctl 提示" "$(last REDS)" "$UNIT2 没在跑.*journalctl -u $UNIT2"

echo "== 3. 服务端本体在、单元在跑、但 /api/health 连不上（起一个只听着不回应的假单元）"
PORT3=$((20000 + RANDOM % 10000))
systemd-run --unit="$UNIT3" --uid="$U" --gid="$U" -p Type=simple --collect --quiet -- \
  node -e 'require("node:net").createServer((c)=>c.on("data",()=>{})).listen(process.argv[1])' "$PORT3" \
  >/dev/null 2>&1
for ((i = 0; i < 50; i++)); do
  [[ "$(systemctl is-active "$UNIT3" 2>/dev/null)" == active ]] && break
  sleep 0.1
done
fresh
check_mirasim_session_unit "$U" "$UNIT3" "$PORT3"
check "判红、不是待配" "${#REDS[@]} ${#PENDING[@]}" "1 0"
has "红里说 health 连不上" "$(last REDS)" "在跑但 http://127\.0\.0\.1:$PORT3/api/health 连不上或没回"

echo "== 4. 服务端本体在、单元在跑、/api/health 回 ok:true：判绿"
PORT4=$((20000 + RANDOM % 10000))
systemd-run --unit="$UNIT4" --uid="$U" --gid="$U" -p Type=simple --collect --quiet -- \
  node -e '
    require("node:http").createServer((req,res)=>{
      if (req.url === "/api/health") { res.end(JSON.stringify({ok:true})); }
      else { res.statusCode = 404; res.end(); }
    }).listen(Number(process.argv[1]), "127.0.0.1");' "$PORT4" \
  >/dev/null 2>&1
# 单元一 fork 出主进程就算 active（Type=simple），不等于 node 已经跑到 .listen() 真正开始收连接——
# 等 is-active 不够，直接等 curl 真的连得上（到点了还连不上就别等了，交给下面的断言去报）
for ((i = 0; i < 50; i++)); do
  curl -fsS --max-time 1 "http://127.0.0.1:$PORT4/api/health" >/dev/null 2>&1 && break
  sleep 0.1
done
fresh
OUT4=$(mktemp)
check_mirasim_session_unit "$U" "$UNIT4" "$PORT4" >"$OUT4" 2>&1
check "判绿：没有待配、没有红" "${#PENDING[@]} ${#REDS[@]}" "0 0"
has "报了在跑、health 回 ok" "$(cat -- "$OUT4")" "$UNIT4 在跑.*api/health 回 ok:true"
rm -f -- "$OUT4"

if ((fail)); then
  echo "mirasim-session：不通过"
  exit 1
fi
echo "mirasim-session：通过"
