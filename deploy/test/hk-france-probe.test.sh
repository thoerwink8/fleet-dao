#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2317 # cleanup 由 trap 调用，shellcheck 看成走不到
# 香港探法国（deploy/hk/france-probe.sh）：连续 2 次失败不推，第 3 次推「法国失联自」，
# 再失败不重复推，恢复推一次；没配 webhook 只写状态、退出 0，不把地址打进日志。
# 不碰真机器：状态、推送地址、时刻都换到临时目录；探测和 POST 换成钩子。
# 用法：bash deploy/test/hk-france-probe.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd -- "$HERE/../.." && pwd)
TMP=$(mktemp -d)
NG_PID=""
cleanup() {
  if [[ -n "$NG_PID" ]]; then
    kill "$NG_PID" 2>/dev/null || true
    wait "$NG_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TMP"
}
trap cleanup EXIT

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
has() { # 说明 文本 要有的一段
  if [[ "$2" == *"$3"* ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：「%s」里没有「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
lacks() { # 说明 文本 不该有的一段
  if [[ "$2" == *"$3"* ]]; then
    printf '  ✗ %s：不该出现「%s」\n' "$1" "$3"
    fail=1
  else
    printf '  ✓ %s\n' "$1"
  fi
}

if ! command -v node >/dev/null; then
  echo "没跑成：这台没有 node，读不了状态 JSON"
  exit 2
fi
if ! FIRST=$(date -u -d '2026-10-15 02:38:00' +%s); then
  echo "没跑成：date -d 不可用，定不了失联时刻"
  exit 2
fi
HHMM=$(TZ=Asia/Shanghai date -d "@$FIRST" +%H:%M)
check "第一次失败换算成北京时间" "$HHMM" "10:38"

STATE=$TMP/state/status.json
ENVF=$TMP/hk-probe.env
POSTS=$TMP/posts
mkdir -p "$TMP/state"
: >"$POSTS"
export FLEET_PROBE_URL=http://10.99.0.2:8787/healthz
export FLEET_PROBE_STATE=$STATE
export FLEET_PROBE_ENV=$ENVF
export FLEET_PROBE_NOW=$FIRST
# shellcheck source=../hk/france-probe.sh
source "$HERE/../hk/france-probe.sh"

HOOK_KIND=down
HOOK_REASON=连不上
probe_observe_hook() {
  OBS_KIND=$HOOK_KIND
  OBS_REASON=$HOOK_REASON
}
probe_post_hook() {
  printf '%s\n' "$2" >>"$POSTS"
}

post_count() {
  local n
  n=$(grep -c . "$POSTS" || true)
  printf '%s' "${n:-0}"
}
state_field() { # 键
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=s[process.argv[2]]; process.stdout.write(v===undefined?"":String(v));' "$STATE" "$1"
}
step_probe() { # up|down 原因 epoch
  HOOK_KIND=$1
  HOOK_REASON=$2
  FLEET_PROBE_NOW=$3
  OUT=$(run_once 2>&1)
  RC=$?
}

printf 'FLEET_HK_PROBE_WEBHOOK="https://example.invalid/hook"\n' >"$ENVF"

echo "== 连续 2 次失败不推，第 3 次才报失联"
step_probe down 连不上 "$FIRST"
check "第 1 次退出 0" "$RC" 0
check "第 1 次不推" "$(post_count)" 0
has "第 1 次还没到失联" "$OUT" "失败 1/3"
step_probe down 超时 "$((FIRST + 60))"
check "第 2 次不推" "$(post_count)" 0
check "第 2 次还不算失联" "$(state_field down)" "false"
check "连续失败记成 2" "$(state_field consecutiveFailures)" "2"
has "第 2 次写明还没到" "$OUT" "失败 2/3"
step_probe down 连不上 "$((FIRST + 120))"
check "第 3 次退出 0" "$RC" 0
check "第 3 次推了一次" "$(post_count)" 1
check "状态是失联" "$(state_field down)" "true"
check "失联时刻是第一次失败，不是第三次" "$(state_field downSince)" "$FIRST"
check "页面用的北京时间" "$(state_field downSinceText)" "10:38"
has "推送正文是法国失联自 10:38" "$(<"$POSTS")" "法国失联自 10:38"
has "日志也写了失联" "$OUT" "法国失联自 10:38"
lacks "日志不打 webhook 地址" "$OUT" "example.invalid"
step_probe down 连不上 "$((FIRST + 180))"
check "失联期间再失败不重复推" "$(post_count)" 1
has "写明仍失联" "$OUT" "仍失联"

echo "== 恢复只报一次"
step_probe up "" "$((FIRST + 240))"
check "恢复退出 0" "$RC" 0
check "恢复推了一次" "$(post_count)" 2
has "恢复正文" "$(<"$POSTS")" "法国恢复了"
has "恢复写明失联自何时" "$(<"$POSTS")" "失联自 10:38"
check "恢复后不再是失联" "$(state_field down)" "false"
check "失败次数清零" "$(state_field consecutiveFailures)" "0"
step_probe up "" "$((FIRST + 300))"
check "一直通着不再推" "$(post_count)" 2
has "通的那一轮写明通" "$OUT" "通（"

echo "== 没配 webhook：只写状态，不推，不报错"
: >"$POSTS"
rm -f -- "$STATE" "$ENVF"
step_probe down 连不上 "$FIRST"
step_probe down 连不上 "$((FIRST + 60))"
step_probe down 连不上 "$((FIRST + 120))"
check "没配也退出 0" "$RC" 0
check "没配不调用推送" "$(post_count)" 0
check "没配照样写成失联" "$(state_field down)" "true"
check "没配也记下北京时间" "$(state_field downSinceText)" "10:38"
has "日志写明没配" "$OUT" "没配推送"
lacks "没配不当成已推送" "$OUT" "已推送"

echo "== 地址不是 http(s)：只写状态，退出 0"
printf 'FLEET_HK_PROBE_WEBHOOK=not-a-url\n' >"$ENVF"
rm -f -- "$STATE"
: >"$POSTS"
step_probe down 连不上 "$FIRST"
step_probe down 连不上 "$((FIRST + 60))"
step_probe down 连不上 "$((FIRST + 120))"
check "坏地址退出 0" "$RC" 0
check "坏地址不推" "$(post_count)" 0
check "坏地址照样写成失联" "$(state_field down)" "true"
has "日志写明地址不对" "$OUT" "不是 http(s)"

echo "== hk.sh 会装定时器，两份站点都把状态文件指给健康页"
HK=$HERE/../hk.sh
has "hk.sh 装探活" "$(<"$HK")" "setup_france_probe"
has "装机流程会调用" "$(<"$HK")" $'\n    setup_france_probe\n'
has "定时器单元名" "$(<"$HK")" "fleet-hk-france-probe.timer"
has "探的是隧道上的法国 healthz" "$(<"$HERE/../hk/france-probe.sh")" "http://10.99.0.2:8787/healthz"
has "服务跑这份脚本" "$(<"$HERE/../hk/fleet-hk-france-probe.service")" "ExecStart=/usr/local/lib/fleet-dao/france-probe.sh"
has "每分钟一次" "$(<"$HERE/../hk/fleet-hk-france-probe.timer")" "OnUnitInactiveSec=1min"
has "样例里有 webhook 键" "$(<"$HERE/../hk/hk-probe.env.example")" "FLEET_HK_PROBE_WEBHOOK="
for tpl in nginx-http.conf nginx-https.conf; do
  text=$(<"$HERE/../hk/$tpl")
  has "$tpl 有精确路径" "$text" "location = /health/france-link.json"
  has "$tpl 指到状态文件" "$text" "alias /var/lib/fleet-hk-france-probe/status.json;"
  has "$tpl 这一层自己带 noindex" "$text" 'add_header X-Robots-Tag "noindex, nofollow" always;'
done

echo "== 装了 nginx 时，健康页读得到「法国失联自 10:38」"
if ! command -v nginx >/dev/null || ! command -v curl >/dev/null; then
  # 不当通过：CI 那台有 nginx，这一段本机跳过时真红过一次没人看见（回应头按小写比，nginx 回的是 X-Robots-Tag）
  echo "  … 没跑成：这台没有 nginx 或 curl，没真起站点（页面判定另由 health-page.test.mjs 盖住）"
  skipped=1
else
  # shellcheck source=../lib/common.sh
  source "$HERE/../lib/common.sh"
  NG=$TMP/nginx
  mkdir -p "$NG" "$TMP/web" "$TMP/acme" "$TMP/state" \
    "$NG/body" "$NG/proxy" "$NG/fastcgi" "$NG/uwsgi" "$NG/scgi"
  # CI 上 sudo 起 nginx，干活的进程不是 root。mktemp 是 700，不放开它就 403，测不成「文件没有是 404」。
  chmod 755 "$TMP" "$TMP/state" "$NG" "$NG/body" "$NG/proxy" "$NG/fastcgi" "$NG/uwsgi" "$NG/scgi"
  # stdout.write：console.log 在 FORCE_COLOR 下会给数字上色，端口串进 listen 后 nginx 认不出
  PORT=$(node -e 'const s=require("net").createServer(); s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port)); s.close()});')
  render "$HERE/../hk/nginx-http.conf" SERVER_NAME=localhost WEB_ROOT="$TMP/web" ACME_ROOT="$TMP/acme" TUNNEL_PEER=10.99.0.2
  check "http 模板占位都换掉了" "${#REDS[@]}" 0
  site=$RENDERED
  site=${site//"alias /var/lib/fleet-hk-france-probe/status.json;"/"alias $TMP/state/status.json;"}
  site=${site//"listen 80;"/"listen 127.0.0.1:$PORT;"}
  site=${site//"access_log /var/log/nginx/access.log "/"access_log $NG/access.log "}
  printf '%s\n' "$site" >"$NG/site.conf"
  cat >"$NG/nginx.conf" <<EOF
pid $NG/nginx.pid;
error_log $NG/error.log;
events {}
http {
    access_log off;
    client_body_temp_path $NG/body;
    proxy_temp_path $NG/proxy;
    fastcgi_temp_path $NG/fastcgi;
    uwsgi_temp_path $NG/uwsgi;
    scgi_temp_path $NG/scgi;
    include $NG/site.conf;
}
EOF
  rm -f -- "$STATE"
  if ! nginx -t -p "$NG/" -c "$NG/nginx.conf" >"$NG/stdout" 2>&1; then
    echo "  nginx -t 没过："
    tail -20 "$NG/stdout" | sed 's/^/    /'
  fi
  nginx -p "$NG/" -c "$NG/nginx.conf" -g 'daemon off;' >>"$NG/stdout" 2>&1 &
  NG_PID=$!
  code=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$PORT/health/france-link.json" || true)
    [[ "$code" == 404 || "$code" == 200 ]] && break
    sleep 0.1
  done
  if [[ "$code" != 404 && "$code" != 200 ]]; then
    echo "  nginx 没答上来（最后状态「${code:-无}」），错误日志："
    tail -20 "$NG/error.log" 2>/dev/null | sed 's/^/    /'
    tail -20 "$NG/stdout" 2>/dev/null | sed 's/^/    /'
  fi
  check "状态文件还没有：404，不落到首页" "$code" 404
  printf '%s\n' '{"schema":1,"down":true,"downSince":"'"$FIRST"'","downSinceText":"10:38","consecutiveFailures":3,"lastCheckAt":"2026-10-15T02:40:00Z","lastError":"连不上"}' >"$STATE"
  chmod 644 -- "$STATE"
  body=$(curl -s --max-time 2 "http://127.0.0.1:$PORT/health/france-link.json" || true)
  # 头名不分大小写，nginx 回的是 X-Robots-Tag：整份转小写再比
  head=$(curl -s -D - -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health/france-link.json" | tr -d '\r' | tr '[:upper:]' '[:lower:]' || true)
  check "状态文件在：200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/health/france-link.json" || true)" 200
  has "回应带 noindex" "$head" "x-robots-tag: noindex, nofollow"
  shown=$(
    BODY=$body HEALTH_JS="$ROOT/deploy/web/health/health.js" node --input-type=module -e '
      import { pathToFileURL } from "node:url";
      const m = await import(pathToFileURL(process.env.HEALTH_JS).href);
      const link = m.franceLinkLine(JSON.parse(process.env.BODY));
      const health = m.judge({
        status: 200,
        body: JSON.stringify({ ok: true, checks: { database: { ok: true }, temporal: { ok: true }, engine: { ok: true } } }),
      });
      const v = m.applyFranceLink(health, link);
      if (!v.summary.startsWith("法国失联自 10:38。") || v.ok !== false || v.rows[0]?.label !== "法国隧道") {
        console.error(JSON.stringify(v));
        process.exit(1);
      }
      console.log(v.summary);
    '
  )
  rc_node=$?
  check "健康页读这份 JSON 显示法国失联自 10:38" "$rc_node:$shown" "0:法国失联自 10:38。全部在线"
  kill "$NG_PID" 2>/dev/null || true
  wait "$NG_PID" 2>/dev/null || true
  NG_PID=""
fi

if ((fail)); then
  echo "不通过"
  exit 1
fi
if ((skipped)); then
  echo "hk-france-probe：其余通过，有没跑成的"
  exit 2
fi
echo "通过"
exit 0
