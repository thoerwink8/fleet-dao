#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # FLEET_HK_PARTS、FLEET_DOMAIN 这些是给 source 进来的 release.sh 里的函数读的
# shellcheck disable=SC2016 # 单引号里的 $uri、$args 是 nginx 配置里的字面量，本来就不该展开
# deploy/release.sh 往香港发静态文件的那一段（release.env 的 FLEET_HK_PARTS 选）：demo 只发演示版到 FLEET_DEMO_PATH、
# 不碰根地址，演示版下面的可见范围（scopes/）发布不删；web 才把驾驶舱整套发到根地址，而且不碰演示版的目录；
# 两样都发时演示版在前、带版本标记的根地址在后。健康检查认得出演示版是不是这一版、深链接回落对不对。
# rsync、curl 换成桩（curl 按一个假香港的目录答），其余是 release.sh 里的真代码。
# 香港站点配置（deploy/hk/nginx-*.conf）的演示版那一段也在这里核对。
# 用法：bash deploy/test/web-publish.test.sh。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
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
config() { # FLEET_HK_PARTS FLEET_DEMO_PATH
  FLEET_HK_PARTS=$1
  FLEET_DEMO_PATH=$2
  demo_config_ok >/dev/null
}
# 每一处发到哪（香港路径），按顺序
dests() { web_plan "$1" | awk '{ print $2 }' | tr '\n' ' '; }

A=$(printf 'a%.0s' {1..40}) # 带演示版的新一版
B=$(printf 'b%.0s' {1..40}) # 老的一版：只有 web/，标记里没有 demo_path
for s in "$A" "$B"; do
  mkdir -p "$RELEASES/$s/web/assets" "$RELEASES/$s/web/health"
  printf '<html>驾驶舱 %s</html>\n' "${s:0:1}" >"$RELEASES/$s/web/index.html"
  printf 'x' >"$RELEASES/$s/web/assets/app.js"
  printf 'health' >"$RELEASES/$s/web/health/index.html"
  printf '{"commit":"%s"}\n' "$s" >"$RELEASES/$s/web/release.json"
done
mkdir -p "$RELEASES/$A/web-demo/assets"
printf '<html>演示版 a <script src="/demo/assets/d.js"></script></html>\n' >"$RELEASES/$A/web-demo/index.html"
printf 'd' >"$RELEASES/$A/web-demo/assets/d.js"
printf 'commit=%s\nweb=桩\ndemo_path=/demo/\n' "$A" >"$RELEASES/$A/.fleet-release"
printf 'commit=%s\nweb=桩\n' "$B" >"$RELEASES/$B/.fleet-release"

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

echo "== sync_web 照着发：顺序、源、参数一样；发不出去报红、后面的不发"
rsync() {
  printf '%s\n' "$*" >>"$TMP/rsync.log"
  if [[ -n "${RSYNC_FAIL_AT:-}" && "${*: -1}" == *"$RSYNC_FAIL_AT" ]]; then
    echo "rsync: connection unexpectedly closed" >&2
    return 12
  fi
  echo ">f+++++++++ changed"
}
config demo /demo/
reset
: >"$TMP/rsync.log"
sync_web "$A" >/dev/null
check "demo：发了一处" "$(grep -c . "$TMP/rsync.log")" 1
check "demo：一处都没往根上发" "$(grep -c 'root@10.99.0.1:/$' "$TMP/rsync.log")" 0
check "demo：只删演示版目录里的旧文件" "$(grep -c -- '--delete-after --delay-updates --exclude=/scopes/ .*root@10.99.0.1:/demo/$' "$TMP/rsync.log")" 1
check "记了一笔改动" "${#CHANGES[@]}" 1
config "web demo" /demo/
reset
: >"$TMP/rsync.log"
RSYNC_FAIL_AT=/demo/
sync_web "$A" >/dev/null
unset RSYNC_FAIL_AT
check "演示版没发出去：报红" "${#REDS[@]}" 1
check "根地址（带版本标记）没发：健康检查就知道这一版没发全" "$(grep -c 'root@10.99.0.1:/$' "$TMP/rsync.log")" 0
config demo /show/
reset
sync_web "$A" >/dev/null
check "演示版的路径和配置对不上：记一项待配" "${#PENDING[@]}" 1
config demo /demo/
reset
sync_web "$B" >/dev/null
check "这一版没带演示版：记一项待配，香港上的演示版不动" "${#PENDING[@]}" 1

echo "== 健康检查：演示版的首页是不是这一版、深链接回落到哪"
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
  hk_as() { # 提交号 根上的首页：把假香港摆成「发完这一版」的样子（根上的首页另给）
    rm -rf -- "$HKD"
    mkdir -p "$HKD/health" "$HKD/demo/scopes"
    cp -- "$RELEASES/$1/web/release.json" "$HKD/release.json"
    cp -- "$RELEASES/$1/web/health/index.html" "$HKD/health/index.html"
    if [[ -d "$RELEASES/$1/web-demo" ]]; then cp -R -- "$RELEASES/$1/web-demo/." "$HKD/demo/"; fi
    printf '%s\n' "$2" >"$HKD/index.html"
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
  check "演示版的首页不是这一版：不过" "$?" 1
  check "报红" "${#REDS[@]}" 1
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
