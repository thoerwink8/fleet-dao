#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # APP_UNITS、SHA 这些是给 source 进来的 release.sh 里的函数读写的
# deploy/release.sh 的来回：换版、健康检查不过自动退回、一键退回、不退到判过不健康的版本、只留最近几版；
# 飞书网关什么时候发、什么时候不动香港，网关的健康检查怎么判；装目录、装路由两层的每条失败路径。
# 取代码、构建、迁移、健康检查、往香港传文件、香港网关的入口、目录装载器、路由两层装载器和库的读回换成桩（按提交号预先定好健康不健康）；
# 切 current、记历史、挑上一版、清旧版、迁移把关、装目录的检查、发网关的决定、网关健康检查用的是 release.sh 里的真代码，
# 目录落在临时目录、不连网；
# 最后一段以 root 真起一个临时服务
# （fleet-release-test-<进程号>），验「主进程跑的是哪一版」，跑完撤掉；不是 root 就那段记「没跑成」、退出 2。
# 真机上的那一半（真起服务、真传文件、真健康检查）在法国、香港上实测，记录在引入本文件的 PR 里。
# 用法：sudo bash deploy/test/release-flow.test.sh。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e # release.sh 开了 -e；这里自己判每一步
mkdir -p "$RELEASES"
SCRIPT_HK_PARTS=$FLEET_HK_PARTS # release.env 里不写 FLEET_HK_PARTS 时用的默认值（后面各段会改这个变量）

fail=0
skipped=0 # 有要 root 的段没跑成
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

# ── 桩 ──
declare -A GATE=() # 提交号 → ok / bad
APP_UNITS=()       # 不装、不停任何单元
FLEET_SERVICES=""
KEEP=3
fetch_code() {
  SHA=$1
  ON_MAIN=1
}
declare -A MIG=() # 提交号 → 这一版带几个迁移
DB_MIG=0          # 库里跑过几个迁移；fail = 读不到
build_release() {
  if [[ -f "$RELEASES/$1/.fleet-release" ]]; then return 0; fi
  mkdir -p "$RELEASES/$1/web"
  printf 'commit=%s\nbuilt=%s\non_main=1\nweb=桩\nmigrations=%s\n' "$1" "$(date -u +%FT%TZ)" "${MIG[$1]:-0}" \
    >"$RELEASES/$1/.fleet-release"
  changed "构建 ${1:0:12}"
}
migrations_applied() {
  if [[ "$DB_MIG" == fail ]]; then return 1; fi
  echo "$DB_MIG"
}
MIGRATE_RUNS=() # 跑过哪几版的迁移程序
migrate() {
  MIGRATE_RUNS+=("$1")
  if [[ "${MIG[$1]:-0}" -gt "$DB_MIG" ]]; then DB_MIG=${MIG[$1]}; fi
}
# 真的 api_report_before 留一份：「切之前读不到健康报告」那一段用真代码，别的段换成桩
eval "real_$(declare -f api_report_before)"
api_report_before() { :; }
SYNCED=0 # 往香港发过几次静态文件
PROBED=0   # 试通过几次往香港传静态文件的路
WEB_DOWN=0 # 1 = 往香港传静态文件的路试不通
sync_web() { SYNCED=$((SYNCED + 1)); }
web_reachable() {
  PROBED=$((PROBED + 1))
  if ((WEB_DOWN)); then
    red "桩：试着往香港传文件没通"
    return 1
  fi
}
# 香港网关的入口（fleet-gateway-deploy）换成桩：状态从 $GWD 下的文件读，收下、切过去也落在那里（发布脚本多在命令替换里调它，
# 变量带不回来）；调过什么一行一条记进 $GWD/calls：「命令 提交号头一个字」
GWD=$TMP/gw
mkdir -p "$GWD/has"
GW_CONFIG=ok
GW_CONNECTED=yes
GW_HAS_RC=1 # has 问到没收下的版本时的退出码：1 = 没有；别的 = 问不成（ssh 断了之类）
gw() {
  local sha=${2:-}
  printf '%s %s\n' "$1" "${sha:0:1}" >>"$GWD/calls"
  case $1 in
  status)
    if [[ -f "$GWD/down" ]]; then
      echo "ssh: connect to host 10.99.0.1 port 22: Connection timed out" >&2
      return 255
    fi
    if [[ -f "$GWD/garbled" ]]; then
      echo "<html>502 Bad Gateway</html>"
      return 0
    fi
    if [[ -f "$GWD/flapping" ]]; then echo $(($(cat "$GWD/restarts" 2>/dev/null || echo 0) + 1)) >"$GWD/restarts"; fi
    printf 'current=%s\nenabled=enabled\nactive=active\npid=42\nrestarts=%s\nrunning=%s\nconnected=%s\nmessages=0\n' \
      "$(cat "$GWD/current" 2>/dev/null)" "$(cat "$GWD/restarts" 2>/dev/null || echo 0)" \
      "$(cat "$GWD/current" 2>/dev/null)" "$GW_CONNECTED"
    printf 'backend=refused\nconfig=%s\n' "$GW_CONFIG"
    ;;
  has) [[ -f "$GWD/has/$2" ]] || return "$GW_HAS_RC" ;;
  receive)
    cat >/dev/null
    : >"$GWD/has/$2"
    echo "changed 收下 ${2:0:12}"
    ;;
  activate)
    if [[ "$(cat "$GWD/current" 2>/dev/null)" == "$2" ]]; then
      echo "ok fleet-feishu 已在跑这一版（pid 42）"
      return 0
    fi
    printf '%s' "$2" >"$GWD/current"
    echo "changed 香港网关 current → ${2:0:12}"
    ;;
  esac
}
gw_calls() { grep -cE "^($1)( |$)" "$GWD/calls"; } # 某种命令调过几次（「receive」「receive a」「has|activate」）
# 里程碑发版后置关（dispatch_off_on_milestone）换成桩：只记哪一版发布成功后叫了它；它自己的判法在 release-dispatch.test.sh
OFF_CALLS=()
dispatch_off_on_milestone() { OFF_CALLS+=("${1:0:1}"); }
# 引擎总开关发版后置关（engine_off_after_release，#1086）同样换成桩；它自己的判法在 release-engine-off.test.sh
ENGINE_OFF_CALLS=()
engine_off_after_release() { ENGINE_OFF_CALLS+=("${1:0:1}"); }
health_gate() {
  if [[ "${GATE[$1]:-ok}" == ok ]]; then return 0; fi
  red "桩：${1:0:12} 健康检查不过"
  return 1
}

A=$(printf 'a%.0s' {1..40})
B=$(printf 'b%.0s' {1..40})
C=$(printf 'c%.0s' {1..40})
D=$(printf 'd%.0s' {1..40})
E=$(printf 'e%.0s' {1..40})
events() { awk '{ printf "%s:%s ", substr($2, 1, 1), $3 }' "$HISTORY"; }
reset() {
  REDS=()
  CHANGES=()
  PENDING=()
}

echo "== 头一版、第二版：健康，照常切过去"
reset
do_release "$A" >/dev/null
check "发 A 之后在用 A" "$(current_sha)" "$A"
check "发 A 没有红" "${#REDS[@]}" 0
reset
do_release "$B" >/dev/null
check "发 B 之后在用 B" "$(current_sha)" "$B"
check "上一版是 A" "$(previous_sha)" "$A"
check "发布成功之后各叫了一次置关判断（A、B）" "${OFF_CALLS[*]}" "a b"

echo "== 同一个提交再发一遍：什么都不变"
reset
before=$(events)
do_release "$B" >/dev/null
check "再发 B：改动 0 处" "${#CHANGES[@]}" 0
check "再发 B：历史没变" "$(events)" "$before"

echo "== 新版健康检查不过：自动退回上一版，并报红"
GATE[$C]=bad
reset
do_release "$C" >/dev/null
check "C 不过之后在用的是 B" "$(current_sha)" "$B"
check "报了红" "$((${#REDS[@]} > 0))" 1
check "历史：C 记成不健康、B 是自动退回的" "$(events)" "a:release b:release c:release c:unhealthy b:auto-rollback "
check "上一版跳过不健康的 C，是 A" "$(previous_sha)" "$A"
check "C 没过健康检查：没叫置关判断（只有发布成功才叫；再发 B 那次叫了一次 B，退回 B 不算）" "${OFF_CALLS[*]}" "a b b"
check "引擎总开关置关和项目开关同一个时机：发布成功才叫，C 没过、退回 B 都不叫" "${ENGINE_OFF_CALLS[*]}" "a b b"

echo "== 一键退回：退到 A；再退一次回到 B（B 健康）"
reset
do_rollback >/dev/null
check "退回后在用 A" "$(current_sha)" "$A"
check "退回没有红" "${#REDS[@]}" 0
check "这时的上一版是 B" "$(previous_sha)" "$B"

echo "== 在用的那版自己健康检查不过（没换版本）：不退，报红"
GATE[$A]=bad
reset
do_release "$A" >/dev/null
check "还在用 A" "$(current_sha)" "$A"
check "报了红" "$((${#REDS[@]} > 0))" 1
GATE[$A]=ok

echo "== 新版不过、退回的那版也不过：两个都记成不健康，报红"
GATE[$D]=bad
GATE[$A]=bad
reset
do_release "$D" >/dev/null
check "退回了 A" "$(current_sha)" "$A"
check "历史最后三件：D 不健康、A 自动退回、A 不健康" \
  "$(tail -3 "$HISTORY" | awk '{ printf "%s:%s ", substr($2, 1, 1), $3 }')" "d:unhealthy a:auto-rollback a:unhealthy "
check "上一版跳过 A、C、D，是 B" "$(previous_sha)" "$B"
GATE[$A]=ok

echo "== 只留最近 $KEEP 版：在用的、上一版一定留；没构建完的临时目录清掉"
mkdir -p "$RELEASES/.build-$E"
reset
do_release "$E" >/dev/null
check "在用 E" "$(current_sha)" "$E"
left=$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | cut -c1 | sort | tr -d '\n')
# 上一版是 B（A 在退回后又判过不健康，C、D 也是），再按最近用过的补一个 A；C、D 清掉
check "留下的版本：E 在用、B 是上一版、再补最近用过的 A" "$left" "abe"
check "没构建完的临时目录清掉了" "$([[ -e "$RELEASES/.build-$E" ]] && echo 在 || echo 没了)" "没了"

echo "== 头一版就不过：没有上一版可退，报红"
rm -rf "${RELEASES:?}"/* "$RELEASES"/.history
GATE[$B]=bad
reset
do_release "$B" >/dev/null
check "报了红" "$((${#REDS[@]} > 0))" 1
check "历史：B 发了、记成不健康" "$(events)" "b:release b:unhealthy "
reset
do_rollback >/dev/null
check "没有可退的：一键退回报红" "$((${#REDS[@]} > 0))" 1

echo "== 判过不健康的在用版本，后来健康检查过了：记回健康（又能当退回目标），再发一遍不再记"
GATE[$B]=ok
reset
do_release "$B" >/dev/null
check "记回健康" "$(events)" "b:release b:unhealthy b:recovered "
check "没有红" "${#REDS[@]}" 0
reset
do_release "$B" >/dev/null
check "再发一遍：改动 0 处" "${#CHANGES[@]}" 0
GATE[$C]=ok
reset
do_release "$C" >/dev/null
check "发 C 之后，上一版是记回健康的 B" "$(previous_sha)" "$B"

echo "== 迁移只进不退：库里跑过的迁移比上一版带的多，自动退回、一键退回都不退，报红"
rm -rf "${RELEASES:?}"/* "$RELEASES"/.history
GATE=()
MIG=([$A]=2 [$B]=3 [$C]=3)
DB_MIG=0
reset
do_release "$A" >/dev/null
check "发 A（带 2 个迁移）：库跑到 2 个" "$DB_MIG" 2
GATE[$B]=bad
reset
do_release "$B" >/dev/null
check "B 带第 3 个迁移、健康检查不过：不自动退回，还停在 B" "$(current_sha)" "$B"
check "报了红" "$((${#REDS[@]} > 0))" 1
check "红里说了为什么不退" "$(printf '%s\n' "${REDS[@]}" | grep -c '库 fleet 已跑过 3 个迁移，那一版只带 2 个')" 1
check "历史：B 发了、不健康，没有退回" "$(events)" "a:release b:release b:unhealthy "
GATE[$B]=ok
reset
do_release "$B" >/dev/null
check "B 修好（配置备齐）再发：记回健康" "$(last_event "$B")" recovered
reset
do_rollback >/dev/null 2>&1
check "一键退回：上一版 A 只带 2 个，不退，还在 B" "$(current_sha)" "$B"
check "报了红" "$((${#REDS[@]} > 0))" 1
reset
do_release "$C" >/dev/null
check "发 C（也是 3 个迁移）：在用 C" "$(current_sha)" "$C"
reset
do_rollback >/dev/null 2>&1
check "一键退回：上一版 B 也带 3 个，退得过去" "$(current_sha)" "$B"
check "没有红" "${#REDS[@]}" 0
DB_MIG=fail
reset
do_rollback >/dev/null 2>&1
check "读不到库里跑过几个迁移：不退" "$(current_sha)" "$B"
check "报了红" "$((${#REDS[@]} > 0))" 1
DB_MIG=3
before=$(events)
reset
MIGRATE_RUNS=()
do_release "$A" >/dev/null 2>&1
check "直接发老提交 A（只带 2 个、库里 3 个）：不切，还在 B" "$(current_sha)" "$B"
check "红里说了为什么不切" "$(printf '%s\n' "${REDS[@]}" | grep -c '不切到 aaaaaaaaaaaa：库 fleet 已跑过 3 个迁移，那一版只带 2 个')" 1
check "老版本的迁移程序没跑" "${#MIGRATE_RUNS[@]}" 0
check "历史没变" "$(events)" "$before"

echo "== 这一版带几个迁移：记在标记里；早先构建、没记的，现场数它的迁移账；读不出就失败"
NODE=$(command -v node) || NODE=""
F=$(printf 'f%.0s' {1..40})
mkdir -p "$RELEASES/$F/packages/db/src/bin" "$RELEASES/$F/packages/db/migrations/meta"
: >"$RELEASES/$F/packages/db/src/bin/migrate.ts"
printf 'commit=%s\n' "$F" >"$RELEASES/$F/.fleet-release"
printf '{"version":"7","entries":[{"idx":0},{"idx":1},{"idx":2},{"idx":3}]}' >"$RELEASES/$F/packages/db/migrations/meta/_journal.json"
if [[ -z "$NODE" ]]; then
  echo "  ✗ 没跑成：这台没有 node"
  fail=1
else
  check "标记里记着的：直接用" "$(release_migrations "$A")" 2
  check "标记里没记：数迁移账" "$(release_migrations "$F")" 4
  printf 'not json' >"$RELEASES/$F/packages/db/migrations/meta/_journal.json"
  release_migrations "$F" >/dev/null
  check "迁移账读不出：失败" "$?" 1
  check "没有迁移入口：0" "$(count_migrations "$TMP")" 0
fi

echo "== 后端的健康报告、任务队列的回答：认得出才逐项给，认不出就是认不出（不当成「没问题」）"
NODE=$(command -v node) || NODE=""
if [[ -z "$NODE" ]]; then
  echo "  ✗ 没跑成：这台没有 node"
  fail=1
else
  body='{"ok":false,"checks":{"database":{"ok":true},"temporal":{"ok":false,"code":"not_connected","message":"Temporal 客户端还没接上"}}}'
  check "503 的报告逐项给出" "$(report_items "$body" | tr '\t\n' '|;')" "database|ok|;temporal|bad|Temporal 客户端还没接上;"
  # 引擎按设置没开时后端报「未接」（ok:true + status:not_wired）：发布脚本当好的看，整体也回 200
  body='{"ok":true,"checks":{"database":{"ok":true},"engine":{"ok":true,"status":"not_wired","message":"这台机器按设置没开引擎"}}}'
  check "「未接」的项按好的给出" "$(report_items "$body" | tr '\t\n' '|;')" "database|ok|;engine|ok|;"
  for body in '<html>502 Bad Gateway</html>' '{"ok":true}' '{"ok":"true","checks":{}}' '{"ok":true,"checks":[]}' ''; do
    report_items "$body" >/dev/null 2>&1
    check "认不出的回答退出 1：${body:-（空）}" "$?" 1
  done
  tq='{"pollers":[{"taskQueueType":"workflow","identity":"4242@vmi"},{"taskQueueType":"activity","identity":"4242@vmi"}]}'
  engine_polling "$tq" 4242@
  check "引擎工人两种任务都在取：在" "$?" 0
  engine_polling "$tq" 999@
  check "换了进程号（旧工人的记录）：不算" "$?" 1
  engine_polling '{"pollers":[{"taskQueueType":"workflow","identity":"4242@vmi"}]}' 4242@
  check "只取工作流任务、不取活动任务：不算" "$?" 1
  engine_polling '{"reachability":null,"pollers":null}' 4242@
  check "没人在取（pollers 为 null）：不算" "$?" 1
  engine_polling 'rpc error: connection refused' 4242@
  check "回答认不出：不算" "$?" 1
fi

echo "== 切之后的健康报告逐项和切之前比：好的变坏了才算这一版的错；会随时间自己变红的项（全流程巡检）只标待处理、不退回"
before_items=$(printf 'database\tok\t\ncanary\tok\t\ntemporal\tbad\t没接上\n')
reset
compare_api_items "$before_items" \
  "$(printf 'database\tok\t\ncanary\tbad\t最近一轮巡检断在验收段\ntemporal\tbad\t没接上\n')" >/dev/null
check "全流程巡检恰好在发版时断了一轮：不算这一版的错" "$?" 0
check "巡检：没有红" "${#REDS[@]}" 0
check "巡检：记成待处理、写明不退回" "$(printf '%s\n' "${PENDING[@]}" | grep -c 'canary 不好.*和换没换版无关，不退回')" 1
reset
compare_api_items "$(printf 'database\tok\t\njudge\tok\t\n')" \
  "$(printf 'database\tok\t\njudge\tbad\t判断题最近一次调用没成\n')" >/dev/null
check "判断题恰好在发版时调用没成（跟着上游变红）：不算这一版的错" "$?" 0
check "判断题：记成待处理、写明不退回" "$(printf '%s\n' "${PENDING[@]}" | grep -c 'judge 不好.*和换没换版无关，不退回')" 1
reset
compare_api_items "$(printf 'database\tok\t\ndeploy_lag\tok\t\n')" \
  "$(printf 'database\tok\t\ndeploy_lag\tbad\t落后主线 3 个提交、1 小时 40 分钟（在等引擎空闲）\n')" >/dev/null
check "跟上主线（deploy_lag）恰好在发版时变红（主线又动了）：不算这一版的错" "$?" 0
check "跟上主线：记成待处理、写明不退回" \
  "$(printf '%s\n' "${PENDING[@]}" | grep -c 'deploy_lag 不好.*和换没换版无关，不退回')" 1
reset
compare_api_items "$(printf 'database\tok\t\nfeishu_gateway\tok\t\n')" \
  "$(printf 'database\tok\t\nfeishu_gateway\tbad\t没查成：后端起来才 12 秒，推送轮询还没来过（盘面快照也没来取过）\n')" >/dev/null
check "飞书网关（feishu_gateway）在后端刚重启时还没回来：不算这一版的错" "$?" 0
check "飞书网关：没有红" "${#REDS[@]}" 0
check "飞书网关：记成待处理、写明不退回" \
  "$(printf '%s\n' "${PENDING[@]}" | grep -c 'feishu_gateway 不好.*和换没换版无关，不退回')" 1
reset
compare_api_items "$before_items" \
  "$(printf 'database\tbad\t连不上\ncanary\tok\t\ntemporal\tbad\t没接上\n')" >/dev/null
check "库切之前好、切之后坏：算这一版的错" "$?" 1
check "库变坏：报红" "$(printf '%s\n' "${REDS[@]}" | grep -c 'database 切之前是好的，换了这一版不好了：连不上')" 1
check "切之前就不好的（temporal）：只标待处理" "$(printf '%s\n' "${PENDING[@]}" | grep -c 'temporal 不好：没接上（切之前就不好')" 1

_fs_saved="$FLEET_SERVICES"
FLEET_SERVICES="fleet-api" # 本机没启用引擎（法国 2026-09-29 起临时关了）
reset
compare_api_items "$(printf 'database\tok\t\nengine\tok\t\n')" \
  "$(printf 'database\tok\t\nengine\tbad\t引擎工人不在（engine_offline）\n')" >/dev/null
check "本机没启用引擎：切之前引擎好、切之后后端报引擎不在——预期的，不算这一版的错" "$?" 0
check "没启用引擎：没有红" "${#REDS[@]}" 0
check "没启用引擎：记成待处理、写明是预期的" \
  "$(printf '%s\n' "${PENDING[@]}" | grep -c 'engine 不好.*本机没启用引擎.*不退回')" 1
FLEET_SERVICES="fleet-engine fleet-api" # 故意造出失败：引擎启用了却坏了，照旧算这一版的错，不能被上面那条放过
reset
compare_api_items "$(printf 'database\tok\t\nengine\tok\t\n')" \
  "$(printf 'database\tok\t\nengine\tbad\t引擎工人不在（engine_offline）\n')" >/dev/null
check "本机启用了引擎：切之前好、切之后坏——算这一版的错（真坏的不能放过）" "$?" 1
check "启用了引擎：报红" "$(printf '%s\n' "${REDS[@]}" | grep -c 'engine 切之前是好的，换了这一版不好了')" 1
FLEET_SERVICES="$_fs_saved"

echo "== 切版本之前读后端的健康报告：没在跑就空着照切；在跑却读不到（连不上、回的不是健康报告）不切（审查 S1：空的「切之前」会让切之后变红的项被当成「之前就不好」、不退回）"
rm -rf "${RELEASES:?}"/* "$RELEASES"/.history
GATE=()
MIG=()
DB_MIG=0
api_healthz_saved=$(declare -f api_healthz)
has_service_saved=$(declare -f has_service)
API_UNIT=inactive # systemctl is-active fleet-api.service 答什么
API_ANSWER=ok     # 驾驶舱接口的 /healthz：ok 答健康报告；down 连不上；garbled 回的不是健康报告（502 的网页）
has_service() { [[ "$1" == fleet-api ]]; } # 本机启用了后端；FLEET_SERVICES 还是空的，切版本时不去动真的 systemd
# shellcheck disable=SC2317,SC2329 # 由 release.sh 里的 api_report_before 间接调用
systemctl() { # 只换掉「后端在不在跑」这一问；别的照走真的
  if [[ "$*" == "is-active fleet-api.service" ]]; then
    echo "$API_UNIT"
    [[ "$API_UNIT" == active ]]
    return
  fi
  command systemctl "$@"
}
api_healthz() {
  case $API_ANSWER in
  ok) printf '200\t%s' '{"ok":true,"checks":{"database":{"ok":true}}}' ;;
  down) return 1 ;;
  garbled) printf '502\t%s' '<html>502 Bad Gateway</html>' ;;
  esac
}
# shellcheck disable=SC2317,SC2329 # 由 do_release 间接调用
api_report_before() { real_api_report_before; }
real_api_report_before >/dev/null
check "后端没在跑：空着、不算读不到（返回 0）" "$?" 0
reset
do_release "$A" >/dev/null
check "后端没在跑：照切到 A、没有红" "$(current_sha):${#REDS[@]}" "$A:0"
API_UNIT=active
check "后端在跑、答得上：逐项给出" "$(real_api_report_before | tr '\t\n' '|;')" "database|ok|;"
reset
do_release "$B" >/dev/null
check "后端在跑、答得上：照切到 B、没有红" "$(current_sha):${#REDS[@]}" "$B:0"
before=$(events)
for API_ANSWER in down garbled; do
  real_api_report_before >/dev/null
  check "后端在跑却读不到（$API_ANSWER）：返回失败，不拿空的当「切之前」" "$?" 1
  reset
  do_release "$C" >/dev/null
  check "后端在跑却读不到（$API_ANSWER）：不切，还在 B" "$(current_sha)" "$B"
  check "后端在跑却读不到（$API_ANSWER）：报红说清" \
    "$(printf '%s\n' "${REDS[@]}" | grep -c '后端在跑，但切版本之前读不到它的健康报告')" 1
  check "后端在跑却读不到（$API_ANSWER）：历史没变" "$(events)" "$before"
done
check "回的不是健康报告：红里写明" "$(printf '%s\n' "${REDS[@]}" | grep -c '健康报告（/healthz 回的不是健康报告（HTTP 502））')" 1
API_ANSWER=down
reset
do_release "$C" >/dev/null
check "连不上：红里写明是连不上" "$(printf '%s\n' "${REDS[@]}" | grep -c "健康报告（驾驶舱接口 http://$COCKPIT/healthz 连不上）")" 1
eval "$api_healthz_saved"
eval "$has_service_saved"
unset -f systemctl
api_report_before() { :; }

echo "== 飞书网关：这一版带网关、香港配置齐了才发过去切过去；香港已收下的不再传；配置不齐、这一版没网关都不动香港网关"
rm -rf "${RELEASES:?}"/* "$RELEASES"/.history
GATE=()
MIG=()
DB_MIG=0
with_gateway() { # 提交号：构建这一版（桩），带上网关文件、标记里记它的 sha256
  build_release "$1" >/dev/null
  mkdir -p "$RELEASES/$1/gateway"
  printf 'console.log("%s")\n' "$1" >"$RELEASES/$1/gateway/gateway.mjs"
  printf 'gateway_sha256=%s\n' "$(sha256sum <"$RELEASES/$1/gateway/gateway.mjs" | cut -c1-64)" >>"$RELEASES/$1/.fleet-release"
}
with_gateway "$A"
reset
: >"$GWD/calls"
do_release "$A" >/dev/null
check "发 A：在用 A" "$(current_sha)" "$A"
check "发 A：香港没有，传过去（receive 一次）" "$(gw_calls 'receive a')" 1
check "发 A：切过去（activate 一次）" "$(gw_calls 'activate a')" 1
check "发 A：香港网关在用 A" "$(cat "$GWD/current")" "$A"
check "发 A：这次切过去了，健康检查要查网关" "$GATEWAY_ACTIVATED" 1
check "发 A：传、切都记成改动" "$(printf '%s\n' "${CHANGES[@]}" | grep -cE '收下 aaaaaaaaaaaa|香港网关 current → aaaaaaaaaaaa')" 2
check "发 A：没有红" "${#REDS[@]}" 0
reset
: >"$GWD/calls"
do_release "$A" >/dev/null
check "再发 A：香港已收下，不再传" "$(gw_calls receive)" 0
check "再发 A：改动 0 处" "${#CHANGES[@]}" 0
with_gateway "$B"
GW_CONFIG="missing FEISHU_TEAM_CHAT_ID"
reset
: >"$GWD/calls"
do_release "$B" >/dev/null
check "香港配置没备齐：法国照样切到 B" "$(current_sha)" "$B"
check "香港配置没备齐：不传、不切" "$(gw_calls 'has|receive|activate')" 0
check "香港配置没备齐：香港网关还是 A" "$(cat "$GWD/current")" "$A"
check "香港配置没备齐：健康检查不查网关" "$GATEWAY_ACTIVATED" 0
check "记待配、说出缺什么" "$(printf '%s\n' "${PENDING[@]}" | grep -c '配置没备齐（FEISHU_TEAM_CHAT_ID）')" 1
check "香港配置没备齐：没有红" "${#REDS[@]}" 0
GW_CONFIG=ok
build_release "$C" >/dev/null
reset
: >"$GWD/calls"
do_release "$C" >/dev/null
check "这一版没有网关：不传、不切" "$(gw_calls 'has|receive|activate')" 0
check "这一版没有网关：记待配" "$(printf '%s\n' "${PENDING[@]}" | grep -c '没有飞书网关')" 1
check "这一版没有网关：香港网关还是 A" "$(cat "$GWD/current")" "$A"
with_gateway "$D"
GW_HAS_RC=255
reset
: >"$GWD/calls"
do_release "$D" >/dev/null
check "问香港有没有这一版没问成：报红" "$(printf '%s\n' "${REDS[@]}" | grep -c '网关没成（退出码 255）')" 1
check "问没问成：不传、不切" "$(gw_calls 'receive|activate')" 0
check "问没问成：退回上一版 C" "$(current_sha)" "$C"
check "问没问成：D 记成不健康" "$(last_event "$D")" unhealthy
GW_HAS_RC=1
touch "$GWD/down"
before=$(events)
with_gateway "$E"
reset
do_release "$E" >/dev/null
check "香港网关的入口问不通：不切，还在 C" "$(current_sha)" "$C"
check "问不通：报红，说是问不到" "$(printf '%s\n' "${REDS[@]}" | grep -c '没切版本：问不到香港飞书网关的状态')" 1
check "问不通：历史没变" "$(events)" "$before"
rm -f -- "$GWD/down"

echo "== 往香港发哪几样：release.env 里不写就只发网关——静态页不发、也不试通（发了会换掉根地址的演示版，要人明写 web）"
check "脚本里的默认值只有 gateway" "$SCRIPT_HK_PARTS" gateway
if ((EUID == 0)); then
  # 照样例重建、或者那一行被删掉之后的 release.env：没有 FLEET_HK_PARTS 这一项
  printf 'FLEET_SERVICES=\nFLEET_DOMAIN=cockpit.example.com\n' >"$TMP/release.env"
  FLEET_HK_PARTS=$SCRIPT_HK_PARTS
  load_env "$TMP/release.env" FLEET_SERVICES FLEET_DOMAIN FLEET_HK_PARTS
  check "release.env 里没写这一项：读完还是只发 gateway" "$FLEET_HK_PARTS" gateway
else
  echo "  … 没跑成：读 release.env 要 root（只认属 root 的文件）"
  skipped=1
  FLEET_HK_PARTS=$SCRIPT_HK_PARTS
fi
SYNCED=0
PROBED=0
reset
do_release "$E" >/dev/null
check "在用 E" "$(current_sha)" "$E"
check "静态文件一次都没发" "$SYNCED" 0
check "传静态文件的路一次都没试" "$PROBED" 0
check "网关照样发过去" "$(cat "$GWD/current")" "$E"
FLEET_HK_PARTS="web gateway"
reset
do_release "$A" >/dev/null
check "明写了 web：先试通、再发静态文件" "$PROBED:$SYNCED" "1:1"
FLEET_HK_PARTS=""
SYNCED=0
reset
: >"$GWD/calls"
do_release "$E" >/dev/null
check "两样都不发：香港网关一次都没问" "$(grep -c . "$GWD/calls")" 0
check "两样都不发：静态文件没发" "$SYNCED" 0
FLEET_HK_PARTS=$SCRIPT_HK_PARTS

echo "== 网关的健康检查：主进程是这一版、连上了飞书、起稳了才过；连不上后端记待配（不算这一版的错）"
GATEWAY_WAIT=0
SETTLE_SECONDS=0
printf '%s' "$A" >"$GWD/current"
reset
check_gateway "$A" >/dev/null
check "连上了、起稳了：过" "$?" 0
check "后端连不上：记待配" "$(printf '%s\n' "${PENDING[@]}" | grep -c '连不上法国后端')" 1
check "没有红" "${#REDS[@]}" 0
reset
check_gateway "$B" >/dev/null
check "主进程跑的不是这一版：不过" "$?" 1
GW_CONNECTED=no
reset
check_gateway "$A" >/dev/null
check "这次起来之后没连上飞书：不过" "$?" 1
GW_CONNECTED=reconnecting
reset
check_gateway "$A" >/dev/null
check "长连接断了、正在重连：不过" "$?" 1
GW_CONNECTED=yes
touch "$GWD/flapping"
reset
check_gateway "$A" >/dev/null
check "连上之后又重启过（没起稳）：不过" "$?" 1
check "说了没稳住" "$(printf '%s\n' "${REDS[@]}" | grep -c '没稳住')" 1
rm -f -- "$GWD/flapping"
GW_CONFIG="missing FEISHU_TEAM_CHAT_ID"
reset
check_gateway "$A" >/dev/null
check "配置没备齐（网关没起）：不算不过，记待配" "$?:${#PENDING[@]}" "0:1"
GW_CONFIG=ok
# 问不到就当场报红：不白等（等的那 60 秒用 sleep 桩数出来），红里说的是「问不到」，不是「没连上飞书」
GATEWAY_WAIT=60
SLEPT=0
sleep() { SLEPT=$((SLEPT + 1)); }
touch "$GWD/down"
reset
check_gateway "$A" >/dev/null
check "问不到网关的状态：不过（不当成没事）" "$?" 1
check "红里说的是问不到，不是没连上飞书" "$(printf '%s\n' "${REDS[@]}" | grep -c '问不到香港飞书网关的状态')" 1
check "问不到就不等（一次都没睡）" "$SLEPT" 0
rm -f -- "$GWD/down"
touch "$GWD/garbled"
reset
check_gateway "$A" >/dev/null
rc=$?
check "回答认不出（不是状态的样子）：不过，也说是问不到" \
  "$rc:$(printf '%s\n' "${REDS[@]}" | grep -c '问不到香港飞书网关的状态')" "1:1"
rm -f -- "$GWD/garbled"
unset -f sleep
GATEWAY_WAIT=0

echo "== 装目录：迁移之后、切版本之前；文件不对、读不到、装不成、装完读不回或是 0 行，都停下不切；同一版再发改动 0 处"
rm -rf "${RELEASES:?}"/* "$RELEASES"/.history
GATE=()
MIG=()
DB_MIG=0
FLEET_HK_PARTS="" # 不碰香港（网关那几段另测）
CATALOG=$TMP/catalog.json
# 装载器的桩放在「这一版的 node」的位置。发布脚本以 env -i 起它，环境里只剩库连接，所以桩要的东西都在它自己的目录里：
# mode 定它这次怎么答（changed 装进去了、same 已齐、别的就报错），calls 每次记一行「参数|当前目录|库连接」，
# audit 是装载器最近一笔操作记录的编号（装进去时加一），读回的桩照它答；order 记迁移、装载器谁先跑，
# 和装载器跑的那一刻 current 指着哪一版
FAKE=$TMP/catalog-fake
mkdir -p "$FAKE"
cat >"$FAKE/node" <<'EOF'
#!/bin/bash
d=$(dirname "$0")
printf '%s|%s|%s %s %s\n' "$*" "$PWD" "${DATABASE_URL:-}" "${PGHOST:-}" "${PGUSER:-}" >>"$d/calls"
printf 'catalog current=%s\n' "$(readlink ../current 2>/dev/null)" >>"$d/order"
case $(cat "$d/mode") in
changed)
  echo "新写入 pools（6）：claude-solo、claude-carpool、mirasim-relay、cursor、grok、jev"
  echo $(($(cat "$d/audit") + 1)) >"$d/audit"
  ;;
same) echo "库里已经齐了，这次一行没改" ;;
*)
  echo "目录配置里引用了不存在的东西"
  echo "- stages.judge 的路由 jev:jev-1.13:api-shel 不存在"
  exit 1
  ;;
esac
EOF
chmod +x "$FAKE/node"
NODE=$FAKE/node
echo 0 >"$FAKE/audit"
# 以 fleet 身份跑的那一下：桩只核对身份参数，后面的 env -i … 照原样执行（真 env，环境真的清空）
runuser() {
  if [[ "$1 $2 $3" != "-u fleet --" ]]; then
    echo "桩：runuser 的参数不对：$*" >&2
    return 99
  fi
  shift 3
  "$@"
}
# 读回的桩：装载器这一轮还没跑时按 PG_BEFORE 答，跑过了按 PG_AFTER 答。ok 是账号池 6、路由 9（#754 起不再数旧的按阶段平铺那两张表）；
# fail 连不上库；garbage 答的不是数；zero-<第几张> 那张表 0 行；grown 多出一个账号池（库被人改了）
PG_BEFORE=ok
PG_AFTER=ok
pg_admin() {
  local mode=$PG_BEFORE c=(6 9)
  if [[ -s "$FAKE/calls" ]]; then mode=$PG_AFTER; fi
  case $mode in
  fail)
    echo 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed' >&2
    return 2
    ;;
  garbage)
    echo 'ERROR:  relation "pools" does not exist'
    return 0
    ;;
  zero-*) c[${mode#zero-}]=0 ;;
  grown) c[0]=7 ;;
  esac
  printf '%s|%s|%s\n' "${c[@]}" "$(cat "$FAKE/audit")"
}
# 迁移的桩照旧，另把「迁移跑过了」记进 order：装载器得排在它后面
migrate() {
  MIGRATE_RUNS+=("$1")
  if [[ "${MIG[$1]:-0}" -gt "$DB_MIG" ]]; then DB_MIG=${MIG[$1]}; fi
  echo "migrate ${1:0:1}" >>"$FAKE/order"
}
with_loader() { # 提交号：构建这一版（桩），带上目录装载器
  build_release "$1" >/dev/null
  mkdir -p "$RELEASES/$1/packages/db/src/bin"
  : >"$RELEASES/$1/packages/db/src/bin/catalog.ts"
}
loader_runs() { if [[ -f "$FAKE/calls" ]]; then grep -c . "$FAKE/calls"; else echo 0; fi; }
round() { # 装载器这一轮怎么答；清掉上一轮的记录
  printf '%s' "$1" >"$FAKE/mode"
  rm -f -- "$FAKE/calls" "$FAKE/order"
  reset
}
said() { grep -cF -- "$1" "$TMP/out"; }           # 这一轮的输出里有几行带这些字
reds_with() { printf '%s\n' "${REDS[@]}" | grep -cF -- "$1"; }
printf '{}\n' >"$CATALOG"
chmod 640 "$CATALOG"
CATALOG_META=$(stat -c '%U:%G %a' -- "$CATALOG") # 桩机上没有 fleet 组：该有的属主、权限按这台上造出来的算
with_loader "$A"
round changed
do_release "$A" >"$TMP/out"
check "装进去了：切到 A、没有红" "$(current_sha):${#REDS[@]}" "$A:0"
IFS='|' read -r got_args got_cwd got_db <"$FAKE/calls"
check "装载器收到的：这一版的命令、真文件的路径" "$got_args" "packages/db/src/bin/catalog.ts $CATALOG"
# 只比结尾：Windows 上的 Git Bash 清空环境后，同一个临时目录会换一种写法
check "装载器在这一版的目录里跑" "$([[ "$got_cwd" == */releases/"$A" ]] && echo 是 || echo "不是（$got_cwd）")" 是
check "装载器连的是本机库（unix socket、peer 认证）" "$got_db" "postgres:///fleet /var/run/postgresql fleet"
check "装载器的话打出来了" "$(said '新写入 pools（6）')" 1
check "记一处改动，带上读回的行数" \
  "$(printf '%s\n' "${CHANGES[@]}" | grep -c '^目录装进库（账号池 6、路由 9）$')" 1
round same
do_release "$A" >"$TMP/out"
check "同一版再发：装载器照样跑，库里一行没改，改动 0 处" "$(loader_runs):${#CHANGES[@]}:${#REDS[@]}" "1:0:0"
check "同一版再发：说的是已齐" "$(said '目录已齐，这次一行没改（账号池 6、路由 9）')" 1
with_loader "$B"
before=$(events)
blocked() { # 说明 红里要有的字 装载器该跑几次：发 B，应当停下、不切、历史不变
  do_release "$B" >"$TMP/out"
  check "$1：不切，还在 A" "$(current_sha)" "$A"
  check "$1：报红，说清是哪一种" "$(reds_with "$2")" 1
  check "$1：历史没变" "$(events)" "$before"
  check "$1：装载器跑了 $3 次" "$(loader_runs)" "$3"
}
mv -- "$CATALOG" "$TMP/catalog.saved"
round changed
blocked "文件不在" "没有 $CATALOG：先从保险箱放上来" 0
mkdir -- "$CATALOG"
chmod 640 "$CATALOG"
round changed
blocked "放成了目录" "$CATALOG 不是普通文件" 0
rmdir -- "$CATALOG"
mv -- "$TMP/catalog.saved" "$CATALOG"
chmod 644 "$CATALOG"
if [[ "$(stat -c '%U:%G %a' -- "$CATALOG")" == "$CATALOG_META" ]]; then
  echo "  … 没跑成：这台改不了文件权限（chmod 不生效），「权限不对」没测"
  skipped=1
else
  round changed
  blocked "权限不对（644）" "应为 $CATALOG_META；没切版本" 0
fi
chmod 640 "$CATALOG"
if ((EUID == 0)); then
  chown 65534 -- "$CATALOG" # nobody：属主换成别人，权限不变
  round changed
  blocked "属主不对（换成别的用户）" "应为 $CATALOG_META；没切版本" 0
  chown 0 -- "$CATALOG"
else
  echo "  … 没跑成：「属主不对」要 root 才造得出来（chown 成别人）"
  skipped=1
fi
mv -- "$CATALOG" "$TMP/catalog.real"
ln -s -- "$TMP/catalog.real" "$CATALOG"
if [[ ! -L "$CATALOG" ]]; then
  echo "  … 没跑成：这台建不了符号链接，「是符号链接」没测"
  skipped=1
else
  round changed
  blocked "是符号链接" "是符号链接，不读" 0
fi
rm -f -- "$CATALOG"
mv -- "$TMP/catalog.real" "$CATALOG"
# 读不到属主权限（stat 失败）：桩只对 $CATALOG 失败，别的文件照常；这一轮完就撤掉
stat() {
  if [[ "${*: -1}" == "$CATALOG" ]]; then return 1; fi
  command stat "$@"
}
check "stat 的桩：只有读 $CATALOG 失败，别的文件照常" \
  "$(stat -c %a -- "$CATALOG" >/dev/null 2>&1 && echo 读到 || echo 读不到):$(stat -c %a -- "$FAKE/node" >/dev/null 2>&1 && echo 读到 || echo 读不到)" \
  "读不到:读到"
round changed
blocked "读不到属主权限（stat 失败）" "$CATALOG 是「读不到」，应为 $CATALOG_META；没切版本" 0
unset -f stat
check "stat 的桩撤掉了" "$(stat -c %a -- "$CATALOG" >/dev/null 2>&1 && echo 读到 || echo 读不到)" 读到
PG_BEFORE=fail
round changed
blocked "装之前连不上库" "装目录之前读不到库 fleet 里目录那几张表的行数" 0
PG_BEFORE=garbage
round changed
blocked "装之前读回的不是数" "装目录之前读不到库 fleet 里目录那几张表的行数" 0
PG_BEFORE=ok
round fail
blocked "装载器报错（引用不存在），读回和装之前一样" "目录没装成（装载器退出码 1，原话见上；读回核过：几张表的行数、装载器的操作记录都和装之前一样；没切版本）：目录配置里引用了不存在的东西" 1
check "装载器报错：它的原话一条条打出来了" "$(said '- stages.judge 的路由 jev:jev-1.13:api-shel 不存在')" 1
PG_AFTER=grown
round fail
blocked "装载器报错，读回库却变了" "；现在 账号池 7、路由 9，到" 1
check "装载器报错，读回库却变了：说要人看，不说「一行没动」" "$(reds_with '要人看；没切版本'):$(reds_with '一样')" "1:0"
PG_AFTER=fail
round fail
blocked "装载器报错，读回也读不到" "装完读不回库，库里变没变没查成；没切版本" 1
round changed
blocked "装完连不上库" "目录装完了，但读不回库 fleet 里目录那几张表的行数" 1
PG_AFTER=garbage
round changed
blocked "装完读回的不是数" "目录装完了，但读不回库 fleet 里目录那几张表的行数" 1
tables=(账号池 路由)
had=(6 9)
for i in 0 1; do
  PG_AFTER=zero-$i
  round changed
  blocked "装完${tables[i]}是 0 行" "库 fleet 里${tables[i]} 0 行（装之前 ${had[i]} 行），引擎派不出活；没切版本" 1
done
PG_BEFORE=ok
PG_AFTER=ok
round changed
do_release "$B" >"$TMP/out"
check "都齐了再发 B：切到 B、没有红" "$(current_sha):${#REDS[@]}" "$B:0"
check "先跑迁移、再装目录，装的时候还没切版本（current 还指着 A）" "$(tr '\n' '|' <"$FAKE/order")" \
  "migrate b|catalog current=$A|"
build_release "$C" >/dev/null # 老提交：这一版没有目录装载器
round changed
do_release "$C" >"$TMP/out"
check "这一版没有装载器：照常切到 C" "$(current_sha)" "$C"
check "这一版没有装载器：没跑装载器、没有红" "$(loader_runs):${#REDS[@]}" "0:0"
check "这一版没有装载器：说了一声" "$(said '这一版没有目录装载器')" 1
# runuser、pg_admin 的桩留着：后面那段不用它们（unset 掉 shellcheck 会当成桩从没被调过）
NODE=$(command -v node) || NODE=""

echo "== 装路由两层（#574）：目录装完之后、切版本之前；读不回、装载器报错、装完是 0 行都停下不切；同一版再发说已齐；老版本没有它照切"
rm -rf "${RELEASES:?}"/* "$RELEASES"/.history
GATE=()
MIG=()
DB_MIG=0
FLEET_HK_PARTS=""
# 两个装载器共用「这一版的 node」，桩按第一个参数分：目录装载器一律答已齐（上一段专测它）；路由两层装载器照 mode 答
# （changed 装进去了、same 已齐、别的就报错），每次记一行「参数|当前目录|库连接」进 calls；order 记两个装载器谁先跑、
# 跑的那一刻 current 指着哪一版
RFAKE=$TMP/routing-fake
mkdir -p "$RFAKE"
cat >"$RFAKE/node" <<'EOF'
#!/bin/bash
d=$(dirname "$0")
case $1 in
packages/db/src/bin/catalog.ts)
  printf 'catalog current=%s\n' "$(readlink ../current 2>/dev/null)" >>"$d/order"
  echo "库里已经齐了，这次一行没改"
  ;;
packages/db/src/bin/routing.ts)
  printf '%s|%s|%s\n' "$*" "$PWD" "${DATABASE_URL:-}" >>"$d/calls"
  printf 'routing current=%s\n' "$(readlink ../current 2>/dev/null)" >>"$d/order"
  case $(cat "$d/mode") in
  changed)
    echo "补了用途 → 模型 48 行（9 个用途：triage、spec、plan、execute、ui、review、verify、research、judge）"
    echo "补了模型 → 路由 10 行（7 个模型：opus-5.5、gpt-5.6-luna、kimi-k3、deepseek-flash、cursor-auto、grok-4.7、jev-1.13）"
    ;;
  same) echo "路由两层已齐，这次一行没改；库里已有、没动的：用途 9 个、模型 7 个（驾驶舱改过的不覆盖）" ;;
  *)
    echo "默认骨架和库里对不上，一行没写"
    echo "- 路由 grok:grok-4.7:grok 库里没有"
    exit 1
    ;;
  esac
  ;;
*)
  echo "桩：认不出的命令 $*" >&2
  exit 99
  ;;
esac
EOF
chmod +x "$RFAKE/node"
NODE=$RFAKE/node
# 读回的桩：目录那几张表一律「都齐、装载器没改」；路由两层那两张，装载器这一轮还没跑时按 R_BEFORE 答，跑过了按 R_AFTER 答：
# empty 两张都是 0 行，full 装齐了（48、10），fail 连不上库，garbage 答的不是数，zero-1 / zero-2 第几张是 0 行，grown 多出几行
R_BEFORE=empty
R_AFTER=full
pg_admin() {
  if [[ "$*" != *routing_purpose_models* ]]; then
    printf '6|9|0\n'
    return 0
  fi
  local mode=$R_BEFORE
  if [[ -s "$RFAKE/calls" ]]; then mode=$R_AFTER; fi
  case $mode in
  fail)
    echo 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed' >&2
    return 2
    ;;
  garbage) echo 'ERROR:  relation "routing_catalog" does not exist' ;;
  empty) echo '0|0' ;;
  full) echo '48|10' ;;
  zero-1) echo '0|10' ;;
  zero-2) echo '48|0' ;;
  grown) echo '3|1' ;;
  esac
}
with_loaders() { # 提交号：构建这一版（桩），带上目录、路由两层两个装载器
  build_release "$1" >/dev/null
  mkdir -p "$RELEASES/$1/packages/db/src/bin"
  : >"$RELEASES/$1/packages/db/src/bin/catalog.ts"
  : >"$RELEASES/$1/packages/db/src/bin/routing.ts"
}
routing_runs() { if [[ -f "$RFAKE/calls" ]]; then grep -c . "$RFAKE/calls"; else echo 0; fi; }
rround() { # 路由两层装载器这一轮怎么答；清掉上一轮的记录
  printf '%s' "$1" >"$RFAKE/mode"
  rm -f -- "$RFAKE/calls" "$RFAKE/order"
  reset
}
with_loaders "$A"
rround changed
do_release "$A" >"$TMP/out"
check "路由两层装进去了：切到 A、没有红" "$(current_sha):${#REDS[@]}" "$A:0"
IFS='|' read -r got_args got_cwd got_db <"$RFAKE/calls"
check "路由两层装载器收到的：这一版的命令，不带别的参数（骨架是这一版自己带的）" "$got_args" "packages/db/src/bin/routing.ts"
check "路由两层装载器在这一版的目录里跑" "$([[ "$got_cwd" == */releases/"$A" ]] && echo 是 || echo "不是（$got_cwd）")" 是
check "路由两层装载器连的是本机库" "$got_db" "postgres:///fleet"
check "先装目录、再装路由两层，都在切版本之前（current 还没指着 A）" "$(tr '\n' '|' <"$RFAKE/order")" \
  "catalog current=|routing current=|"
check "路由两层装载器的话打出来了（补了几行）" "$(said '补了模型 → 路由 10 行')" 1
check "记一处改动，带上读回的行数" \
  "$(printf '%s\n' "${CHANGES[@]}" | grep -c '^路由两层装进库（用途 → 模型 48 行、模型 → 路由 10 行）$')" 1
R_BEFORE=full
rround same
do_release "$A" >"$TMP/out"
check "同一版再发：路由两层装载器照样跑，没有红、改动 0 处" "$(routing_runs):${#REDS[@]}:${#CHANGES[@]}" "1:0:0"
check "同一版再发：说的是路由两层已齐" "$(said '路由两层已齐，这次一行没改（用途 → 模型 48 行、模型 → 路由 10 行）')" 1
with_loaders "$B"
before=$(events)
rblocked() { # 说明 红里要有的字 装载器该跑几次：发 B，应当停下、不切、历史不变
  do_release "$B" >"$TMP/out"
  check "$1：不切，还在 A" "$(current_sha)" "$A"
  check "$1：报红，说清是哪一种" "$(reds_with "$2")" 1
  check "$1：历史没变" "$(events)" "$before"
  check "$1：路由两层装载器跑了 $3 次" "$(routing_runs)" "$3"
}
R_BEFORE=fail
rround changed
rblocked "路由两层装之前连不上库" "装路由两层之前读不到库 fleet 里那两张表的行数：没装，没切版本" 0
R_BEFORE=garbage
rround changed
rblocked "路由两层装之前读回的不是数" "装路由两层之前读不到库 fleet 里那两张表的行数" 0
R_BEFORE=empty
R_AFTER=empty
rround fail
rblocked "路由两层装载器报错（骨架里的路由库里没有），读回和装之前一样" \
  "路由两层没装成（装载器退出码 1，原话见上；读回核过：两张表的行数和装之前一样；没切版本）：默认骨架和库里对不上，一行没写" 1
check "路由两层装载器报错：它的原话一条条打出来了" "$(said '- 路由 grok:grok-4.7:grok 库里没有')" 1
R_AFTER=grown
rround fail
rblocked "路由两层装载器报错，读回库却变了" \
  "库变了（装之前 用途 → 模型 0 行、模型 → 路由 0 行，现在 用途 → 模型 3 行、模型 → 路由 1 行），要人看；没切版本" 1
R_AFTER=fail
rround fail
rblocked "路由两层装载器报错，读回也读不到" "装完读不回库，库里变没变没查成；没切版本" 1
rround changed
rblocked "路由两层装完连不上库" "路由两层装完了，但读不回库 fleet 里那两张表的行数：没切版本" 1
R_AFTER=garbage
rround changed
rblocked "路由两层装完读回的不是数" "路由两层装完了，但读不回库 fleet 里那两张表的行数" 1
R_AFTER=zero-1
rround changed
rblocked "装完用途 → 模型是 0 行" \
  "库 fleet 里路由两层用途 → 模型 0 行（装之前 用途 → 模型 0 行、模型 → 路由 0 行），选路派不出活（要人看）；没切版本" 1
R_AFTER=zero-2
rround changed
rblocked "装完模型 → 路由是 0 行" "库 fleet 里路由两层模型 → 路由 0 行" 1
R_AFTER=full
rround changed
do_release "$B" >"$TMP/out"
check "路由两层都齐了再发 B：切到 B、没有红" "$(current_sha):${#REDS[@]}" "$B:0"
check "发 B：先装目录、再装路由两层，装的时候还没切版本（current 还指着 A）" "$(tr '\n' '|' <"$RFAKE/order")" \
  "catalog current=$A|routing current=$A|"
build_release "$C" >/dev/null # 老提交：带目录装载器，没有路由两层装载器
mkdir -p "$RELEASES/$C/packages/db/src/bin"
: >"$RELEASES/$C/packages/db/src/bin/catalog.ts"
rround changed
do_release "$C" >"$TMP/out"
check "这一版没有路由两层装载器：照常切到 C" "$(current_sha)" "$C"
check "这一版没有路由两层装载器：没跑它、没有红" "$(routing_runs):${#REDS[@]}" "0:0"
check "这一版没有路由两层装载器：说了一声" "$(said '这一版没有路由两层装载器')" 1
NODE=$(command -v node) || NODE=""

echo "== 自动发布（--auto）：演示版不发（对外，要人确认）；历史行带 auto；切之前看会话——在跑、读不到、认不出都不切，什么都没动（退出码 76）；--busy-ok 照切；另一个发布在跑是 75"
rm -rf "${RELEASES:?}"/* "$RELEASES"/.history
GATE=()
MIG=()
DB_MIG=0
FLEET_HK_PARTS=""
: >"$FAKE/order" # 迁移的桩（上一段换的）往这里记跑过哪一版
# 会话列表（fleet-agent-scope list）的桩：照旁边 .mode 文件答，问一次记一行进 .calls
SCOPE=$TMP/agent-scope
cat >"$SCOPE" <<'EOF'
#!/bin/bash
echo "$*" >>"$0.calls"
case $(cat "$0.mode") in
idle) printf '7 inactive\n9 failed\n' ;;
none) ;;
busy) printf '7 inactive\n12 active\n13 activating\n' ;;
garbled) echo 'Failed to connect to bus: No such file or directory' ;;
*)
  echo 'sudo: fleet-agent-scope: command not found' >&2
  exit 1
  ;;
esac
EOF
chmod +x "$SCOPE"
AGENT_SCOPE=$SCOPE
scope() { # 会话列表这一轮怎么答；清掉问过几次的记录
  printf '%s' "$1" >"$SCOPE.mode"
  rm -f -- "$SCOPE.calls"
}
scope_calls() { if [[ -f "$SCOPE.calls" ]]; then grep -c . "$SCOPE.calls"; else echo 0; fi; }
last_line() { tail -1 "$HISTORY" | cut -d' ' -f3-; } # 历史最后一行去掉时间、提交号：「事件 [标记…]」

sends() { if sends_demo; then echo 发; else echo 不发; fi; } # 这次发不发演示版
AUTO=1
FLEET_HK_PARTS="web demo gateway"
DEMO_PUBLISH=1
reset
auto_parts >"$TMP/out"
check "自动发布：演示版不发，驾驶舱静态文件、网关照发" "$(sends):$FLEET_HK_PARTS" "不发:web demo gateway"
check "自动发布：演示版还在要核对的里（原先连核对一起去掉，香港上的演示版就没人看了）" "$(has_part demo && echo 核对)" 核对
check "自动发布：说了演示版这次不动、只核对" "$(said '自动发布不发演示版（对外，要人确认）：香港上的演示版这次不动，只核对')" 1
check "自动发布：往香港发哪几样照实说（演示版只核对）" "$(parts_said)" "web demo（只核对、不发） gateway"
FLEET_HK_PARTS="demo"
DEMO_PUBLISH=1
auto_parts >/dev/null
check "只配了演示版：自动发布一样都不往香港传" "$(sends):$(has_part web && echo 发根地址)" "不发:"
FLEET_HK_PARTS="gateway"
DEMO_PUBLISH=1
auto_parts >"$TMP/out"
check "没配演示版：不变、不多说" "$FLEET_HK_PARTS:$DEMO_PUBLISH:$(said '演示版')" "gateway:1:0"
AUTO=0
FLEET_HK_PARTS="web demo gateway"
DEMO_PUBLISH=1
auto_parts >/dev/null
check "人手动发：演示版照发" "$(sends):$(parts_said)" "发:web demo gateway"
FLEET_HK_PARTS=""

AUTO=1
scope idle
reset
do_release "$A" >"$TMP/out"
check "会话都停了：切到 A" "$(current_sha)" "$A"
check "会话都停了：切之前问过一次会话列表" "$(scope_calls)" 1
check "历史这一行带 auto（自动发布据此分得清哪次是人手动切的）" "$(last_line)" "release auto"
scope none
reset
do_release "$B" >"$TMP/out"
check "一个会话都没有：切到 B" "$(current_sha)" "$B"

scope busy
before=$(events)
reset
(do_release "$C") >"$TMP/out" 2>&1
rc=$?
check "会话在跑：退出码 76（没动，不是没成）" "$rc" 76
check "会话在跑：不切，还在 B" "$(current_sha)" "$B"
check "会话在跑：历史没变" "$(events)" "$before"
check "会话在跑：说出是哪几个、这次没发" "$(said '这次没发：引擎有会话在跑（12 13），这次不切')" 1
check "会话在跑：结论写明什么都没动" "$(said '什么都没动')" 1
check "会话在跑：构建留着，下一轮直接用" "$([[ -f "$RELEASES/$C/.fleet-release" ]] && echo 在 || echo 没了)" 在
check "会话在跑：迁移没跑" "$(grep -c 'migrate c' "$FAKE/order")" 0
scope broken
reset
(do_release "$C") >"$TMP/out" 2>&1
rc=$?
check "会话列表读不到（fleet-agent-scope 没成）：按在跑算，退出码 76" "$rc" 76
check "读不到：说没查成，不当成没有会话" "$(said '这次没发：会话在不在跑没查成')" 1
check "读不到：它的原话进了日志" "$(said 'command not found')" 1
check "读不到：还在 B" "$(current_sha)" "$B"
scope garbled
reset
(do_release "$C") >"$TMP/out" 2>&1
rc=$?
check "会话列表认不出（退出码 0，却不是「编号 状态」）：按在跑算，退出码 76" "$rc" 76
check "认不出：说认不出、带上那一行" "$(said '这次没发：会话列表认不出（有一行是「Failed to connect to bus')" 1
check "认不出：还在 B、历史没变" "$(current_sha):$(events)" "$B:$before"

BUSY_OK=1
scope busy
reset
do_release "$C" >"$TMP/out"
check "等空闲到了上限（--busy-ok）：会话在跑也切到 C" "$(current_sha)" "$C"
check "--busy-ok：不去问会话列表" "$(scope_calls)" 0
check "--busy-ok：说了照切、会话按编号续上" "$(said '等空闲到了上限，引擎有会话在跑也切')" 1
BUSY_OK=0

scope idle
GATE[$D]=bad
reset
do_release "$D" >"$TMP/out"
check "自动发布的新版不过健康检查：退回 C" "$(current_sha)" "$C"
check "自动发布里的发布、不健康、自动退回都带 auto（不算人手动切的）" \
  "$(tail -3 "$HISTORY" | cut -d' ' -f3- | tr '\n' '|')" "release auto|unhealthy auto|auto-rollback auto|"
GATE[$D]=ok

AUTO=0
scope busy
reset
do_release "$E" >"$TMP/out"
check "人手动发：不看会话（人自己定），照切到 E" "$(scope_calls):$(current_sha)" "0:$E"
check "人手动发的：历史行不带 auto" "$(last_line)" release

if command -v flock >/dev/null; then
  exec 8>>"$RELEASES/.lock"
  flock -n 8
  AUTO=1
  (take_lock) >"$TMP/out" 2>&1
  rc=$?
  check "另一个发布拿着锁：自动发布退出码 75（没动）" "$rc" 75
  check "另一个发布拿着锁：结论写明这次没发" "$(said '这次没发：另一个发布正在跑')" 1
  AUTO=0
  reset
  (
    take_lock >/dev/null
    echo "rc=$? reds=${#REDS[@]}"
  ) >"$TMP/out" 2>&1
  check "人手动发、锁被占：照旧报红、返回 1" "$(grep '^rc=' "$TMP/out")" "rc=1 reds=1"
  flock -u 8
  exec 8>&-
else
  echo "  … 没跑成：这台没有 flock，「另一个发布在跑」没测"
  skipped=1
fi

echo "== 排空引擎（发布不白杀在干的活）：构建之前写排空请求，迁移之前等排空、停引擎、撤请求；读不到、不会排空、等到上限都照实说"
if [[ -z "$NODE" ]]; then
  echo "  ✗ 没跑成：这台没有 node"
  fail=1
else
  ENG=$TMP/engine
  mkdir -p "$ENG"
  ENGINE_STATE_DEFAULT=$ENG
  ENGINE_ENV=$TMP/no-engine.env
  ENG_STATE=active
  : >"$ENG/calls"
  systemctl() { # 引擎单元的桩：在不在跑、主进程号、停、起；调过什么记进 calls
    case "$*" in
    "is-active fleet-engine.service") echo "$ENG_STATE" ;;
    "is-enabled fleet-engine.service") echo enabled ;;
    "show -p MainPID --value fleet-engine.service") echo "$$" ;;
    "stop fleet-engine.service")
      echo stop >>"$ENG/calls"
      ENG_STATE=inactive
      ;;
    "start fleet-engine.service" | "restart fleet-engine.service")
      echo "${1}" >>"$ENG/calls"
      ENG_STATE=active
      ;;
    *) command systemctl "$@" ;;
    esac
  }
  status_json() { # 会话数 [pid]
    local list="" i
    for ((i = 0; i < $1; i++)); do list+="${list:+,}{\"runId\":\"run-$i-xxxxxxxx\",\"stage\":\"execute\",\"taskId\":\"t\",\"phase\":\"running\",\"since\":\"x\"}"; done
    printf '{"schema":2,"pid":%s,"writtenAt":"x","cordon":{"source":"release","since":"x","until":"2026-09-28T01:40:00.000Z","why":"w"},"overdue":false,"sessions":[%s]}\n' \
      "${2:-$$}" "$list" >"$ENG/drain.json"
  }
  # 排空时每睡一觉，「引擎」交回一个会话；第一次睡的时候把排空请求抄下来
  sleep() {
    if [[ ! -f "$ENG/request-seen" && -f "$DRAIN_REQUEST" ]]; then cp -- "$DRAIN_REQUEST" "$ENG/request-seen"; fi
    local n
    n=$(grep -o '"runId"' "$ENG/drain.json" | grep -c .)
    if ((n > 0 && ${ENG_STUCK:-0} == 0)); then status_json $((n - 1)); fi
  }
  FLEET_SERVICES=fleet-engine
  AUTO=0
  DRAIN_POLL=0

  status_json 2
  rm -f -- "$ENG/request-seen"
  reset
  do_release "$A" >"$TMP/out"
  check "会排空的引擎：切到 A" "$(current_sha)" "$A"
  check "等两个会话交回（睡了两觉）才停引擎，停完起回来（切版本）" "$(tr '\n' ' ' <"$ENG/calls")" "stop start "
  check "排空请求写的是要切到的提交、人手动发" \
    "$("$NODE" -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.schema,r.sha===process.argv[2],r.by,(Date.parse(r.until)-Date.parse(r.requestedAt))/1000)' "$ENG/request-seen" "$A")" \
    "1 true manual 600"
  check "停完撤了排空请求（新引擎起来不能再认它）" "$([[ -e "$DRAIN_REQUEST" ]] && echo 还在 || echo 撤了)" 撤了
  check "说了排空请求、排空了、停下引擎" \
    "$(said '排空请求：引擎不起新会话'):$(said '引擎排空了：手上没有会话'):$(said '停下引擎（切版本之前）')" "1:1:1"
  check "会排空的引擎：没有待处理" "${#PENDING[@]}" 0

  : >"$ENG/calls"
  rm -f -- "$ENG/drain.json"
  reset
  do_release "$B" >"$TMP/out"
  check "引擎不会排空（没有 drain.json）：照旧停、切到 B" "$(current_sha):$(tr '\n' ' ' <"$ENG/calls")" "$B:stop start "
  check "不会排空：照实记待处理（会话会断、按编号续上），不当成排空了" \
    "$(printf '%s\n' "${PENDING[@]}" | grep -c '在跑的引擎不会排空：没有 .*drain.json')" 1

  : >"$ENG/calls"
  status_json 1 99999999
  reset
  do_release "$C" >"$TMP/out"
  check "drain.json 是上一个进程留下的（pid 对不上）：不信，当不会排空" \
    "$(printf '%s\n' "${PENDING[@]}" | grep -c '是上一个进程（99999999）留下的')" 1
  printf 'garbage' >"$ENG/drain.json"
  : >"$ENG/calls"
  reset
  do_release "$D" >"$TMP/out"
  check "drain.json 认不出：不信，照实说认不出" "$(printf '%s\n' "${PENDING[@]}" | grep -c 'drain.json 认不出')" 1

  # 会话一直不交回：等到上限照停，写明还剩谁
  status_json 1
  ENG_STUCK=1
  DRAIN_GRACE=0
  DRAIN_STOP_REPORT=0
  DRAIN_SLACK=0
  : >"$ENG/calls"
  reset
  do_release "$E" >"$TMP/out"
  check "会话一直不交回：等到上限照停、切到 E" "$(current_sha):$(tr '\n' ' ' <"$ENG/calls")" "$E:stop start "
  check "等到上限：记待处理、写明还剩谁" "$(printf '%s\n' "${PENDING[@]}" | grep -c '排空等到了上限.*execute(run-0-xx)')" 1
  ENG_STUCK=0
  DRAIN_GRACE=600
  DRAIN_STOP_REPORT=120
  DRAIN_SLACK=60

  # 同一版再发：引擎跑的就是它（主进程的目录）→ 不写请求、不停引擎。桩的主进程是这个测试进程，拿它的目录冒充那一版
  : >"$ENG/calls"
  ln -sfn "$PWD" "$RELEASES/$E.cwd"
  running_release_real=$(declare -f running_release)
  running_release() { printf '%s' "$RELEASES/$E"; }
  reset
  do_release "$E" >"$TMP/out"
  check "同一版再发：不写排空请求、不停引擎" "$(tr '\n' ' ' <"$ENG/calls"):$(said '排空请求')" ":0"
  eval "$running_release_real"
  rm -f -- "$RELEASES/$E.cwd"

  # 自动发布、会排空的引擎：不看会话列表（排空替它）；有会话在跑也发
  AUTO=1
  scope busy
  status_json 1
  rm -f -- "$ENG/request-seen"
  : >"$ENG/calls"
  reset
  do_release "$A" >"$TMP/out"
  check "自动发布、会排空的引擎：会话在跑也切到 A，不问会话列表" "$(current_sha):$(scope_calls)" "$A:0"
  check "自动发布：说了不等空闲、排空" "$(said '引擎会排空')" 1
  check "自动发布：排空请求写 auto" "$(grep -c '"by":"auto"' "$ENG/request-seen")" 1
  # 不会排空的引擎、会话在跑：照旧 76，排空请求撤掉
  rm -f -- "$ENG/drain.json"
  reset
  (do_release "$B") >"$TMP/out" 2>&1
  rc=$?
  check "自动发布、不会排空的引擎、会话在跑：照旧 76（什么都没动）" "$rc:$(current_sha)" "76:$A"
  check "76 退出时排空请求撤了" "$([[ -e "$DRAIN_REQUEST" ]] && echo 还在 || echo 撤了)" 撤了
  AUTO=0

  # --now：不给宽限
  NOW_MODE=1
  check "--now：宽限 0" "$(drain_grace)" 0
  NOW_MODE=0
  check "不带 --now：宽限 600 秒" "$(drain_grace)" 600

  # 停下引擎以后失败了（没走到切版本）：收尾把引擎起回来、撤请求
  ENG_STATE=inactive
  ENGINE_STOPPED=1
  DRAIN_WROTE=1
  : >"$DRAIN_REQUEST"
  : >"$ENG/calls"
  reset
  finish_hook >"$TMP/out"
  check "没走到切版本：收尾把停下的引擎起回来" "$(tr '\n' ' ' <"$ENG/calls")" "start "
  check "收尾撤了排空请求" "$([[ -e "$DRAIN_REQUEST" ]] && echo 还在 || echo 撤了)" 撤了
  check "收尾说了起回来" "$(said '把停下的引擎起回来')" 1
  # 引擎起不回来：红
  systemctl_ok=$(declare -f systemctl)
  systemctl() { if [[ "$1" == start ]]; then return 1; fi; echo inactive; }
  ENGINE_STOPPED=1
  reset
  finish_hook >"$TMP/out"
  check "引擎起不回来：记红，不当成没事" "$(reds_with '停下的引擎也起不回来')" 1
  eval "$systemctl_ok"

  unset -f systemctl sleep status_json
  FLEET_SERVICES=""
  ENGINE_STOPPED=0
  scope idle
fi

echo "== 照期望写本机配置（#323）：切版本之前、只写期望变了的键，人手改的不改回，退回、自动退回照旧版写回去；写不成（期望认不出、线上文件认不出、一个键几行、新的 release.env 发布脚本认不出、写后读回不一致、档位认不出）就不切、一个字不写"
NODE=$(command -v node) || NODE=""
if [[ -z "$NODE" ]]; then
  echo "  ✗ 没跑成：这台没有 node"
  fail=1
elif ((EUID != 0)); then
  echo "  … 没跑成：release.env 要属 root 才读（load_env），这一段要 root"
  skipped=1
else
  rm -rf "${RELEASES:?}"/* "$RELEASES"/.history "$CONFIG_STATE"
  GATE=()
  MIG=()
  DB_MIG=0
  AUTO=0
  FLEET_HK_PARTS=""
  FLEET_SERVICES=""
  saved_release_env=$RELEASE_ENV
  CONFIG_ETC=$TMP/etc-apply
  CONFIG_PROFILE=$CONFIG_ETC/profile
  RELEASE_ENV=$CONFIG_ETC/release.env
  mkdir -p "$CONFIG_ETC"
  # 这一版的期望：机器名、域名，engine.env 多加的一项（「,"键":"值"」），往香港发几样，放在哪（不给就是法国那份）。
  # 起的服务一直是空的：桩里没有单元可装（APP_UNITS 是空的），写了服务名发布脚本自己就认不出
  put_desired() { # 提交号 机器名 域名 [多加的一项] [往香港发] [位置]
    local file=$RELEASES/$1/${6:-deploy/france/desired-config.json}
    mkdir -p "$(dirname "$file")"
    printf '{"formatVersion":1,"selfHeal":false,"files":{"engine.env":{"FLEET_MACHINE_NAME":"%s"%s},"api.env":{"FLEET_ENV":"production"},"release.env":{"FLEET_SERVICES":"","FLEET_DOMAIN":"%s","FLEET_HK_PARTS":"%s"},"france.env":{}}}\n' \
      "$2" "${4:-}" "$3" "${5:-}" >"$file"
  }
  live_files() { # 机器名 域名
    printf '# 人写的注释\nFLEET_MACHINE_NAME=%s\n' "$1" >"$CONFIG_ETC/engine.env"
    printf 'FLEET_ENV=production\n' >"$CONFIG_ETC/api.env"
    printf 'FLEET_SERVICES=\nFLEET_DOMAIN=%s\nFLEET_HK_PARTS=\n' "$2" >"$RELEASE_ENV"
    chmod 640 "$CONFIG_ETC"/*.env
  }
  env_sum() { cat -- "$CONFIG_ETC/engine.env" "$CONFIG_ETC/api.env" "$RELEASE_ENV" 2>/dev/null | sha256sum | cut -c1-16; }
  etc_sum() { printf '%s %s' "$(env_sum)" "$(sha256sum <"$CONFIG_STATE" 2>/dev/null | cut -c1-16)"; } # 连记录一起
  has_line() { if grep -qxF -- "$2" "$CONFIG_ETC/$1"; then echo 有; else echo 没有; fi; } # 文件 整行
  live_files 法国 a.invalid
  put_desired "$A" 法国 a.invalid
  before=$(env_sum)
  reset
  do_release "$A" >"$TMP/out"
  check "第一次：切到 A、没有红" "$(current_sha):${#REDS[@]}" "$A:0"
  check "第一次：只记基线，环境文件一个字不写" "$(said '只记基线'):$(env_sum)" "1:$before"
  check "第一次：记下了基线" "$([[ -f "$CONFIG_STATE" ]] && echo 有 || echo 没有)" 有
  put_desired "$B" 巴黎 b.invalid
  reset
  do_release "$B" >"$TMP/out"
  check "发 B：切到 B、没有红" "$(current_sha):${#REDS[@]}" "$B:0"
  check "发 B：engine.env、release.env 照 B 的期望写上" \
    "$(has_line engine.env FLEET_MACHINE_NAME=巴黎):$(has_line release.env FLEET_DOMAIN=b.invalid)" "有:有"
  check "发 B：两处都记成改动" "$(printf '%s\n' "${CHANGES[@]}" | grep -c '照 bbbbbbbbbbbb 的期望写成')" 2
  check "发 B：release.env 重读过，这一版照新的来" "$FLEET_DOMAIN" b.invalid
  check "发 B：别的行（人写的注释）没动" "$(has_line engine.env '# 人写的注释')" 有
  check "发 B：先照期望写配置、再切版本" \
    "$(awk '/== 照期望写本机配置/ { w = NR } /== 切到/ { s = NR } END { print (w && s && w < s) ? "先写后切" : "不对" }' "$TMP/out")" 先写后切
  reset
  do_release "$B" >"$TMP/out"
  check "再发 B：改动 0 处、说不用写" "${#CHANGES[@]}:$(said '的期望和上次写的一样，不用写')" "0:1"
  sed -i 's/^FLEET_MACHINE_NAME=.*/FLEET_MACHINE_NAME=手改的/' "$CONFIG_ETC/engine.env"
  put_desired "$C" 巴黎 b.invalid ',"FLEET_NEW_KEY":"v1"'
  reset
  do_release "$C" >"$TMP/out"
  check "发 C：切到 C" "$(current_sha)" "$C"
  check "发 C：期望里新加的键补上" "$(has_line engine.env FLEET_NEW_KEY=v1)" 有
  check "发 C：人手改的不改回（selfHeal 关着）" "$(has_line engine.env FLEET_MACHINE_NAME=手改的)" 有
  check "发 C：说了人手改的不改回，值不打印" "$(said '不改回（期望里 selfHeal 关着'):$(said '手改的')" "1:0"
  reset
  do_rollback >"$TMP/out"
  check "一键退回：在用 B、没有红" "$(current_sha):${#REDS[@]}" "$B:0"
  check "一键退回：照 B 的期望写回去（C 新加的键删掉），人手改的照旧不动" \
    "$(has_line engine.env FLEET_NEW_KEY=v1):$(has_line engine.env FLEET_MACHINE_NAME=手改的)" "没有:有"

  cblocked() { # 说明 红里要有的字：发 D，应当停下、不切、历史不变、本机配置和记录一个字没动
    local was_events was_sum
    was_events=$(events)
    was_sum=$(etc_sum)
    reset
    do_release "$D" >"$TMP/out"
    check "$1：不切，还在 B" "$(current_sha)" "$B"
    check "$1：报红，说清是哪一种" "$(reds_with "$2")" 1
    check "$1：历史没变" "$(events)" "$was_events"
    check "$1：本机配置和记录一个字没动" "$(etc_sum)" "$was_sum"
  }
  build_release "$D" >/dev/null
  mkdir -p "$RELEASES/$D/deploy/france"
  printf '{' >"$RELEASES/$D/deploy/france/desired-config.json"
  cblocked "期望认不出（不是 JSON）" "dddddddddddd 的期望认不出"
  put_desired "$D" 巴黎 d.invalid
  cp -- "$CONFIG_ETC/engine.env" "$TMP/engine.saved"
  printf 'FLEET_MACHINE_NAME="没配上\n' >"$CONFIG_ETC/engine.env"
  cblocked "线上文件认不出（引号没配上）" "engine.env 认不出"
  cp -- "$TMP/engine.saved" "$CONFIG_ETC/engine.env"
  cp -- "$RELEASE_ENV" "$TMP/release.saved"
  printf 'FLEET_DOMAIN=b.invalid\n' >>"$RELEASE_ENV"
  cblocked "要写的键在文件里写了两行" "FLEET_DOMAIN 写了 2 行"
  cp -- "$TMP/release.saved" "$RELEASE_ENV"
  put_desired "$D" 巴黎 d.invalid "" bogus
  cblocked "照期望写出来的 release.env 发布脚本认不出" "发布脚本认不出"
  check "认不出的是哪一样说清了" "$(reds_with '不认识的「bogus」')" 1
  put_desired "$D" 巴黎 d.invalid
  export REAL_NODE=$NODE
  cat >"$TMP/node-expect-fails" <<'EOF'
#!/bin/bash
# 桩：算（--plan）照真的跑，写（--expect）时照 config.mjs 写完读回不一致、已改回原样的样子答
for a in "$@"; do
  if [[ "$a" == --expect ]]; then
    echo "red 写完读回不一致：release.env 改完照 systemd 读回来不对：FLEET_DOMAIN 不是该有的样子：写过的 release.env 已改回原样"
    exit 1
  fi
done
exec "$REAL_NODE" "$@"
EOF
  chmod +x "$TMP/node-expect-fails"
  NODE=$TMP/node-expect-fails
  cblocked "写后读回不一致" "照期望写本机配置没写成：写完读回不一致"
  NODE=$REAL_NODE
  printf 'paris\n' >"$CONFIG_PROFILE"
  chmod 640 "$CONFIG_PROFILE"
  cblocked "档位认不出" "档位文件"
  rm -f -- "$CONFIG_PROFILE"
  reset
  do_release "$D" >"$TMP/out"
  check "都改好了再发 D：切到 D、照期望写上" "$(current_sha):$(has_line release.env FLEET_DOMAIN=d.invalid)" "$D:有"

  X1=$(printf '3%.0s' {1..40})
  X2=$(printf '4%.0s' {1..40})
  put_desired "$X1" 巴黎 x1.invalid
  GATE[$X1]=bad
  reset
  do_release "$X1" >"$TMP/out"
  check "新版没过健康检查：自动退回 D" "$(current_sha)" "$D"
  check "自动退回：配置照 D 的期望写回去、重读过" "$(has_line release.env FLEET_DOMAIN=d.invalid):$FLEET_DOMAIN" "有:d.invalid"
  check "自动退回：历史照常" "$(tail -3 "$HISTORY" | awk '{ printf "%s:%s ", substr($2, 1, 1), $3 }')" "3:release 3:unhealthy d:auto-rollback "
  cat >"$TMP/node-rollback-fails" <<'EOF'
#!/bin/bash
# 桩：发新版照真的跑；自动退回时照期望写配置没成
for a in "$@"; do
  if [[ "$a" == auto-rollback ]]; then
    echo "red 桩：照上一版的期望写配置没成"
    exit 1
  fi
done
exec "$REAL_NODE" "$@"
EOF
  chmod +x "$TMP/node-rollback-fails"
  NODE=$TMP/node-rollback-fails
  put_desired "$X2" 巴黎 x2.invalid
  GATE[$X2]=bad
  reset
  do_release "$X2" >"$TMP/out"
  check "自动退回时照期望写配置没成：没切回去，照实说没退回" \
    "$(current_sha):$(reds_with '也没退回 dddddddddddd')" "$X2:1"
  check "没切回去：上一版没试过，不记它不健康" "$(last_event "$D")" auto-rollback
  NODE=$REAL_NODE
  GATE=()

  # 期望给往香港发的加了一样：发布开头只试了原来那几样（这时一样都没有），写之前照样试通新加的，不通就不写、不切
  Z=$(printf '6%.0s' {1..40})
  put_desired "$Z" 巴黎 z.invalid "" web
  WEB_DOWN=1
  was_sum=$(etc_sum)
  was_probed=$PROBED
  reset
  do_release "$Z" >"$TMP/out"
  check "期望新加了往香港发 web、试不通：不切，本机配置和记录一个字没动" "$(current_sha):$(etc_sum)" "$X2:$was_sum"
  check "试的是新加的那一样，红里说清" "$((PROBED - was_probed)):$(reds_with '要往香港新发的几样试不通')" "1:1"
  WEB_DOWN=0
  was_probed=$PROBED
  was_synced=$SYNCED
  reset
  do_release "$Z" >"$TMP/out"
  check "试得通：切到 Z、照期望写上、这一版照新的发了静态文件" \
    "$(current_sha):$(has_line release.env FLEET_HK_PARTS=web):$((PROBED - was_probed)):$((SYNCED - was_synced))" "$Z:有:1:1"
  reset
  do_release "$Z" >"$TMP/out"
  check "再发 Z：开头就照新的几样试通，写配置时不再多试一遍" "$((PROBED - was_probed))" 2

  build_release "$E" >/dev/null # 老提交：这一版里没有配置的期望
  reset
  do_release "$E" >"$TMP/out"
  check "这一版没有配置的期望：照常切到 E、不写、没有红" \
    "$(current_sha):$(said '里没有配置的期望（#323 之前的版本）：不照期望写'):${#REDS[@]}" "$E:1:0"
  # 本机档：照这一版里 deploy/local 那份写，不拿法国那份
  printf 'local\n' >"$CONFIG_PROFILE"
  chmod 640 "$CONFIG_PROFILE"
  Y=$(printf '5%.0s' {1..40})
  put_desired "$Y" 法国 x2.invalid
  put_desired "$Y" 本机 fleet-local.invalid "" "" deploy/local/desired-config.json
  reset
  do_release "$Y" >"$TMP/out"
  check "本机档：照 deploy/local 那份写" \
    "$(current_sha):$(has_line engine.env FLEET_MACHINE_NAME=本机):$(has_line release.env FLEET_DOMAIN=fleet-local.invalid)" "$Y:有:有"
  rm -f -- "$CONFIG_PROFILE"
  unset REAL_NODE
  RELEASE_ENV=$saved_release_env
  FLEET_HK_PARTS=""
  FLEET_SERVICES=""
fi

echo "== 自动发布的参数：--auto 只跟一个主线上的提交，--busy-ok 只跟着 --auto，--now 不跟 --auto、--check；不对就用法错（64），什么都不做"
AUTO=0
BUSY_OK=0
for args in "--auto" "$A --auto --unmerged" "$A --busy-ok" "--auto --busy-ok" "--check --auto" "--rollback --auto" \
  "--rollback --busy-ok" "$A --auto --now" "--check --now"; do
  # shellcheck disable=SC2086 # 故意按空格拆成几个参数
  (main $args) >/dev/null 2>&1
  rc=$?
  check "「${args//$A/<提交号>}」：退出 64" "$rc" 64
done

echo "== --check 列出自动发布的读数：定时器没在跑、还没有读数、读数认不出，都照实记待处理（不当成没事）"
if [[ -z "$NODE" ]]; then
  echo "  ✗ 没跑成：这台没有 node"
  fail=1
else
  TIMER=inactive
  systemctl() { # 只换掉「定时器在不在跑」这一问；别的照走真的
    if [[ "$*" == "is-active fleet-auto-release.timer" ]]; then
      echo "$TIMER"
    else
      command systemctl "$@"
    fi
  }
  check "systemctl 的桩：定时器在不在跑照 TIMER 答" "$(systemctl is-active fleet-auto-release.timer)" inactive
  mkdir -p "$(dirname "$AUTO_STATE")"
  rm -f -- "$AUTO_STATE"
  reset
  check_auto_release >"$TMP/out"
  check "定时器没在跑：记待处理" "$(printf '%s\n' "${PENDING[@]}" | grep -c 'fleet-auto-release.timer 没在跑')" 1
  check "还没有读数：记待处理" "$(printf '%s\n' "${PENDING[@]}" | grep -c '还没有自动发布的读数')" 1
  cat >"$AUTO_STATE" <<EOF
{"schema":1,"ranAt":"2026-09-27T01:00:00.000Z",
 "main":{"checkedAt":"2026-09-27T01:00:00.000Z","head":"$B","headAt":"2026-09-27T00:50:00.000Z",
  "commits":[["$B","2026-09-27T00:50:00.000Z"],["$A","2026-09-27T00:40:00.000Z"]]},
 "mainError":null,"current":"$A",
 "ci":{"sha":"$B","verdict":"pending","detail":"CI 在跑（in_progress）","checkedAt":"2026-09-27T01:00:00.000Z"},
 "hold":null,"waitingSince":null,"busy":null,"attempt":null,
 "rules":{"commit":"$A","at":"2026-09-27T00:45:00.000Z","result":"ok","detail":""},
 "system":{"appliedSha":"$A","behind":0,"oldestAt":null},"alerts":[],"resolve":[],
 "last":{"action":"ci-pending","detail":"CI 在跑（in_progress）","at":"2026-09-27T01:00:00.000Z"}}
EOF
  TIMER=active
  reset
  check_auto_release >"$TMP/out"
  check "定时器在跑、读数认得出：没有待处理" "${#PENDING[@]}" 0
  check "读数：上一轮什么时候跑的" "$(said '· 上一轮 2026-09-27T01:00:00.000Z')" 1
  check "读数：主线头和它的 CI" "$(said '· 主线头 bbbbbbbbbbbb，CI pending')" 1
  check "读数：在用的落后几个提交" "$(said '· 在用 aaaaaaaaaaaa，落后 1 个提交')" 1
  check "读数：这一轮在等 CI" "$(said '· 这轮：ci-pending（CI 在跑（in_progress））')" 1
  check "读数：规矩同步到哪个提交" "$(said '· 规矩同步到 aaaaaaaaaaaa（ok）')" 1
  check "读数：装机脚本装到哪" "$(said '· 装机脚本装到 aaaaaaaaaaaa，之后相关提交 0 个')" 1
  printf '{"schema":2}\n' >"$AUTO_STATE"
  reset
  check_auto_release >"$TMP/out"
  check "读数的格式认不出（schema 不对）：记待处理、说认不出" \
    "$(printf '%s\n' "${PENDING[@]}" | grep -c '自动发布的读数认不出.*格式认不出（schema 2，应为 1）')" 1
  printf 'not json' >"$AUTO_STATE"
  reset
  check_auto_release >"$TMP/out"
  check "读数不是 JSON：记待处理、说认不出" "$(printf '%s\n' "${PENDING[@]}" | grep -c '自动发布的读数认不出')" 1
  unset -f systemctl
fi

echo "== 真起一个服务：切完 current 没重启就被打断，再跑同一版会重启；主进程跑的是哪一版，健康检查查得出"
if ((EUID != 0)) || [[ ! -d /run/systemd/system ]]; then
  echo "  … 没跑成：要 root 和 systemd（sudo bash deploy/test/run.sh）"
  skipped=1
else
  U=fleet-release-test-$$
  G=$(printf '1%.0s' {1..40})
  H=$(printf '2%.0s' {1..40})
  cleanup_unit() {
    systemctl disable --now --quiet "$U.service" 2>/dev/null
    rm -f "/etc/systemd/system/$U.service"
    systemctl daemon-reload
    rm -rf -- "$TMP"
  }
  trap cleanup_unit EXIT
  APP_UNITS=("$U")
  FLEET_SERVICES=$U
  for s in "$G" "$H"; do
    mkdir -p "$RELEASES/$s/.units"
    printf 'commit=%s\non_main=1\nmigrations=0\n' "$s" >"$RELEASES/$s/.fleet-release"
    printf '[Service]\nWorkingDirectory=%s/current\nExecStart=/bin/sleep infinity\n\n[Install]\nWantedBy=multi-user.target\n' \
      "$RELEASES" >"$RELEASES/$s/.units/$U.service"
  done
  reset
  activate "$G" release >/dev/null
  check "切到 G、起服务：主进程在 G 的目录里" "$(running_release "$U.service")" "$RELEASES/$G"
  # 被打断：current 已经指到 H，服务还没重启
  ln -sfn "$H" "$RELEASES/current"
  reset
  check_running_release "$H" >/dev/null
  check "健康检查查出主进程跑的还是旧版" "$?" 1
  reset
  activate "$H" release >/dev/null
  check "再跑一遍 H（current 早就是 H）：照样重启，主进程到了 H" "$(running_release "$U.service")" "$RELEASES/$H"
  check_running_release "$H" >/dev/null
  check "健康检查认可" "$?" 0
  pid=$(unit_prop "$U.service" MainPID)
  reset
  activate "$H" release >/dev/null
  check "再跑一遍：不重启（主进程没换）" "$(unit_prop "$U.service" MainPID)" "$pid"
  check "再跑一遍：改动 0 处" "${#CHANGES[@]}" 0
fi

if ((fail)); then
  echo "release-flow：不通过"
  exit 1
fi
if ((skipped)); then
  echo "release-flow：其余通过，要 root 的段没跑成（见上面的「没跑成」）"
  exit 2
fi
echo "release-flow：通过"
