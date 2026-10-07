#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # FLEET_HK_PARTS、FLEET_DOMAIN 这些是给 source 进来的 release.sh 里的函数读的
# shellcheck disable=SC2016 # 单引号里的 $uri、$args 是 nginx 配置里的字面量，本来就不该展开
# deploy/release.sh 往香港发静态文件的那一段（release.env 的 FLEET_HK_PARTS 选）：demo 只发演示版到 FLEET_DEMO_PATH、
# 不碰根地址，演示版下面的可见范围（scopes/）发布不删，发成了当场记下香港上的演示版是哪一版；web 才把驾驶舱整套发到
# 根地址，而且不碰演示版的目录；两样都发时演示版在前、带版本标记的根地址在后。
# 健康检查照发演示版的记录比：香港上的是不是上次发的那份、深链接回落对不对——在用的是后来发的新版时，
# 它的演示版和香港上的不一样不算错（2026-09-27 拿在用的这一版去比，误报过）。
# rsync、curl 换成桩（curl 按一个假香港的目录答），其余是 release.sh 里的真代码。
# 香港站点配置（deploy/hk/nginx-*.conf）的演示版那一段也在这里核对。
# 用法：bash deploy/test/web-publish.test.sh。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
export FLEET_HK_RSYNC_LOCK=$TMP/hk-rsync.lock
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e # release.sh 开了 -e；这里自己判每一步
mkdir -p "$RELEASES"
NODE=$(command -v node) || NODE=""
FLEET_DOMAIN=cockpit.example.test

fail=0
skipped=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
reset() {
  REDS=()
  CHANGES=()
  PENDING=()
}
config() { # FLEET_HK_PARTS FLEET_DEMO_PATH：人手动发布（和 --check）的样子
  FLEET_HK_PARTS=$1
  FLEET_DEMO_PATH=$2
  demo_config_ok >/dev/null
}
said_line() { grep -cF -- "$1" "$TMP/out"; } # 上一次存进 $TMP/out 的输出里有几行带这段话
record_is() { # 发演示版的记录里的提交号、路径、首页指纹（没有记录打印「没有」）
  if [[ -f "$DEMO_RECORD" ]]; then
    printf '%s %s %s' "$(kv_get "$DEMO_RECORD" commit)" "$(kv_get "$DEMO_RECORD" path)" "$(kv_get "$DEMO_RECORD" index_sha256)"
  else
    printf '没有'
  fi
}
record_of() { printf '%s %s %s' "$1" "$2" "$(file_sum "$RELEASES/$1/web-demo/index.html")"; } # 提交号 路径：发了它该记成的样子
# 每一处发到哪（香港路径），按顺序
dests() { web_plan "$1" | awk '{ print $2 }' | tr '\n' ' '; }

A=$(printf 'a%.0s' {1..40}) # 带演示版的新一版
B=$(printf 'b%.0s' {1..40}) # 老的一版：只有 web/，标记里没有 demo_path
C=$(printf 'c%.0s' {1..40}) # A 之后自动发布发的一版：前端改过，演示版的资源文件名（带内容哈希）和 A 的不一样
for s in "$A" "$B" "$C"; do
  mkdir -p "$RELEASES/$s/web/assets" "$RELEASES/$s/web/health"
  printf '<html>驾驶舱 %s</html>\n' "${s:0:1}" >"$RELEASES/$s/web/index.html"
  printf 'x' >"$RELEASES/$s/web/assets/app.js"
  printf 'health' >"$RELEASES/$s/web/health/index.html"
  printf '{"commit":"%s"}\n' "$s" >"$RELEASES/$s/web/release.json"
done
mkdir -p "$RELEASES/$A/web-demo/assets" "$RELEASES/$C/web-demo/assets"
printf '<html>演示版 a <script src="/demo/assets/d.js"></script></html>\n' >"$RELEASES/$A/web-demo/index.html"
printf 'd' >"$RELEASES/$A/web-demo/assets/d.js"
printf '<html>演示版 c <script src="/demo/assets/d-c.js"></script></html>\n' >"$RELEASES/$C/web-demo/index.html"
printf 'dc' >"$RELEASES/$C/web-demo/assets/d-c.js"
printf 'commit=%s\nweb=桩\ndemo_path=/demo/\n' "$A" >"$RELEASES/$A/.fleet-release"
printf 'commit=%s\nweb=桩\n' "$B" >"$RELEASES/$B/.fleet-release"
printf 'commit=%s\nweb=桩\ndemo_path=/demo/\n' "$C" >"$RELEASES/$C/.fleet-release"

echo "== 演示版的路径：没写取默认 /demo/；不是一级路径、和根上已有的东西撞，报红"
reset
FLEET_DEMO_PATH=""
demo_config_ok >/dev/null
check "默认 /demo/" "$FLEET_DEMO_PATH" /demo/
check "默认值没有红" "${#REDS[@]}" 0
for p in /show/ /d-2/; do
  reset
  config demo "$p"
  check "FLEET_DEMO_PATH=$p：认" "${#REDS[@]}" 0
done
for p in /assets/ /health/ /api/ /auth/ /a/b/ /demo /Demo/ /../; do
  reset
  config demo "$p"
  check "FLEET_DEMO_PATH=$p：报红" "${#REDS[@]}" 1
done
check "demo 是认得的一样" "$([[ " ${HK_PARTS[*]} " == *" demo "* ]] && echo 是)" 是

echo "== 发到哪：demo 只动演示版的目录；web 才动根地址、也不碰演示版的目录；两样都发时演示版在前"
config gateway /demo/
check "只发网关（默认）：静态文件一处都不发" "$(dests "$A")" ""
config demo /demo/
check "demo：只发 /demo/，不碰根地址" "$(dests "$A")" "/demo/ "
check "演示版那一处不删 scopes/" "$(web_plan "$A" | grep -c -- '--exclude=/scopes/')" 1
check "演示版那一处发的是 web-demo/" "$(web_plan "$A" | awk '{ print $1 }')" "$RELEASES/$A/web-demo/"
check "demo、老的一版（没有演示版）：一处都不发" "$(dests "$B")" ""
config web /demo/
check "web：只发根地址" "$(dests "$A")" "/ "
check "根地址那一处不碰演示版的目录" "$(web_plan "$A" | grep -c -- '--exclude=/demo/')" 1
config "web demo" /demo/
check "web + demo：演示版在前，带版本标记的根地址在后" "$(dests "$A")" "/demo/ / "
config demo /show/
check "演示版是按 /demo/ 构建的、现在配的是 /show/：这次不发演示版" "$(dests "$A")" ""
config web /show/
check "根地址那一处护着的是现在配的演示版目录" "$(web_plan "$A" | grep -c -- '--exclude=/show/')" 1

echo "== sync_web 照着发：顺序、源、参数一样；发不出去报红、后面的不发；演示版发成了才记下香港上的是哪一版"
ONE_AT_A_TIME=0
rsync() {
  printf '%s\n' "$*" >>"$TMP/rsync.log"
  if ((ONE_AT_A_TIME)); then
    # 像香港的 rrsync：同一时刻只让一个进来（mkdir 当它的锁），占 0.4 秒；后到的照 rrsync 的原话拒掉、退出码 12
    if ! mkdir -- "$TMP/rrsync.busy" 2>/dev/null; then
      echo "/usr/bin/rrsync error: Another instance of rrsync is already accessing this directory." >&2
      return 12
    fi
    sleep 0.4
    rmdir -- "$TMP/rrsync.busy"
    return 0
  fi
  if [[ -n "${RSYNC_FAIL_AT:-}" && "${*: -1}" == *"$RSYNC_FAIL_AT" ]]; then
    echo "rsync: connection unexpectedly closed" >&2
    return 12
  fi
  echo ">f+++++++++ changed"
}
config demo /demo/
reset
: >"$TMP/rsync.log"
rm -f -- "$DEMO_RECORD"
sync_web "$A" >/dev/null
check "demo：发了一处" "$(grep -c . "$TMP/rsync.log")" 1
check "demo：一处都没往根上发" "$(grep -c 'root@10.99.0.1:/$' "$TMP/rsync.log")" 0
check "demo：只删演示版目录里的旧文件" "$(grep -c -- '--delete-after --delay-updates --exclude=/scopes/ .*root@10.99.0.1:/demo/$' "$TMP/rsync.log")" 1
check "demo：发成了当场记下香港上的演示版是 A（提交号、路径、首页指纹）" "$(record_is)" "$(record_of "$A" /demo/)"
check "记了两笔改动：换了文件、记下了是哪一版" "${#CHANGES[@]}" 2
# 同一个提交再发一遍：记录不重写（发的时间还是头一次的），只剩 rsync 自己报的（真 rsync 这时报 0 行、改动 0 处）
sed -i 's/^published=.*/published=2026-09-26T23:05:01Z/' "$DEMO_RECORD"
reset
sync_web "$A" >/dev/null
check "同一个提交再发一遍：记录不重写" "$(kv_get "$DEMO_RECORD" published)" 2026-09-26T23:05:01Z
check "同一个提交再发一遍：改动里没有「记下」那一笔" "$(printf '%s\n' "${CHANGES[@]}" | grep -c '记下香港上的演示版')" 0
config "web demo" /demo/
reset
: >"$TMP/rsync.log"
rm -f -- "$DEMO_RECORD"
RSYNC_FAIL_AT=/demo/
sync_web "$A" >/dev/null
unset RSYNC_FAIL_AT
check "演示版没发出去：报红" "${#REDS[@]}" 1
check "根地址（带版本标记）没发：健康检查就知道这一版没发全" "$(grep -c 'root@10.99.0.1:/$' "$TMP/rsync.log")" 0
check "演示版没发出去：不记（记了，核对就会把没发上去的当成在发的）" "$(record_is)" 没有
# 记录写不进去（这里让记录的位置是个目录）：演示版已经换了、却对不上号，要报红，不能悄悄过去
mkdir -p -- "$DEMO_RECORD"
reset
: >"$TMP/rsync.log"
sync_web "$A" >/dev/null 2>&1
check "记录写不进去：报红、停下（根地址不接着发）" \
  "${#REDS[@]}:$(printf '%s\n' "${REDS[@]}" | grep -c '记不下是哪一版'):$(grep -c 'root@10.99.0.1:/$' "$TMP/rsync.log")" "1:1:0"
rm -rf -- "$DEMO_RECORD" "$DEMO_RECORD.new"
config demo /show/
reset
sync_web "$A" >/dev/null
check "演示版的路径和配置对不上：记一项待配" "${#PENDING[@]}" 1
config demo /demo/
reset
sync_web "$B" >/dev/null
check "这一版没带演示版：记一项待配，香港上的演示版不动" "${#PENDING[@]}" 1
check "没发演示版：不记" "$(record_is)" 没有

echo "== 往香港推要排队：香港的 rrsync 同一时刻只让一个进来，法国这头先拿同一把锁（2026-09-26 发布撞上过 fleet-demo-scopes）"
ONE_AT_A_TIME=1
both() { # 命令：同时跑两次，打印两个退出码（从小到大）
  local a b ra rb
  "$@" x y 2>/dev/null &
  a=$!
  "$@" x y 2>/dev/null &
  b=$!
  wait "$a"
  ra=$?
  wait "$b"
  rb=$?
  printf '%s\n%s\n' "$ra" "$rb" | sort -n | tr '\n' ' '
}
check "不排队（修之前直接 rsync）：两个同时推，后到的被拒" "$(both rsync)" "0 12 "
check "排队（hk_rsync）：两个同时推都成" "$(both hk_rsync)" "0 0 "
# 锁一直被别人占着：等到点就照实失败（75），不硬推；发布的试通、发静态文件都走这把锁
exec 8>>"$HK_RSYNC_LOCK"
flock 8
HK_RSYNC_WAIT=1
: >"$TMP/rsync.log"
out=$(hk_rsync x y 2>&1)
check "锁被占着：等 1 秒就退出 75，说清楚" "$? $(grep -c '还没轮到往香港推文件' <<<"$out")" "75 1"
reset
web_reachable >/dev/null
check "试通香港也排队：轮不到就报红（没切版本），一次都没推" \
  "${#REDS[@]} $(printf '%s\n' "${REDS[@]}" | grep -c '还没轮到') $(grep -c . "$TMP/rsync.log")" "1 1 0"
config web /demo/
reset
sync_web "$A" >/dev/null
check "发静态文件也排队：轮不到就报红，一次都没推" \
  "${#REDS[@]} $(printf '%s\n' "${REDS[@]}" | grep -c '还没轮到') $(grep -c . "$TMP/rsync.log")" "1 1 0"
HK_RSYNC_WAIT=120
exec 8>&-
reset
web_reachable >/dev/null
check "锁放开了：试通香港照常过" "${#REDS[@]} $(grep -c . "$TMP/rsync.log")" "0 1"
ONE_AT_A_TIME=0

echo "== 健康检查：演示版照发演示版的记录比（是不是上次发的那份）、深链接回落到哪"
if [[ -z "$NODE" ]]; then
  echo "  … 没跑成：这台没有 node（版本标记要用它读）"
  skipped=1
else
  # 假香港：一个目录，curl 按 nginx 的回落规则答。NGINX=new 有演示版那一段，old 是没重跑 hk.sh 之前的样子
  HKD=$TMP/hk
  NGINX=new
  serve() { # 站内路径 → 打印要给的文件；没有返回 1
    local p=${1%%\?*}
    # 香港站点里它单有一段：没有这个文件（或不是从隧道来的）就是 404，不回落到首页
    if [[ "$p" == /release.json ]]; then
      if [[ -f "$HKD/release.json" ]]; then
        echo "$HKD/release.json"
        return 0
      fi
      return 1
    fi
    if [[ "$p" == */ && -f "$HKD${p}index.html" ]]; then
      echo "$HKD${p}index.html"
      return 0
    fi
    if [[ -f "$HKD$p" ]]; then
      echo "$HKD$p"
      return 0
    fi
    if [[ "$p" == /health/* ]]; then return 1; fi
    if [[ "$NGINX" == new && "$p" == "$FLEET_DEMO_PATH"* ]]; then
      echo "$HKD${FLEET_DEMO_PATH}index.html"
      return 0
    fi
    echo "$HKD/index.html"
  }
  curl() {
    local url="" out="" fmt="" strict=0 file
    while (($#)); do
      case $1 in
      -o)
        out=$2
        shift
        ;;
      -w)
        fmt=$2
        shift
        ;;
      -f) strict=1 ;;
      --resolve | --max-time) shift ;;
      https://*) url=$1 ;;
      esac
      shift
    done
    if ! file=$(serve "${url#https://"$FLEET_DOMAIN"}"); then
      if [[ -n "$fmt" ]]; then printf '404'; fi
      if ((strict)); then return 22; fi
      return 0
    fi
    if [[ -n "$out" ]]; then cp -- "$file" "$out"; else cat -- "$file"; fi
    if [[ -n "$fmt" ]]; then printf '200'; fi
  }
  hk_as() { # 提交号 根上的首页：把假香港摆成「人手动发完这一版」的样子（根上的首页另给），带演示版的连演示版一起发、记下
    rm -rf -- "$HKD" "$DEMO_RECORD"
    mkdir -p "$HKD/health" "$HKD/demo/scopes"
    cp -- "$RELEASES/$1/web/release.json" "$HKD/release.json"
    cp -- "$RELEASES/$1/web/health/index.html" "$HKD/health/index.html"
    printf '%s\n' "$2" >"$HKD/index.html"
    if [[ -d "$RELEASES/$1/web-demo" ]]; then demo_published "$1"; fi
  }
  demo_published() { # 提交号：假香港的演示版换成这一版的，记录由 release.sh 的真 record_demo 写（和 sync_web 发成了一样）
    rm -rf -- "$HKD/demo"
    mkdir -p "$HKD/demo/scopes"
    cp -R -- "$RELEASES/$1/web-demo/." "$HKD/demo/"
    record_demo "$1" >/dev/null
  }
  root_as() { # 提交号：假香港的根地址换成这一版的（自动发布发 web 的样子），演示版不动
    cp -- "$RELEASES/$1/web/release.json" "$HKD/release.json"
    printf '<html>驾驶舱 %s</html>\n' "${1:0:1}" >"$HKD/index.html"
  }
  config demo /demo/
  hk_as "$A" '<html>根上原来的演示版</html>'
  printf '{"commit":"%s"}\n' "$B" >"$HKD/release.json"
  reset
  check_web "$A" >/dev/null
  check "demo：演示版是这一版、深链接对：通过（不看根上的版本标记）" "$?" 0
  check "demo：没有红" "${#REDS[@]}" 0
  check "demo：没有待配" "${#PENDING[@]}" 0
  NGINX=old
  reset
  check_web "$A" >/dev/null
  check "香港的站点还没有演示版那一段：照样通过" "$?" 0
  check "但记一项待配，让人去香港重跑 hk.sh" "$(printf '%s\n' "${PENDING[@]}" | grep -c 'hk.sh')" 1
  NGINX=new
  printf '<html>演示版 上一版</html>\n' >"$HKD/demo/index.html"
  reset
  check_web "$A" >/dev/null
  check "演示版的首页被换过（不是上次发的那份）：不过" "$?" 1
  check "报红，说不是上次发的那份" "$(printf '%s\n' "${REDS[@]}" | grep -c '不是上次发的演示版')" 1
  config "web demo" /demo/
  hk_as "$A" '<html>驾驶舱 a</html>'
  reset
  check_web "$A" >/dev/null
  check "web + demo：版本标记、健康页、演示版都对：通过" "$?" 0
  hk_as "$B" '<html>根上原来的演示版</html>'
  reset
  check_web "$A" >/dev/null
  check "web：版本标记还是别的版本：不过" "$?" 1
  hk_as "$A" '<html>驾驶舱 a</html>'
  rm -f -- "$HKD/release.json"
  reset
  check_web "$A" >/dev/null
  check "web：香港对版本标记回 404（比如站点放行的不是法国的隧道地址）：不过" "$?" 1
  check "红里说的是取不到，不当成「在发一个空版本」" "$(printf '%s\n' "${REDS[@]}" | grep -c '从香港取不到')" 1

  echo "== --check 看演示版（2026-09-27 那次误报）：香港上的演示版还是上次人发的 A，在用的是后来发的 C"
  config "web demo" /demo/
  hk_as "$A" '<html>驾驶舱 a</html>'
  root_as "$C"
  check "场景和那次一样：香港上的演示版首页和在用的 C 的不一样（拿 C 的去比就是那次的红）" \
    "$([[ "$(page_sum /demo/)" != "$(file_sum "$RELEASES/$C/web-demo/index.html")" ]] && echo 不一样)" 不一样
  reset
  check_web "$C" >"$TMP/out"
  check "--check：通过——香港上的就是上次人发的那份，C 的没发是定好的（对外，要人确认）" "$?:${#REDS[@]}" "0:0"
  check "--check：说清香港上的是哪一版" "$(said_line '演示版是上次发的那份（aaaaaaaaaaaa，')" 1
  check "--check：列出 C 的演示版还没发、怎么发" "$(said_line 'cccccccccccc 的演示版和香港上的不一样，还没发')" 1
  check "--check：不记待配（没发是定好的，不是缺配置）" "${#PENDING[@]}" 0

  echo "== --check 照样核对演示版：故意把香港上的演示版弄坏"
  config "web demo" /demo/
  printf '<html>被人手改过</html>\n' >"$HKD/demo/index.html"
  reset
  check_web "$C" >/dev/null
  check "首页被改过：不过（报红，照常退回、报警）" "$?:${#REDS[@]}" "1:1"
  check "红里说清：不是上次发的那份、是哪一版" "$(printf '%s\n' "${REDS[@]}" | grep -c '不是上次发的演示版（aaaaaaaaaaaa，')" 1
  rm -f -- "$HKD/demo/index.html"
  reset
  check_web "$C" >/dev/null
  check "首页没了：也不过" "$?:${#REDS[@]}" "1:1"

  echo "== 发演示版的记录：没有、认不出、路径对不上，都照实说，不当成对得上"
  demo_published "$A"
  rm -f -- "$DEMO_RECORD"
  reset
  check_web "$C" >"$TMP/out"
  check "没有记录：不报红（还没人发过，或刚上这套记录）" "$?:${#REDS[@]}" "0:0"
  check "没有记录：记待处理、说没查成（不当成查了没事）" "$(printf '%s\n' "${PENDING[@]}" | grep -c '没有发演示版的记录.*没查成')" 1
  check "没有记录：不说「演示版是上次发的那份」" "$(said_line '演示版是上次发的那份')" 0
  printf 'commit=%s\npath=/demo/\n' "$A" >"$DEMO_RECORD"
  reset
  check_web "$C" >/dev/null
  check "记录缺首页指纹：报红（认不出不能当成对得上）" "$?:$(printf '%s\n' "${REDS[@]}" | grep -c '记录认不出')" "1:1"
  printf '香港上是 A 那版\n' >"$DEMO_RECORD"
  reset
  check_web "$C" >/dev/null
  check "记录不是「键=值」：报红" "$?:$(printf '%s\n' "${REDS[@]}" | grep -c '记录认不出')" "1:1"
  demo_published "$A"
  sed -i 's#^path=.*#path=/show/#' "$DEMO_RECORD"
  reset
  check_web "$C" >/dev/null
  check "记录里的路径不是现在配的：不报红，记待处理（新路径上还没发过）" \
    "$?:${#REDS[@]}:$(printf '%s\n' "${PENDING[@]}" | grep -c '新路径上还没发过')" "0:0:1"

  echo "== 人手动发 C（创始人确认了）：香港上的演示版换成 C、记录跟着换，核对认 C"
  config "web demo" /demo/
  hk_as "$C" '<html>驾驶舱 c</html>'
  reset
  check_web "$C" >"$TMP/out"
  check "通过，没有红、没有待配" "$?:${#REDS[@]}:${#PENDING[@]}" "0:0:0"
  check "记录是 C 的" "$(record_is)" "$(record_of "$C" /demo/)"
  check "不再列「还没发」" "$(said_line '还没发')" 0
fi

echo "== 香港的站点配置：演示版那一段（两份模板都有，占位都换得掉）"
block() { # 开头那一行：打印 $RENDERED 里从这一行到它那个「}」的一段
  awk -v h="$1" 'index($0, h) { on = 1 } on { print } on && /^ *}$/ { exit }' <<<"$RENDERED"
}
for tpl in nginx-http.conf nginx-https.conf; do
  render "$HERE/../hk/$tpl" SERVER_NAME=cockpit.example.test WEB_ROOT=/srv/fleet-dao-web ACME_ROOT=/var/www/acme \
    API_UPSTREAM=10.99.0.2:8787 DEMO_PATH=/demo/ DEMO_BASE=/demo TUNNEL_PEER=10.99.0.2 >/dev/null
  check "$tpl：占位都换掉了" "$?" 0
  check "$tpl：深链接回落到演示版自己的首页" "$(grep -c 'try_files $uri /demo/index.html;' <<<"$RENDERED")" 1
  check "$tpl：可见范围查不到就 404、不缓存" "$(block 'location ^~ /demo/scopes/ {' | grep -c -e 'no-store' -e 'try_files $uri =404;')" 2
  check "$tpl：演示版首页不缓存" "$( (block 'location = /demo/ {' && block 'location = /demo/index.html {') | grep -c 'no-cache')" 2
  check "$tpl：/demo 跳到 /demo/" "$(grep -A1 'location = /demo {' <<<"$RENDERED" | grep -c 'return 301 /demo/$is_args$args;')" 1
  reset
  render "$HERE/../hk/$tpl" SERVER_NAME=x WEB_ROOT=/w ACME_ROOT=/a API_UPSTREAM=u DEMO_PATH=/demo/ >/dev/null
  check "$tpl：少给一个占位就报红" "${#REDS[@]}" 1
done

if ((fail)); then
  echo "web-publish：不通过"
  exit 1
fi
if ((skipped)); then
  echo "web-publish：其余通过，有没跑成的"
  exit 2
fi
echo "web-publish：通过"
