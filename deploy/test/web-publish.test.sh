#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # FLEET_HK_PARTS、FLEET_DOMAIN 这些是给 source 进来的 release.sh 里的函数读的
# shellcheck disable=SC2016 # 单引号里的 $uri、$args 是 nginx 配置里的字面量，本来就不该展开
# deploy/release.sh 往香港发静态文件的那一段（release.env 的 FLEET_HK_PARTS 选）：web 把驾驶舱整套发到根地址、
# 根上不是这一版的一律删。香港站点配置（deploy/hk/nginx-*.conf）里 /demo 一律 404（#1223）。
# rsync、curl 换成桩（curl 按一个假香港的目录答），其余是 release.sh 里的真代码。
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
UPLOAD_KEY=$TMP/up.key
HK_KNOWN_HOSTS=$TMP/known-hosts

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
config() { # FLEET_HK_PARTS：人手动发布（和 --check）的样子
  FLEET_HK_PARTS=$1
}
reds_with_text() { printf '%s\n' "${REDS[@]}" | grep -cF -- "$1"; } # 红里有几条带这段话
# 每一处发到哪（香港路径），按顺序
dests() { web_plan "$1" | awk '{ print $2 }' | tr '\n' ' '; }

A=$(printf 'a%.0s' {1..40})
B=$(printf 'b%.0s' {1..40})
for s in "$A" "$B"; do
  mkdir -p "$RELEASES/$s/web/assets" "$RELEASES/$s/web/health"
  printf '<html>驾驶舱 %s</html>\n' "${s:0:1}" >"$RELEASES/$s/web/index.html"
  printf 'x' >"$RELEASES/$s/web/assets/app.js"
  printf 'health' >"$RELEASES/$s/web/health/index.html"
  printf '{"commit":"%s"}\n' "$s" >"$RELEASES/$s/web/release.json"
  printf 'commit=%s\nweb=桩\n' "$s" >"$RELEASES/$s/.fleet-release"
done

echo "== 往香港发哪几样：认得的只有 web；老机器上留着的 demo 不再是认得的一样"
check "认得的一样：web" "${HK_PARTS[*]}" "web"
check "demo 不是认得的一样" "$([[ " ${HK_PARTS[*]} " == *" demo "* ]] && echo 是 || echo 不是)" 不是

echo "== 发到哪：什么都不发就一处都不发；web 整套发根地址，不再排除老目录"
config ""
check "什么都不发（默认）：静态文件一处都不发" "$(dests "$A")" ""
config web
check "web：只发根地址" "$(dests "$A")" "/ "
check "根地址那一处不再排除任何目录（老目录要被带走）" "$(web_plan "$A" | grep -c -- '--exclude')" 0
check "根地址那一处发的是 web/，先落临时名、旧的最后删" \
  "$(web_plan "$A")" "$RELEASES/$A/web/ / --delete-after --delay-updates"
config web
check "往香港发哪几样照实说" "$(parts_said)" "web"
config ""
check "什么都不发也照实说" "$(parts_said)" "（都不发）"

echo "== sync_web 照着发：源、参数一样；发不出去报红"
ONE_AT_A_TIME=0
HKD=$TMP/hk # 假香港的目录
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
config web
reset
: >"$TMP/rsync.log"
sync_web "$A" >/dev/null
check "web：发了一处" "$(grep -c . "$TMP/rsync.log")" 1
check "web：发到根上" "$(grep -c 'root@10.99.0.1:/$' "$TMP/rsync.log")" 1
check "web：只带 --delete-after --delay-updates，不排除任何目录" \
  "$(grep -c -- '--delete-after --delay-updates -e .* -- .*/web/ root@10.99.0.1:/$' "$TMP/rsync.log"):$(grep -c -- '--exclude' "$TMP/rsync.log")" "1:0"
check "web：记了一笔改动" "${#CHANGES[@]}" 1
reset
: >"$TMP/rsync.log"
RSYNC_FAIL_AT=/
sync_web "$A" >/dev/null
unset RSYNC_FAIL_AT
check "发不出去：报红" "${#REDS[@]}" 1

echo "== 往香港推要排队：香港的 rrsync 同一时刻只让一个进来，法国这头先拿同一把锁（2026-09-26 发布撞上过）"
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
config web
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

echo "== 健康检查：根地址的版本标记、健康页对（发版不再删、不再读回香港上老的 /demo/：#1223 早做完、目录已不在，#2186）"
check "删老目录、读回老目录那几步已撤" "$(declare -F retire_hk_dir check_retired_dir hk_static_ours | wc -l)" 0
if [[ -z "$NODE" ]]; then
  echo "  … 没跑成：这台没有 node（版本标记要用它读）"
  skipped=1
else
  # 假香港：一个目录，curl 按 nginx 的回落规则答
  FAKE_DOWN=0 # 1 = 连不上香港
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
    if ((FAKE_DOWN)); then return 7; fi
    if ! file=$(serve "${url#https://"$FLEET_DOMAIN"}"); then
      if [[ -n "$fmt" ]]; then printf '404'; fi
      if ((strict)); then return 22; fi
      return 0
    fi
    if [[ -n "$out" ]]; then cp -- "$file" "$out"; else cat -- "$file"; fi
    if [[ -n "$fmt" ]]; then printf '200'; fi
  }
  hk_at() { # 提交号：把假香港摆成「根上是这一版」的样子
    rm -rf -- "$HKD"
    mkdir -p "$HKD/health"
    cp -- "$RELEASES/$1/web/release.json" "$HKD/release.json"
    cp -- "$RELEASES/$1/web/health/index.html" "$HKD/health/index.html"
    printf '<html>驾驶舱 %s</html>
' "${1:0:1}" >"$HKD/index.html"
  }
  hk_at "$A"
  config web
  reset
  check_web "$A" >/dev/null
  check "web：版本标记、健康页都对：通过、没有红" "$?:${#REDS[@]}" "0:0"
  hk_at "$B"
  reset
  check_web "$A" >/dev/null
  check "web：版本标记还是别的版本：不过" "$?" 1
  hk_at "$A"
  rm -f -- "$HKD/release.json"
  reset
  check_web "$A" >/dev/null
  check "web：香港对版本标记回 404（比如站点放行的不是法国的隧道地址）：不过" "$?" 1
  check "红里说的是取不到，不当成「在发一个空版本」" "$(reds_with_text '从香港取不到')" 1
  config ""
  hk_at "$A"
  rm -f -- "$HKD/release.json"
  reset
  check_web "$A" >/dev/null
  check "什么都不发：不查根地址的版本标记" "$?:${#REDS[@]}" "0:0"
fi

echo "== 香港的站点配置：/demo 一律 404、不回落到首页；演示版那一段（占位、scopes）没有了"
block() { # 开头那一行：打印 $RENDERED 里从这一行到它那个「}」的一段
  awk -v h="$1" 'index($0, h) { on = 1 } on { print } on && /^ *}$/ { exit }' <<<"$RENDERED"
}
for tpl in nginx-http.conf nginx-https.conf; do
  render "$HERE/../hk/$tpl" SERVER_NAME=cockpit.example.test WEB_ROOT=/srv/fleet-dao-web ACME_ROOT=/var/www/acme \
    API_UPSTREAM=10.99.0.2:8787 TUNNEL_PEER=10.99.0.2 >/dev/null
  check "$tpl：占位都换掉了（不再有演示版的占位）" "$?" 0
  check "$tpl：/demo 和 /demo/ 开头的一律 return 404" "$(block 'location ~ ^/demo(/|$) {' | grep -c 'return 404;')" 1
  check "$tpl：没有可见范围（scopes）那一段" "$(grep -c 'scopes' <<<"$RENDERED")" 0
  check "$tpl：没有把 /demo/ 回落到演示版自己的首页" "$(grep -c 'demo/index.html' <<<"$RENDERED")" 0
  reset
  render "$HERE/../hk/$tpl" SERVER_NAME=x WEB_ROOT=/w ACME_ROOT=/a API_UPSTREAM=u >/dev/null
  check "$tpl：少给一个占位（TUNNEL_PEER）就报红" "${#REDS[@]}" 1
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
