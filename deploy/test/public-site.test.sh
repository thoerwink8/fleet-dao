#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2016 # 单引号里是给 node 的 JS、nginx 配置里的字面量，本来就不该由 shell 展开
# shellcheck disable=SC2034 # REDS、CHANGES、PENDING 是给 source 进来的 release.sh（common.sh）里的函数读写的
# 从公网看得到的几样不带仓名、GitHub 账号名和地址（创始人 2026-09-25，#54 第 4 条），也不让搜索引擎收录：
# - 发布脚本生成的静态目录（这一版没有 packages/web 时：占位页当首页 + 健康页）拿演示版打包扫描的同一份名单扫
#   （packages/web/src/build/scan.ts 的 BUILTIN_TERMS）。构建用的是 release.sh 里的真代码 build_web，只把「以 fleet 身份跑」换成原地跑。
# - 香港站点配置（deploy/hk/nginx-*.conf 渲染出来的）：先按 nginx 的继承规则查每一层都带 X-Robots-Tag；再真起一个 nginx
#   （临时目录、本机回环上的临时端口、自签证书）打请求：带完整提交号的 release.json 只给隧道那头（这里拿 127.0.0.2 当法国），
#   别处来的 404；每种回应都带 noindex；robots.txt 不禁抓（禁抓了爬虫就看不到 noindex）。这台没有 nginx、openssl、curl
#   就记「没跑成」。
# 用法：bash deploy/test/public-site.test.sh（不用 root）。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd -- "$HERE/../.." && pwd)
TMP=$(mktemp -d)
NGX_PIDS=() # 起了的测试用 nginx 的 pid 文件，收尾时停掉
STUB_PID="" # 假后端的进程号，收尾时停掉
cleanup() {
  local p
  for p in "${NGX_PIDS[@]}"; do
    if [[ -f "$p" ]]; then kill "$(cat -- "$p")" 2>/dev/null; fi
  done
  if [[ -n "$STUB_PID" ]]; then kill "$STUB_PID" 2>/dev/null; fi
  rm -rf -- "$TMP"
}
trap cleanup EXIT
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e # release.sh 开了 -e；这里自己判每一步
NODE=$(command -v node) || NODE=""
SCAN_TS=$REPO/packages/web/src/build/scan.ts
SITE=$TMP/site
ACME=$TMP/acme

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

# 公开页也会写的两个词：都在演示版的名单里，但健康页得显示 Temporal 在不在线（P0 验收看的就是它），
# 「驾驶舱」是正式版、演示版都用的中性叫法（#54 第 4 条）
PUBLIC_OK='temporal 驾驶舱'

# 拿 scan.ts 的内置名单（除去上面两个词）扫一个目录：打印扫了几个文件；命中了列出来、退出 1；
# 没扫成（目录空、不在，名单读不进来或是空的）退出 2——「没扫到」不能冒充「扫了没事」
scan_public() { # 目录 [名单所在的模块，默认 scan.ts]
  "$NODE" --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const [dir, from, ok] = process.argv.slice(1);
    let m;
    try {
      m = await import(pathToFileURL(from).href);
    } catch (e) {
      console.error(`名单读不进来（${from}）：${e.message}`);
      process.exit(2);
    }
    if (!Array.isArray(m.BUILTIN_TERMS) || m.BUILTIN_TERMS.length === 0 || typeof m.scanDir !== "function") {
      console.error(`${from} 里的名单是空的，或没有 scanDir`);
      process.exit(2);
    }
    const allowed = ok.split(" ");
    let r;
    try {
      r = m.scanDir(dir, m.BUILTIN_TERMS.filter((t) => !allowed.includes(t)));
    } catch (e) {
      console.error(`没扫成：${e.message}`);
      process.exit(2);
    }
    if (r.hits.length > 0) {
      console.error(m.formatHits(r.hits));
      process.exit(1);
    }
    console.log(r.files);
  ' "$1" "${2:-$SCAN_TS}" "$PUBLIC_OK"
}

# 按 nginx 的规矩查 X-Robots-Tag：add_header 哪一层（server、location、if）自己写了一条，那一层就不继承上一层的，
# 它自己也得带；每个 server 都得带（没写 add_header 的 location 从它继承）。配置从标准输入读，打印认出了几层；
# 有漏的逐层列出、退出 1；配置认不出（空的、括号不配对、一个 server 都没有）退出 2，不当成「查了没事」
robots_rule() {
  "$NODE" -e '
    const src = require("node:fs").readFileSync(0, "utf8");
    const want = "add_header X-Robots-Tag \"noindex, nofollow\" always";
    const levels = [];
    const stack = [];
    let stmt = "";
    let quote = "";
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        stmt += c;
        if (c === "\\") stmt += src[++i] ?? "";
        else if (c === quote) quote = "";
      } else if (c === "\"" || c === "\x27") {
        quote = c;
        stmt += c;
      } else if (c === "#") {
        while (i + 1 < src.length && src[i + 1] !== "\n") i++;
      } else if (c === "{") {
        const level = { head: stmt.trim().replace(/\s+/g, " "), robots: false, headers: 0 };
        levels.push(level);
        stack.push(level);
        stmt = "";
      } else if (c === "}") {
        if (!stack.pop()) {
          console.error("括号不配对：多了一个 }");
          process.exit(2);
        }
        stmt = "";
      } else if (c === ";") {
        const s = stmt.trim().replace(/\s+/g, " ");
        const level = stack.at(-1);
        if (level && s.startsWith("add_header ")) {
          level.headers++;
          if (s === want) level.robots = true;
        }
        stmt = "";
      } else {
        stmt += c;
      }
    }
    if (stack.length > 0) {
      console.error("括号不配对：少了 }");
      process.exit(2);
    }
    if (!levels.some((l) => l.head === "server")) {
      console.error("一个 server 都没认出来");
      process.exit(2);
    }
    const bad = levels.filter((l) => (l.head === "server" || l.headers > 0) && !l.robots);
    if (bad.length > 0) {
      console.error(bad.map((l) => `  没带 X-Robots-Tag：${l.head}`).join("\n"));
      process.exit(1);
    }
    console.log(levels.length);
  '
}

# 按 hk.sh 的样子渲染一份站点模板（占位和 hk.sh 传的一样多：少给一个，render 就报红）
render_site() { # 模板 隧道那头的地址
  render "$HERE/../hk/$1" SERVER_NAME=cockpit.example.test WEB_ROOT="$SITE" ACME_ROOT="$ACME" \
    API_UPSTREAM=127.0.0.1:1 DEMO_PATH=/demo/ DEMO_BASE=/demo TUNNEL_PEER="$2"
}

echo "== 发布脚本生成的静态目录（这一版没有 packages/web：占位页当首页 + 健康页）：不带仓名、GitHub 账号名和地址"
if [[ -z "$NODE" ]]; then
  echo "  … 没跑成：这台没有 node"
  skipped=1
else
  as_fleet_in() { # 目录 命令…：release.sh 里是切成 fleet 跑，这里原地跑（不用 root）
    local dir=$1
    shift
    (cd -- "$dir" && "$@")
  }
  STAGE=$TMP/stage
  mkdir -p "$STAGE"
  cp -R -- "$REPO/deploy" "$STAGE/deploy"
  reset
  build_web "$STAGE" "$TMP/build.log" >/dev/null
  check "build_web 走完、没有红" "$?:${#REDS[@]}" "0:0"
  check "生成的是占位页当首页、加上健康页" "$(cd -- "$STAGE/web" && find . -type f | sort | tr '\n' ' ')" \
    "./health/health.js ./health/index.html ./index.html "
  out=$(scan_public "$STAGE/web" 2>&1)
  check "扫了这 3 个文件，一个都没命中" "$?:$out" "0:3"
  grep -rqF 'release.json' -- "$STAGE/web"
  check "页面里不去读 release.json（公网上它是 404）" "$?" 1

  echo "== 扫描本身：造出来的真名查得出；目录空、不在，名单读不进来、是空的，都算没扫成（退出 2），不当成干净"
  mkdir -p "$TMP/planted"
  printf '<title>Fleet-Dao 健康检查</title>\n' >"$TMP/planted/index.html"
  scan_public "$TMP/planted" >/dev/null 2>&1
  check "标题里写了仓名（大小写不同）：查得出" "$?" 1
  printf '<a href="https://GitHub.com/someone/x">源码</a>\n' >"$TMP/planted/index.html"
  scan_public "$TMP/planted" >/dev/null 2>&1
  check "带了 GitHub 地址：查得出" "$?" 1
  printf '<p>Temporal 在线；驾驶舱还在建</p>\n' >"$TMP/planted/index.html"
  out=$(scan_public "$TMP/planted" 2>&1)
  check "只写了 Temporal、驾驶舱：放过" "$?:$out" "0:1"
  mkdir -p "$TMP/empty"
  scan_public "$TMP/empty" >/dev/null 2>&1
  check "空目录：没扫成" "$?" 2
  scan_public "$TMP/nowhere" >/dev/null 2>&1
  check "目录不在：没扫成" "$?" 2
  scan_public "$STAGE/web" "$TMP/nowhere/scan.ts" >/dev/null 2>&1
  check "名单读不进来：没扫成" "$?" 2
  printf 'export const BUILTIN_TERMS = [];\nexport function scanDir() { return { files: 3, hits: [] }; }\n' \
    >"$TMP/empty-list.mjs"
  scan_public "$STAGE/web" "$TMP/empty-list.mjs" >/dev/null 2>&1
  check "名单是空的：没扫成" "$?" 2
fi

echo "== 香港站点配置（两份模板）：按 nginx 的继承规则，每一层都带 X-Robots-Tag"
if [[ -z "$NODE" ]]; then
  echo "  … 没跑成：这台没有 node"
  skipped=1
else
  for tpl in nginx-http.conf nginx-https.conf; do
    reset
    render_site "$tpl" 10.99.0.2 >/dev/null
    check "$tpl：占位都换掉了" "${#REDS[@]}" 0
    out=$(robots_rule <<<"$RENDERED" 2>&1)
    rc=$?
    check "$tpl：每一层都带" "$rc" 0
    if ((rc != 0)); then echo "$out"; fi
  done

  echo "== 这道查法本身：漏了查得出；配置认不出算没查成（退出 2），不当成合规"
  tag='add_header X-Robots-Tag "noindex, nofollow" always;'
  cache='add_header Cache-Control "no-cache" always;'
  robots_rule <<<"server { $tag location = /a { $cache $tag } location / { } }" >/dev/null 2>&1
  check "server 带了、自己写了 add_header 的 location 也带了：合规" "$?" 0
  out=$(robots_rule <<<"server { $tag location = /a { $cache } }" 2>&1)
  check "location 自己写了 add_header、没再写一遍：查得出是哪一层" "$?:$out" "1:  没带 X-Robots-Tag：location = /a"
  robots_rule <<<"server { location / { } }" >/dev/null 2>&1
  check "server 没带：查得出" "$?" 1
  robots_rule <<<"server { # $tag
  }" >/dev/null 2>&1
  check "注释掉的不算" "$?" 1
  robots_rule <<<"" >/dev/null 2>&1
  check "空配置：没查成" "$?" 2
  robots_rule <<<"server { $tag" >/dev/null 2>&1
  check "括号不配对：没查成" "$?" 2
  robots_rule <<<"location / { $tag }" >/dev/null 2>&1
  check "一个 server 都没有：没查成" "$?" 2
fi

echo "== 往法国后端的连接复用（hk.sh 读回用的 site_keepalive_gaps）：https 模板齐了；缺哪样查得出哪样，认不出不当成齐了"
reset
render_site nginx-https.conf 10.99.0.2 >/dev/null
printf '%s\n' "$RENDERED" >"$TMP/ka.conf"
check "https 模板：upstream fleet_dao_api 带 keepalive，每一处 proxy_pass 都走它" "$(site_keepalive_gaps "$TMP/ka.conf")" ""
check "实时推送单列一段、读超时 1 小时；其余转发 1 分钟没回音回 504" \
  "$(grep -A1 'location = /api/events {' "$TMP/ka.conf" | grep -c 'proxy_read_timeout 1h;') $(grep -cx '    proxy_read_timeout 1m;' "$TMP/ka.conf")" "1 1"
grep -v 'keepalive 16;' "$TMP/ka.conf" >"$TMP/ka-bad.conf"
check "去掉 keepalive：查得出" "$(site_keepalive_gaps "$TMP/ka-bad.conf")" \
  "upstream fleet_dao_api 里没有 keepalive：连接用完就关，不复用"
sed 's/^    keepalive 16;/    # keepalive 16;/' "$TMP/ka.conf" >"$TMP/ka-bad.conf"
check "keepalive 注释掉了：不算有" "$(site_keepalive_gaps "$TMP/ka-bad.conf")" \
  "upstream fleet_dao_api 里没有 keepalive：连接用完就关，不复用"
grep -v 'keepalive_timeout' "$TMP/ka.conf" >"$TMP/ka-bad.conf"
check "没写 keepalive_timeout：查得出" "$(site_keepalive_gaps "$TMP/ka-bad.conf")" \
  "upstream fleet_dao_api 里没写 keepalive_timeout：要写明，而且比法国后端的空闲超时短"
sed '0,/proxy_pass http:\/\/fleet_dao_api;/s//proxy_pass http:\/\/10.99.0.2:8787;/' "$TMP/ka.conf" >"$TMP/ka-bad.conf"
check "有一处直接转给地址、绕开了 upstream：查得出是哪一句" "$(site_keepalive_gaps "$TMP/ka-bad.conf")" \
  "有 proxy_pass 没走 upstream fleet_dao_api：proxy_pass http://10.99.0.2:8787;"
sed 's/upstream fleet_dao_api/upstream other_api/' "$TMP/ka.conf" >"$TMP/ka-bad.conf"
check "没有这个 upstream：查得出" "$(site_keepalive_gaps "$TMP/ka-bad.conf")" \
  "没有 upstream fleet_dao_api：往法国的请求每次都新建连接"
render_site nginx-http.conf 10.99.0.2 >/dev/null
printf '%s\n' "$RENDERED" >"$TMP/ka-bad.conf"
check "一处 proxy_pass 都没有（只开 80 的模板）：说认不出，不说齐了" \
  "$(site_keepalive_gaps "$TMP/ka-bad.conf" | grep -c '一处 proxy_pass 都没有')" 1
check "文件读不到：说读不到，不说齐了" "$(site_keepalive_gaps "$TMP/nowhere.conf")" "读不到站点配置 $TMP/nowhere.conf"

echo "== 真起一个 nginx：release.json 只给隧道那头（127.0.0.2 当法国）、别处来的 404；每种回应都带 noindex；robots.txt 不禁抓"
no_tools=""
for c in nginx openssl curl; do
  if ! command -v "$c" >/dev/null; then no_tools+=" $c"; fi
done
if [[ -n "$no_tools" ]]; then
  echo "  … 没跑成：这台没有$no_tools"
  skipped=1
else
  NG=$TMP/nginx
  COMMIT=$(printf 'c%.0s' {1..40})
  mkdir -p "$NG" "$SITE/health" "$SITE/demo/scopes" "$ACME/.well-known/acme-challenge"
  chmod 755 "$TMP" # root 起的 nginx，干活的进程不是 root，要进得来
  printf '<html>首页</html>\n' >"$SITE/index.html"
  printf '{"commit":"%s"}\n' "$COMMIT" >"$SITE/release.json"
  printf '<html>健康页</html>\n' >"$SITE/health/index.html"
  printf '<html>演示版</html>\n' >"$SITE/demo/index.html"
  printf '{}\n' >"$SITE/demo/scopes/a.json"
  printf 'probe' >"$ACME/.well-known/acme-challenge/probe"
  # 三个临时端口：https 模板的 80、443，http 模板的 80
  P1=$((20000 + RANDOM % 20000))
  P2=$((P1 + 1))
  P3=$((P1 + 2))
  started=0
  reset
  render_site nginx-https.conf 127.0.0.2 >/dev/null
  s=${RENDERED//"listen 80;"/"listen 127.0.0.1:$P1;"}
  s=${s//"listen 443 ssl;"/"listen 127.0.0.1:$P2 ssl;"}
  s=${s//"/etc/letsencrypt/live/cockpit.example.test/fullchain.pem"/"$NG/cert.pem"}
  s=${s//"/etc/letsencrypt/live/cockpit.example.test/privkey.pem"/"$NG/key.pem"}
  printf '%s\n' "$s" >"$NG/site-https.conf"
  render_site nginx-http.conf 127.0.0.2 >/dev/null
  printf '%s\n' "${RENDERED//"listen 80;"/"listen 127.0.0.1:$P3;"}" >"$NG/site-http.conf"
  check "两份模板都渲染成了" "${#REDS[@]}" 0
  # listen 和证书路径换没换干净：换漏了，测试的 nginx 就会去占真端口、找真证书。打印「换成临时端口的/全部 listen」
  listens() { printf '%s/%s' "$(grep -cE '^[[:space:]]*listen 127\.0\.0\.1:' "$1")" "$(grep -cE '^[[:space:]]*listen ' "$1")"; }
  check "listen 全换成了临时端口、证书换成了自签的" \
    "$(listens "$NG/site-https.conf") $(listens "$NG/site-http.conf") $(grep -c letsencrypt "$NG/site-https.conf")" "2/2 1/1 0"
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
    include $NG/site-https.conf;
    include $NG/site-http.conf;
}
EOF
  if ! openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=cockpit.example.test \
    -keyout "$NG/key.pem" -out "$NG/cert.pem" >"$NG/openssl.log" 2>&1; then
    check "自签证书做出来了" "$(tail -2 "$NG/openssl.log" | tr '\n' ' ')" "（做出来了）"
  elif ! out=$(nginx -t -p "$NG/" -c "$NG/nginx.conf" 2>&1); then
    check "nginx 验得过这份配置" "$(tail -3 <<<"$out" | tr '\n' ' ')" "（验得过）"
  elif ! out=$(nginx -p "$NG/" -c "$NG/nginx.conf" 2>&1); then
    check "测试用的 nginx 起来了" "$(tail -3 <<<"$out" | tr '\n' ' ')" "（起来了）"
  else
    NGX_PIDS+=("$NG/nginx.pid")
    started=1
  fi
  if ((started)); then
    # 打一次，打印「状态码 带了几条 X-Robots-Tag: noindex, nofollow」；连不上时状态码是 000
    probe() { # curl 参数…
      local head code
      head=$(curl -s -o /dev/null -D - --max-time 5 "$@" 2>/dev/null | tr -d '\r')
      code=$(awk 'NR == 1 { print $2 }' <<<"$head")
      printf '%s %s' "${code:-000}" "$(grep -ci '^x-robots-tag: noindex, nofollow$' <<<"$head")"
    }
    TLS=(-k --resolve "cockpit.example.test:$P2:127.0.0.1")
    HTTPS=https://cockpit.example.test:$P2
    for pc in "/ 200" "/index.html 200" "/tasks/deep-link 200" "/release.json 404" "/health/ 200" "/health/nope 404" \
      "/robots.txt 200" "/demo 301" "/demo/ 200" "/demo/index.html 200" "/demo/tasks/x 200" "/demo/scopes/a.json 200" \
      "/demo/scopes/nope.json 404" "/healthz 502" "/api/x 502" "/auth/x 502" "/github/webhook 502"; do
      check "https ${pc% *}（隧道外来的）：${pc#* }，带 noindex" "$(probe "${TLS[@]}" "$HTTPS${pc% *}")" "${pc#* } 1"
    done
    check "https /release.json（隧道那头来的）：200，带 noindex" \
      "$(probe "${TLS[@]}" --interface 127.0.0.2 "$HTTPS/release.json")" "200 1"
    check "隧道那头拿到的就是版本标记" "$(curl -s "${TLS[@]}" --interface 127.0.0.2 "$HTTPS/release.json")" \
      "{\"commit\":\"$COMMIT\"}"
    check "版本标记照旧不让浏览器凭猜缓存" \
      "$(curl -s -o /dev/null -D - "${TLS[@]}" --interface 127.0.0.2 "$HTTPS/release.json" | tr -d '\r' | grep -ci '^cache-control: no-cache$')" 1
    check "robots.txt 不禁抓（爬虫抓得到页面才看得见 noindex）" "$(curl -s "${TLS[@]}" "$HTTPS/robots.txt")" \
      $'User-agent: *\nAllow: /'
    check "robots.txt 是纯文本" "$(curl -s -o /dev/null -w '%{content_type}' "${TLS[@]}" "$HTTPS/robots.txt")" text/plain
    PLAIN=(--resolve "cockpit.example.test:$P1:127.0.0.1")
    for pc in "/ 301" "/robots.txt 301" "/.well-known/acme-challenge/probe 200"; do
      check "https 模板的 80 口 ${pc% *}：${pc#* }，带 noindex" \
        "$(probe "${PLAIN[@]}" "http://cockpit.example.test:$P1${pc% *}")" "${pc#* } 1"
    done
    ONLY=(--resolve "cockpit.example.test:$P3:127.0.0.1")
    HTTP=http://cockpit.example.test:$P3
    for pc in "/ 200" "/tasks/deep-link 200" "/release.json 404" "/health/ 200" "/robots.txt 200" "/demo 301" \
      "/demo/ 200" "/demo/tasks/x 200" "/demo/scopes/a.json 200" "/demo/scopes/nope.json 404" \
      "/.well-known/acme-challenge/probe 200"; do
      check "只开 80 的模板 ${pc% *}（隧道外来的）：${pc#* }，带 noindex" "$(probe "${ONLY[@]}" "$HTTP${pc% *}")" "${pc#* } 1"
    done
    check "只开 80 的模板 /release.json（隧道那头来的）：200，带 noindex" \
      "$(probe "${ONLY[@]}" --interface 127.0.0.2 "$HTTP/release.json")" "200 1"
    check "只开 80 的模板：robots.txt 不禁抓" "$(curl -s "${ONLY[@]}" "$HTTP/robots.txt")" $'User-agent: *\nAllow: /'
    if ((fail)); then
      echo "  测试用的 nginx 的错误日志（最后 10 行）："
      tail -10 "$NG/error.log" 2>/dev/null | sed 's/^/    /'
    fi
  fi
fi

echo "== 真起 nginx 接一个假后端：三个请求走同一条往后端的连接；实时推送边收边转；去掉 keepalive 就成了三条连接（查法本身查得出）"
no_tools=""
for c in nginx openssl curl; do
  if ! command -v "$c" >/dev/null; then no_tools+=" $c"; fi
done
if [[ -z "$NODE" ]]; then no_tools+=" node"; fi
if [[ -n "$no_tools" ]]; then
  echo "  … 没跑成：这台没有$no_tools"
  skipped=1
else
  KA=$TMP/keepalive
  mkdir -p "$KA"
  chmod 755 "$TMP" "$KA" # root 起的 nginx，干活的进程不是 root，要进得来
  # 假后端：给每条连进来的连接编号，每个请求记一行「路径 连接号」；/api/events 回一条 ready 之后不结束，像真的实时推送
  BACK=$((20000 + RANDOM % 20000))
  "$NODE" -e '
    const http = require("node:http");
    const fs = require("node:fs");
    const [port, log] = process.argv.slice(1);
    let conns = 0;
    const server = http.createServer((req, res) => {
      fs.appendFileSync(log, `${req.url} ${req.socket.fleetConn}\n`);
      if (req.url === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: ready\ndata: {}\n\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    server.on("connection", (s) => {
      conns += 1;
      s.fleetConn = conns;
    });
    server.keepAliveTimeout = 60000;
    server.listen(Number(port), "127.0.0.1", () => fs.writeFileSync(`${log}.ready`, ""));
  ' "$BACK" "$KA/backend.log" >"$KA/backend.out" 2>&1 &
  STUB_PID=$!
  for _ in $(seq 50); do
    if [[ -f "$KA/backend.log.ready" ]]; then break; fi
    sleep 0.1
  done
  # 起一个测试用的 nginx，只含这一份站点（listen 换成临时端口、证书换成自签的）。起不来把原因放进 KA_WHY、返回 1
  # （别在 $(…) 里调：pid 文件要记进 NGX_PIDS，子 shell 里记了收尾时看不到）
  KA_WHY=""
  ka_nginx() { # 目录 站点内容 80口 443口
    local dir=$1 s=$2 out
    mkdir -p "$dir"
    s=${s//"listen 80;"/"listen 127.0.0.1:$3;"}
    s=${s//"listen 443 ssl;"/"listen 127.0.0.1:$4 ssl;"}
    s=${s//"/etc/letsencrypt/live/cockpit.example.test/fullchain.pem"/"$KA/cert.pem"}
    s=${s//"/etc/letsencrypt/live/cockpit.example.test/privkey.pem"/"$KA/key.pem"}
    printf '%s\n' "$s" >"$dir/site.conf"
    cat >"$dir/nginx.conf" <<EOF
pid $dir/nginx.pid;
error_log $dir/error.log;
events {}
http {
    access_log off;
    client_body_temp_path $dir/body;
    proxy_temp_path $dir/proxy;
    fastcgi_temp_path $dir/fastcgi;
    uwsgi_temp_path $dir/uwsgi;
    scgi_temp_path $dir/scgi;
    include $dir/site.conf;
}
EOF
    if ! out=$(nginx -t -p "$dir/" -c "$dir/nginx.conf" 2>&1) || ! out=$(nginx -p "$dir/" -c "$dir/nginx.conf" 2>&1); then
      KA_WHY=$(tail -3 <<<"$out" | tr '\n' ' ')
      return 1
    fi
    NGX_PIDS+=("$dir/nginx.pid")
  }
  # 连发三个 /api/me，每个用一条新的客户端连接（像浏览器开了几条）；打印「三个状态码 后端看到这三个请求来自几条连接」
  ka_three() { # 443口
    local codes="" _
    : >"$KA/backend.log"
    for _ in 1 2 3; do
      codes+="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
        --resolve "cockpit.example.test:$1:127.0.0.1" "https://cockpit.example.test:$1/api/me") "
    done
    printf '%s%s' "$codes" "$(awk '$1 == "/api/me" { print $2 }' "$KA/backend.log" | sort -u | wc -l | tr -d ' ')"
  }
  K1=$((20000 + RANDOM % 20000))
  reset
  render "$HERE/../hk/nginx-https.conf" SERVER_NAME=cockpit.example.test WEB_ROOT="$SITE" ACME_ROOT="$ACME" \
    API_UPSTREAM="127.0.0.1:$BACK" DEMO_PATH=/demo/ DEMO_BASE=/demo TUNNEL_PEER=127.0.0.2 >/dev/null
  good=$RENDERED
  check "带假后端地址的 https 模板渲染成了" "${#REDS[@]}" 0
  if [[ ! -f "$KA/backend.log.ready" ]]; then
    check "假后端起来了" "$(tail -3 "$KA/backend.out" 2>/dev/null | tr '\n' ' ')" "（起来了）"
  elif ! openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=cockpit.example.test \
    -keyout "$KA/key.pem" -out "$KA/cert.pem" >"$KA/openssl.log" 2>&1; then
    check "自签证书做出来了" "$(tail -2 "$KA/openssl.log" | tr '\n' ' ')" "（做出来了）"
  elif ! ka_nginx "$KA/good" "$good" "$K1" $((K1 + 1)); then
    check "测试用的 nginx（仓里的模板）起来了" "$KA_WHY" "（起来了）"
  else
    TLS=(-k --resolve "cockpit.example.test:$((K1 + 1)):127.0.0.1")
    check "仓里的模板：三个请求都 200，后端看到的是同一条连接" "$(ka_three $((K1 + 1)))" "200 200 200 1"
    out=$(curl -s -N --max-time 2 "${TLS[@]}" "https://cockpit.example.test:$((K1 + 1))/api/events" 2>/dev/null)
    check "实时推送：后端发的第一条事件当场转到（不攒着等连接结束）" "$(grep -cx 'event: ready' <<<"$out")" 1
    check "实时推送的连接留着没断（curl 是自己到点才停的）" \
      "$(curl -s -o /dev/null -N --max-time 2 "${TLS[@]}" "https://cockpit.example.test:$((K1 + 1))/api/events" >/dev/null 2>&1; echo $?)" 28
    if ! ka_nginx "$KA/bad" "$(grep -v 'keepalive 16;' <<<"$good")" $((K1 + 2)) $((K1 + 3)); then
      check "测试用的 nginx（去掉 keepalive 的）起来了" "$KA_WHY" "（起来了）"
    else
      check "故意去掉 keepalive：后端看到三条连接（上面那条查法抓得到不复用）" "$(ka_three $((K1 + 3)))" "200 200 200 3"
    fi
    if ((fail)); then
      echo "  测试用的 nginx 的错误日志（最后 10 行）："
      tail -10 "$KA/good/error.log" "$KA/bad/error.log" 2>/dev/null | sed 's/^/    /'
    fi
  fi
fi

if ((fail)); then
  echo "public-site：不通过"
  exit 1
fi
if ((skipped)); then
  echo "public-site：其余通过，有没跑成的"
  exit 2
fi
echo "public-site：通过"
