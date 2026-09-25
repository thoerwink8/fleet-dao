#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 香港机器装机（以 root 跑；幂等：跑第二遍什么都不变）。装的是：系统用户 fleet 与 /etc/fleet-dao、
# WireGuard 服务端、nginx 上 fleet-dao 这一个站点（驾驶舱静态文件 + Let's Encrypt 证书与自动续期；/api、/auth、
# /github/webhook、/healthz 经隧道转法国）、法国发布脚本用的两把钥匙（都只许经隧道来：一把只能往 /srv/fleet-dao-web
# 写静态文件，一把只能跑 fleet-gateway-deploy 发飞书网关）、飞书网关要的固定版本 node、单元、配置里缺的几项。
# 飞书网关的代码由法国 deploy/release.sh 发来。别家的站点和服务一概不动。端口表、怎么跑、怎么看健康、怎么回滚：docs/ops.md。
#   bash deploy/hk.sh           装：缺的补上，已有的不动
#   bash deploy/hk.sh --check   只读回和自检，不改任何东西
set -Eeuo pipefail
umask 022

DEPLOY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
source "$DEPLOY_DIR/lib/common.sh"
# shellcheck source=lib/snapshot.sh
source "$DEPLOY_DIR/lib/snapshot.sh"
# shellcheck source=lib/root-exec-check.sh
source "$DEPLOY_DIR/lib/root-exec-check.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

# ── 约定（改这里要同步 docs/ops.md）──
WG_IF=wg-fleet
# UDP，香港唯一新开的公网入站端口。这台的上游只放行少数常见 UDP 端口：2026-09-25 从法国实测，
# 53/67/69/123/161/500/1701/4500 进得来，51820 和其余高端口都到不了网卡。4500（IPsec NAT-T）空着，WireGuard 在上面握得上手。
WG_PORT=4500
WG_ADDR=10.99.0.1/24
WG_PEER_ADDR=10.99.0.2
# 法国驾驶舱后端（packages/api 的 FLEET_COCKPIT_LISTEN）：/api、/auth、/github/webhook、/healthz 经隧道转到这里
API_UPSTREAM=$WG_PEER_ADDR:8787
ENV_FILE=/etc/fleet-dao/hk.env
ENV_KEYS=(FLEET_DOMAIN FLEET_ACME_EMAIL FLEET_WG_FRANCE_PUBLIC_KEY FLEET_WEB_UPLOAD_PUBLIC_KEY
  FLEET_GATEWAY_DEPLOY_PUBLIC_KEY)
# 驾驶舱静态文件归 root。法国的发布脚本经隧道用一把只能写这个目录的钥匙往里传（rrsync -wo），钥匙登记在 root 的
# authorized_keys2：这份文件整份归 fleet-dao 管，root 原有的 authorized_keys 一行不碰
WEB_ROOT=/srv/fleet-dao-web
UPLOAD_KEYS_FILE=/root/.ssh/authorized_keys2
# 飞书网关的通行证：和法国 /etc/fleet-dao/gateway-token.env 同一份（法国 france.sh 生成，整份文件原样拷过来）
GATEWAY_TOKEN_ENV=/etc/fleet-dao/gateway-token.env
# 飞书网关：一版一个文件（法国打好的 gateway.mjs），放 /srv/fleet-dao-gateway/<提交号>；node 装固定版本、核对 sha256，
# 不用系统里的 node（Ubuntu 22.04 带的太旧，也不跟别人共用）
NODE_VERSION=22.23.3
NODE_SHA256=1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af
NODE_HOME=/opt/fleet-dao/node-v$NODE_VERSION
NODE_LINK=/opt/fleet-dao/node
GATEWAY_ROOT=/srv/fleet-dao-gateway
GATEWAY_UNIT=fleet-feishu.service
GATEWAY_DEPLOY_BIN=/usr/local/sbin/fleet-gateway-deploy
GATEWAY_CONNECT_WAIT=30 # 网关刚起（比如上面刚重启过）时，读回等它连上飞书最多这么久再判
# 飞书凭据、创始人由人放；缺的后端地址、公网地址、团队群由本脚本补（已有的不改）；通行证不抄进来，单元另读 gateway-token.env
FEISHU_ENV=/etc/fleet-dao/feishu.env
ACME_ROOT=/var/www/fleet-dao-acme
SITE_AVAILABLE=/etc/nginx/sites-available/fleet-dao
SITE_ENABLED=/etc/nginx/sites-enabled/fleet-dao
# 没配域名时的 server_name：.invalid 永远解析不到——站点装着、配置验得过，但谁也访问不到
PLACEHOLDER_NAME=fleet-dao.invalid

FLEET_DOMAIN=""
FLEET_ACME_EMAIL=""
FLEET_WG_FRANCE_PUBLIC_KEY=""
FLEET_WEB_UPLOAD_PUBLIC_KEY=""
FLEET_GATEWAY_DEPLOY_PUBLIC_KEY=""
TLS_ISSUED=0

CHECK_ONLY=0
case "${1:-}" in
--check) CHECK_ONLY=1 ;;
"") ;;
*)
  echo "用法：bash $0 [--check]" >&2
  exit 64
  ;;
esac

# shellcheck disable=SC1091 # /etc/os-release 是目标机器上的文件
preflight() {
  step "前提"
  if ((EUID != 0)); then
    echo "要 root：sudo bash $0" >&2
    exit 64
  fi
  local id ver
  id=$(. /etc/os-release && echo "$ID")
  ver=$(. /etc/os-release && echo "$VERSION_ID")
  if [[ "$id" != ubuntu ]]; then
    red "只在 Ubuntu 上验过，这台是 $id $ver"
    return 1
  fi
  ok "系统 $id $ver，$(uname -m)"
}

setup_identity() {
  step "用户与目录"
  ensure_service_user fleet /home/fleet
  ensure_dir /home/fleet fleet:fleet 750
  ensure_dir /etc/fleet-dao root:fleet 750
  if [[ -e "$ENV_FILE" ]]; then
    fix_meta "$ENV_FILE" root:fleet 640
  else
    put_file "$ENV_FILE" root:fleet 640 "$(<"$DEPLOY_DIR/hk/hk.env.example")"
  fi
  # 通行证不在这里生成（法国是源头），拷过来了就只管属主和权限
  if [[ -e "$GATEWAY_TOKEN_ENV" ]]; then fix_meta "$GATEWAY_TOKEN_ENV" root:fleet 640; fi
}

# authorized_keys2 里登记法国的两把钥匙时，各自那一行的样子（读回按整行核对）
web_key_line() { printf 'from="%s",restrict,command="/usr/bin/rrsync -wo -munge %s" %s' "$WG_PEER_ADDR" "$WEB_ROOT" "$FLEET_WEB_UPLOAD_PUBLIC_KEY"; }
gateway_key_line() { printf 'from="%s",restrict,command="%s" %s' "$WG_PEER_ADDR" "$GATEWAY_DEPLOY_BIN" "$FLEET_GATEWAY_DEPLOY_PUBLIC_KEY"; }

setup_web_upload() {
  step "法国发布脚本用的钥匙（$UPLOAD_KEYS_FILE：都只许经隧道来；一把只能写 $WEB_ROOT，一把只能跑 $GATEWAY_DEPLOY_BIN）"
  local keys re='^ssh-ed25519 [A-Za-z0-9+/]{68}( [^[:space:]]+)?$' name content
  ensure_pkgs rsync
  if [[ -z "$FLEET_WEB_UPLOAD_PUBLIC_KEY" && -z "$FLEET_GATEWAY_DEPLOY_PUBLIC_KEY" ]]; then
    # 读回那一步会记「待配」
    echo "  还没有法国的公钥（$ENV_FILE 的 FLEET_WEB_UPLOAD_PUBLIC_KEY、FLEET_GATEWAY_DEPLOY_PUBLIC_KEY），先不登记"
    return 0
  fi
  for name in FLEET_WEB_UPLOAD_PUBLIC_KEY FLEET_GATEWAY_DEPLOY_PUBLIC_KEY; do
    if [[ -n "${!name}" && ! "${!name}" =~ $re ]]; then
      red "$ENV_FILE 的 $name 不像 ed25519 公钥（应为法国 france.sh 打印的那一整行）"
      return 1
    fi
  done
  if [[ -n "$FLEET_WEB_UPLOAD_PUBLIC_KEY" && "$FLEET_WEB_UPLOAD_PUBLIC_KEY" == "$FLEET_GATEWAY_DEPLOY_PUBLIC_KEY" ]]; then
    red "$ENV_FILE 里两把公钥是同一把：sshd 只认第一行的限制，第二把的用途就落空了"
    return 1
  fi
  # 这份文件整份归 fleet-dao：已经有、又不是我们写的，就不碰
  if [[ -e "$UPLOAD_KEYS_FILE" && "$(head -1 -- "$UPLOAD_KEYS_FILE")" != "# fleet-dao"* ]]; then
    red "$UPLOAD_KEYS_FILE 已存在且不是 hk.sh 写的，不碰它：停下等人看"
    return 1
  fi
  keys=$(sshd -T 2>/dev/null | awk '$1 == "authorizedkeysfile" { $1 = ""; print }')
  if [[ " $keys " != *" .ssh/authorized_keys2 "* ]]; then
    red "这台 sshd 不读 .ssh/authorized_keys2（AuthorizedKeysFile 是「${keys# }」）：上传钥匙登记了也不生效"
    return 1
  fi
  if [[ ! -d /root/.ssh ]]; then install -d -o root -g root -m 700 /root/.ssh; fi
  content="# fleet-dao（deploy/hk.sh 写的，整份归它管，别手改）：法国发布脚本用的钥匙，都只许从隧道地址 $WG_PEER_ADDR 来，
# 不给终端、不许转发。"
  if [[ -n "$FLEET_WEB_UPLOAD_PUBLIC_KEY" ]]; then
    content+="
# 往 $WEB_ROOT 传驾驶舱静态文件：登上来只能跑 rrsync，且只能往 $WEB_ROOT 里写（-wo：读不走任何东西；
# -munge：传来的符号链接落地时改成无效的样子，nginx 跟着它读不到目录外的文件）。
$(web_key_line)"
  fi
  if [[ -n "$FLEET_GATEWAY_DEPLOY_PUBLIC_KEY" ]]; then
    content+="
# 发飞书网关：登上来只能跑 $GATEWAY_DEPLOY_BIN（收下一版、切过去、看状态，见脚本开头）。
$(gateway_key_line)"
  fi
  put_file "$UPLOAD_KEYS_FILE" root:root 600 "$content"
}

# 从一份 KEY=VALUE 文件里取一个键的值（只当数据读、不 source；值不打印）。没有就空
env_file_value() { # 文件 键
  local line v=""
  [[ -f "$1" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$2="* ]]; then v=${line#*=}; fi
  done <"$1"
  v=${v#\"}
  printf '%s' "${v%\"}"
}

setup_node() {
  step "node $NODE_VERSION（飞书网关用；装在 $NODE_HOME，不碰系统里的 node）"
  local tmp url=https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz
  if [[ "$(uname -m)" != x86_64 ]]; then
    red "装的是 linux-x64 的 node，这台是 $(uname -m)"
    return 1
  fi
  ensure_dir /opt/fleet-dao root:root 755
  # 标记文件最后才写：半截的安装下次重来
  if [[ -f "$NODE_HOME/.fleet-dao-sha256" && "$("$NODE_HOME/bin/node" --version 2>/dev/null)" == "v$NODE_VERSION" ]]; then
    ok "node $NODE_VERSION 已装"
  else
    tmp=$(mktemp -d /opt/fleet-dao/.node-new.XXXXXX)
    if ! curl -fsSL --retry 3 --max-time 900 -o "$tmp/node.tgz" "$url"; then
      rm -rf -- "$tmp"
      red "下载失败：$url"
      return 1
    fi
    if ! printf '%s  %s\n' "$NODE_SHA256" "$tmp/node.tgz" | sha256sum --quiet --status -c -; then
      rm -rf -- "$tmp"
      red "sha256 对不上，不装：$url"
      return 1
    fi
    mkdir -- "$tmp/tree"
    tar -xzf "$tmp/node.tgz" -C "$tmp/tree" --strip-components=1 --no-same-owner
    chown -R -h root:root -- "$tmp/tree"
    chmod -R go-w -- "$tmp/tree"
    printf '%s\n' "$NODE_SHA256" >"$tmp/tree/.fleet-dao-sha256"
    rm -rf -- "$NODE_HOME"
    mv -T -- "$tmp/tree" "$NODE_HOME"
    rm -rf -- "$tmp"
    changed "装 node $NODE_VERSION（sha256 已核对）到 $NODE_HOME"
  fi
  ensure_symlink "$NODE_LINK" "node-v$NODE_VERSION"
  # 换了 node、网关正在跑：重启才换上（发布只在换版本、改了配置时重启）
  if ((WROTE)) && [[ "$(systemctl is-active "$GATEWAY_UNIT" 2>/dev/null)" == active ]]; then
    systemctl restart "$GATEWAY_UNIT"
    changed "重启 $GATEWAY_UNIT（换了 node）"
  fi
}

# 飞书机器人在哪些群里：一行一个「chat_id<TAB>群名」。凭据从 feishu.env 读，经环境变量交给 node，不上命令行。没列成返回 1
bot_chats() {
  env -i PATH=/usr/bin:/bin FEISHU_APP_ID="$(env_file_value "$FEISHU_ENV" FEISHU_APP_ID)" \
    FEISHU_APP_SECRET="$(env_file_value "$FEISHU_ENV" FEISHU_APP_SECRET)" \
    "$NODE_LINK/bin/node" "$DEPLOY_DIR/hk/list-bot-chats.mjs"
}

setup_gateway() {
  step "飞书网关（单元 $GATEWAY_UNIT、各版的目录 $GATEWAY_ROOT、法国发布脚本用的入口 $GATEWAY_DEPLOY_BIN）"
  ensure_dir "$GATEWAY_ROOT" root:root 755
  put_file "$GATEWAY_DEPLOY_BIN" root:root 755 "$(<"$DEPLOY_DIR/hk/fleet-gateway-deploy.sh")"
  put_file "/etc/systemd/system/$GATEWAY_UNIT" root:root 644 "$(<"$DEPLOY_DIR/hk/fleet-feishu.service")"
  if ((WROTE)); then
    systemctl daemon-reload
    # 单元改了、网关正在跑：重启让新单元生效。没在跑就不起它——起网关归发布（配置备齐了、有这一版了才起）
    if [[ "$(systemctl is-active "$GATEWAY_UNIT" 2>/dev/null)" == active ]]; then
      systemctl restart "$GATEWAY_UNIT"
      changed "重启 $GATEWAY_UNIT（单元改了）"
    fi
  fi
  setup_feishu_env
}

# feishu.env 里缺的几项补上，已有的一概不改（人填的值优先）。团队群：机器人只在一个群里时就是它；
# 不在任何群里、或在好几个群里，记待配，等人拉群或写明
setup_feishu_env() {
  local add=() chats n kv content
  if [[ ! -f "$FEISHU_ENV" ]]; then
    pending "还没有 $FEISHU_ENV：照 packages/feishu/deploy/feishu.env.example 放好飞书凭据和创始人（root:fleet 640），再跑一遍"
    return 0
  fi
  fix_meta "$FEISHU_ENV" root:fleet 640
  if [[ -z "$(env_file_value "$FEISHU_ENV" FLEET_BACKEND_URL)" ]]; then add+=("FLEET_BACKEND_URL=http://$API_UPSTREAM"); fi
  if [[ -z "$(env_file_value "$FEISHU_ENV" FLEET_PUBLIC_URL)" && -n "$FLEET_DOMAIN" ]]; then
    add+=("FLEET_PUBLIC_URL=https://$FLEET_DOMAIN")
  fi
  if [[ -z "$(env_file_value "$FEISHU_ENV" FEISHU_TEAM_CHAT_ID)" ]]; then
    if ! chats=$(bot_chats 2>&1); then
      pending "列飞书机器人在哪些群里没列成，团队群没补：${chats:0:200}"
    else
      n=$(grep -c . <<<"$chats" || true)
      if ((n == 1)); then
        add+=("FEISHU_TEAM_CHAT_ID=${chats%%$'\t'*}")
      elif ((n == 0)); then
        pending "飞书机器人还不在任何群里：建好团队群、把机器人拉进去，再跑一遍 hk.sh（会自动补上 FEISHU_TEAM_CHAT_ID）"
      else
        pending "飞书机器人在 $n 个群里，认不出哪个是团队群：在 $FEISHU_ENV 写明 FEISHU_TEAM_CHAT_ID（群名：$(cut -f2 <<<"$chats" | tr '\n' '、')）"
      fi
    fi
  fi
  if ((${#add[@]} == 0)); then
    ok "$FEISHU_ENV 没有要补的"
    return 0
  fi
  content=$(<"$FEISHU_ENV")
  content+=$'\n'"# 下面几项是 deploy/hk.sh 补的（缺才补，已有的不改）"
  for kv in "${add[@]}"; do content+=$'\n'"$kv"; done
  put_file "$FEISHU_ENV" root:fleet 640 "$content"
  echo "  补上：$(for kv in "${add[@]}"; do printf '%s ' "${kv%%=*}"; done)（值不打印）"
}

load_config() {
  load_env "$ENV_FILE" "${ENV_KEYS[@]}"
  ok "本机配置 $ENV_FILE：域名 ${FLEET_DOMAIN:-（未配）}，法国公钥$(filled "$FLEET_WG_FRANCE_PUBLIC_KEY")"
}

setup_wireguard() {
  step "WireGuard 服务端（UDP $WG_PORT）"
  ensure_pkgs wireguard-tools
  ensure_dir /etc/wireguard root:root 700
  # 端口先查清：没人占，或者占着的正是我们自己的接口
  if port_in_use udp "$WG_PORT" && [[ "$(wg show "$WG_IF" listen-port 2>/dev/null)" != "$WG_PORT" ]]; then
    red "UDP $WG_PORT 已被别的程序占着：$(ss -Hlunp "sport = :$WG_PORT")"
    return 1
  fi
  # 这是香港唯一新开的公网入站端口。ufw 开着才要放行；这台没开 ufw 时 iptables 默认放行
  local fw
  if command -v ufw >/dev/null; then
    fw=$(ufw status 2>/dev/null || true)
    if [[ "$fw" == "Status: active"* && "$fw" != *"$WG_PORT/udp"*ALLOW* ]]; then
      ufw allow "$WG_PORT/udp" comment 'fleet-dao wireguard' >/dev/null
      changed "ufw 放行 UDP $WG_PORT"
    fi
  fi
  ensure_wg_key "$WG_IF"
  local key_changed=$WROTE conf
  echo "  香港公钥：$WG_PUBLIC_KEY"
  echo "  （填进法国 /etc/fleet-dao/france.env：FLEET_WG_HK_PUBLIC_KEY=这串，FLEET_WG_HK_ENDPOINT=<香港公网IP>:$WG_PORT）"
  conf="# fleet-dao 两机隧道，香港这头（服务端）。deploy/hk.sh 生成，别手改；私钥在 /etc/wireguard/$WG_IF.key。
[Interface]
Address = $WG_ADDR
ListenPort = $WG_PORT
PostUp = wg set %i private-key /etc/wireguard/%i.key"
  if [[ -n "$FLEET_WG_FRANCE_PUBLIC_KEY" ]]; then
    if ! valid_wg_key "$FLEET_WG_FRANCE_PUBLIC_KEY"; then
      red "$ENV_FILE 的 FLEET_WG_FRANCE_PUBLIC_KEY 不像 WireGuard 公钥（应为 44 个字符、以 = 结尾）"
      return 1
    fi
    conf+="

[Peer]
# 法国
PublicKey = $FLEET_WG_FRANCE_PUBLIC_KEY
AllowedIPs = $WG_PEER_ADDR/32"
  fi
  put_file "/etc/wireguard/$WG_IF.conf" root:root 600 "$conf"
  ensure_unit_running "wg-quick@$WG_IF.service" $((key_changed || WROTE))
}

# 旧站点的默认应答（不带域名直接打本机 80/443）：重载前后应当一样
default_site_codes() {
  local a b
  a=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1/ || true)
  b=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1/ || true)
  printf 'http %s，https %s' "$a" "$b"
}

setup_site() {
  step "nginx 站点（$SITE_AVAILABLE）"
  ensure_pkgs nginx
  # 驾驶舱页面归 root：以后飞书网关以 fleet 跑在这台，网关被打穿也改不了驾驶舱的页面
  ensure_dir "$WEB_ROOT" root:root 755
  # 占位页只在还没有首页时放：驾驶舱真正发布之后，这一步不能把它盖掉（只管属主和权限）
  if [[ -e "$WEB_ROOT/index.html" ]]; then
    fix_meta "$WEB_ROOT/index.html" root:root 644
  else
    put_file "$WEB_ROOT/index.html" root:root 644 "$(<"$DEPLOY_DIR/hk/placeholder.html")"
  fi
  ensure_dir "$ACME_ROOT" root:root 755
  local name=${FLEET_DOMAIN:-$PLACEHOLDER_NAME} tpl=nginx-http.conf old="" had=0 site_changed before after why
  if [[ -n "$FLEET_DOMAIN" && -f "/etc/letsencrypt/live/$FLEET_DOMAIN/fullchain.pem" ]]; then tpl=nginx-https.conf; fi
  render "$DEPLOY_DIR/hk/$tpl" SERVER_NAME="$name" WEB_ROOT="$WEB_ROOT" ACME_ROOT="$ACME_ROOT" API_UPSTREAM="$API_UPSTREAM"
  if [[ -f "$SITE_AVAILABLE" ]]; then
    old=$(<"$SITE_AVAILABLE")
    had=1
  fi
  put_file "$SITE_AVAILABLE" root:root 644 "$RENDERED"
  site_changed=$WROTE
  ensure_symlink "$SITE_ENABLED" "$SITE_AVAILABLE"
  if ((site_changed == 0 && WROTE == 0)); then
    ok "站点配置没变（$tpl，server_name $name）"
    return 0
  fi
  # 重载前先把整套配置验一遍；验不过就把本站点撤回原样，旧站点一点不受影响
  if ! why=$(nginx -t 2>&1); then
    if ((had)); then put_file "$SITE_AVAILABLE" root:root 644 "$old"; else rm -f -- "$SITE_ENABLED" "$SITE_AVAILABLE"; fi
    red "nginx 配置验不过，已把 fleet-dao 站点撤回：$(tail -3 <<<"$why" | tr '\n' ' ')"
    return 1
  fi
  before=$(default_site_codes)
  if ! systemctl reload nginx; then
    red "nginx 重载失败：journalctl -u nginx -n 50 看现场"
    return 1
  fi
  changed "重载 nginx（只加了 fleet-dao 站点，$tpl，server_name $name）"
  sleep 1
  after=$(default_site_codes)
  if [[ "$before" != "$after" ]]; then
    red "重载后旧站点的默认应答变了：$before → $after"
    return 1
  fi
  ok "旧站点的默认应答没变（$after）"
}

setup_tls() {
  step "HTTPS 证书"
  if [[ -z "$FLEET_DOMAIN" ]]; then
    pending "没配域名（$ENV_FILE 的 FLEET_DOMAIN），证书这步跳过"
    return 0
  fi
  local live=/etc/letsencrypt/live/$FLEET_DOMAIN ip mine log
  if [[ -f "$live/fullchain.pem" ]]; then
    ok "证书已在 $live（续期交给 certbot.timer）"
    return 0
  fi
  # 域名得先解析到这台：没指过来就去申请，只会白白消耗 Let's Encrypt 的失败次数
  ip=$(getent ahostsv4 "$FLEET_DOMAIN" | awk 'NR == 1 { print $1 }') || ip=""
  mine=$(ip -4 -o addr show | awk '{ sub(/\/.*/, "", $4); print $4 }')
  if [[ -z "$ip" || $'\n'"$mine"$'\n' != *$'\n'"$ip"$'\n'* ]]; then
    pending "$FLEET_DOMAIN 还没解析到这台（解析到：${ip:-无}），证书这步先跳过"
    return 0
  fi
  ensure_pkgs certbot
  local args=(certonly --webroot -w "$ACME_ROOT" -d "$FLEET_DOMAIN" --cert-name "$FLEET_DOMAIN"
    --non-interactive --agree-tos --deploy-hook "systemctl reload nginx")
  if [[ -n "$FLEET_ACME_EMAIL" ]]; then
    args+=(--email "$FLEET_ACME_EMAIL")
  else
    args+=(--register-unsafely-without-email)
  fi
  log=$(mktemp)
  if ! certbot "${args[@]}" >"$log" 2>&1; then
    red "证书没签下来：$(tail -5 "$log" | tr '\n' ' ')"
    rm -f -- "$log"
    return 1
  fi
  rm -f -- "$log"
  TLS_ISSUED=1
  changed "签发证书 $FLEET_DOMAIN（HTTP-01，验证文件放 $ACME_ROOT；续期交给 certbot.timer，续完重载 nginx）"
}

readback() {
  step "读回"
  readback_secrets_dir
  readback_wireguard
  readback_site
  readback_upstream
  readback_cert
  readback_web_upload
  readback_release
  readback_gateway_token
  readback_gateway
}

readback_web_upload() {
  if [[ -n "$FLEET_WEB_UPLOAD_PUBLIC_KEY$FLEET_GATEWAY_DEPLOY_PUBLIC_KEY" &&
    "$(stat -c '%U:%G %a' -- "$UPLOAD_KEYS_FILE" 2>/dev/null)" != "root:root 600" ]]; then
    red "$UPLOAD_KEYS_FILE 不是 root:root 600（$(stat -c '%U:%G %a' -- "$UPLOAD_KEYS_FILE" 2>&1)）"
    return 0
  fi
  if [[ -z "$FLEET_WEB_UPLOAD_PUBLIC_KEY" ]]; then
    pending "法国的上传公钥还没填（$ENV_FILE 的 FLEET_WEB_UPLOAD_PUBLIC_KEY，法国跑 france.sh 时会打印）：发布脚本传不了静态文件"
  elif ! grep -qxF "$(web_key_line)" -- "$UPLOAD_KEYS_FILE"; then
    red "$UPLOAD_KEYS_FILE 里没有带限制的那一行上传钥匙"
  elif [[ ! -x /usr/bin/rrsync ]]; then
    red "没有 /usr/bin/rrsync：上传钥匙登得上也什么都做不了"
  else
    ok "上传钥匙已登记：只许从 $WG_PEER_ADDR 来、只能往 $WEB_ROOT 写"
  fi
  if [[ -z "$FLEET_GATEWAY_DEPLOY_PUBLIC_KEY" ]]; then
    pending "法国发网关用的公钥还没填（$ENV_FILE 的 FLEET_GATEWAY_DEPLOY_PUBLIC_KEY，法国跑 france.sh 时会打印）：发布脚本发不了飞书网关"
  elif ! grep -qxF "$(gateway_key_line)" -- "$UPLOAD_KEYS_FILE"; then
    red "$UPLOAD_KEYS_FILE 里没有带限制的那一行网关钥匙"
  else
    ok "网关钥匙已登记：只许从 $WG_PEER_ADDR 来、只能跑 $GATEWAY_DEPLOY_BIN"
  fi
}

# 飞书网关：node、单元、入口脚本都在；配置齐不齐、网关跑没跑、连没连上飞书、连不连得上后端，照 fleet-gateway-deploy status 报
readback_gateway() {
  local have st key val
  have=$("$NODE_LINK/bin/node" --version 2>/dev/null) || have=""
  if [[ "$have" == "v$NODE_VERSION" ]]; then ok "node $have（$NODE_LINK）"; else red "$NODE_LINK/bin/node 是「${have:-没有}」，应为 v$NODE_VERSION"; fi
  if [[ ! -f "/etc/systemd/system/$GATEWAY_UNIT" || ! -x "$GATEWAY_DEPLOY_BIN" ]]; then
    red "飞书网关的单元或入口脚本不在（/etc/systemd/system/$GATEWAY_UNIT、$GATEWAY_DEPLOY_BIN）"
    return 0
  fi
  if ! st=$("$GATEWAY_DEPLOY_BIN" status 2>&1); then
    red "fleet-gateway-deploy status 没跑成：${st:0:200}"
    return 0
  fi
  declare -A s=()
  while IFS='=' read -r key val; do s[$key]=$val; done <<<"$st"
  if [[ "${s[config]:-}" != ok ]]; then
    pending "飞书网关的配置没备齐（${s[config]#missing }），发布时网关先不起"
  fi
  # 配了的团队群里真有机器人：不然盘面卡、推送都发不出去（群号是人写错了、或机器人被移出群）
  val=$(env_file_value "$FEISHU_ENV" FEISHU_TEAM_CHAT_ID)
  if [[ -n "$val" ]]; then
    if ! have=$(bot_chats 2>&1); then
      pending "列飞书机器人在哪些群里没列成，团队群没核对：${have:0:200}"
    elif grep -qF -- "$val"$'\t' <<<"$have"; then
      ok "FEISHU_TEAM_CHAT_ID 配的群里有飞书机器人"
    else
      red "FEISHU_TEAM_CHAT_ID 配的群里没有飞书机器人：盘面卡、推送都发不出去"
    fi
  fi
  if [[ -z "${s[current]:-}" ]]; then
    pending "飞书网关还没发布过（法国 deploy/release.sh 发）"
    return 0
  fi
  if [[ "${s[active]:-}" != active ]]; then
    # 配置没备齐时网关本来就不起（上面已记待配）；备齐了还没在跑才是毛病
    if [[ "${s[config]:-}" == ok ]]; then red "飞书网关（${s[current]:0:12}）没在跑：journalctl -u $GATEWAY_UNIT -n 50"; fi
    return 0
  fi
  if [[ "${s[running]:-}" != "${s[current]}" ]]; then red "飞书网关的主进程跑的是「${s[running]:-别处}」，不是在用的 ${s[current]:0:12}"; fi
  # 刚起的网关（比如上面装机时单元改了、刚重启过）要一两秒才连上飞书：还没连上就再等一会儿再判，
  # 不然读回和重启撞在一起，报成「没连上」（2026-09-25 香港真机撞到）
  local waited=0
  while [[ "${s[connected]:-}" != yes ]] && ((waited < GATEWAY_CONNECT_WAIT)); do
    sleep 2
    waited=$((waited + 2))
    st=$("$GATEWAY_DEPLOY_BIN" status 2>&1) || break
    s=()
    while IFS='=' read -r key val; do s[$key]=$val; done <<<"$st"
  done
  case ${s[connected]:-} in
  yes) ok "飞书网关 ${s[current]:0:12} 在跑，长连接连着飞书（这次起来后处理过 ${s[messages]:-0} 条消息）" ;;
  reconnecting) red "飞书网关在跑，但长连接断了、${GATEWAY_CONNECT_WAIT} 秒里没重连上：journalctl -u $GATEWAY_UNIT -n 50" ;;
  *) red "飞书网关在跑，但这次起来之后 ${GATEWAY_CONNECT_WAIT} 秒里没见它连上飞书：journalctl -u $GATEWAY_UNIT -n 50" ;;
  esac
  case ${s[backend]:-} in
  reachable) ok "飞书网关经隧道连得上法国后端" ;;
  refused) pending "飞书网关连不上法国后端（连接被拒：法国 fleet-api 没起；网关照实回「后端连不上」，不会崩）" ;;
  *) pending "飞书网关连法国后端：${s[backend]:-没查成}" ;;
  esac
}

# 香港上在发的是哪一版：发布脚本在静态目录里放 release.json；没有就还是装机时的占位页
readback_release() {
  local commit=""
  if [[ ! -f "$WEB_ROOT/release.json" ]]; then
    ok "$WEB_ROOT 还是装机时的占位页（没发布过）"
    return 0
  fi
  # 发布脚本写的就是一行 {"commit":"<40 位>"}：按这个样子认，不借这台机器上旧系统的 node
  commit=$(<"$WEB_ROOT/release.json")
  if [[ "$commit" =~ ^\{\"commit\":\"([0-9a-f]{40})\"\}$ ]]; then
    ok "$WEB_ROOT 在发 ${BASH_REMATCH[1]:0:12}（法国 deploy/release.sh 发来的）"
  else
    red "$WEB_ROOT/release.json 读不出提交号"
  fi
}

# 飞书网关的通行证：和法国同一份（这里只查在不在、属主权限、格式；两台是否一致见 docs/ops.md 第九节的比对命令）
readback_gateway_token() {
  local line
  if [[ ! -f "$GATEWAY_TOKEN_ENV" ]]; then
    pending "还没有 $GATEWAY_TOKEN_ENV：从法国原样拷一份（docs/ops.md 第九节），飞书网关上线前要有"
    return 0
  fi
  line=$(grep -c '^FLEET_FEISHU_GATEWAY_TOKEN=[0-9a-f]\{64\}$' -- "$GATEWAY_TOKEN_ENV" 2>/dev/null) || line=0
  if [[ "$line" != 1 ]]; then
    red "$GATEWAY_TOKEN_ENV 里的 FLEET_FEISHU_GATEWAY_TOKEN 不是法国生成的样子"
  else
    ok "飞书网关的通行证在（$GATEWAY_TOKEN_ENV，值不打印）"
  fi
}

# 经隧道连法国驾驶舱后端：连上 = 通；被拒 = 隧道和法国防火墙都通、后端还没起；超时 = 隧道断了或法国防火墙挡着
readback_upstream() {
  local rc=0
  timeout 5 bash -c "exec 3<>/dev/tcp/${API_UPSTREAM%:*}/${API_UPSTREAM#*:}" 2>/dev/null || rc=$?
  if ((rc == 0)); then
    ok "经隧道连得上法国驾驶舱后端 $API_UPSTREAM"
  elif ((rc == 124)); then
    red "连 $API_UPSTREAM 超时：隧道断了，或法国 ufw 没在 wg-fleet 上放行这个端口"
  else
    pending "法国驾驶舱后端 $API_UPSTREAM 还没起（连接被拒：隧道和法国防火墙是通的）"
  fi
}

readback_wireguard() {
  local port latest age
  if [[ "$(systemctl is-active "wg-quick@$WG_IF.service" 2>/dev/null)" != active ]]; then
    red "wg-quick@$WG_IF 没在跑"
    return 0
  fi
  port=$(wg show "$WG_IF" listen-port 2>/dev/null) || port=""
  if [[ "$port" == "$WG_PORT" ]]; then ok "WireGuard 在听 UDP $WG_PORT"; else red "WireGuard 听的是「${port:-读不到}」，应为 $WG_PORT"; fi
  if [[ -z "$FLEET_WG_FRANCE_PUBLIC_KEY" ]]; then
    pending "还没有法国的公钥（$ENV_FILE 的 FLEET_WG_FRANCE_PUBLIC_KEY），隧道只起了香港这头"
    return 0
  fi
  latest=$(wg show "$WG_IF" latest-handshakes 2>/dev/null | awk -v k="$FLEET_WG_FRANCE_PUBLIC_KEY" '$1 == k { print $2 }') || latest=""
  if [[ -z "$latest" || "$latest" == 0 ]]; then
    pending "法国还没连上来（从没握过手）：法国那边跑过 france.sh 了吗？"
    return 0
  fi
  age=$(($(date +%s) - latest))
  # 法国每 25 秒发一次保活，握手每两分钟换一次；超过三分钟没握手就是断了
  if ((age <= 180)); then ok "法国上次握手在 $age 秒前"; else red "法国 $age 秒没握手了"; fi
}

readback_site() {
  local name=${FLEET_DOMAIN:-$PLACEHOLDER_NAME} code probe token body
  if [[ "$(systemctl is-active nginx 2>/dev/null)" != active ]]; then
    red "nginx 没在跑"
    return 0
  fi
  if [[ -L "$SITE_ENABLED" && -f "$SITE_AVAILABLE" ]]; then ok "站点已启用（$SITE_ENABLED）"; else red "站点没启用"; fi
  if [[ -n "$FLEET_DOMAIN" && -f "/etc/letsencrypt/live/$FLEET_DOMAIN/fullchain.pem" ]]; then
    # 走真证书链：curl 按系统根证书校验，证书不对这里就失败
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$name:443:127.0.0.1" "https://$name/" || true)
    if [[ "$code" == 200 ]]; then ok "https://$name/ 返回 200（证书校验通过）"; else red "https://$name/ 返回「$code」"; fi
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$name:80:127.0.0.1" "http://$name/" || true)
    if [[ "$code" == 301 ]]; then ok "http://$name/ 跳 https（301）"; else red "http://$name/ 返回「$code」，应为 301"; fi
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $name" http://127.0.0.1/ || true)
    if [[ "$code" == 200 ]]; then ok "http://$name/（本机）返回 200"; else red "http://$name/（本机）返回「$code」"; fi
  fi
  # 证书续期靠 80 口的验证路径：放一个探针文件走一遍（只在装机时做——读回模式不写文件）
  if ((CHECK_ONLY == 0)); then
    token=fleet-dao-probe-$$
    probe=$ACME_ROOT/.well-known/acme-challenge/$token
    install -d -m 755 "$ACME_ROOT/.well-known/acme-challenge"
    printf '%s' "$token" >"$probe"
    body=$(curl -s --max-time 10 --resolve "$name:80:127.0.0.1" "http://$name/.well-known/acme-challenge/$token" || true)
    rm -f -- "$probe"
    if [[ "$body" == "$token" ]]; then ok "续期验证路径 http://$name/.well-known/acme-challenge/ 走得通"; else red "续期验证路径走不通（拿到「${body:0:60}」）"; fi
  fi
}

readback_cert() {
  local live end left renewal=/etc/letsencrypt/renewal/$FLEET_DOMAIN.conf
  if [[ -z "$FLEET_DOMAIN" ]]; then return 0; fi
  live=/etc/letsencrypt/live/$FLEET_DOMAIN
  if [[ ! -f "$live/fullchain.pem" ]]; then
    pending "还没有 $FLEET_DOMAIN 的证书"
    return 0
  fi
  end=$(openssl x509 -enddate -noout -in "$live/fullchain.pem" | cut -d= -f2)
  left=$((($(date -d "$end" +%s) - $(date +%s)) / 86400))
  # certbot 在剩 30 天时续期；剩不到 20 天说明续期没生效
  if ((left > 20)); then ok "证书还剩 $left 天（到 $end）"; else red "证书只剩 $left 天：续期没生效？certbot renew --dry-run 看现场"; fi
  if grep -qxF 'renew_hook = systemctl reload nginx' "$renewal" 2>/dev/null; then
    ok "续期后会重载 nginx（$renewal）"
  else
    red "$renewal 里没有「续完重载 nginx」，续了新证书 nginx 也不会用"
  fi
  if [[ "$(systemctl is-active certbot.timer 2>/dev/null)" == active && -n "$(unit_prop certbot.timer NextElapseUSecRealtime)" ]]; then
    ok "certbot.timer 在排班（下次 $(systemctl show -p NextElapseUSecRealtime --value certbot.timer)）"
  else
    red "certbot.timer 没在排班：证书到期不会自己续"
  fi
}

main() {
  local before=""
  preflight
  if ((CHECK_ONLY == 0)); then
    before=$(snapshot_others)
    setup_identity
    load_config
    setup_wireguard
    setup_web_upload
    setup_node
    setup_gateway
    setup_site
    setup_tls
    # 证书刚签下来：站点从只开 80 换成 80 + 443
    if ((TLS_ISSUED)); then setup_site; fi
  else
    load_config
  fi
  readback
  self_check_root_exec
  if ((CHECK_ONLY == 0)); then compare_others "$before"; fi
  finish
}

main "$@"
