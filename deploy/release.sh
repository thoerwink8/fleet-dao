#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 发布（在法国以 root 跑）：把主线上的一个提交装成一版 → 跑数据库迁移、装目录、装路由两层 → 切过去、按本机配置起应用服务 → 经隧道把飞书网关发到香港
# （release.env 的 FLEET_HK_PARTS 写了 demo，人手动发布连演示版一起发到 FLEET_DEMO_PATH、记下发的是哪一版；明写了 web，才连
# 驾驶舱静态文件一起发到根地址）→ 健康检查；不过就自动退回上一版并报错（库的迁移比上一版新时不退）。幂等：同一个提交跑第二遍什么都不变。
# 发布和退回自己交给 systemd 跑（临时服务），终端断了照样跑完；日志在 /srv/fleet-dao-releases/.logs/。
#   bash deploy/release.sh [<提交号>]            发布这个提交（不给就发主线最新）；只认主线上的提交
#   bash deploy/release.sh --rollback            退回上一版（上一个在用过、没被判过不健康、目录还在的版本）
#   bash deploy/release.sh --check               只读：在用哪版、有哪几版、服务与健康检查，不改任何东西
#   bash deploy/release.sh <提交号> --unmerged   发还没合进主线的提交（只用来合并前在真机上验；历史里会标出来）
#   bash deploy/release.sh <提交号> --auto [--busy-ok]
#                                                自动发布（fleet-auto-release）用：不发演示版（对外，人闸；只核对香港上的
#                                                还是上次人发的那份）、历史行带 auto；引擎不会排空（这一版之前的）时切之前
#                                                有会话在跑就不切（--busy-ok 照切）；这两种「没动」单给退出码
#   发布、退回加 --now：不给在跑的会话宽限，马上停下（按编号续上）；急修、急退用
# 要换引擎的版本时先排空（packages/engine/src/drain.ts）：一开始就写排空请求（$DRAIN_REQUEST），引擎马上不起新会话，在跑的最多再做
# DRAIN_GRACE 秒（和构建一起走），到点没做完的由引擎按切号那一套停下、新引擎起来按编号续上；排空完停引擎，再迁移、切版本。
# 每一版在 /srv/fleet-dao-releases/<提交号>，current 指着在用的那版；留最近 5 版。目录、单元、本机配置、怎么看、
# 怎么退：docs/ops.md 第九节。退出码同装机脚本：0 全绿，1 有红（含「没过健康检查、已退回」），2 没红但有待配；
# 只有 --auto 才有的：75 另一个发布在跑、76 切之前看到会话在跑——这两种什么都没动（构建留着，下次直接用）。
set -Eeuo pipefail
umask 022

DEPLOY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
source "$DEPLOY_DIR/lib/common.sh"

REPO_URL=https://github.com/thoerwink8/fleet-dao.git
RELEASES=${FLEET_RELEASES_DIR:-/srv/fleet-dao-releases} # 只有 deploy/test/release-flow.test.sh 会改它
CACHE=$RELEASES/.repo.git   # 取代码用的裸仓（root 的）
# 每切一次、每判一次记一行：时间 提交号 事件 [unmerged]。事件：release、rollback、auto-rollback（切过去）、
# unhealthy（健康检查没过）、recovered（判过不健康的在用版本后来又过了）
HISTORY=$RELEASES/.history
KEEP=5                      # 留几版：在用的、上一版，再加最近用过的
APP_UNITS=(fleet-engine fleet-api)
RELEASE_ENV=/etc/fleet-dao/release.env
UPLOAD_KEY=/etc/fleet-dao/web-upload.key
HK_KNOWN_HOSTS=/etc/fleet-dao/hk-known-hosts
HK_TUNNEL=10.99.0.1            # 香港在隧道上的地址：静态文件、飞书网关经它发，发完也经它核对（不依赖公网解析）
GATEWAY_KEY=/etc/fleet-dao/gateway-deploy.key # 发飞书网关的钥匙：香港把它限死成只能跑 fleet-gateway-deploy
HK_PARTS=(web demo gateway)    # 往香港发的三样：驾驶舱静态文件（根地址）、演示版、飞书网关（release.env 的 FLEET_HK_PARTS 选）
GATEWAY_WAIT=60                # 网关起来后等它连上飞书长连接，最多这么久
COCKPIT=10.99.0.2:8787         # 驾驶舱接口（api.env 的 FLEET_COCKPIT_LISTEN）
AGENT_API=127.0.0.1:8788       # fleet 命令接口（api.env 的 FLEET_AGENT_LISTEN）
TASK_QUEUE=fleet               # 引擎工人取活的任务队列（engine.env 的 FLEET_TASK_QUEUE）
# 迁移连本机库：unix socket + peer 认证（同 api.env；postgres.js 不认连接串里的 ?host=，主机走 PGHOST）
DB_ENV=(DATABASE_URL=postgres:///fleet PGHOST=/var/run/postgresql PGUSER=fleet)
# 目录配置（族、渠道、账号池、模型、路由、各阶段顺序）：从保险箱放上来（docs/ops.md 第九节「目录配置」），迁移之后装进库
CATALOG=/etc/fleet-dao/catalog.json
CATALOG_META="root:fleet 640" # 它该有的属主、权限；只有测试会改
NODE=/usr/bin/node    # 法国的 node（france.sh 的前提里查过 22 以上）；只有测试会换成别处的
SETTLE_SECONDS=10     # 服务起来后再看这么久：这段时间里退出过、重启过，就是没起稳
ENGINE_POLL_WAIT=90   # 引擎工人起来后要先打包工作流，才去任务队列取活
AGENT_SCOPE=/usr/local/sbin/fleet-agent-scope # 列 AI 会话（--auto 切之前看有没有会话在跑）；只有测试会换
AUTO_STATE=$RELEASES/.auto/state.json         # 自动发布每一轮的读数（deploy/france/auto-release 写，--check 列出来）
# 香港上的演示版是哪一版：演示版发成了（sync_web）当场记下提交号、时间、路径、首页的 sha256，核对（check_demo）都照它比。
# 自动发布不发演示版，香港上的就该一直是这里记的那份——拿「在用的这一版」去比，会把「还没发」当成「坏了」（2026-09-27 误报过）
DEMO_RECORD=$RELEASES/.demo-published
# 自动发布（--auto）的两种「这次不发、什么都没动」：退出码单列，自动发布据此分得清「没动」和「没成」（没成的不再试）
EXIT_RELEASE_BUSY=75
EXIT_SESSIONS_BUSY=76
AUTO=0    # --auto：自动发布起的
BUSY_OK=0 # --busy-ok：引擎不会排空时（这一版之前的引擎），等空闲到了上限，有会话在跑也切
NOW_MODE=0 # --now：不给在跑的会话宽限
# 发布前排空引擎（packages/engine/src/drain.ts、drain-control.ts）。改宽限要和引擎的 RELEASE_GRACE_MS、fleet-engine.service 的
# TimeoutStopSec 一起改（packages/engine/test/drain.test.ts 核对）。请求只在发布锁占着时算数：这个脚本中途没了，引擎不会一直停着不派
DRAIN_GRACE=600                  # 宽限（秒）：在跑的会话最多再做这么久
DRAIN_REQUEST=$RELEASES/.drain-request
DRAIN_STOP_REPORT=120            # 到截止引擎叫停会话以后，等它们交回最多这么久（秒，和引擎的 STOP_REPORT_MS 同一个数）
DRAIN_SLACK=60                   # 再多等这么久才不等了、直接停（秒）
DRAIN_POLL=10                    # 多久看一次排空进度（秒）
ENGINE_ENV=/etc/fleet-dao/engine.env
ENGINE_STATE_DEFAULT=/var/lib/fleet-dao/engine # 引擎写 drain.json 的地方（engine.env 的 FLEET_ENGINE_STATE_DIR，没写取它）
DRAIN_WROTE=0    # 这次写了排空请求、还没撤
DRAIN_UNTIL=0    # 请求里的截止（秒）
ENGINE_DRAINS=0  # 在跑的引擎会排空（认了 drain.json）
ENGINE_STOPPED=0 # 这次把引擎停下了、还没起回来：没走到切版本就失败，收尾时照原样起回来

FLEET_SERVICES=""
FLEET_DOMAIN=""
# release.env 里不写 FLEET_HK_PARTS 时只发飞书网关、不发静态页：发静态页会把香港根地址上的东西（现在是演示版）整个换成
# 这一版的前端，等于对外发布，要先告诉创始人、在 release.env 里明写 web 才发。演示版（demo）只发到 FLEET_DEMO_PATH，不碰根地址
FLEET_HK_PARTS="gateway"
GATEWAY_ACTIVATED=0 # 这一版的网关这次切过去了没有（没有网关、配置没备齐就是 0，健康检查不查它）
# 演示版在香港站点上的路径（release.env，默认 /demo/）；和香港 hk.env 的 FLEET_DEMO_PATH 是同一个
FLEET_DEMO_PATH=""
DEMO_PUBLISH=1 # 这次发不发演示版：人手动发布发；自动发布（--auto）不发，只核对（auto_parts）
SHA=""
ON_MAIN=1
WEB_KIND=""

usage() {
  cat <<'EOF'
用法（法国，root）：
  bash deploy/release.sh [<提交号>]            发布（不给提交号就发主线最新）
  bash deploy/release.sh <提交号> --unmerged   发还没合进主线的提交（合并前在真机上验）
  bash deploy/release.sh <提交号> --auto [--busy-ok]
                                               自动发布用（fleet-auto-release 起，人不用）
  bash deploy/release.sh [<提交号>] --now      发布，不给在跑的会话宽限（马上停下、按编号续上）
  bash deploy/release.sh --rollback [--now]    退回上一版
  bash deploy/release.sh --check               只读：看在用哪版、服务与健康
EOF
}

# --auto 这次不发、什么都没动（另一个发布在跑、会话在跑）：照样给出结论，退出码单列
not_now() { # 退出码 原因
  drain_withdraw
  pending "$2"
  printf '\n== 结论\n这次没发：%s。什么都没动\n' "$2"
  exit "$1"
}

# ── 小零件 ──

is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
short() { # 提交号 没有时显示的字
  if [[ -n "$1" ]]; then printf '%s' "${1:0:12}"; else printf '%s' "$2"; fi
}
has_service() { [[ " $FLEET_SERVICES " == *" $1 "* ]]; }
has_part() { [[ " $FLEET_HK_PARTS " == *" $1 "* ]]; } # 香港上的这一样归发布管：发（自动发布不发演示版）、核对
sends_demo() { has_part demo && ((DEMO_PUBLISH)); }   # 这次发演示版
current_sha() {
  local s
  s=$(readlink -- "$RELEASES/current" 2>/dev/null) || return 0
  if is_sha "$s"; then printf '%s' "$s"; fi
}

# 上一版：历史里最近在用过、不是现在这版、最后一次事件不是「不健康」、目录还在的那一版
previous_sha() {
  local cur s
  cur=$(current_sha)
  if [[ ! -f "$HISTORY" ]]; then return 0; fi
  while read -r s; do
    if is_sha "$s" && [[ "$s" != "$cur" && -f "$RELEASES/$s/.fleet-release" ]]; then
      printf '%s' "$s"
      return 0
    fi
  done < <(awk '{ last[$2] = $3; if ($3 != "unhealthy") order[++n] = $2 }
    END { for (i = n; i >= 1; i--) if (last[order[i]] != "unhealthy" && !seen[order[i]]++) print order[i] }' "$HISTORY")
}

last_event() { # 提交号
  if [[ -f "$HISTORY" ]]; then awk -v s="$1" '$2 == s { e = $3 } END { printf "%s", e }' "$HISTORY"; fi
}

# 自动发布起的（--auto）带 auto：自动发布据此分得清哪次是人手动切的——人最近手动切过、主线上还没有更新的提交，它就不动
record() { # 提交号 事件
  local tag=""
  if [[ "$(marker_get "$1" on_main)" == 0 ]]; then tag=" unmerged"; fi
  if ((AUTO)); then tag+=" auto"; fi
  printf '%s %s %s%s\n' "$(date -u +%FT%TZ)" "$1" "$2" "$tag" >>"$HISTORY"
}

marker_get() { kv_get "$RELEASES/$1/.fleet-release" "$2"; } # 提交号 键：这一版构建完成标记里的一项

kv_get() { # 文件 键：「键=值」一行一项的文件里这一项的值（文件不在、没有这一项都打印空）
  local line
  if [[ ! -f "$1" ]]; then return 0; fi
  while IFS= read -r line; do
    if [[ "$line" == "$2="* ]]; then printf '%s' "${line#*=}"; fi
  done <"$1"
}

# 以 fleet 身份、在给定目录里跑命令（环境清空，同 as_user）
as_fleet_in() { # 目录 命令…
  local dir=$1
  shift
  (cd -- "$dir" && runuser -u fleet -- env -i HOME=/home/fleet USER=fleet LOGNAME=fleet \
    PATH=/home/fleet/.local/bin:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@")
}

pg_admin() { (cd / && runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -tA "$@"); }
tcli() { env -i HOME=/root PATH=/usr/bin:/bin /usr/local/bin/fleet-temporal "$@"; }

# ── 前提 ──

preflight() {
  step "前提"
  if ((EUID != 0)); then
    echo "要 root：sudo bash $0" >&2
    exit 64
  fi
  if [[ ! -f /etc/fleet-dao/france.env || ! -f "$RELEASE_ENV" ]]; then
    red "没有 /etc/fleet-dao/france.env 或 $RELEASE_ENV：发布只在装过 deploy/france.sh 的法国机器上跑，先跑一遍它"
    return 1
  fi
  load_env "$RELEASE_ENV" FLEET_SERVICES FLEET_DOMAIN FLEET_HK_PARTS FLEET_DEMO_PATH
  demo_config_ok || return 1
  local s c
  for s in $FLEET_HK_PARTS; do
    if [[ " ${HK_PARTS[*]} " != *" $s "* ]]; then
      red "$RELEASE_ENV 的 FLEET_HK_PARTS 里有不认识的「$s」（认识的：${HK_PARTS[*]}）"
      return 1
    fi
  done
  for s in $FLEET_SERVICES; do
    if [[ " ${APP_UNITS[*]} " != *" $s "* ]]; then
      red "$RELEASE_ENV 的 FLEET_SERVICES 里有不认识的服务「$s」（认识的：${APP_UNITS[*]}）"
      return 1
    fi
  done
  if [[ ! "$FLEET_DOMAIN" =~ ^[a-z0-9.-]+$ ]]; then
    red "$RELEASE_ENV 的 FLEET_DOMAIN 应为驾驶舱的域名，现在是「$FLEET_DOMAIN」"
    return 1
  fi
  for c in git rsync curl flock runuser psql "$NODE" /usr/local/bin/fleet-temporal; do
    if ! command -v "$c" >/dev/null; then
      red "缺 $c：先跑一遍 deploy/france.sh"
      return 1
    fi
  done
  auto_parts
  ok "本机启用的服务：${FLEET_SERVICES:-（无：只发代码、跑迁移）}；往香港发：$(parts_said)；域名 $FLEET_DOMAIN"
  if has_part demo; then ok "演示版在香港站点的 $FLEET_DEMO_PATH"; fi
}

# 往香港发哪几样，说给人看：自动发布不发的演示版写明只核对
parts_said() {
  local p said=""
  for p in $FLEET_HK_PARTS; do
    if [[ "$p" == demo ]] && ! sends_demo; then p="demo（只核对、不发）"; fi
    said+="${said:+ }$p"
  done
  printf '%s' "${said:-（都不发）}"
}

# 自动发布（--auto）不发演示版：演示版是对外的（链接发给了很多人），换它是对外发布，按版本由人确认（人闸，
# docs/decisions/0003 第 18 条）。香港上的演示版这时不动，但照样核对（check_demo）：它得还是上次人发的那份——往根地址发的
# 驾驶舱静态文件和它在同一个目录底下，碰坏了要当场知道（原先连核对一起去掉，香港上的演示版就没人看了）。
# 驾驶舱前端（web）和飞书网关是自家用的，和后端同一版一起跟
auto_parts() {
  if ((AUTO == 0)) || ! has_part demo; then return 0; fi
  DEMO_PUBLISH=0
  ok "自动发布不发演示版（对外，要人确认）：香港上的演示版这次不动，只核对它还是上次人发的那份"
}

# 演示版在哪个路径：没写取默认 /demo/；不是一级路径、和根上已有的东西撞，报红
demo_config_ok() {
  FLEET_DEMO_PATH=${FLEET_DEMO_PATH:-/demo/}
  if ! demo_path_ok "$FLEET_DEMO_PATH"; then
    red "$RELEASE_ENV 的 FLEET_DEMO_PATH 应为 /demo/ 这样的一级路径（不能是 assets、health、healthz、api、auth、github），现在是「$FLEET_DEMO_PATH」"
    return 1
  fi
}

# 同一时间只许一个发布在跑
take_lock() {
  exec 9>>"$RELEASES/.lock"
  if ! flock -n 9; then
    if ((AUTO)); then not_now "$EXIT_RELEASE_BUSY" "另一个发布正在跑（$RELEASES/.lock）"; fi
    red "另一个发布正在跑（$RELEASES/.lock）"
    return 1
  fi
}

# 自动发布切之前最后看一眼：引擎有会话在跑就不切（切版本要重启引擎，会话跟着断），构建留着、下一轮直接用。
# 放在构建之后、迁移之前：构建要几分钟，这一眼离切版本越近，看完又起新会话的空当越小。读不到、认不出会话列表都按「在跑」算。
# 等空闲到了上限（fleet-auto-release 定的），它带 --busy-ok 来，照切：会话按编号续上（design 第四节「会话断了接着干」）
auto_gate() {
  local out busy bad
  if ((ENGINE_DRAINS)); then
    ok "自动发布：引擎会排空（不起新会话、在跑的最多再做 $((DRAIN_GRACE / 60)) 分钟），不等空闲"
    return 0
  fi
  if ((BUSY_OK)); then
    ok "自动发布：等空闲到了上限，引擎有会话在跑也切（会话按编号续上）"
    return 0
  fi
  # 只拿标准输出来认（一行「编号 状态」）；它的报错照样进日志
  if ! out=$("$AGENT_SCOPE" list); then
    not_now "$EXIT_SESSIONS_BUSY" "会话在不在跑没查成（$AGENT_SCOPE list 没成，原话见上），按在跑算，这次不切"
  fi
  bad=$(awk 'NF && !/^[^ ]+ [a-z-]+$/ { print; exit }' <<<"$out")
  if [[ -n "$bad" ]]; then
    not_now "$EXIT_SESSIONS_BUSY" "会话列表认不出（有一行是「${bad:0:80}」），按在跑算，这次不切"
  fi
  busy=$(awk 'NF && $2 != "inactive" && $2 != "failed" { printf "%s ", $1 }' <<<"$out")
  if [[ -n "$busy" ]]; then
    not_now "$EXIT_SESSIONS_BUSY" "引擎有会话在跑（${busy% }），这次不切；构建留着，下一轮直接用"
  fi
  ok "自动发布：引擎没有会话在跑，切"
}

# ── 排空引擎 ──

# 引擎写的 drain.json 读成一行：「ok <在排空 0/1> <截止秒> <会话数> <会话列表>」或「no <为什么不信>」。
# pid 对不上 systemd 的 MainPID 就是上一个进程留下的，不信；读不成、认不出照实说
engine_drain_status() { # 引擎主进程号
  local dir
  dir=$(kv_get "$ENGINE_ENV" FLEET_ENGINE_STATE_DIR)
  "$NODE" -e '
    const fs = require("fs");
    const [file, pid] = process.argv.slice(1);
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (e) {
      console.log(e.code === "ENOENT" ? "no 没有 " + file + "（这一版之前的引擎不写它，不会排空）" : "no " + file + " 读不成：" + e.message);
      process.exit(0);
    }
    let st;
    try { st = JSON.parse(text); } catch (e) { console.log("no " + file + " 认不出：" + e.message); process.exit(0); }
    if (!st || st.schema !== 2) { console.log("no " + file + " 的 schema 不是 2（" + JSON.stringify(st && st.schema) + "）"); process.exit(0); }
    if (String(st.pid) !== pid) { console.log("no " + file + " 是上一个进程（" + st.pid + "）留下的，在跑的是 " + pid); process.exit(0); }
    const list = Array.isArray(st.sessions) ? st.sessions : [];
    const until = st.cordon ? Math.floor(Date.parse(st.cordon.until) / 1000) || 0 : 0;
    const names = list.map((x) => x.stage + "(" + String(x.runId).slice(0, 8) + ")").join("、");
    console.log(["ok", st.cordon ? 1 : 0, until, list.length, names || "-"].join(" "));
  ' "${dir:-$ENGINE_STATE_DEFAULT}/drain.json" "$1"
}

# 要换引擎的版本（引擎在跑、跑的不是这一版）就写排空请求：引擎认了马上不起新会话。宽限和构建一起走，所以要早写。
# 引擎认不认 drain.json（会不会排空）也在这里定：不会排空的（这一版之前的引擎），自动发布照旧看会话（auto_gate）
drain_request() { # 要切到的提交号 宽限（秒）
  local sha=$1 grace=$2 pid st by=manual now tmp
  ENGINE_DRAINS=0
  if ! has_service fleet-engine || [[ "$(systemctl is-active fleet-engine.service 2>/dev/null)" != active ]]; then return 0; fi
  if [[ "$(running_release fleet-engine.service)" == "$RELEASES/$sha" ]]; then return 0; fi
  pid=$(unit_prop fleet-engine.service MainPID)
  st=$(engine_drain_status "$pid") || st="no drain.json 没读成（node 没跑成）"
  if [[ "$st" == ok\ * ]]; then
    ENGINE_DRAINS=1
  else
    pending "在跑的引擎不会排空：${st#no }。这次切版本照旧重启引擎，在跑的会话会断、新引擎起来按编号续上"
  fi
  if ((AUTO)); then by=auto; fi
  if [[ "${FUNCNAME[1]:-}" == do_rollback ]]; then by=rollback; fi
  now=$(date -u +%s)
  DRAIN_UNTIL=$((now + grace))
  tmp=$DRAIN_REQUEST.tmp
  printf '{"schema":1,"sha":"%s","requestedAt":"%s","until":"%s","by":"%s"}\n' "$sha" \
    "$(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ)" "$(date -u -d "@$DRAIN_UNTIL" +%Y-%m-%dT%H:%M:%SZ)" "$by" >"$tmp"
  chmod 644 -- "$tmp"
  mv -f -- "$tmp" "$DRAIN_REQUEST"
  DRAIN_WROTE=1
  if ((ENGINE_DRAINS)); then
    changed "排空请求：引擎不起新会话，在跑的最晚做到 $(date -u -d "@$DRAIN_UNTIL" +%H:%M:%SZ)（$((grace / 60)) 分钟），到点没做完的停下、新引擎起来按编号续上"
  fi
}

# 撤掉排空请求（没走到切版本就不发了、或者引擎已经停下）：引擎下一眼就接着派
drain_withdraw() {
  if ((DRAIN_WROTE)); then
    rm -f -- "$DRAIN_REQUEST"
    DRAIN_WROTE=0
  fi
}

# 等排空、停引擎：手上的会话都交回了（或者到了截止、引擎叫停后也等过了交回）就停。停下以后撤请求（新引擎起来不能再认它）。
# 引擎不会排空的：直接停（会话会断，按编号续上），和原来一样
drain_engine() {
  local st pid now last=0 cap
  if ((DRAIN_WROTE == 0)); then return 0; fi
  if ((ENGINE_DRAINS)); then
    cap=$((DRAIN_UNTIL + DRAIN_STOP_REPORT + DRAIN_SLACK))
    while :; do
      pid=$(unit_prop fleet-engine.service MainPID)
      st=$(engine_drain_status "$pid") || st="no drain.json 没读成"
      now=$(date -u +%s)
      if [[ "$st" != ok\ * ]]; then
        pending "排空进度读不到（${st#no }）：不等了，直接停引擎（在跑的会话会断，按编号续上）"
        break
      fi
      read -r _ _ _ n names <<<"$st"
      if ((n == 0)); then
        ok "引擎排空了：手上没有会话"
        break
      fi
      if ((now >= cap)); then
        pending "排空等到了上限（截止后又等了 $((DRAIN_STOP_REPORT + DRAIN_SLACK)) 秒），还有 $n 个会话没交回（$names）：照停，新引擎起来按编号续上"
        break
      fi
      if ((now - last >= 60)); then
        echo "  · 排空中：还在等 $n 个会话（$names），截止 $(date -u -d "@$DRAIN_UNTIL" +%H:%M:%SZ)；不想等：systemctl kill --kill-whom=main -s TERM fleet-engine（再发一次停机信号，马上停）"
        last=$now
      fi
      sleep "$DRAIN_POLL"
    done
  fi
  if ! systemctl stop fleet-engine.service; then
    red "停不下 fleet-engine（排空之后）：journalctl -u fleet-engine -n 50 看现场"
    return 1
  fi
  ENGINE_STOPPED=1
  drain_withdraw
  changed "停下引擎（切版本之前）"
}

# 收尾（common.sh 的 finish 先调它）：撤掉没撤的排空请求；这次停下了引擎、没走到切版本（没起回来），照原样起回来——
# 引擎不能因为发布没成就一直停着
finish_hook() {
  drain_withdraw
  if ((ENGINE_STOPPED)) && has_service fleet-engine &&
    [[ "$(systemctl is-active fleet-engine.service 2>/dev/null)" != active ]]; then
    if systemctl start fleet-engine.service; then
      changed "发布没走到切版本：把停下的引擎起回来（$(short "$(current_sha)" 在用的)），接着派"
    else
      red "发布没走到切版本，停下的引擎也起不回来：systemctl start fleet-engine；journalctl -u fleet-engine -n 50"
    fi
  fi
  ENGINE_STOPPED=0
}

# ── 取代码、构建 ──

fetch_code() { # 要发的提交（空 = 主线最新）
  local target=$1 out
  step "取代码"
  if [[ ! -d "$CACHE" ]]; then
    git init -q --bare "$CACHE"
    git -C "$CACHE" remote add origin "$REPO_URL"
    echo "  · 建了取代码用的裸仓 $CACHE"
  fi
  if ! out=$(timeout 300 git -C "$CACHE" fetch -q --prune origin '+refs/heads/main:refs/remotes/origin/main' 2>&1); then
    red "从 $REPO_URL 取主线失败：$(tail -2 <<<"$out" | tr '\n' ' ')"
    return 1
  fi
  if [[ -z "$target" ]]; then
    SHA=$(git -C "$CACHE" rev-parse refs/remotes/origin/main)
  else
    if ! git -C "$CACHE" cat-file -e "$target^{commit}" 2>/dev/null; then
      if ((${#target} < 40)); then
        red "本地没有 $target，短提交号又没法向 GitHub 要：给完整的 40 位提交号"
        return 1
      fi
      if ! out=$(timeout 300 git -C "$CACHE" fetch -q origin "$target" 2>&1); then
        red "向 GitHub 要不到提交 $target：$(tail -2 <<<"$out" | tr '\n' ' ')"
        return 1
      fi
    fi
    if ! SHA=$(git -C "$CACHE" rev-parse -q --verify "$target^{commit}"); then
      red "认不出提交 $target"
      return 1
    fi
  fi
  if git -C "$CACHE" merge-base --is-ancestor "$SHA" refs/remotes/origin/main; then
    ON_MAIN=1
    ok "提交 ${SHA:0:12}（在主线上）：$(git -C "$CACHE" log -1 --format=%s "$SHA")"
  elif ((UNMERGED)); then
    ON_MAIN=0
    echo "  ! 提交 ${SHA:0:12} 不在主线上（--unmerged：只用来合并前在真机上验）：$(git -C "$CACHE" log -1 --format=%s "$SHA")"
  else
    red "提交 ${SHA:0:12} 不在主线上：只发主线上的提交（合并前要在真机上验，加 --unmerged）"
    return 1
  fi
}

# 装成一版：fleet 在临时目录里装依赖、构建前端（第三方代码不以 root 跑）；构建完整个目录换成 root 的、fleet 只读，
# 再原子地挪到 <提交号>。root 要照着办事的东西（单元文件、完成标记）在换属主之后才由 root 从 git 里取、写，fleet 碰不到。
build_release() { # 提交号
  local sha=$1 dir=$RELEASES/$1 stage=$RELEASES/.build-$1 log u odd n gsum
  step "构建 ${sha:0:12}"
  if [[ -f "$dir/.fleet-release" ]]; then
    ok "已构建（$dir，$(marker_get "$sha" built) 建的）"
    return 0
  fi
  if [[ -e "$dir" || -L "$dir" ]]; then
    red "$dir 在但没有构建完成的标记——不是发布脚本放的？停下等人看"
    return 1
  fi
  rm -rf -- "$stage"
  install -d -o fleet -g fleet -m 750 "$stage"
  log=$stage/.fleet-build.log
  if ! git -C "$CACHE" archive --format=tar "$sha" | as_fleet_in "$stage" tar -x -f -; then
    red "把 ${sha:0:12} 的代码解到 $stage 失败"
    return 1
  fi
  echo "  装依赖（pnpm install --frozen-lockfile，日志 $dir/.fleet-build.log）"
  # copy：依赖整份拷进这一版，不和 fleet 的 pnpm 仓库共用文件（共用的话，换属主会连带改掉仓库里的文件）
  if ! as_fleet_in "$stage" pnpm install --frozen-lockfile --package-import-method=copy --reporter=append-only >>"$log" 2>&1; then
    red "pnpm install --frozen-lockfile 失败（没切版本）：$(tail -5 "$log" | tr '\n' ' ')"
    return 1
  fi
  build_web "$stage" "$log"
  build_gateway "$stage" "$log"
  # 换属主：之后 fleet 只读。-h：符号链接只改它自己，不跟过去改别处
  chown -R -h root:root -- "$stage"
  chmod -R u+rwX,go+rX,go-w -- "$stage"
  # 网关那个文件的 sha256：香港收下时照它核对，传坏了不收
  gsum=""
  if [[ -f "$stage/gateway/gateway.mjs" ]]; then gsum=$(sha256sum <"$stage/gateway/gateway.mjs" | cut -c1-64); fi
  # 静态文件要原样发到香港：不许有符号链接和特殊文件（rsync 不跟链接，也防借链接把本机文件带出去）
  local sites=("$stage/web")
  if [[ -d "$stage/web-demo" ]]; then sites+=("$stage/web-demo"); fi
  odd=$(find "${sites[@]}" ! -type f ! -type d -print -quit)
  if [[ -n "$odd" ]]; then
    red "静态文件里有符号链接或特殊文件（${odd#"$stage"/}），不发"
    return 1
  fi
  printf '{"commit":"%s"}\n' "$sha" >"$stage/web/release.json"
  # 单元文件从 git 里取（不用构建目录里那份：构建时它归 fleet，root 要照着它起服务）
  rm -rf -- "$stage/.units"
  install -d -m 755 "$stage/.units"
  for u in "${APP_UNITS[@]}"; do
    if git -C "$CACHE" cat-file -e "$sha:deploy/france/$u.service" 2>/dev/null; then
      git -C "$CACHE" show "$sha:deploy/france/$u.service" >"$stage/.units/$u.service"
    fi
  done
  # 这一版带几个迁移：退回时拿它和库里跑过的条数比（见 schema_allows）
  if ! n=$(count_migrations "$stage"); then
    red "读不出 ${sha:0:12} 带几个迁移（packages/db/migrations/meta/_journal.json）"
    return 1
  fi
  rm -f -- "$stage/.fleet-release"
  # demo_path：演示版是按哪个路径构建的（资源地址写死在里面），发的时候只往这个路径发
  printf 'commit=%s\nbuilt=%s\non_main=%s\nweb=%s\nmigrations=%s\ngateway_sha256=%s\ndemo_path=%s\n' "$sha" \
    "$(date -u +%FT%TZ)" "$ON_MAIN" "$WEB_KIND" "$n" "$gsum" "$DEMO_BUILT" >"$stage/.fleet-release"
  mv -T -- "$stage" "$dir"
  changed "构建 ${sha:0:12}：依赖装好，静态文件是$WEB_KIND${gsum:+，飞书网关打成了一个文件}"
}

# 飞书网关：这一版有 packages/feishu，就连同依赖打成一个文件 gateway/gateway.mjs（打包、冒烟都以 fleet 跑）。
# 香港上只放这一个文件和固定版本的 node：不放仓库、不装依赖、不连 GitHub
build_gateway() { # 临时目录 日志
  local stage=$1 log=$2
  if [[ ! -f "$stage/packages/feishu/src/main.ts" || ! -f "$stage/deploy/france/bundle-gateway.sh" ]]; then return 0; fi
  echo "  打包飞书网关（packages/feishu → gateway/gateway.mjs，打完冒烟跑一次）"
  as_fleet_in "$stage" mkdir -p gateway
  if ! as_fleet_in "$stage" env FLEET_BUNDLE_NODE="$NODE" bash deploy/france/bundle-gateway.sh "$stage" \
    "$stage/gateway/gateway.mjs" >>"$log" 2>&1; then
    red "飞书网关没打成（没切版本）：$(tail -5 "$log" | tr '\n' ' ')"
    return 1
  fi
}

web_script() { # 临时目录 脚本名：packages/web 有没有这个 npm 脚本（老提交没有 build:demo）
  [[ -f "$1/packages/web/package.json" ]] &&
    "$NODE" -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).scripts?.[process.argv[2]] ? 0 : 1)' \
      "$1/packages/web/package.json" "$2"
}

# 静态文件，两份：web/ 是正式驾驶舱（有 packages/web 就构建它，没有就用占位页）加健康页 /health/、版本标记
# release.json（由 root 写；香港只给经隧道来的读）；web-demo/ 是演示版（这一版的 packages/web 有 build:demo 才有），
# 按 FLEET_DEMO_PATH 这个路径构建，打包后自己扫一遍产物，出现真名、真域名（FLEET_DOMAIN）、GitHub 地址就构建失败。发到哪见 sync_web
DEMO_BUILT=""
build_web() { # 临时目录 日志
  local stage=$1 log=$2
  DEMO_BUILT=""
  if web_script "$stage" build; then
    echo "  构建驾驶舱前端（packages/web；登录页的「看演示版」指向 $FLEET_DEMO_PATH）"
    if ! as_fleet_in "$stage" env FLEET_DEMO_URL="$FLEET_DEMO_PATH" pnpm --filter ./packages/web run build >>"$log" 2>&1; then
      red "驾驶舱前端构建失败（没切版本）：$(tail -5 "$log" | tr '\n' ' ')"
      return 1
    fi
    if [[ ! -f "$stage/packages/web/dist/client/index.html" ]]; then
      red "驾驶舱前端构建完没有 packages/web/dist/client/index.html"
      return 1
    fi
    as_fleet_in "$stage" cp -R packages/web/dist/client web
    WEB_KIND="驾驶舱前端（packages/web）+ 健康页"
    if web_script "$stage" build:demo; then
      echo "  构建演示版（packages/web 的 build:demo，放在 $FLEET_DEMO_PATH）"
      if ! as_fleet_in "$stage" env FLEET_WEB_BASE="$FLEET_DEMO_PATH" FLEET_DEMO_FORBID="$FLEET_DOMAIN" \
        pnpm --filter ./packages/web run build:demo >>"$log" 2>&1; then
        red "演示版构建失败（打包后的扫描没过也算；没切版本）：$(tail -5 "$log" | tr '\n' ' ')"
        return 1
      fi
      if [[ ! -f "$stage/packages/web/dist-demo/client/index.html" ]]; then
        red "演示版构建完没有 packages/web/dist-demo/client/index.html"
        return 1
      fi
      as_fleet_in "$stage" cp -R packages/web/dist-demo/client web-demo
      DEMO_BUILT=$FLEET_DEMO_PATH
      WEB_KIND+="；演示版（$FLEET_DEMO_PATH）"
    fi
  else
    as_fleet_in "$stage" mkdir web
    as_fleet_in "$stage" cp deploy/hk/placeholder.html web/index.html
    WEB_KIND="占位页（这一版还没有驾驶舱前端）+ 健康页"
  fi
  if [[ -e "$stage/web/health" ]]; then
    red "驾驶舱前端自己带了 /health/，和健康页撞了"
    return 1
  fi
  as_fleet_in "$stage" cp -R deploy/web/health web/health
  if [[ ! -f "$stage/web/index.html" || ! -f "$stage/web/health/index.html" || ! -f "$stage/web/health/health.js" ]]; then
    red "静态文件不全：要有 index.html、health/index.html、health/health.js"
    return 1
  fi
}

# ── 迁移 ──

# 已跑过几个迁移。还没跑过（drizzle 的记账表还不在）是 0；读不到就失败，不当成 0
migrations_applied() {
  local exists
  exists=$(pg_admin -d fleet -c "select to_regclass('drizzle.__drizzle_migrations') is not null") || return 1
  if [[ "$exists" == f ]]; then
    echo 0
    return 0
  fi
  pg_admin -d fleet -c 'select count(*) from drizzle.__drizzle_migrations'
}

# 一份代码带几个迁移：drizzle 的迁移账 packages/db/migrations/meta/_journal.json 有几条（库里每跑一个记一行，两边可比）。
# 没有迁移入口就是 0；有入口却读不出条数就失败，不当成 0
count_migrations() { # 代码目录
  if [[ ! -f "$1/packages/db/src/bin/migrate.ts" ]]; then
    echo 0
    return 0
  fi
  "$NODE" -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(j.entries)) process.exit(1);
    console.log(j.entries.length);' "$1/packages/db/migrations/meta/_journal.json" 2>/dev/null
}

# 某一版带几个迁移：构建时记在 .fleet-release 里；早先构建、没记的，现场数它目录里的迁移账
release_migrations() { # 提交号
  local n
  n=$(marker_get "$1" migrations)
  if [[ "$n" =~ ^[0-9]+$ ]]; then
    echo "$n"
    return 0
  fi
  count_migrations "$RELEASES/$1"
}

# 迁移只进不退：退到某一版之前先比库。库里跑过的比那一版带的多，旧代码就要对着它不认识的表结构跑
# （比如新迁移改了主键、加了 NOT NULL 列，旧代码一写就报错，健康检查还查不出来）——不退，报红等人。读不清也不退
schema_allows() { # 提交号 [动作：退到（默认）/ 切到]
  local have want act=${2:-退到}
  if ! have=$(migrations_applied); then
    red "读不到库 fleet 里跑过几个迁移，不敢${act} ${1:0:12}"
    return 1
  fi
  if ! want=$(release_migrations "$1"); then
    red "读不出 ${1:0:12} 带几个迁移，不敢${act}它"
    return 1
  fi
  if ((have > want)); then
    red "不${act} ${1:0:12}：库 fleet 已跑过 $have 个迁移，那一版只带 $want 个（迁移只进不退，旧代码对着新表结构会出错）"
    return 1
  fi
}

# 迁移在切版本之前跑、只进不退：新迁移要写成旧代码照样能跑（先加后删）；退回时由 schema_allows 把关
migrate() { # 提交号
  local dir=$RELEASES/$1 before after out
  step "数据库迁移"
  if [[ ! -f "$dir/packages/db/src/bin/migrate.ts" ]]; then
    ok "这一版没有数据库迁移"
    return 0
  fi
  if ! before=$(migrations_applied); then
    red "读不到库 fleet 里已跑过的迁移"
    return 1
  fi
  if ! out=$(cd -- "$dir" && runuser -u fleet -- env -i HOME=/home/fleet PATH=/usr/bin:/bin LANG=C.UTF-8 "${DB_ENV[@]}" \
    "$NODE" packages/db/src/bin/migrate.ts 2>&1); then
    red "迁移失败（没切版本，在用的那版不受影响）：$(tail -5 <<<"$out" | tr '\n' ' ')"
    return 1
  fi
  if ! after=$(migrations_applied); then
    red "迁移跑完了，但读不到库 fleet 里已跑过的迁移"
    return 1
  fi
  if [[ "$before" == "$after" ]]; then
    ok "没有新迁移（库 fleet 已跑过 $after 个）"
  else
    changed "跑了新迁移：库 fleet 已跑过的从 $before 个到 $after 个"
  fi
}

# ── 目录 ──

# 目录那几张表的读回，一行「账号池|路由|阶段|阶段里挂的路由|装载器最近一笔操作记录的编号」。装载器只在改了库时记一笔
# （catalog.load），编号只增不减：前后一比就知道这次改没改。读不到、认不出就失败，不当成 0
catalog_readback() {
  local out
  out=$(pg_admin -d fleet -c "select (select count(*) from pools), (select count(*) from routes),
    (select count(*) from stage_policies), (select count(*) from stage_policy_routes),
    (select coalesce(max(id), 0) from audit_log where action = 'catalog.load')") || return 1
  if [[ ! "$out" =~ ^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$ ]]; then return 1; fi
  printf '%s' "$out"
}

# 读回的一行说成人话（不带操作记录编号）
catalog_words() { # catalog_readback 的一行
  local c=()
  IFS='|' read -r -a c <<<"$1"
  printf '账号池 %s、路由 %s、阶段 %s、阶段里挂的路由 %s' "${c[0]}" "${c[1]}" "${c[2]}" "${c[3]}"
}

# 装目录：迁移之后、切版本之前，以 fleet 跑这一版的装载器（packages/db/src/bin/catalog.ts）。它只补缺——驾驶舱里改过的不动，
# 每个阶段只排一次，跑几遍都一样；格式错、引用不存在它整批不写（装不成时这里再读回一次核对，不光信它）。文件不在、属主权限
# 不对、装不成、读不回，都停下、不切版本（在用的那版不受影响）。装完账号池、路由、阶段、阶段里挂的路由哪张是 0 行也判红：
# 引擎没有它们派不出活
load_catalog() { # 提交号
  local dir=$RELEASES/$1 have before after out rc=0 line first i empty="" counts=() was=()
  local names=(账号池 路由 阶段 阶段里挂的路由)
  step "装目录（$CATALOG → 库 fleet）"
  if [[ ! -f "$dir/packages/db/src/bin/catalog.ts" ]]; then
    ok "这一版没有目录装载器"
    return 0
  fi
  if [[ -L "$CATALOG" ]]; then
    red "$CATALOG 是符号链接，不读：放成普通文件（$CATALOG_META，见 docs/ops.md 第九节「目录配置」）；没切版本"
    return 1
  fi
  if [[ ! -e "$CATALOG" ]]; then
    red "没有 $CATALOG：先从保险箱放上来（docs/ops.md 第九节「目录配置」）再发布；没切版本"
    return 1
  fi
  have=$(stat -c '%U:%G %a' -- "$CATALOG" 2>/dev/null) || have="读不到"
  if [[ ! -f "$CATALOG" ]]; then
    red "$CATALOG 不是普通文件（$have）：放成普通文件、$CATALOG_META；没切版本"
    return 1
  fi
  if [[ "$have" != "$CATALOG_META" ]]; then
    red "$CATALOG 是「$have」，应为 $CATALOG_META；没切版本"
    return 1
  fi
  if ! before=$(catalog_readback); then
    red "装目录之前读不到库 fleet 里目录那几张表的行数：没装，没切版本"
    return 1
  fi
  out=$(cd -- "$dir" && runuser -u fleet -- env -i HOME=/home/fleet PATH=/usr/bin:/bin LANG=C.UTF-8 "${DB_ENV[@]}" \
    "$NODE" packages/db/src/bin/catalog.ts "$CATALOG" 2>&1) || rc=$?
  while IFS= read -r line; do
    if [[ -n "$line" ]]; then printf '    %s\n' "$line"; fi
  done <<<"$out"
  if ((rc != 0)); then
    first=$(head -1 <<<"$out")
    # 装载器是一个事务、出错整批不写；这里不光信它，再读回一次和装之前比，照实说库变没变
    if ! after=$(catalog_readback); then
      line="装完读不回库，库里变没变没查成"
    elif [[ "$after" == "$before" ]]; then
      line="读回核过：几张表的行数、装载器的操作记录都和装之前一样"
    else
      line="库变了（装之前 $(catalog_words "$before")，装载器的操作记录到 ${before##*|} 号；现在 $(catalog_words "$after")，到 ${after##*|} 号），要人看"
    fi
    red "目录没装成（装载器退出码 $rc，原话见上；$line；没切版本）：${first:-（没有输出）}"
    return 1
  fi
  if ! after=$(catalog_readback); then
    red "目录装完了，但读不回库 fleet 里目录那几张表的行数：没切版本"
    return 1
  fi
  IFS='|' read -r -a counts <<<"$after"
  IFS='|' read -r -a was <<<"$before"
  for i in 0 1 2 3; do
    if ((counts[i] == 0)); then empty+="${empty:+、}${names[i]} 0 行（装之前 ${was[i]} 行）"; fi
  done
  if [[ -n "$empty" ]]; then
    # 驾驶舱只摘得掉阶段里挂的路由（池、路由、阶段它删不了）；装载器又只补缺，阶段排过一次就不再动
    line="要人看"
    if [[ "$empty" == "${names[3]}"* ]]; then line="阶段排过一次装载器就不再动：是驾驶舱里摘光的，就去驾驶舱挂上"; fi
    red "装完读回：库 fleet 里${empty}，引擎派不出活（$line）；没切版本"
    return 1
  fi
  line=$(catalog_words "$after")
  if [[ "${before##*|}" == "${counts[4]}" ]]; then
    ok "目录已齐，这次一行没改（$line）"
  else
    changed "目录装进库（$line）"
  fi
}

# ── 路由两层 ──

# 路由两层那两张表的读回，一行「用途 → 模型的行数|模型 → 路由的行数」。读不到、认不出就失败，不当成 0
routing_readback() {
  local out
  out=$(pg_admin -d fleet -c "select (select count(*) from routing_purpose_models), (select count(*) from routing_catalog)") || return 1
  if [[ ! "$out" =~ ^[0-9]+\|[0-9]+$ ]]; then return 1; fi
  printf '%s' "$out"
}

# 读回的一行说成人话
routing_words() { # routing_readback 的一行
  printf '用途 → 模型 %s 行、模型 → 路由 %s 行' "${1%%|*}" "${1##*|}"
}

# 装路由两层的默认骨架（#574）：目录装完之后、切版本之前，以 fleet 跑这一版的装载器（packages/db/src/bin/routing.ts，骨架是这一版
# 自己带的 packages/db/routing.default.json，不放 /etc）。它只补缺——库里已有的用途、模型一行不动（驾驶舱改过的不覆盖）；骨架读不到、
# 认不出、引用对不上（骨架里的模型、路由库里没有）整批不写、退出 1。装不成、读不回、装完哪张表是 0 行，都停下、不切版本（在用的那版
# 不受影响）：选路按这两张表派活，空的就一条都派不出。路由由目录装载器先装进库，所以排在 load_catalog 后面
load_routing() { # 提交号
  local dir=$RELEASES/$1 before after out rc=0 line first empty=""
  step "装路由两层（这一版的 packages/db/routing.default.json → 库 fleet）"
  if [[ ! -f "$dir/packages/db/src/bin/routing.ts" ]]; then
    ok "这一版没有路由两层装载器"
    return 0
  fi
  if ! before=$(routing_readback); then
    red "装路由两层之前读不到库 fleet 里那两张表的行数：没装，没切版本"
    return 1
  fi
  out=$(cd -- "$dir" && runuser -u fleet -- env -i HOME=/home/fleet PATH=/usr/bin:/bin LANG=C.UTF-8 "${DB_ENV[@]}" \
    "$NODE" packages/db/src/bin/routing.ts 2>&1) || rc=$?
  while IFS= read -r line; do
    if [[ -n "$line" ]]; then printf '    %s\n' "$line"; fi
  done <<<"$out"
  if ((rc != 0)); then
    first=$(head -1 <<<"$out")
    # 装载器是一个事务、出错整批不写；这里不光信它，再读回一次和装之前比，照实说库变没变
    if ! after=$(routing_readback); then
      line="装完读不回库，库里变没变没查成"
    elif [[ "$after" == "$before" ]]; then
      line="读回核过：两张表的行数和装之前一样"
    else
      line="库变了（装之前 $(routing_words "$before")，现在 $(routing_words "$after")），要人看"
    fi
    red "路由两层没装成（装载器退出码 $rc，原话见上；$line；没切版本）：${first:-（没有输出）}"
    return 1
  fi
  if ! after=$(routing_readback); then
    red "路由两层装完了，但读不回库 fleet 里那两张表的行数：没切版本"
    return 1
  fi
  if [[ "${after%%|*}" == 0 ]]; then empty="用途 → 模型 0 行"; fi
  if [[ "${after##*|}" == 0 ]]; then empty+="${empty:+、}模型 → 路由 0 行"; fi
  if [[ -n "$empty" ]]; then
    red "装完读回：库 fleet 里路由两层${empty}（装之前 $(routing_words "$before")），选路派不出活（要人看）；没切版本"
    return 1
  fi
  line=$(routing_words "$after")
  # 装载器只插不删：两张表的行数都没变，就是这次一行没写
  if [[ "$after" == "$before" ]]; then
    ok "路由两层已齐，这次一行没改（$line）"
  else
    changed "路由两层装进库（$line）"
  fi
}

# ── 切版本 ──

# 单元读的环境文件在它这次起来之后改过没有（改了 engine.env、api.env 要重启才生效）
env_changed_since_start() { # 单元
  local start f
  start=$(systemctl show -p ExecMainStartTimestamp --timestamp=unix --value "$1" 2>/dev/null) || start=""
  start=${start#@}
  if [[ ! "$start" =~ ^[0-9]+$ ]]; then return 1; fi
  while read -r f _; do
    if [[ -f "$f" ]] && (($(stat -c %Y -- "$f") > start)); then return 0; fi
  done < <(systemctl show -p EnvironmentFiles --value "$1" 2>/dev/null)
  return 1
}

# 服务的主进程跑的是哪一版：它的当前目录。单元的 WorkingDirectory 是 current，起进程那一刻解成 <提交号> 目录，
# 之后 current 再怎么切，已经在跑的进程还在老目录里。没在跑就打印空
running_release() { # 单元
  local pid
  pid=$(unit_prop "$1" MainPID)
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then readlink -- "/proc/$pid/cwd" 2>/dev/null || true; fi
}

# 切到这一版：current 指过去；本机启用的服务装上这一版的单元、起来——主进程不在这一版的目录里（包括上次切完
# current、还没重启完就被打断）、或单元、环境文件变了，就重启；没启用的停掉撤掉；静态文件发到香港。
# 哪一步不成就记红、返回 1，退不退由调用方定。
activate() { # 提交号 事件（release / rollback / auto-rollback）
  local sha=$1 how=$2 dir=$RELEASES/$1 u reload=0 restart unit_file running
  local -A fresh=()
  if [[ "$(readlink -- "$RELEASES/current" 2>/dev/null)" != "$sha" ]]; then
    if ! ln -sfn -- "$sha" "$RELEASES/.current.new" || ! mv -Tf -- "$RELEASES/.current.new" "$RELEASES/current"; then
      red "把 current 切到 ${sha:0:12} 失败"
      return 1
    fi
    record "$sha" "$how"
    changed "current → ${sha:0:12}（$how）"
  else
    ok "current 已是 ${sha:0:12}"
  fi
  for u in "${APP_UNITS[@]}"; do
    unit_file=/etc/systemd/system/$u.service
    if has_service "$u"; then
      if [[ ! -f "$dir/.units/$u.service" ]]; then
        red "这一版没有 deploy/france/$u.service，起不了 $u"
        return 1
      fi
      put_file "$unit_file" root:root 644 "$(<"$dir/.units/$u.service")"
      fresh[$u]=$WROTE
      if ((WROTE)); then reload=1; fi
    elif [[ -e "$unit_file" ]]; then
      if ! systemctl disable --now --quiet "$u.service"; then
        red "停不掉 $u（本机 release.env 没启用它）"
        return 1
      fi
      rm -f -- "$unit_file"
      reload=1
      changed "停用并撤掉 $u（本机 release.env 没启用它）"
    fi
  done
  if ((reload)) && ! systemctl daemon-reload; then
    red "systemctl daemon-reload 失败"
    return 1
  fi
  for u in $FLEET_SERVICES; do
    restart=0
    if [[ "${fresh[$u]:-0}" == 1 ]] || env_changed_since_start "$u.service"; then restart=1; fi
    running=$(running_release "$u.service")
    if [[ -n "$running" && "$running" != "$dir" ]]; then
      echo "  · $u 的主进程还在跑 ${running##*/}（不是这一版），要重启"
      restart=1
    fi
    if ! ensure_unit_running "$u.service" "$restart"; then return 1; fi
  done
  if has_part web || sends_demo; then sync_web "$sha" || return 1; fi
  if has_part gateway; then deploy_gateway "$sha" || return 1; fi
}

gw() { gateway_ssh "$GATEWAY_KEY" "$HK_KNOWN_HOSTS" "root@$HK_TUNNEL" "$@"; }

# fleet-gateway-deploy status 的输出里某一项的值
status_field() { # 状态输出 键
  local line
  while IFS= read -r line; do
    if [[ "$line" == "$2="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <<<"$1"
}

# fleet-gateway-deploy 的输出：「changed …」记一笔改动，「ok …」照样报，别的原样列出来
report_gateway_lines() { # 输出
  local line
  while IFS= read -r line; do
    case $line in
    "changed "*) changed "${line#changed }" ;;
    "ok "*) ok "${line#ok }" ;;
    "") ;;
    *) echo "  · $line" ;;
    esac
  done <<<"$1"
}

# 切版本之前先试通要往香港发的那几样：不通就别切——切了健康检查必不过，新旧两版会一起被记成不健康
hk_reachable() {
  local bad=0
  if has_part web || sends_demo; then web_reachable || bad=1; fi
  if has_part gateway; then gateway_reachable || bad=1; fi
  return "$bad"
}

# 问一次香港网关的状态，放进 GW_STATUS。问不到（ssh 没连上、那头报错）或回答认不出（没有 config= 那一行）就报红、返回 1：
# 「没问到」不能当成「还没连上」去白等，红里也要说清是问不到
GW_STATUS=""
gw_status_or_red() { # 在做哪一步（写进红里）
  local out rc=0
  out=$(gw status 2>&1) || rc=$?
  if ((rc != 0)) || [[ -z "$(status_field "$out" config)" ]]; then
    red "$1：问不到香港飞书网关的状态（退出码 $rc）：$(tail -2 <<<"$out" | tr '\n' ' ')——查隧道、发网关的钥匙、香港的 fleet-gateway-deploy"
    return 1
  fi
  GW_STATUS=$out
}

# 发之前先问一次香港网关的入口（隧道、钥匙、fleet-gateway-deploy）：问不通就别切
gateway_reachable() {
  gw_status_or_red "没切版本" || return 1
  ok "香港飞书网关的入口是通的（在用 $(short "$(status_field "$GW_STATUS" current)" 还没有)）"
}

# 飞书网关发到香港：这一版有网关、香港的配置备齐了，才收下、切过去；进程由香港的 fleet-gateway-deploy 起、重启。
# 配置没备齐（比如机器人还没进团队群）就先不起，记待配——起了也只会读完配置就退、反复重启
deploy_gateway() { # 提交号
  local sha=$1 sum st config out rc=0
  GATEWAY_ACTIVATED=0
  gw_status_or_red "发飞书网关" || return 1
  st=$GW_STATUS
  sum=$(marker_get "$sha" gateway_sha256)
  if [[ -z "$sum" ]]; then
    pending "${sha:0:12} 没有飞书网关（那时还没有 packages/feishu），香港网关不动（在跑 $(short "$(status_field "$st" running)" 没有)）"
    return 0
  fi
  config=$(status_field "$st" config)
  if [[ "$config" != ok ]]; then
    pending "香港飞书网关的配置没备齐（${config#missing }），这次网关先不起；补齐后再发一次（docs/ops.md 第十二节）"
    return 0
  fi
  gw has "$sha" >/dev/null 2>&1 || rc=$?
  if ((rc == 1)); then
    if ! out=$(gw receive "$sha" "$sum" <"$RELEASES/$sha/gateway/gateway.mjs" 2>&1); then
      red "把飞书网关发到香港没成：$(tail -2 <<<"$out" | tr '\n' ' ')"
      return 1
    fi
    report_gateway_lines "$out"
  elif ((rc != 0)); then
    red "问香港有没有 ${sha:0:12} 的网关没成（退出码 $rc）"
    return 1
  fi
  if ! out=$(gw activate "$sha" 2>&1); then
    red "香港飞书网关没切到 ${sha:0:12}：$(tail -2 <<<"$out" | tr '\n' ' ')"
    return 1
  fi
  report_gateway_lines "$out"
  GATEWAY_ACTIVATED=1
}

# 发之前先试通香港（隧道、钥匙、rrsync；-n 什么都不传）：不通就别切——切了健康检查必不过，新旧两版会一起被记成不健康
web_reachable() {
  local empty out rc=0
  empty=$(mktemp -d)
  out=$(hk_rsync -n -r -e "$(web_upload_ssh "$UPLOAD_KEY" "$HK_KNOWN_HOSTS")" -- "$empty/" "root@$HK_TUNNEL:/" 2>&1) || rc=$?
  rmdir -- "$empty"
  if ((rc != 0)); then
    red "试着往香港传文件没通（rsync 退出码 $rc，没切版本）：$(tail -3 <<<"$out" | tr '\n' ' ')"
    return 1
  fi
  ok "往香港传静态文件的路是通的（试跑，没传东西）"
}

# 这一版的静态文件往香港哪几处发，一行一处：「本机源 香港路径 rsync 参数…」（sync_web 照着发，测试直接核对它）。
# - demo（自动发布不发）：演示版发到 FLEET_DEMO_PATH，只动那一个目录；它下面的 scopes/ 是可见范围，归 fleet-demo-scopes 推，
#   发布不删。这一版的演示版是按哪个路径构建的（标记里的 demo_path）就只往那发；和现在配的不一样就不发，等发一个新构建的版本。
# - web：驾驶舱静态文件（连健康页、版本标记 release.json）整套发到根地址，根上不是这一版的删掉——但演示版的目录一概
#   不碰（不管这次发不发演示版）。放在演示版后面：release.json 换了，就说明这次要发的都发完了（check_web 认它）。
web_plan() { # 提交号
  local dir=$RELEASES/$1 built
  if sends_demo; then
    built=$(marker_get "$1" demo_path)
    if [[ -d "$dir/web-demo" && -n "$built" && "$built" == "$FLEET_DEMO_PATH" ]]; then
      printf '%s %s %s\n' "$dir/web-demo/" "$FLEET_DEMO_PATH" "--delete-after --delay-updates --exclude=/scopes/"
    fi
  fi
  if has_part web; then
    printf '%s %s %s\n' "$dir/web/" / "--delete-after --delay-updates --exclude=$FLEET_DEMO_PATH"
  fi
}

# 静态文件经隧道发到香港（那头 rrsync 把路径限死在 /srv/fleet-dao-web、只许写）。每一处都先落临时名、最后一起换上，
# 旧的最后删：换的那一下之前浏览器拿到的都是整套旧页面。属主是香港的 root。
# 按内容比（-c）、不带修改时间（不加 -t）：每一版都是新构建的，时间必然不同，按时间比会把内容没变的文件也算成变化。
# 演示版那一处发成了，当场记下香港上的演示版是哪一版（record_demo）：后面的核对都照这份记录比
sync_web() { # 提交号
  local src dest args out line all="" demo
  local -a extra
  demo=$(marker_get "$1" demo_path)
  if ! sends_demo; then
    :
  elif [[ ! -d "$RELEASES/$1/web-demo" ]]; then
    pending "${1:0:12} 没带演示版（那时的 packages/web 还没有 build:demo），香港上的演示版这次不动"
  elif [[ "$demo" != "$FLEET_DEMO_PATH" ]]; then
    pending "${1:0:12} 的演示版是按 ${demo:-（没记）} 构建的，release.env 现在是 $FLEET_DEMO_PATH：这次不发演示版，发一个新构建的版本就好"
  fi
  while read -r src dest args; do
    read -ra extra <<<"$args"
    if ! out=$(hk_rsync -rpc -O --itemize-changes "${extra[@]}" \
      -e "$(web_upload_ssh "$UPLOAD_KEY" "$HK_KNOWN_HOSTS")" -- "$src" "root@$HK_TUNNEL:$dest" 2>&1); then
      red "把静态文件发到香港 $dest 没成：$(tail -3 <<<"$out" | tr '\n' ' ')"
      return 1
    fi
    if [[ -n "$out" ]]; then
      while IFS= read -r line; do all+="$dest $line"$'\n'; done <<<"$out"
    fi
    # 演示版这一处发成了就记（后面根地址那一处发不成，香港上的演示版也已经换了）
    if [[ "$dest" == "$FLEET_DEMO_PATH" ]]; then record_demo "$1" || return 1; fi
  done < <(web_plan "$1")
  if [[ -n "$all" ]]; then
    # 逐条列出来（最多 20 条）：数字不对时看得到是哪些
    head -20 <<<"$all" | sed 's/^/    /'
    changed "香港的静态文件换成 ${1:0:12} 那版（rsync 报了 $(grep -c . <<<"$all") 行变化）"
  else
    ok "香港的静态文件已是 ${1:0:12} 那版"
  fi
}

# 记下香港上的演示版现在是哪一版：提交号、什么时候发的、发在哪个路径、首页的 sha256（DEMO_RECORD，核对照它比）。
# 和上次记的是同一版、同一个首页就不动（同一个提交再发一遍什么都不变）；先落临时名再换上，写一半不算数
record_demo() { # 提交号
  local sum
  if ! sum=$(file_sum "$RELEASES/$1/web-demo/index.html"); then
    red "演示版发到了香港，却算不出 ${1:0:12} 的演示版首页的指纹：记不下香港上的是哪一版"
    return 1
  fi
  if [[ "$(kv_get "$DEMO_RECORD" commit) $(kv_get "$DEMO_RECORD" path) $(kv_get "$DEMO_RECORD" index_sha256)" == \
    "$1 $FLEET_DEMO_PATH $sum" ]]; then
    return 0
  fi
  if ! printf 'commit=%s\npublished=%s\npath=%s\nindex_sha256=%s\n' "$1" "$(date -u +%FT%TZ)" "$FLEET_DEMO_PATH" "$sum" \
    >"$DEMO_RECORD.new" || ! mv -Tf -- "$DEMO_RECORD.new" "$DEMO_RECORD"; then
    red "演示版发到了香港，却记不下是哪一版（$DEMO_RECORD 写不进去）：之后的核对拿它比会报红"
    return 1
  fi
  changed "记下香港上的演示版是 ${1:0:12} 那版（$DEMO_RECORD）"
}

# ── 健康检查 ──

# 健康报告（packages/api 的 health.ts）：{ ok, checks: { 名: { ok, code?, message? } } }。
# 认得出就逐项打印「名<TAB>ok|bad<TAB>原因」，认不出退出 1。故意不复用后端和健康页的解析代码：自己查自己查不出错
# shellcheck disable=SC2016 # 单引号里是给 node 的 JS，模板字符串不归 shell 展开
report_items() {
  printf '%s' "$1" | "$NODE" -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let r;
      try { r = JSON.parse(s); } catch { process.exit(1); }
      const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
      if (!isObj(r) || typeof r.ok !== "boolean" || !isObj(r.checks)) process.exit(1);
      for (const [k, v] of Object.entries(r.checks)) {
        const good = isObj(v) && v.ok === true;
        const why = good ? "" : isObj(v) && typeof v.message === "string" && v.message ? v.message : "没给原因";
        console.log(`${k}\t${good ? "ok" : "bad"}\t${why.replace(/\s+/g, " ")}`);
      }
    });'
}

# 驾驶舱接口上的 /healthz：打印「状态码<TAB>正文」；连不上返回 1
api_healthz() {
  local out
  out=$(curl -sS --max-time 10 -w '\n%{http_code}' "http://$COCKPIT/healthz" 2>&1) || return 1
  printf '%s\t%s' "${out##*$'\n'}" "${out%$'\n'*}"
}

# 切之前后端的健康报告（后端没在跑就空）：切之后逐项对比，之前好的变坏了才算这一版的错
api_report_before() {
  local got
  if ! has_service fleet-api || [[ "$(systemctl is-active fleet-api.service 2>/dev/null)" != active ]]; then return 0; fi
  got=$(api_healthz) || return 0
  report_items "${got#*$'\t'}" 2>/dev/null || true
}

# 服务起来后再看一会儿：还在跑、主进程没换、没被重启过，才算起稳了
settle_services() {
  local u bad=0
  local -A pid=() restarts=()
  for u in $FLEET_SERVICES; do
    pid[$u]=$(unit_prop "$u.service" MainPID)
    restarts[$u]=$(unit_prop "$u.service" NRestarts)
  done
  sleep "$SETTLE_SECONDS"
  for u in $FLEET_SERVICES; do
    if [[ "$(systemctl is-active "$u.service" 2>/dev/null)" != active || "$(unit_prop "$u.service" MainPID)" != "${pid[$u]}" ||
      "$(unit_prop "$u.service" NRestarts)" != "${restarts[$u]}" ]]; then
      red "$u 起来后没稳住（${SETTLE_SECONDS} 秒里退出或重启过，累计重启 $(unit_prop "$u.service" NRestarts) 次）：journalctl -u $u -n 50"
      bad=1
    else
      ok "$u 起稳了（pid ${pid[$u]}，${SETTLE_SECONDS} 秒没退出）"
    fi
  done
  return "$bad"
}

# 起着的服务跑的真是这一版：主进程的当前目录就是这一版的目录（不是 current 指过去了、进程还是旧的）
check_running_release() { # 提交号
  local u running bad=0
  for u in $FLEET_SERVICES; do
    running=$(running_release "$u.service")
    if [[ "$running" == "$RELEASES/$1" ]]; then
      ok "$u 的主进程跑的是这一版（${1:0:12}）"
    else
      red "$u 的主进程跑的不是这一版：在「${running:-没在跑}」"
      bad=1
    fi
  done
  return "$bad"
}

# 会随时间自己变红、和换没换版无关的健康项：只标待处理，不当成这一版的错去退回。
# draft_backlog = 最早一张待开单等得太久：发版那一两分钟里恰好跨过时限，好版本也会被退回。
# judge = 判断题最近一次真调用没成：跟着上游（连不上、限流、钥匙失效）自己变红；判断题只是帮着判，红了引擎照规则走。
# deploy_lag = 线上版本跟不上主线：主线一动就可能落后（自动发布正在追、在等 CI 或空闲），和这一版好不好无关。
# feishu_gateway = 飞书网关（香港）不来了：网关、隧道、香港出事都会；后端刚重启、网关还在退避重连时是「没查成」，和这一版无关。
# session_org = 引擎切会话用户挂的组织没成、切完读回不在线、拼车恢复时刻读不到（#157）：跟着上游额度、登录自己变红，引擎每
#   15 分钟判一次，和这一版无关。
# canary = 全流程巡检最近一轮断了、没跑成、太久没跑完一轮（#223）：跟着每 6 小时一轮的结论自己变红，和这一版无关。
# github_app = GitHub 两个机器人的权限不对、没查成（#299）：GitHub 那边有人改了 App 权限、新权限在安装处没点接受就红，引擎
#   每小时自检一次、好了自己撤，和这一版无关。
# watchdog = 看门狗（引擎每 5 分钟一轮，#203）最近一轮没跑成、过了 15 分钟没跑完一轮：跟着引擎自己变红；切版本那一刻它的下一轮
#   还没来（第一次带上它的那版切上去时它一轮都还没跑），和这一版好不好无关。
# 这里的名字都得是后端真报的项（packages/api 的 health.test.ts 核对，改了名那边报警）
DRIFTING_HEALTH_ITEMS="draft_backlog judge deploy_lag feishu_gateway session_org canary github_app watchdog"

# 切之后的健康报告逐项和切之前比：之前好的变坏了才算这一版的错（返回 1）；会自己变红的那几项只标待处理
compare_api_items() { # 切之前的逐项结果 切之后的逐项结果
  local k st why was bad=0
  while IFS=$'\t' read -r k st why; do
    if [[ -z "$k" ]]; then continue; fi
    was=$(awk -F '\t' -v k="$k" '$1 == k { print $2 }' <<<"$1")
    if [[ "$st" == ok ]]; then
      ok "后端报 $k 好"
    elif [[ "$k" == engine ]] && ! has_service fleet-engine; then
      # 本机没启用引擎（$RELEASE_ENV 的 FLEET_SERVICES 里没有它，比如法国 2026-09-29 起临时关了）：后端报「引擎不在」是预期的；
      # 没这一条，切之前引擎还好、这一版把它撤掉，就会被当成这一版的错退回
      pending "后端报 engine 不好：$why（本机没启用引擎：$RELEASE_ENV 的 FLEET_SERVICES 里没有 fleet-engine，是预期的，不退回）"
    elif [[ " $DRIFTING_HEALTH_ITEMS " == *" $k "* ]]; then
      pending "后端报 $k 不好：$why（这一项会随时间自己变红，和换没换版无关，不退回）"
    elif [[ "$was" == ok ]]; then
      red "fleet-api：$k 切之前是好的，换了这一版不好了：$why"
      bad=1
    else
      pending "后端报 $k 不好：$why（切之前就不好或第一次起，不算这一版的错，不退回）"
    fi
  done <<<"$2"
  return "$bad"
}

check_api() { # 切之前的逐项结果
  local before=$1 got code body items bad=0
  if ! got=$(api_healthz); then
    red "fleet-api：驾驶舱接口 http://$COCKPIT/healthz 连不上"
    return 1
  fi
  code=${got%%$'\t'*}
  body=${got#*$'\t'}
  if [[ "$code" != 200 && "$code" != 503 ]] || ! items=$(report_items "$body"); then
    red "fleet-api：/healthz 回的不是健康报告（HTTP $code）"
    return 1
  fi
  ok "fleet-api：驾驶舱接口 $COCKPIT 在答健康报告（HTTP $code）"
  compare_api_items "$before" "$items" || bad=1
  if ! timeout 5 bash -c "exec 3<>/dev/tcp/${AGENT_API%:*}/${AGENT_API#*:}" 2>/dev/null; then
    red "fleet-api：fleet 命令接口 $AGENT_API 连不上"
    bad=1
  else
    ok "fleet-api：fleet 命令接口 $AGENT_API 在听"
  fi
  return "$bad"
}

# 引擎工人：任务队列上有它（身份是「进程号@主机名」）在取工作流任务和活动任务
# fleet-temporal task-queue describe -o json 的回答里，身份以这个前缀开头的取活者，工作流任务和活动任务是不是都在取。
# 回答认不出（不是 JSON）也算不在，不当成「没问题」
engine_polling() { # JSON 身份前缀
  printf '%s' "$1" | "$NODE" -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let r; try { r = JSON.parse(s); } catch { process.exit(1); }
      const mine = ((r && r.pollers) || []).filter((p) => typeof p.identity === "string" && p.identity.startsWith(process.argv[1]));
      const types = new Set(mine.map((p) => p.taskQueueType));
      process.exit(types.has("workflow") && types.has("activity") ? 0 : 1);
    });' "$2"
}

check_engine() {
  local pid json i
  pid=$(unit_prop fleet-engine.service MainPID)
  for ((i = 0; i < ENGINE_POLL_WAIT; i += 3)); do
    json=$(tcli task-queue describe --task-queue "$TASK_QUEUE" -o json 2>/dev/null) || json=""
    if engine_polling "$json" "$pid@"; then
      ok "fleet-engine：引擎工人（pid $pid）在任务队列 $TASK_QUEUE 上取工作流任务和活动任务"
      return 0
    fi
    sleep 3
  done
  red "fleet-engine：引擎工人（pid $pid）${ENGINE_POLL_WAIT} 秒还没到任务队列 $TASK_QUEUE 取活：journalctl -u fleet-engine -n 50"
  return 1
}

# 香港在发的对不对：经隧道连香港的 nginx（证书照常按域名校验）。发了 web 的，读 release.json 与健康页——
# release.json 香港只给经隧道来的，别处来的是 404；配了 demo 的，看演示版是不是上次发的那份（check_demo）。
# 没配的那样不查（根地址上是什么由人定）
check_web() { # 提交号
  local body commit code bad=0
  if has_part web; then
    if ! body=$(curl -sS -f --max-time 10 --resolve "$FLEET_DOMAIN:443:$HK_TUNNEL" "https://$FLEET_DOMAIN/release.json" 2>&1); then
      red "从香港取不到 https://$FLEET_DOMAIN/release.json：$(tail -1 <<<"$body")"
      return 1
    fi
    commit=$(json_field "$body" commit)
    if [[ "$commit" != "$1" ]]; then
      red "香港在发的是「${commit:0:12}」，不是 ${1:0:12}"
      return 1
    fi
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$FLEET_DOMAIN:443:$HK_TUNNEL" "https://$FLEET_DOMAIN/health/") || code=000
    if [[ "$code" != 200 ]]; then
      red "健康页 https://$FLEET_DOMAIN/health/ 返回「$code」"
      return 1
    fi
    ok "香港在发 ${1:0:12} 这版：首页与健康页 https://$FLEET_DOMAIN/health/ 都在"
  fi
  if has_part demo; then check_demo "$1" || bad=1; fi
  return "$bad"
}

# 演示版：香港上的要是上次发的那份（DEMO_RECORD，发成了当场记）。人手动发布当场发、当场记，这时就是这一版的；自动发布
# 不发演示版（对外，要人确认），香港上的就该还是上次人发的——和这一版的不一样不算错，列出来等人定什么时候发。
# 比的是首页：里面写着资源文件的名字（带内容哈希），一个字节都不差才算同一份。在演示版里点到别的页再刷新（深链接），要
# 回落到演示版自己的首页、不能回落到根上那一份——回落错了是香港的 nginx 站点还没有演示版那一段（hk.sh 没重跑，或两台的
# FLEET_DEMO_PATH 不一样）
check_demo() { # 提交号
  local commit at path want got mine url="https://$FLEET_DOMAIN$FLEET_DEMO_PATH"
  if [[ ! -e "$DEMO_RECORD" ]]; then
    pending "没有发演示版的记录（$DEMO_RECORD；人手动发一次演示版就有）：香港 $url 是不是上次发的那份，没查成"
    return 0
  fi
  if [[ ! -r "$DEMO_RECORD" ]]; then
    red "发演示版的记录 $DEMO_RECORD 读不了：香港上的演示版对不上号"
    return 1
  fi
  commit=$(kv_get "$DEMO_RECORD" commit)
  at=$(kv_get "$DEMO_RECORD" published)
  path=$(kv_get "$DEMO_RECORD" path)
  want=$(kv_get "$DEMO_RECORD" index_sha256)
  if ! is_sha "$commit" || ! demo_path_ok "$path" || [[ ! "$want" =~ ^[0-9a-f]{64}$ ]]; then
    red "发演示版的记录认不出（$DEMO_RECORD 要有 commit、path、index_sha256）：香港上的演示版对不上号"
    return 1
  fi
  if [[ "$path" != "$FLEET_DEMO_PATH" ]]; then
    pending "演示版上次发在 $path，release.env 现在是 $FLEET_DEMO_PATH：新路径上还没发过，人手动发一次（bash $DEPLOY_DIR/release.sh）"
    return 0
  fi
  if ! got=$(page_sum "$FLEET_DEMO_PATH"); then
    red "从香港取不到演示版的首页 $url"
    return 1
  fi
  if [[ "$got" != "$want" ]]; then
    red "香港 $url 给的不是上次发的演示版（${commit:0:12}，${at:-时间没记} 发的）：被改过或没发全，要人看"
    return 1
  fi
  ok "演示版是上次发的那份（${commit:0:12}，${at:-时间没记} 发的；$url）"
  if [[ -f "$RELEASES/$1/web-demo/index.html" ]] && mine=$(file_sum "$RELEASES/$1/web-demo/index.html") &&
    [[ "$mine" != "$want" ]]; then
    echo "  · ${1:0:12} 的演示版和香港上的不一样，还没发：演示版对外，按版本由人确认后手动发（bash $DEPLOY_DIR/release.sh）"
  fi
  if [[ "$(page_sum "${FLEET_DEMO_PATH}tasks/release-check")" == "$want" ]]; then
    ok "演示版的深链接回落到它自己的首页（${FLEET_DEMO_PATH}tasks/…）"
  else
    pending "演示版的深链接（${FLEET_DEMO_PATH}tasks/…）没回落到演示版自己的首页：香港 git pull 后重跑 deploy/hk.sh，hk.env 的 FLEET_DEMO_PATH 写 $FLEET_DEMO_PATH"
  fi
}

# 经隧道从香港取一页（证书照常按域名校验），不是 200 就算没取到
fetch_page() { # 站内路径
  curl -sS -f --max-time 10 --resolve "$FLEET_DOMAIN:443:$HK_TUNNEL" "https://$FLEET_DOMAIN$1"
}

# 经隧道从香港取的一页、本机一个文件的 sha256（64 位十六进制）。取不到（不是 200）、读不了返回 1，不拿空的去比
page_sum() { # 站内路径
  local out
  out=$(fetch_page "$1" 2>/dev/null | sha256sum) || return 1
  printf '%s' "${out:0:64}"
}
file_sum() { # 文件
  local out
  out=$(sha256sum <"$1") || return 1
  printf '%s' "${out:0:64}"
}

json_field() { # JSON 键
  printf '%s' "$1" | "$NODE" -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const v = JSON.parse(s)[process.argv[1]]; if (typeof v === "string") process.stdout.write(v); } catch {}
    });' "$2"
}

# 健康页读的 /healthz 经香港转不转得到法国：不归发布管（香港的站点配置、隧道），不计入健康检查，只报出来
check_chain() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --resolve "$FLEET_DOMAIN:443:$HK_TUNNEL" "https://$FLEET_DOMAIN/healthz") || code=000
  case $code in
  200) ok "健康页那条路通：香港 → 隧道 → 法国后端的 /healthz 回 200（全好）" ;;
  503) ok "健康页那条路通：香港 → 隧道 → 法国后端的 /healthz 回 503（有项不好，健康页会照实报红）" ;;
  502 | 504)
    if ! has_service fleet-api; then
      pending "健康页现在三项全红（香港转 /healthz 回 $code）：本机没启用 fleet-api（$RELEASE_ENV 的 FLEET_SERVICES）"
    elif api_healthz >/dev/null; then
      pending "本机后端在答，香港却转不过来（HTTP $code）：看香港 nginx 与隧道"
    else
      # 本机后端没在答，上面已经记了红；健康页这时照实显示「香港连不上法国后端」
      echo "  · 健康页现在三项全红（香港转 /healthz 回 $code）：本机后端没在答"
    fi
    ;;
  404) pending "香港还没转 /healthz（HTTP 404）：香港 git pull 后重跑 deploy/hk.sh" ;;
  *) pending "经香港取 /healthz 没取成（HTTP $code）" ;;
  esac
}

# 这一版健不健康：起了的服务起稳了、各自该通的通了、香港在发这一版。不过返回 1（原因已记成红）
health_gate() { # 提交号 切之前后端的逐项结果
  local sha=$1 before=${2:-} bad=0
  step "健康检查（${sha:0:12}）"
  if [[ -n "$FLEET_SERVICES" ]]; then
    settle_services || bad=1
    check_running_release "$sha" || bad=1
  fi
  if has_service fleet-api; then check_api "$before" || bad=1; fi
  if has_service fleet-engine; then check_engine || bad=1; fi
  if has_part web || has_part demo; then check_web "$sha" || bad=1; fi
  if has_part gateway && ((GATEWAY_ACTIVATED)); then check_gateway "$sha" || bad=1; fi
  check_chain
  return "$bad"
}

# 香港飞书网关：主进程跑的是这一版、这次起来之后连上了飞书长连接，而且起稳了（一段时间里没退出、没重启）。
# 连不上法国后端不算这一版的错：法国 fleet-api 没起时就是这样，网关照实回「后端连不上」、不会崩——记待配
check_gateway() { # 提交号
  local sha=$1 st i pid restarts config
  gw_status_or_red "飞书网关的健康检查" || return 1
  st=$GW_STATUS
  config=$(status_field "$st" config)
  if [[ "$config" != ok ]]; then
    pending "香港飞书网关的配置没备齐（${config#missing }），网关没起"
    return 0
  fi
  for ((i = 0; ; i += 3)); do
    if [[ "$(status_field "$st" running)" == "$sha" && "$(status_field "$st" active)" == active &&
      "$(status_field "$st" connected)" == yes ]]; then break; fi
    if ((i >= GATEWAY_WAIT)); then
      red "香港飞书网关 ${GATEWAY_WAIT} 秒还没以 ${sha:0:12} 连上飞书（主进程在跑「$(status_field "$st" running)」，$(status_field "$st" active)，连上了：$(status_field "$st" connected)）：香港 journalctl -u fleet-feishu -n 50"
      return 1
    fi
    sleep 3
    gw_status_or_red "飞书网关的健康检查" || return 1
    st=$GW_STATUS
  done
  pid=$(status_field "$st" pid)
  restarts=$(status_field "$st" restarts)
  sleep "$SETTLE_SECONDS"
  gw_status_or_red "飞书网关的健康检查" || return 1
  st=$GW_STATUS
  if [[ "$(status_field "$st" pid)" != "$pid" || "$(status_field "$st" restarts)" != "$restarts" ||
    "$(status_field "$st" active)" != active ]]; then
    red "香港飞书网关连上飞书之后没稳住（${SETTLE_SECONDS} 秒里退出或重启过）：香港 journalctl -u fleet-feishu -n 50"
    return 1
  fi
  ok "香港飞书网关 ${sha:0:12} 在跑、连上了飞书长连接（pid $pid，这次起来后处理过 $(status_field "$st" messages) 条消息）"
  case $(status_field "$st" backend) in
  reachable) ok "香港飞书网关经隧道连得上法国后端" ;;
  refused) pending "香港飞书网关连不上法国后端（连接被拒：法国 fleet-api 没起）；网关照实回「后端连不上」，没有崩" ;;
  *) pending "香港飞书网关连法国后端：$(status_field "$st" backend)" ;;
  esac
}

mark_unhealthy() { # 提交号
  record "$1" unhealthy
  echo "  · 历史里把 ${1:0:12} 记成不健康：以后 --rollback 不会退到它"
}

# ── 清旧版 ──

# 留 KEEP 版：在用的、上一版，再按最近用过的顺序补满；没用过的（构建了没切过去）按构建时间排在后面
prune() {
  local cur prev s d kept=() order=()
  cur=$(current_sha)
  prev=$(previous_sha)
  if [[ -f "$HISTORY" ]]; then mapfile -t order < <(tac -- "$HISTORY" | awk '!seen[$2]++ { print $2 }'); fi
  while read -r _ d; do order+=("$d"); done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn)
  for s in "$cur" "$prev" "${order[@]}"; do
    if ! is_sha "$s" || [[ ! -d "$RELEASES/$s" ]] || [[ " ${kept[*]} " == *" $s "* ]]; then continue; fi
    if ((${#kept[@]} < KEEP)) || [[ "$s" == "$cur" || "$s" == "$prev" ]]; then kept+=("$s"); fi
  done
  for d in "$RELEASES"/*; do
    s=${d##*/}
    if ! is_sha "$s" || [[ -L "$d" || ! -d "$d" ]]; then continue; fi
    if [[ " ${kept[*]} " != *" $s "* ]]; then
      rm -rf -- "$d"
      changed "清掉旧版 ${s:0:12}（只留最近 $KEEP 版）"
    fi
  done
  # 上次没构建完留下的临时目录（发布有锁，这时不会有别的发布在用它们）
  for d in "$RELEASES"/.build-*; do
    if [[ -d "$d" ]]; then
      rm -rf -- "$d"
      changed "清掉没构建完的临时目录 ${d##*/}"
    fi
  done
}

# 这次给在跑的会话多少宽限（秒）：--now 不给
drain_grace() { if ((NOW_MODE)); then echo 0; else echo "$DRAIN_GRACE"; fi; }

# ── 三种用法 ──

do_release() { # 要发的提交（空 = 主线最新）
  local cur before=""
  fetch_code "$1"
  # 排空请求在构建之前写：宽限和构建一起走
  drain_request "$SHA" "$(drain_grace)"
  build_release "$SHA"
  if ((AUTO)); then auto_gate; fi
  cur=$(current_sha)
  hk_reachable || return 1
  # 直接发一个老提交也一样把关：库里的迁移比它带的多就不切（drizzle 碰到比代码新的迁移记录什么也不做、也不报错，
  # 光靠迁移那一步拦不住）。放在迁移之前：老版本的迁移程序连库都不碰
  schema_allows "$SHA" 切到 || return 1
  # 迁移之前停引擎：排空的这几分钟里旧引擎还在跑，不能让它对着新的库结构
  drain_engine || return 1
  migrate "$SHA"
  load_catalog "$SHA" || return 1
  load_routing "$SHA" || return 1
  before=$(api_report_before)
  step "切到 ${SHA:0:12}（在用：$(short "$cur" 还没有)）"
  if activate "$SHA" release && health_gate "$SHA" "$before"; then
    # 之前判过不健康（比如那时本机配置没备齐）、这次过了：记回健康，它又能当退回的目标
    if [[ "$(last_event "$SHA")" == unhealthy ]]; then
      record "$SHA" recovered
      changed "历史里把 ${SHA:0:12} 记回健康（之前判过不健康，这次健康检查过了）"
    fi
    ok "发布完成：在用 ${SHA:0:12}"
  elif [[ -z "$cur" ]]; then
    mark_unhealthy "$SHA"
    red "${SHA:0:12} 没过健康检查；这是头一版，没有上一版可退"
  elif [[ "$cur" == "$SHA" ]]; then
    red "在用的就是 ${SHA:0:12}，它的健康检查没过（没换版本，不退）"
  else
    mark_unhealthy "$SHA"
    step "自动退回上一版 ${cur:0:12}"
    if ! schema_allows "$cur"; then
      red "${SHA:0:12} 没过健康检查，也没自动退回（库的迁移比上一版新，见上）：停在 ${SHA:0:12}，要人来看"
    elif
      # 新版不健康：它刚起来那几分钟起的会话不给宽限，马上停下（按编号续上），尽快退回
      drain_request "$cur" 0
      drain_engine && activate "$cur" auto-rollback && health_gate "$cur" ""
    then
      ok "已退回 ${cur:0:12}，健康检查过了"
      red "${SHA:0:12} 没过健康检查，已自动退回 ${cur:0:12}（原因见上面的红）"
    else
      mark_unhealthy "$cur"
      red "退回 ${cur:0:12} 之后健康检查也没过：要人来看"
      red "${SHA:0:12} 没过健康检查，已自动退回 ${cur:0:12}（原因见上面的红）"
    fi
  fi
  prune
}

do_rollback() {
  local cur prev
  cur=$(current_sha)
  prev=$(previous_sha)
  if [[ -z "$prev" ]]; then
    red "没有可退的上一版（历史里没有别的在用过、没被判过不健康、目录还在的版本）"
    return 1
  fi
  step "退回 ${prev:0:12}（在用：$(short "$cur" 没有)）"
  schema_allows "$prev" || return 1
  hk_reachable || return 1
  drain_request "$prev" "$(drain_grace)"
  drain_engine || return 1
  if activate "$prev" rollback && health_gate "$prev" ""; then
    ok "已退回 ${prev:0:12}"
  else
    mark_unhealthy "$prev"
    red "退回 ${prev:0:12} 之后健康检查没过：要人来看"
  fi
}

do_check() {
  local cur prev d s
  step "版本"
  cur=$(current_sha)
  prev=$(previous_sha)
  if [[ -z "$cur" ]]; then
    pending "还没发布过（$RELEASES/current 不在）"
    return 0
  fi
  ok "在用 ${cur:0:12}（$(marker_get "$cur" built) 建的，静态文件：$(marker_get "$cur" web)）；上一版 $(short "$prev" 没有)"
  for d in "$RELEASES"/*; do
    s=${d##*/}
    if is_sha "$s" && [[ -d "$d" && ! -L "$d" ]]; then echo "  · 留着的版本 ${s:0:12}（$(marker_get "$s" built) 建的）"; fi
  done
  if [[ -f "$HISTORY" ]]; then
    echo "  最近的切换："
    tail -5 -- "$HISTORY" | sed 's/^/    /'
  fi
  check_auto_release
  step "服务"
  for s in "${APP_UNITS[@]}"; do
    if has_service "$s"; then
      if [[ "$(systemctl is-active "$s.service" 2>/dev/null)" == active ]]; then
        ok "$s 在跑（pid $(unit_prop "$s.service" MainPID)，累计重启 $(unit_prop "$s.service" NRestarts) 次）"
      else
        red "$s 启用了但没在跑：journalctl -u $s -n 50"
      fi
    else
      echo "  · $s 本机没启用（$RELEASE_ENV 的 FLEET_SERVICES）"
    fi
  done
  if has_part gateway && [[ -n "$(marker_get "$cur" gateway_sha256)" ]]; then GATEWAY_ACTIVATED=1; fi
  health_gate "$cur" "" || true
}

# 自动发布的读数（fleet-auto-release 每一轮写的状态文件）照实列出来：主线头、CI、在用的落后几个、这一轮干了什么、规矩同步到哪、
# 装机脚本装到哪。跟不跟得上主线的判定在后端 /healthz 的 deploy_lag 一项（下面健康检查里逐项列出）
check_auto_release() {
  local out line
  step "自动发布"
  if [[ "$(systemctl is-active fleet-auto-release.timer 2>/dev/null)" == active ]]; then
    ok "fleet-auto-release.timer 在跑（每 5 分钟看一轮主线）"
  else
    pending "fleet-auto-release.timer 没在跑：不会自动跟上主线（装：bash /srv/fleet-dao/deploy/france.sh）"
  fi
  if [[ ! -f "$AUTO_STATE" ]]; then
    pending "还没有自动发布的读数（$AUTO_STATE）"
    return 0
  fi
  # shellcheck disable=SC2016 # 单引号里是给 node 的 JS，模板字符串不归 shell 展开
  if ! out=$("$NODE" --input-type=module -e '
    const [lib, file] = process.argv.slice(1);
    try {
      const { STATE_SCHEMA, summary } = await import((await import("node:url")).pathToFileURL(lib).href);
      const st = JSON.parse((await import("node:fs")).readFileSync(file, "utf8"));
      if (st?.schema !== STATE_SCHEMA) throw new Error(`格式认不出（schema ${st?.schema}，应为 ${STATE_SCHEMA}）`);
      console.log(`上一轮 ${st.ranAt}`);
      for (const part of summary(st).split("；")) console.log(part);
    } catch (e) {
      console.log(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }' \
    "$DEPLOY_DIR/france/auto-release/lib.mjs" "$AUTO_STATE" 2>&1); then
    pending "自动发布的读数认不出（$AUTO_STATE）：$(tail -1 <<<"$out")"
    return 0
  fi
  while IFS= read -r line; do printf '  · %s\n' "$line"; done <<<"$out"
}

# 发布交给 systemd 跑（一个临时服务 fleet-dao-release-<时间>），这个终端只跟着看日志：跳板断线、终端关了，
# 发布照样跑完，不会停在「切完 current、服务还没重启完」的半截。断了之后看进度：tail -f 那份日志（开头会打印路径）
detach() { # 原样的参数…
  local id unit log line rc=""
  id=$(date -u +%Y%m%dT%H%M%SZ)-$$
  unit=fleet-dao-release-$id
  install -d -o root -g root -m 750 "$RELEASES/.logs"
  log=$RELEASES/.logs/$id.log
  : >"$log"
  if ! systemd-run --quiet --unit="$unit" --collect --setenv=FLEET_RELEASE_DETACHED=1 --setenv=HOME=/root \
    -p StandardOutput="append:$log" -p StandardError="append:$log" \
    /bin/bash -c 'bash "$@"; echo "fleet-dao-release-exit=$?"' _ "$DEPLOY_DIR/release.sh" "$@"; then
    echo "起不了发布用的临时服务（systemd-run）" >&2
    exit 1
  fi
  echo "发布在临时服务 $unit 里跑，日志 $log（这个终端断了也不影响它）"
  tail -n +1 -f -- "$log" &
  local tailer=$!
  while [[ "$(systemctl is-active "$unit" 2>/dev/null)" =~ ^(active|activating|deactivating)$ ]]; do sleep 1; done
  sleep 1
  kill "$tailer" 2>/dev/null || true
  wait "$tailer" 2>/dev/null || true
  line=$(grep -a '^fleet-dao-release-exit=' -- "$log" | tail -1) || line=""
  rc=${line#fleet-dao-release-exit=}
  if [[ ! "$rc" =~ ^[0-9]+$ ]]; then
    echo "发布的临时服务结束了，但没留下退出码：看 $log、journalctl -u $unit" >&2
    exit 1
  fi
  # 日志只留最近 30 份
  find "$RELEASES/.logs" -maxdepth 1 -name '*.log' -printf '%T@ %p\n' | sort -rn | tail -n +31 | cut -d' ' -f2- |
    while IFS= read -r line; do rm -f -- "$line"; done
  exit "$rc"
}

main() {
  local mode=release target="" arg
  UNMERGED=0
  for arg in "$@"; do
    case $arg in
    --rollback) mode=rollback ;;
    --check) mode=check ;;
    --unmerged) UNMERGED=1 ;;
    --auto) AUTO=1 ;;
    --busy-ok) BUSY_OK=1 ;;
    --now) NOW_MODE=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      exit 64
      ;;
    *)
      if [[ -n "$target" || ! "$arg" =~ ^[0-9a-f]{7,40}$ ]]; then
        usage >&2
        exit 64
      fi
      target=$arg
      ;;
    esac
  done
  if [[ "$mode" != release && (-n "$target" || "$UNMERGED" == 1 || "$AUTO" == 1) ]]; then
    usage >&2
    exit 64
  fi
  # 自动发布只发给定的、主线上的提交；--busy-ok 只跟着 --auto；--now 是人急修、急退用的，不跟 --auto、--check
  if { ((AUTO)) && [[ -z "$target" || "$UNMERGED" == 1 ]]; } || { ((BUSY_OK)) && ((AUTO == 0)); } ||
    { ((NOW_MODE)) && { ((AUTO)) || [[ "$mode" == check ]]; }; }; then
    usage >&2
    exit 64
  fi
  if [[ "$mode" != check && -z "${FLEET_RELEASE_DETACHED:-}" ]]; then
    if ((EUID != 0)); then
      echo "要 root：sudo bash $0" >&2
      exit 64
    fi
    install -d -o root -g root -m 755 "$RELEASES"
    detach "$@"
  fi
  trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR
  preflight
  if [[ "$mode" == check ]]; then
    do_check
    finish
  fi
  ensure_dir "$RELEASES" root:root 755
  take_lock
  # 最后一道：脚本怎么退都撤掉排空请求（引擎那头只在发布锁占着时认它，这里撤是为了马上接着派）
  trap 'drain_withdraw' EXIT
  if [[ "$mode" == rollback ]]; then do_rollback; else do_release "$target"; fi
  finish
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
