#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # APP_UNITS、SHA 这些是给 source 进来的 release.sh 里的函数读写的
# deploy/release.sh 的来回：换版、健康检查不过自动退回、一键退回、不退到判过不健康的版本、只留最近几版；
# 飞书网关什么时候发、什么时候不动香港，网关的健康检查怎么判。
# 取代码、构建、迁移、健康检查、往香港传文件、香港网关的入口换成桩（按提交号预先定好健康不健康）；切 current、记历史、
# 挑上一版、清旧版、迁移把关、发网关的决定、网关健康检查用的是 release.sh 里的真代码，目录落在临时目录、不连网；
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
api_report_before() { :; }
SYNCED=0 # 往香港发过几次静态文件
PROBED=0 # 试通过几次往香港传静态文件的路
sync_web() { SYNCED=$((SYNCED + 1)); }
web_reachable() { PROBED=$((PROBED + 1)); }
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
