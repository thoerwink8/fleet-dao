#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 香港机器装机（以 root 跑；幂等：跑第二遍什么都不变）。装的是：系统用户 fleet 与 /etc/fleet-dao、
# 防火墙基线（ufw 已经开着才收口：默认拒绝入站，只放白名单）、WireGuard 服务端、nginx 上 fleet-dao 这一个站点（驾驶舱静态文件 + Let's Encrypt 证书与自动续期；/api、/auth、
# /github/webhook、/healthz 经隧道转法国）、每分钟经隧道探法国 /healthz 的定时器（连续 3 次失败才算失联）、法国发布脚本用的一把钥匙
# （只许经隧道来，只能往 /srv/fleet-dao-web 写静态文件）、备份仓库的第二份（root 每天复制、留 14 天）和最新快照超没超 26 小时。
# 别家的站点和服务一概不动。端口表、怎么跑、怎么看健康、怎么回滚：docs/ops.md。
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
# shellcheck source=lib/nginx-body.sh
source "$DEPLOY_DIR/lib/nginx-body.sh"
# fail2ban 的 sshd jail 装法复用法国的（setup_fail2ban_sshd、readback_fail2ban_sshd）。它顺带带进来同名的 setup_identity、
# setup_firewall：下面香港自己的同名函数在 source 之后定义，会盖掉它们，所以这一行必须在所有函数定义之前。
# shellcheck source=lib/human-tier.sh
source "$DEPLOY_DIR/lib/human-tier.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

# ── 约定（改这里要同步 docs/ops.md）──
WG_IF=wg-fleet
# UDP，香港唯一新开的公网入站端口。这台的上游只放行少数常见 UDP 端口：2026-09-25 从法国实测，
# 53/67/69/123/161/500/1701/4500 进得来，51820 和其余高端口都到不了网卡。4500（IPsec NAT-T）空着，WireGuard 在上面握得上手。
WG_PORT=4500
# 对公网入站白名单。改这份名单要同步 docs/ops.md 第一节「公网入站」和第二节香港端口表。
# 本仓管的（缺了才 ufw allow）：22/tcp、80/tcp、443/tcp、4500/udp（4500 就是上面的 WG_PORT）。
HK_FW_OURS=(22/tcp 80/tcp 443/tcp "${WG_PORT}/udp")
# 别家登记：8443/tcp 不归本仓管（self-proxy-hk.service，ufw 注释 self-proxy，「别动」）。
# 见 docs/ops.md 第二节香港端口表。setup_firewall 不添加、不删除它的 ufw 规则，读回时认它不算多开。
HK_FW_FOREIGN=(8443/tcp)
WG_ADDR=10.99.0.1/24
WG_PEER_ADDR=10.99.0.2
# fail2ban 的 sshd jail（#1784）：内容在 deploy/hk/fail2ban-sshd.jail，放过隧道网段，法国在隧道里几次失败登录不会把发版链封死。
# 机器上原来手放的 sshd.local 和它同名段叠加，装的时候挪成 sshd.local.bak-<日期>（不删）。
FAIL2BAN_SSHD_JAIL=/etc/fail2ban/jail.d/fleet-dao-sshd.local
FAIL2BAN_SSHD_LEGACY=/etc/fail2ban/jail.d/sshd.local
HK_F2B_JAIL_SRC=$DEPLOY_DIR/hk/fail2ban-sshd.jail
HK_F2B_IGNORE=10.99.0.0/24
# 法国驾驶舱后端（packages/api 的 FLEET_COCKPIT_LISTEN）：/api、/auth、/github/webhook、/healthz 经隧道转到这里。
# 站点里它是 upstream fleet_dao_api 唯一的 server，连接留着复用（nginx-https.conf 开头）
API_UPSTREAM=$WG_PEER_ADDR:8787
# 香港本机探法国：每分钟打隧道上的 /healthz，连续 3 次失败才算失联。状态不放进静态目录（发版会 --delete）。
# 推送地址在另一份文件里，没配只写状态。改路径要同步 france-probe.sh 的默认值和两份 nginx 模板。
PROBE_BIN=/usr/local/lib/fleet-dao/france-probe.sh
PROBE_STATE_DIR=/var/lib/fleet-hk-france-probe
PROBE_ENV=/etc/fleet-dao/hk-probe.env
PROBE_SERVICE=fleet-hk-france-probe.service
PROBE_TIMER=fleet-hk-france-probe.timer
ENV_FILE=/etc/fleet-dao/hk.env
ENV_KEYS=(FLEET_DOMAIN FLEET_ACME_EMAIL FLEET_WG_FRANCE_PUBLIC_KEY FLEET_WEB_UPLOAD_PUBLIC_KEY
  FLEET_GATEWAY_DEPLOY_PUBLIC_KEY FLEET_DEMO_PATH) # 两个已删的键（飞书网关、演示版#1223）：老的 hk.env 里可能还有，认下来、忽略
# 驾驶舱静态文件归 root。法国的发布脚本经隧道用一把只能写这个目录的钥匙往里传（rrsync -wo），钥匙登记在 root 的
# authorized_keys2：这份文件整份归 fleet-dao 管，root 原有的 authorized_keys 一行不碰
WEB_ROOT=/srv/fleet-dao-web
UPLOAD_KEYS_FILE=/root/.ssh/authorized_keys2
ACME_ROOT=/var/www/fleet-dao-acme
SITE_AVAILABLE=/etc/nginx/sites-available/fleet-dao
SITE_ENABLED=/etc/nginx/sites-enabled/fleet-dao
# 没配域名时的 server_name：.invalid 永远解析不到——站点装着、配置验得过，但谁也访问不到
PLACEHOLDER_NAME=fleet-dao.invalid
# 已退役的飞书网关（#2184 删了它的部署，#2226 清机器上的残留）：装机时停掉、删掉它的单元；它的发布目录和收版本的脚本先打包进
# RETIRED_BACKUP_DIR（root 600）再删；令牌文件、它专用的 node 运行时不备份直接删。读回核对这些都不在、authorized_keys2 里没有
# 发网关的那一行（setup_web_upload 整份重写时就不再写它）。已经没有就什么都不动（幂等）。下面几个变量只有测试会改
RETIRED_UNITS=(fleet-feishu.service)
RETIRED_UNIT_DIR=/etc/systemd/system
RETIRED_KEEP=(/srv/fleet-dao-gateway /usr/local/sbin/fleet-gateway-deploy) # 删前打包
# 直接删：网关的飞书凭据、它的旧备份、网关通行证、/opt/fleet-dao 下网关专用的 node（官方发行包，机器上别的服务不用它）。可带通配
RETIRED_DROP=(/etc/fleet-dao/feishu.env '/etc/fleet-dao/feishu.env.bak-*' /etc/fleet-dao/gateway-token.env
  /opt/fleet-dao/node '/opt/fleet-dao/node-v*')
RETIRED_BACKUP_DIR=/var/backups/fleet-dao
# 备份的第二份和「最新快照超没超 26 小时」。仓库仍由 deploy/backup/install.sh 交给 fleet-backup；这里只让 root 再留一份，并自己写状态。
# 状态文件的格式在 deploy/backup/hk-status.sh。ensure_dir 用字面路径：目录表从这一行读，不认变量。
HK_BACKUP_LIB=/usr/local/lib/fleet-dao/backup
HK_BACKUP_MIRROR_UNITS=(fleet-backup-copy.service fleet-backup-copy.timer fleet-backup-freshness.service fleet-backup-freshness.timer)
HK_BACKUP_MIRROR_TIMERS=(fleet-backup-copy.timer fleet-backup-freshness.timer)
# 别家 self-proxy 的程序目录（#2235）：它的 self-proxy-userinfo.timer 每 15 分钟以 root 跑里面的 hk/userinfo.sh，
# 可它每次部署都是从创始人的 Mac 上 tar 解包，属主是 Mac 的 uid 501 / 组 staff。香港没有这个 uid，眼下没人改得了，
# 但谁拿到 uid 501 或 staff 组就能让 root 执行任意代码。装机把整棵树收成 root:root、组和其他人不可写（只动属主和写权限，
# 内容不碰）；self-proxy 重新部署会再变回去，所以读回也查，变回去判红、重跑 hk.sh 收回
SELF_PROXY_SRC=/opt/self-proxy/src

FLEET_DOMAIN=""
FLEET_ACME_EMAIL=""
FLEET_WG_FRANCE_PUBLIC_KEY=""
FLEET_WEB_UPLOAD_PUBLIC_KEY=""
# shellcheck disable=SC2034 # load_env 往里写，没人读
FLEET_GATEWAY_DEPLOY_PUBLIC_KEY="" # 已删的键（飞书网关），只为认得老的 hk.env
# shellcheck disable=SC2034 # 同上
FLEET_DEMO_PATH="" # 已删的键（#1223），只为认得老的 hk.env
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

# authorized_keys2 里登记法国的上传钥匙时，那一行的样子（读回按整行核对）
web_key_line() { printf 'from="%s",restrict,command="/usr/bin/rrsync -wo -munge %s" %s' "$WG_PEER_ADDR" "$WEB_ROOT" "$FLEET_WEB_UPLOAD_PUBLIC_KEY"; }

setup_web_upload() {
  step "法国发布脚本用的钥匙（$UPLOAD_KEYS_FILE：只许经隧道来，只能写 $WEB_ROOT）"
  local keys re='^ssh-ed25519 [A-Za-z0-9+/]{68}( [^[:space:]]+)?$' content
  ensure_pkgs rsync
  if [[ -z "$FLEET_WEB_UPLOAD_PUBLIC_KEY" ]]; then
    # 读回那一步会记「待配」
    echo "  还没有法国的公钥（$ENV_FILE 的 FLEET_WEB_UPLOAD_PUBLIC_KEY），先不登记"
    return 0
  fi
  if [[ ! "$FLEET_WEB_UPLOAD_PUBLIC_KEY" =~ $re ]]; then
    red "$ENV_FILE 的 FLEET_WEB_UPLOAD_PUBLIC_KEY 不像 ed25519 公钥（应为法国 france.sh 打印的那一整行）"
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
# 不给终端、不许转发。
# 往 $WEB_ROOT 传驾驶舱静态文件：登上来只能跑 rrsync，且只能往 $WEB_ROOT 里写（-wo：读不走任何东西；
# -munge：传来的符号链接落地时改成无效的样子，nginx 跟着它读不到目录外的文件）。
$(web_key_line)"
  put_file "$UPLOAD_KEYS_FILE" root:root 600 "$content"
}

# RETIRED_DROP 展开后机器上真有的：一行一个，没有就什么都不打印
retired_drop_present() {
  local p f
  for p in "${RETIRED_DROP[@]}"; do
    # shellcheck disable=SC2086 # 要的就是按通配展开；路径里没有空白
    for f in $p; do
      if [[ -e "$f" || -L "$f" ]]; then printf '%s\n' "$f"; fi
    done
  done
}

# SELF_PROXY_SRC 下属主不是 root、组不是 root、或组/其他人可写的：一行一个，目录不在或都干净就什么都不打印
self_proxy_src_loose() {
  [[ -d "$SELF_PROXY_SRC" ]] || return 0
  find "$SELF_PROXY_SRC" -xdev \( ! -user root -o ! -group root -o -perm /022 \) ! -type l
}

# 把 self-proxy 程序目录收成 root:root、组和其他人不可写（#2235）。已经干净就什么都不动（幂等）
fix_self_proxy_src_owner() {
  local n
  n=$(self_proxy_src_loose | wc -l)
  if ((n == 0)); then
    ok "$SELF_PROXY_SRC 没有（或已经）全属 root:root、组和其他人不可写"
    return 0
  fi
  chown -R -h root:root -- "$SELF_PROXY_SRC"
  chmod -R go-w -- "$SELF_PROXY_SRC"
  changed "$SELF_PROXY_SRC 下 $n 处属主或写权限不对，已收成 root:root、组和其他人不可写（#2235）"
}

# 读回：同上，还有不合格的判红（多半是 self-proxy 重新部署又解包成了 Mac 的 uid）
readback_self_proxy_src() {
  local n first
  n=$(self_proxy_src_loose | wc -l)
  if ((n == 0)); then
    ok "$SELF_PROXY_SRC 全属 root:root、组和其他人不可写"
  else
    first=$(self_proxy_src_loose | sed -n 1p)
    red "$SELF_PROXY_SRC 下 $n 处属主不是 root 或别人可写（例 $first）：root 会执行里面的脚本（#2235），重跑 hk.sh 收回"
  fi
}

# 清掉已退役的飞书网关（#2226）。停不掉、打包不成、删不掉都判红，打包不成的不删
retire_gateway() {
  step "清掉已退役的飞书网关（#2226）"
  local u f touched=0 keep=() tarball
  for u in "${RETIRED_UNITS[@]}"; do
    f=$RETIRED_UNIT_DIR/$u
    if [[ ! -e "$f" && ! -L "$f" && "$(systemctl is-active "$u" 2>/dev/null)" != active ]]; then continue; fi
    if ! systemctl disable --now "$u" >/dev/null 2>&1 && [[ "$(systemctl is-active "$u" 2>/dev/null)" == active ]]; then
      red "$u 停不掉（#2226）：systemctl status $u 看现场"
      continue
    fi
    if ! rm -f -- "$f"; then
      red "$f 删不掉（#2226）"
      continue
    fi
    touched=1
    changed "停掉并删掉 $u（#2226）"
  done
  if ((touched)) && ! systemctl daemon-reload; then red "systemctl daemon-reload 失败（#2226）"; fi
  for f in "${RETIRED_KEEP[@]}"; do
    if [[ -e "$f" || -L "$f" ]]; then keep+=("${f#/}"); fi
  done
  if ((${#keep[@]})); then
    tarball=$RETIRED_BACKUP_DIR/retired-feishu-gateway-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
    if install -d -o root -g root -m 700 -- "$RETIRED_BACKUP_DIR" &&
      (umask 077 && tar -czf "$tarball" -C / -- "${keep[@]}") && tar -tzf "$tarball" >/dev/null; then
      chmod 600 -- "$tarball"
      changed "打包 ${keep[*]} 进 $tarball（sha256 $(sha256sum <"$tarball" | cut -c1-16)…）"
      for f in "${keep[@]}"; do
        if rm -rf -- "/${f:?}"; then changed "删掉 /$f（#2226）"; else red "/$f 删不掉（#2226）"; fi
      done
    else
      rm -f -- "$tarball"
      red "打包 ${keep[*]} 没成（#2226）：没删，看 $RETIRED_BACKUP_DIR 的空间和权限后重跑"
    fi
  fi
  while IFS= read -r f; do
    if rm -rf -- "${f:?}"; then changed "删掉 $f（#2226）"; else red "$f 删不掉（#2226）"; fi
  done < <(retired_drop_present)
}

# 读回：已退役的飞书网关留下的单元、目录、文件都不在，authorized_keys2 里没有发网关的那一行
readback_retired_gateway() {
  local u f bad=0
  for u in "${RETIRED_UNITS[@]}"; do
    if [[ -e "$RETIRED_UNIT_DIR/$u" || -L "$RETIRED_UNIT_DIR/$u" ]] || [[ "$(systemctl is-active "$u" 2>/dev/null)" == active ]]; then
      red "已退役的 $u 还在（#2226）：重跑 hk.sh 清掉"
      bad=1
    fi
  done
  # shellcheck disable=SC2046 # retired_drop_present 一行一个路径，路径里没有空白
  for f in "${RETIRED_KEEP[@]}" $(retired_drop_present); do
    if [[ -e "$f" || -L "$f" ]]; then
      red "已退役的飞书网关留下的 $f 还在（#2226）：重跑 hk.sh 清掉"
      bad=1
    fi
  done
  if [[ -f "$UPLOAD_KEYS_FILE" ]] && grep -q 'fleet-gateway-deploy' -- "$UPLOAD_KEYS_FILE"; then
    red "$UPLOAD_KEYS_FILE 里还有发飞书网关的那一行（#2226）：重跑 hk.sh 整份重写"
    bad=1
  fi
  if ((bad == 0)); then ok "已退役的飞书网关留下的单元、目录、令牌文件都不在了（#2226）"; fi
}

load_config() {
  load_env "$ENV_FILE" "${ENV_KEYS[@]}"
  ok "本机配置 $ENV_FILE：域名 ${FLEET_DOMAIN:-（未配）}，法国公钥$(filled "$FLEET_WG_FRANCE_PUBLIC_KEY")"
}

# 读 ufw status verbose。成功时正文在 HK_FW_STATUS、第一行在 HK_FW_STATUS_LINE。
# 命令失败或第一行不是 Status: active / inactive：红「没查成」，返回 1（不当成没开、也不当成没事）。
hk_fw_read_status() {
  local rc=0
  HK_FW_STATUS=""
  HK_FW_STATUS_LINE=""
  if ! command -v ufw >/dev/null 2>&1; then
    red "ufw 状态没查成：没有 ufw 命令"
    return 1
  fi
  HK_FW_STATUS=$(ufw status verbose 2>&1) || rc=$?
  if ((rc != 0)); then
    red "ufw 状态没查成：命令失败（${HK_FW_STATUS:0:200}）"
    return 1
  fi
  HK_FW_STATUS_LINE=${HK_FW_STATUS%%$'\n'*}
  case "$HK_FW_STATUS_LINE" in
  "Status: active" | "Status: inactive") return 0 ;;
  esac
  red "ufw 状态没查成：输出认不出"
  return 1
}

# 默认入站策略（deny / allow / reject）。verbose 里没有 Default 行就空
hk_fw_incoming_policy() {
  local policy=""
  if [[ "$HK_FW_STATUS" =~ Default:[[:space:]]*([a-z]+)[[:space:]]*\(incoming\) ]]; then
    policy=${BASH_REMATCH[1]}
  fi
  printf '%s' "$policy"
}

# 这一条端口/协议已有 v4 的入站 ALLOW IN（「22/tcp (v6)」那行不算：缺 v4 时 ufw allow 会补）。
# 只认 ALLOW IN：同端口的 ALLOW OUT 是出站，不算已放行。只有出站时仍要补入站，再把默认入站改成拒绝。
hk_fw_allowed() {
  grep -qE "^${1}[[:space:]]+ALLOW IN([[:space:]]|$)" <<<"$HK_FW_STATUS"
}

hk_fw_comment() {
  case $1 in
  22/tcp) printf '%s' 'fleet-dao ssh' ;;
  80/tcp) printf '%s' 'fleet-dao http' ;;
  443/tcp) printf '%s' 'fleet-dao https' ;;
  "${WG_PORT}/udp") printf '%s' 'fleet-dao wireguard' ;;
  *) printf '%s' "fleet-dao $1" ;;
  esac
}

# 在白名单（本仓的或别家登记的）里
hk_fw_listed() {
  local x
  for x in "${HK_FW_OURS[@]}" "${HK_FW_FOREIGN[@]}"; do
    [[ "$x" == "$1" ]] && return 0
  done
  return 1
}

# ss -Hltunp 的一行。对公网：打印「端口/协议<TAB>进程名」并返回 0。
# 回环（127.0.0.0/8、::1，地址上的 %区 先剥掉）和隧道地址 10.99.0.1：返回 1。认不出：返回 2。
hk_fw_public_line() {
  local line=$1 proto local_spec addr port proc
  proto=${line%%[[:space:]]*}
  case "$proto" in
  tcp | udp) ;;
  *) return 2 ;;
  esac
  local_spec=$(awk '{ print $5 }' <<<"$line")
  [[ -n "$local_spec" && "$local_spec" != "$proto" ]] || return 2
  if [[ "$local_spec" == "["*"]:"* ]]; then
    addr=${local_spec#\[}
    addr=${addr%%\]:*}
    port=${local_spec##*:}
  elif [[ "$local_spec" == *:* ]]; then
    addr=${local_spec%:*}
    port=${local_spec##*:}
  else
    return 2
  fi
  addr=${addr%%%*}
  [[ "$port" =~ ^[0-9]+$ ]] || return 2
  if [[ "$addr" == 127.* || "$addr" == "::1" || "$addr" == "0:0:0:0:0:0:0:1" ]]; then
    return 1
  fi
  if [[ "$addr" == "${WG_ADDR%%/*}" ]]; then
    return 1
  fi
  proc="-"
  if [[ "$line" =~ users:\(\(\"([^\"]+)\" ]]; then
    proc=${BASH_REMATCH[1]}
  fi
  printf '%s/%s\t%s\n' "$port" "$proto" "$proc"
}

hk_fw_join_lines() {
  awk 'BEGIN { s = "" } { s = s (NR > 1 ? "、" : "") $0 } END { printf "%s", s }'
}

# ufw 没开就停下，不执行 ufw enable（开防火墙可能断 SSH）。已开着：默认不是拒绝才改成拒绝；
# 本仓白名单里缺的才 ufw allow。别家已有的规则（含 8443 上注释 self-proxy 的那条）一律不添加、不删除。
# 先补放行再收紧默认：免得默认一改成拒绝、22 还没放行，把自己关在门外。已经是这个样子时一条改 ufw 的命令都不发。
setup_firewall() {
  step "防火墙（默认拒绝入站；本仓只放白名单，别家的规则不动）"
  local spec cmt policy touched=0
  if ! hk_fw_read_status; then return 1; fi
  if [[ "$HK_FW_STATUS_LINE" == "Status: inactive" ]]; then
    red "ufw 没开：不替人开（开防火墙可能断 SSH）"
    return 1
  fi
  for spec in "${HK_FW_OURS[@]}"; do
    if hk_fw_allowed "$spec"; then continue; fi
    cmt=$(hk_fw_comment "$spec")
    if ! ufw allow "$spec" comment "$cmt" >/dev/null; then
      red "ufw 放行 $spec 没做成"
      return 1
    fi
    changed "ufw 放行 $spec"
    touched=1
  done
  policy=$(hk_fw_incoming_policy)
  if [[ -z "$policy" ]]; then
    red "ufw 状态没查成：默认入站策略认不出"
    return 1
  fi
  if [[ "$policy" != deny ]]; then
    if ! ufw default deny incoming >/dev/null; then
      red "ufw 默认拒绝入站没做成"
      return 1
    fi
    changed "ufw 默认拒绝入站（原来是 $policy）"
    touched=1
  fi
  if ((touched == 0)); then ok "ufw 开着，默认拒绝入站，白名单都已放行"; fi
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
  # 公网放行不在这里：setup_firewall 的白名单含 UDP $WG_PORT。这里只起接口。
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
  # 配置没变也核/修请求体落盘目录；否则小请求通、大 webhook 在转发前 500。
  ensure_nginx_body || return 1
  # 驾驶舱页面归 root：跑在这台上的别的进程被打穿也改不了驾驶舱的页面
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
  # TUNNEL_PEER：法国在隧道上的地址，站点只把 release.json 给从它来的请求
  render "$DEPLOY_DIR/hk/$tpl" SERVER_NAME="$name" WEB_ROOT="$WEB_ROOT" ACME_ROOT="$ACME_ROOT" API_UPSTREAM="$API_UPSTREAM" \
    TUNNEL_PEER="$WG_PEER_ADDR"
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

setup_fail2ban() {
  local bak
  if [[ -f "$FAIL2BAN_SSHD_LEGACY" && ! -L "$FAIL2BAN_SSHD_LEGACY" ]]; then
    bak=$FAIL2BAN_SSHD_LEGACY.bak-$(date +%F)
    mv -f -- "$FAIL2BAN_SSHD_LEGACY" "$bak"
    changed "手放的 $FAIL2BAN_SSHD_LEGACY 挪成 $bak（它和 fleet-dao-sshd.local 的 sshd 段叠加，不删）"
  fi
  setup_fail2ban_sshd "$HK_F2B_JAIL_SRC"
}

readback_fail2ban() {
  readback_fail2ban_sshd "$HK_F2B_JAIL_SRC" "$HK_F2B_IGNORE"
  if command -v fail2ban-client >/dev/null && [[ -e "$FAIL2BAN_SSHD_LEGACY" ]]; then
    red "$FAIL2BAN_SSHD_LEGACY 还在：手放的旧 sshd jail 会盖掉 fleet-dao-sshd.local 的值，重跑 hk.sh 挪开它"
  fi
}

# 探法国：脚本、定时器、状态目录。推送没配只记待配，不判红（没配就只写状态）。
setup_france_probe() {
  step "探法国 healthz（每分钟经隧道，连续 3 次失败才算失联）"
  # jq：探活脚本拼飞书请求、读飞书回应
  ensure_pkgs curl jq
  ensure_dir /usr/local/lib/fleet-dao root:root 755
  ensure_dir "$PROBE_STATE_DIR" root:root 755
  if [[ -e "$PROBE_ENV" ]]; then
    fix_meta "$PROBE_ENV" root:root 600
  else
    put_file "$PROBE_ENV" root:root 600 "$(<"$DEPLOY_DIR/hk/hk-probe.env.example")"
  fi
  put_file "$PROBE_BIN" root:root 755 "$(<"$DEPLOY_DIR/hk/france-probe.sh")"
  local reload=0 timer_wrote=0
  put_file "/etc/systemd/system/$PROBE_SERVICE" root:root 644 "$(<"$DEPLOY_DIR/hk/$PROBE_SERVICE")"
  reload=$((reload || WROTE))
  put_file "/etc/systemd/system/$PROBE_TIMER" root:root 644 "$(<"$DEPLOY_DIR/hk/$PROBE_TIMER")"
  timer_wrote=$WROTE
  reload=$((reload || WROTE))
  if ((reload)); then
    if ! systemctl daemon-reload; then
      red "systemctl daemon-reload 失败（法国探活）"
      return 1
    fi
  fi
  if [[ "$(systemctl is-enabled "$PROBE_TIMER" 2>/dev/null)" != enabled ]]; then
    if ! systemctl enable --quiet "$PROBE_TIMER"; then
      red "$PROBE_TIMER 启用失败"
      return 1
    fi
    changed "启用 $PROBE_TIMER"
  fi
  if [[ "$(systemctl is-active "$PROBE_TIMER" 2>/dev/null)" != active ]]; then
    if ! systemctl start "$PROBE_TIMER"; then
      red "$PROBE_TIMER 起不来：systemctl status $PROBE_TIMER"
      return 1
    fi
    changed "启动 $PROBE_TIMER"
  elif ((timer_wrote)); then
    if ! systemctl restart "$PROBE_TIMER"; then
      red "$PROBE_TIMER 重启失败：systemctl status $PROBE_TIMER"
      return 1
    fi
    changed "重启 $PROBE_TIMER（单元变了）"
  fi
  ok "法国探活已排班（每分钟打 http://${WG_PEER_ADDR}:8787/healthz，连续 3 次失败才算失联）"
}

# 等号后面的值：去首尾空白，再剥掉一对双引号（和 france-probe.sh 同一套读法）
probe_env_value() {
  local val=$1
  val=${val#"${val%%[![:space:]]*}"}
  val=${val%"${val##*[![:space:]]}"}
  if [[ "$val" =~ ^\"(.*)\"$ ]]; then val=${BASH_REMATCH[1]}; fi
  val=${val#"${val%%[![:space:]]*}"}
  val=${val%"${val##*[![:space:]]}"}
  printf '%s' "$val"
}

# 推送配的是哪种：印 app（飞书应用三项齐）、half（应用配了一半）、webhook、none。只看等号后面有没有字，不把值打出来（里面是凭据）。
# 和 france-probe.sh 的 probe_pick_channel 同一套判法。
probe_push_channel() {
  local line val app=0 webhook=0
  if [[ -r "$PROBE_ENV" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
      [[ "$line" =~ ^(FLEET_HK_PROBE_[A-Z_]+)=(.*)$ ]] || continue
      val=$(probe_env_value "${BASH_REMATCH[2]}")
      [[ -n "$val" ]] || continue
      case "${BASH_REMATCH[1]}" in
      FLEET_HK_PROBE_FEISHU_APP_ID | FLEET_HK_PROBE_FEISHU_APP_SECRET | FLEET_HK_PROBE_FEISHU_CHAT_ID) app=$((app + 1)) ;;
      FLEET_HK_PROBE_WEBHOOK) webhook=1 ;;
      *) ;;
      esac
    done <"$PROBE_ENV"
  fi
  if ((app >= 3)); then
    echo app
  elif ((app > 0)); then
    echo half
  elif ((webhook)); then
    echo webhook
  else
    echo none
  fi
}

# systemd 把「没有」印成空、0、n/a 或 infinity。这四种都不算有下次时间或上次触发。
timer_prop_set() {
  local v="$1"
  [[ -n "$v" && "$v" != "0" && "$v" != "n/a" && "$v" != "infinity" ]]
}

# 单元正文。cat 读到的是正在用的那份（含 drop-in）；cat 不成再看装上去的文件。
timer_unit_text() {
  local unit=$1 text=""
  text=$(systemctl cat "$unit" 2>/dev/null) || true
  if [[ -z "$text" && -f /etc/systemd/system/$unit ]]; then
    text=$(<"/etc/systemd/system/$unit")
  fi
  printf '%s\n' "$text"
}

# 第三种兜底只认 OnUnitActiveSec。走到这里时下次时间和 LastTriggerUSec 都是空的，也就是刚启动、还没触发过。
# 不认 OnBootSec / OnActiveSec / OnStartupSec / OnUnitInactiveSec：没有 OnUnitActiveSec、下次和上次都空，不算在排班。
timer_unit_just_started_on_unit_active() {
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*OnUnitActiveSec[[:space:]]*= ]] && return 0
  done <<<"$(timer_unit_text "$1")"
  return 1
}

# 在排班：enabled 且 active，并且「下次触发时间非空」或「已有 LastTriggerUSec」或「有 OnUnitActiveSec 且刚启动」三者之一。
# 下次时间：日历定时器在 NextElapseUSecRealtime；只按开机/激活间隔排的，Realtime 一直是空的，时间在
# NextElapseUSecMonotonic。只看 Realtime，探活从装上起就永远是红。探活单元是 OnBootSec + OnUnitInactiveSec，
# 刚启动时单调钟已经有下次时间，走第一条，不靠第三种兜底。
# 刚启动：一次都没触发过（LastTriggerUSec 还没有），下次时间也还没填上。oneshot 正在跑时下次时间会被清掉，
# 但 LastTriggerUSec 已经有了，走第二条。
timer_is_scheduled() {
  local unit=$1
  [[ "$(systemctl is-enabled "$unit" 2>/dev/null)" == enabled ]] || return 1
  [[ "$(systemctl is-active "$unit" 2>/dev/null)" == active ]] || return 1
  timer_prop_set "$(unit_prop "$unit" NextElapseUSecRealtime)" && return 0
  timer_prop_set "$(unit_prop "$unit" NextElapseUSecMonotonic)" && return 0
  timer_prop_set "$(unit_prop "$unit" LastTriggerUSec)" && return 0
  timer_unit_just_started_on_unit_active "$unit"
}

# 读回一条。没排上时红字用调用方给的原因（读回不 return 1，免得装机停在半截）。
readback_timer_scheduled() {
  local unit=$1 why=$2 next
  if ! timer_is_scheduled "$unit"; then
    red "$unit 没在排班：$why"
    return 0
  fi
  # Realtime 是墙钟，可以直接给人看。Monotonic 印出来的是开机后的单调钟读数，不是「还要多久」，不能当成下次时刻。
  next=$(unit_prop "$unit" NextElapseUSecRealtime)
  if timer_prop_set "$next"; then
    ok "$unit 在排班（下次 $next）"
  elif timer_prop_set "$(unit_prop "$unit" NextElapseUSecMonotonic)"; then
    ok "$unit 在排班（已排上下次）"
  elif timer_prop_set "$(unit_prop "$unit" LastTriggerUSec)"; then
    ok "$unit 在排班（已触发过，下次时间还没填上）"
  else
    ok "$unit 在排班（刚启动，下次触发时间还没填上）"
  fi
}

readback_france_probe() {
  if [[ -x "$PROBE_BIN" ]]; then
    ok "法国探活脚本在 $PROBE_BIN"
  else
    red "没有法国探活脚本 $PROBE_BIN：重跑 hk.sh"
  fi
  if [[ -d "$PROBE_STATE_DIR" && "$(stat -c '%U:%G %a' -- "$PROBE_STATE_DIR" 2>/dev/null)" == "root:root 755" ]]; then
    ok "法国探活状态目录 $PROBE_STATE_DIR（root:root 755，nginx 读得了）"
  else
    red "法国探活状态目录不对（$PROBE_STATE_DIR 应为 root:root 755）：重跑 hk.sh"
  fi
  if [[ -f "$SITE_AVAILABLE" ]] && grep -qF 'location = /health/france-link.json' -- "$SITE_AVAILABLE" &&
    grep -qF "alias $PROBE_STATE_DIR/status.json;" -- "$SITE_AVAILABLE"; then
    ok "健康页能读本机探活状态（/health/france-link.json）"
  else
    red "站点没把 /health/france-link.json 指到 $PROBE_STATE_DIR/status.json：重跑 hk.sh"
  fi
  readback_timer_scheduled "$PROBE_TIMER" "法国关机时香港不会自己发现"
  case "$(probe_push_channel)" in
  app) ok "法国探活推送走飞书应用（凭据不在这里打印）" ;;
  webhook) ok "法国探活推送走飞书群机器人（地址不在这里打印）" ;;
  half) red "法国探活的飞书应用配了一半（$PROBE_ENV 的 FLEET_HK_PROBE_FEISHU_APP_ID / _APP_SECRET / _CHAT_ID 要三项都有）：失联推不出去" ;;
  *) pending "法国探活没配推送（$PROBE_ENV 的飞书应用三项或 FLEET_HK_PROBE_WEBHOOK）：只写状态文件和日志，健康页仍显示失联" ;;
  esac
}

setup_backup_mirror() {
  step "备份第二份（root 每天复制、留 14 天）和最新快照检查"
  local u t reload=0
  ensure_pkgs rsync
  ensure_dir /var/backups/fleet-dao/restic-copies root:root 700
  ensure_dir /var/lib/fleet-hk root:root 755
  ensure_dir /usr/local/lib/fleet-dao/backup root:root 755
  put_file "$HK_BACKUP_LIB/hk-status.sh" root:root 644 "$(<"$DEPLOY_DIR/backup/hk-status.sh")"
  put_file "$HK_BACKUP_LIB/hk-repo-copy.sh" root:root 755 "$(<"$DEPLOY_DIR/backup/hk-repo-copy.sh")"
  put_file "$HK_BACKUP_LIB/hk-snapshot-freshness.sh" root:root 755 "$(<"$DEPLOY_DIR/backup/hk-snapshot-freshness.sh")"
  for u in "${HK_BACKUP_MIRROR_UNITS[@]}"; do
    put_file "/etc/systemd/system/$u" root:root 644 "$(<"$DEPLOY_DIR/hk/$u")"
    reload=$((reload || WROTE))
  done
  if ((reload)); then systemctl daemon-reload; fi
  for t in "${HK_BACKUP_MIRROR_TIMERS[@]}"; do
    if [[ "$(systemctl is-enabled "$t" 2>/dev/null)" != enabled ]]; then
      systemctl enable --quiet "$t"
      changed "启用 $t"
    fi
    # 单元文件变了要重新排班；定时器没在等也要拉起来。oneshot 服务本身不在这里起：装机不该当场复制一整份仓库
    if ((reload)) || [[ "$(systemctl is-active "$t" 2>/dev/null)" != active ]]; then
      if ! systemctl restart "$t"; then
        red "$t 起不来：journalctl -u $t -n 30 看现场"
        return 1
      fi
      changed "启动 $t"
    fi
  done
}

readback_owned_dir() { # 路径 属主:组 权限。只红，不 return 1（读回不能把装机停在半截）
  local path=$1 own=$2 mode=$3 have
  if [[ -L "$path" || ! -d "$path" ]]; then
    red "$path 不是目录"
    return 0
  fi
  have=$(stat -c '%U:%G %a' -- "$path" 2>/dev/null || true)
  if [[ "$have" != "$own $mode" ]]; then
    red "$path 是 ${have:-读不到}，要 $own $mode"
    return 0
  fi
  ok "$path（$own $mode）"
}

readback_file_match() { # 装上的 属主:组 权限 仓里的
  local dest=$1 own=$2 mode=$3 src=$4 have
  if [[ -L "$dest" || ! -f "$dest" ]]; then
    red "$dest 不是普通文件"
    return 0
  fi
  have=$(stat -c '%U:%G %a' -- "$dest" 2>/dev/null || true)
  if [[ "$have" != "$own $mode" ]]; then
    red "$dest 是 ${have:-读不到}，要 $own $mode"
    return 0
  fi
  if ! cmp -s -- "$dest" "$src"; then
    red "$dest 和仓里的不一样"
    return 0
  fi
  ok "$dest 和仓里一致"
}

readback_backup_mirror() {
  local t
  if ! command -v rsync >/dev/null; then
    red "没有 rsync：备份复制做不成"
  fi
  readback_owned_dir /var/backups/fleet-dao/restic-copies root:root 700
  readback_owned_dir /var/lib/fleet-hk root:root 755
  readback_owned_dir /usr/local/lib/fleet-dao/backup root:root 755
  readback_file_match "$HK_BACKUP_LIB/hk-status.sh" root:root 644 "$DEPLOY_DIR/backup/hk-status.sh"
  readback_file_match "$HK_BACKUP_LIB/hk-repo-copy.sh" root:root 755 "$DEPLOY_DIR/backup/hk-repo-copy.sh"
  readback_file_match "$HK_BACKUP_LIB/hk-snapshot-freshness.sh" root:root 755 "$DEPLOY_DIR/backup/hk-snapshot-freshness.sh"
  for t in "${HK_BACKUP_MIRROR_UNITS[@]}"; do
    readback_file_match "/etc/systemd/system/$t" root:root 644 "$DEPLOY_DIR/hk/$t"
  done
  for t in "${HK_BACKUP_MIRROR_TIMERS[@]}"; do
    if [[ "$(systemctl is-enabled "$t" 2>/dev/null)" != enabled ]]; then
      red "$t 没启用"
    elif [[ "$(systemctl is-active "$t" 2>/dev/null)" != active ]]; then
      red "$t 没在排班"
    else
      ok "$t 在排班"
    fi
  done
  # 仓库还没有不算没装：install.sh hk 可能还没跑。定时器先挂上，复制那一轮会自己记下没做成
  if [[ -L /srv/fleet-dao-backup/restic || ! -d /srv/fleet-dao-backup/restic ]]; then
    pending "备份仓库还没有（/srv/fleet-dao-backup/restic，先跑 install.sh hk）：复制和新鲜度要等它出现"
  fi
}

readback() {
  step "读回"
  readback_fail2ban
  readback_backup_mirror
  readback_secrets_dir
  readback_firewall
  readback_wireguard
  readback_site
  readback_upstream
  readback_france_probe
  readback_cert
  readback_web_upload
  readback_retired_gateway
  readback_self_proxy_src
  readback_release
}

readback_web_upload() {
  if [[ -n "$FLEET_WEB_UPLOAD_PUBLIC_KEY" &&
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

# 对公网多开了口才红，并点名端口和进程。白名单里有、机器上还没在听（证书没签时的 443）只记一行 ok。
# ss 失败或有认不出的行：红「没查成」，不当成「没有多开」。
hk_fw_readback_ports() {
  local out="" rc=0 line parsed st key proc spec
  local -A seen=()
  local bad="" extras=() missing=() shown joined
  if ! command -v ss >/dev/null 2>&1; then
    red "对公网的端口没查成：没有 ss 命令"
    return 0
  fi
  # -H 不要表头，-l 只看监听，-tu tcp 和 udp，-n 数字地址，-p 才有进程名
  out=$(ss -Hltunp 2>&1) || rc=$?
  if ((rc != 0)); then
    red "对公网的端口没查成：ss 失败（${out:0:200}）"
    return 0
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    parsed=$(hk_fw_public_line "$line") && st=0 || st=$?
    if ((st == 1)); then continue; fi
    if ((st != 0)); then
      bad+="${bad:+ }${line:0:120}"
      continue
    fi
    key=${parsed%%$'\t'*}
    proc=${parsed#*$'\t'}
    if [[ -z "${seen[$key]:-}" ]]; then
      seen[$key]=$proc
    elif [[ ",${seen[$key]}," != *",$proc,"* ]]; then
      seen[$key]+=",$proc"
    fi
  done <<<"$out"
  if [[ -n "$bad" ]]; then red "对公网的端口没查成：ss 有认不出的行（$bad）"; fi
  for key in "${!seen[@]}"; do
    if hk_fw_listed "$key"; then continue; fi
    extras+=("${key}（进程 ${seen[$key]}）")
  done
  if ((${#extras[@]})); then
    shown=$(printf '%s\n' "${extras[@]}" | LC_ALL=C sort | hk_fw_join_lines)
    red "对公网多开了端口：$shown"
  fi
  for spec in "${HK_FW_OURS[@]}"; do
    if [[ -z "${seen[$spec]:-}" ]]; then missing+=("$spec"); fi
  done
  if ((${#missing[@]})); then
    joined=$(printf '%s\n' "${missing[@]}" | hk_fw_join_lines)
    ok "白名单里还没在听：${joined}（没在听不算红，例如证书没签时 443）"
  fi
  if ((${#extras[@]} == 0)) && [[ -z "$bad" ]]; then ok "对公网在听的端口都在白名单里"; fi
}

readback_firewall() {
  local policy=""
  if hk_fw_read_status; then
    if [[ "$HK_FW_STATUS_LINE" == "Status: inactive" ]]; then
      red "ufw 没开"
    else
      policy=$(hk_fw_incoming_policy)
      if [[ -z "$policy" ]]; then
        red "ufw 状态没查成：默认入站策略认不出"
      elif [[ "$policy" != deny ]]; then
        red "ufw 默认入站不是拒绝（现在是 $policy）"
      else
        ok "ufw 开着，默认拒绝入站"
      fi
    fi
  fi
  hk_fw_readback_ports
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
  local name=${FLEET_DOMAIN:-$PLACEHOLDER_NAME} code probe token body gaps
  # 只读核目录和真实 worker 身份，不用会改临时目录 metadata 的 nginx -t/-T。
  readback_nginx_body || return 1
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
    # 往法国的连接复用：少了它每个请求多等一趟隧道往返（约 0.2 秒）
    gaps=$(site_keepalive_gaps "$SITE_AVAILABLE")
    if [[ -z "$gaps" ]]; then
      ok "往法国后端的连接复用（upstream fleet_dao_api 带 keepalive，转给法国的每一处都走它）"
    else
      red "往法国后端的连接不复用：$(tr '\n' ' ' <<<"$gaps")"
    fi
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
    # 先收防火墙：没开就停下，不往下装。放在快照前，补白名单不算「装机碰了旧系统」；别家规则这一步也不改。
    setup_firewall
    before=$(snapshot_others)
    setup_identity
    load_config
    setup_wireguard
    setup_web_upload
    retire_gateway
    fix_self_proxy_src_owner
    setup_fail2ban
    setup_backup_mirror
    setup_site
    setup_tls
    # 证书刚签下来：站点从只开 80 换成 80 + 443
    if ((TLS_ISSUED)); then setup_site; fi
    setup_france_probe
  else
    load_config
  fi
  readback
  self_check_root_exec
  if ((CHECK_ONLY == 0)); then compare_others "$before"; fi
  finish
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
