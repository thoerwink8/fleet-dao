#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 香港机器装机（以 root 跑；幂等：跑第二遍什么都不变）。装的是：系统用户 fleet 与 /etc/fleet-dao、
# WireGuard 服务端、nginx 上 fleet-dao 这一个站点（驾驶舱入口占位页 + Let's Encrypt 证书与自动续期）。
# 旧网关的站点和服务一概不动。端口表、怎么跑、怎么看健康、怎么回滚：docs/ops.md。
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
ENV_FILE=/etc/fleet-dao/hk.env
ENV_KEYS=(FLEET_DOMAIN FLEET_ACME_EMAIL FLEET_WG_FRANCE_PUBLIC_KEY)
WEB_ROOT=/srv/fleet-dao-web
ACME_ROOT=/var/www/fleet-dao-acme
SITE_AVAILABLE=/etc/nginx/sites-available/fleet-dao
SITE_ENABLED=/etc/nginx/sites-enabled/fleet-dao
# 没配域名时的 server_name：.invalid 永远解析不到——站点装着、配置验得过，但谁也访问不到
PLACEHOLDER_NAME=fleet-dao.invalid

FLEET_DOMAIN=""
FLEET_ACME_EMAIL=""
FLEET_WG_FRANCE_PUBLIC_KEY=""
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
  ensure_dir "$WEB_ROOT" fleet:fleet 755
  # 占位页只在还没有首页时放：驾驶舱真正发布之后，这一步不能把它盖掉
  if [[ ! -e "$WEB_ROOT/index.html" ]]; then
    put_file "$WEB_ROOT/index.html" fleet:fleet 644 "$(<"$DEPLOY_DIR/hk/placeholder.html")"
  fi
  ensure_dir "$ACME_ROOT" root:root 755
  local name=${FLEET_DOMAIN:-$PLACEHOLDER_NAME} tpl=nginx-http.conf old="" had=0 site_changed before after why
  if [[ -n "$FLEET_DOMAIN" && -f "/etc/letsencrypt/live/$FLEET_DOMAIN/fullchain.pem" ]]; then tpl=nginx-https.conf; fi
  render "$DEPLOY_DIR/hk/$tpl" SERVER_NAME="$name" WEB_ROOT="$WEB_ROOT" ACME_ROOT="$ACME_ROOT"
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
  readback_cert
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
