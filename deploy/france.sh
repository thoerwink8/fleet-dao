#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 法国机器装机（以 root 跑；幂等：跑第二遍什么都不变）。装的是：引擎用户 fleet、两个会话专用用户、创始人的登录用户 pilot、目录、
# PostgreSQL 16（Ubuntu 自带的源，吃得到自动安全更新）、Temporal 服务端 1.32.0（Postgres 持久化，端口和旧系统错开）、
# 本机上只许 root 和 fleet 连 Temporal 与库的 nft 表、AI 会话资源池 fleet-agents.slice 与起会话的脚本、
# fleet 用户的 pnpm（corepack）、WireGuard 客户端（主动连香港，法国不开任何入站端口）、
# 应用的本机配置与随机密钥、往香港传驾驶舱静态文件的钥匙、会话用户和 pilot 家里各家 AI 的全局说明与方法类 skill、
# 他们各自的 ddgs（用钉住版本的 uv 装）。应用本身（引擎、后端、前端）由 deploy/release.sh 发布。
# 旧系统的服务、端口、文件一概不动。端口表、怎么跑、怎么看健康、怎么回滚：docs/ops.md。
#   bash deploy/france.sh           装：缺的补上，已有的不动
#   bash deploy/france.sh --check   只读回和自检，不改任何东西
set -Eeuo pipefail
umask 022

DEPLOY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
source "$DEPLOY_DIR/lib/common.sh"
# shellcheck source=lib/snapshot.sh
source "$DEPLOY_DIR/lib/snapshot.sh"
# shellcheck source=lib/root-exec-check.sh
source "$DEPLOY_DIR/lib/root-exec-check.sh"
# shellcheck source=lib/login-user.sh
source "$DEPLOY_DIR/lib/login-user.sh"
# shellcheck source=lib/cli-tools.sh
source "$DEPLOY_DIR/lib/cli-tools.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

# ── 钉死的版本与校验和：外部二进制装上机器就进了信任面，不用 latest ──
TEMPORAL_SERVER_VERSION=1.32.0
TEMPORAL_SERVER_SHA256=ca1ccbb1d1545b68eb4523de463c51ffcd80f7e0bccd14a9b2c56fc7e389e792
TEMPORAL_CLI_VERSION=1.9.1
TEMPORAL_CLI_SHA256=09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5
PG_MAJOR=16 # Temporal 官方测过的最高大版本（13.18/14.15/15.10/16.6）；Ubuntu 24.04 自带的源里就是 16
# pilot 的 reclaude：和会话用户手上那份同一个（dl.reclaude.ai/stable.json 列的 linux-amd64）。只在没有时装，
# 之后由 pilot 自己 reclaude update，脚本不盖
RECLAUDE_VERSION=v1.4.0
RECLAUDE_SHA256=4f5d683b695ea392f53d4e8f2a916f092794f8d4196d5b7356afb0c9a9392f0a
# uv：只用来给会话用户和 pilot 各装一份 ddgs（lib/cli-tools.sh）。装在 /opt/fleet-dao/uv/<版本>，归 root，不进谁的 PATH
UV_VERSION=0.12.17
UV_SHA256=fa82fd8dde8e8eefdecada6aa0889666556cfceb690d06e0c3bca49eb3070a63
# ddgs：skill docs-lookup 首选的搜索命令行（PyPI 上的包，uv 按这个版本号装）
DDGS_VERSION=9.16.0

# ── 端口：全部只绑本机，和旧系统的开发版 Temporal（7233/8233 与一批临时端口）错开。改了同步 docs/ops.md ──
PG_PORT=5432
TEMPORAL_FRONTEND_PORT=7243
TEMPORAL_FRONTEND_MEMBERSHIP_PORT=6943
TEMPORAL_HISTORY_PORT=7244
TEMPORAL_HISTORY_MEMBERSHIP_PORT=6944
TEMPORAL_MATCHING_PORT=7245
TEMPORAL_MATCHING_MEMBERSHIP_PORT=6945
TEMPORAL_WORKER_PORT=7249
TEMPORAL_WORKER_MEMBERSHIP_PORT=6949
TEMPORAL_PORTS=("$TEMPORAL_FRONTEND_PORT" "$TEMPORAL_FRONTEND_MEMBERSHIP_PORT" "$TEMPORAL_HISTORY_PORT"
  "$TEMPORAL_HISTORY_MEMBERSHIP_PORT" "$TEMPORAL_MATCHING_PORT" "$TEMPORAL_MATCHING_MEMBERSHIP_PORT"
  "$TEMPORAL_WORKER_PORT" "$TEMPORAL_WORKER_MEMBERSHIP_PORT")

NAMESPACE=fleet
RETENTION_HOURS=720 # 30 天；Temporal 默认只留 24 小时，过后网页上查不到时间线

WG_IF=wg-fleet
WG_ADDR=10.99.0.2/24
WG_HK_ADDR=10.99.0.1
# 驾驶舱后端在隧道地址上的端口（packages/api 的 FLEET_COCKPIT_LISTEN）：只对香港开，只在隧道网卡上开
API_PORT=8787
# 本机上只许 root 和 fleet 连的端口：Temporal 没开认证，库和驾驶舱后端也不该让会话直接碰（nft 表 inet fleet_dao）
PROTECTED_PORTS=("$PG_PORT" "${TEMPORAL_PORTS[@]}" "$API_PORT")
NFT_FILE=/etc/fleet-dao/nftables.nft
# AI 会话跑在两个专用用户下，各挂一个 reclaude 组织、永不切号（独享、拼车）；引擎（fleet）经 sudo 只能调 fleet-agent-scope 起会话。
# 会话用户：没有 sudo、不能提权、家目录干净、没有 GitHub 凭据、读不到 /etc/fleet-dao。旧系统的会话用户不用、不碰。
SESSION_USERS=(fleet-agent-dedicated fleet-agent-carpool)
# 创始人的登录用户：经 Mirasim 的 ssh 远程模式登进来干活。没有 sudo、只在自己的组和 systemd-journal 里，
# 家里只放 reclaude 二进制、不放任何凭据（lib/login-user.sh）。它改得了的 root 执行文件一样要清零，所以也算写入身份
PILOT_USER=pilot
PILOT_HOME=/home/pilot
WRITER_IDENTITIES=(fleet "${SESSION_USERS[@]}" "$PILOT_USER")
# 各家 AI 的全局说明（仓根 AGENTS.md 的通用段）和方法类 skill（agents/skills/）写进这几个用户家里：
# 同步脚本以各用户自己的身份写（文件归他们），只动标记圈起来的那一块和它清单里记着的 skill（docs/ops.md 第五节）
AGENT_RULES_USERS=("${SESSION_USERS[@]}" "$PILOT_USER")
AGENTS_SYNC=$DEPLOY_DIR/../packages/agents-sync/bin/agents-sync
AGENT_SCOPE_BIN=/usr/local/sbin/fleet-agent-scope
SUDOERS_FILE=/etc/sudoers.d/fleet-dao
ENV_FILE=/etc/fleet-dao/france.env
ENV_KEYS=(FLEET_WG_HK_ENDPOINT FLEET_WG_HK_PUBLIC_KEY)
TEMPORAL_HOME=/opt/fleet-dao/temporal
UV_HOME=/opt/fleet-dao/uv
TEMPORAL_ENV=/etc/fleet-dao/temporal.env
TEMPORAL_CONFIG=/etc/fleet-dao/temporal.yaml
PG_UNIT=postgresql@$PG_MAJOR-main.service
# 应用：每一版装在 /srv/fleet-dao-releases/<提交号>（deploy/release.sh）。本机配置从仓里的样例建一次，之后只读不写
RELEASES_DIR=/srv/fleet-dao-releases
APP_ENV_FILES=(engine api release) # /etc/fleet-dao/<名>.env ← deploy/france/<名>.env.example
# 随机密钥（文件:键:用途），首次生成后不再动。gateway-token.env 香港也要放同一份（docs/ops.md 第九节）
APP_SECRETS=("agent-token:FLEET_AGENT_TOKEN_SECRET:签 fleet 通行证（引擎签、后端验）"
  "session-secret:FLEET_SESSION_SECRET:驾驶舱登录的 Cookie"
  "gateway-token:FLEET_FEISHU_GATEWAY_TOKEN:飞书网关的通行证（香港放同一份）")
# 发布脚本往香港传驾驶舱静态文件用的钥匙（只有 root 读得到），和钉住的香港 sshd 主机钥匙
WEB_UPLOAD_KEY=/etc/fleet-dao/web-upload.key
HK_KNOWN_HOSTS=/etc/fleet-dao/hk-known-hosts
# 发布脚本发飞书网关用的钥匙（另一把）：香港把它限死成只能跑 fleet-gateway-deploy
GATEWAY_DEPLOY_KEY=/etc/fleet-dao/gateway-deploy.key

FLEET_WG_HK_ENDPOINT=""
FLEET_WG_HK_PUBLIC_KEY=""
FLEET_TEMPORAL_DB_PASSWORD=""

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
  local id ver node_major
  id=$(. /etc/os-release && echo "$ID")
  ver=$(. /etc/os-release && echo "$VERSION_ID")
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  if [[ "$id" != ubuntu ]]; then
    red "只在 Ubuntu 上验过，这台是 $id $ver"
    return 1
  fi
  if [[ "$(uname -m)" != x86_64 ]]; then
    red "Temporal 装的是 linux_amd64 包，这台是 $(uname -m)"
    return 1
  fi
  if [[ "$(stat -fc %T /sys/fs/cgroup)" != cgroup2fs ]]; then
    red "资源池要 cgroup v2，这台不是"
    return 1
  fi
  node_major=$(/usr/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || node_major=0
  if ((node_major < 22)); then
    red "要 /usr/bin/node 22 或更高（pnpm 靠它自带的 corepack），这台是「$node_major」"
    return 1
  fi
  # 早年用 systemd-run 起的同名临时单元会遮住文件单元，daemon-reload 也换不掉（审计 P10）
  if [[ "$(unit_prop fleet-temporal.service FragmentPath)" == /run/systemd/transient/* ]]; then
    red "fleet-temporal.service 是个临时单元（systemd-run 起的），先 systemctl stop 它再装"
    return 1
  fi
  ok "Ubuntu $ver（$CODENAME），x86_64，cgroup v2，node $(/usr/bin/node --version)"
}

setup_identity() {
  step "用户与目录"
  ensure_service_user fleet /home/fleet
  ensure_dir /home/fleet fleet:fleet 750
  # 代码归 root、fleet 只读：以 fleet 身份跑的 AI 会话改不了引擎自己的代码。/srv/fleet-dao 是装机脚本所在的检出，
  # 应用的各版在 /srv/fleet-dao-releases（发布脚本建，构建完才换成 root 的）
  ensure_dir /srv/fleet-dao root:root 755
  ensure_dir "$RELEASES_DIR" root:root 755
  ensure_dir /var/lib/fleet-dao fleet:fleet 750
  ensure_dir /var/log/fleet-dao fleet:fleet 750
  ensure_dir /etc/fleet-dao root:fleet 750
  # 两个 GitHub 机器人的私钥放这里（root:fleet 640，手放，不进 git）：引擎读得到，会话用户和旧系统的用户读不到
  ensure_dir /etc/fleet-dao/github root:fleet 750
  ensure_dir /opt/fleet-dao root:root 755
  local u
  for u in "${SESSION_USERS[@]}"; do
    ensure_service_user "$u" "/home/$u"
    ensure_dir "/home/$u" "$u:$u" 750
  done
  if [[ -e "$ENV_FILE" ]]; then
    fix_meta "$ENV_FILE" root:fleet 640
  else
    put_file "$ENV_FILE" root:fleet 640 "$(<"$DEPLOY_DIR/france/france.env.example")"
  fi
}

setup_pilot() {
  step "创始人的登录用户 $PILOT_USER（经 Mirasim 的 ssh 远程模式登进来；没有 sudo，看得了日志）"
  # Mirasim 桌面端连进来时在它家里自己装服务端（~/.mirasim-remote，自带 node）：这头要 curl 直接下服务端包
  # （下不了由桌面端经 scp 传）、tar 和 gzip 解包（Ubuntu 必装的包）；干活要 git 和 ssh 客户端
  ensure_pkgs git openssh-client curl
  setup_login_user "$PILOT_USER" "$PILOT_HOME" "https://dl.reclaude.ai/$RECLAUDE_VERSION/reclaude-linux-amd64" "$RECLAUDE_SHA256"
}

load_config() {
  load_env "$ENV_FILE" "${ENV_KEYS[@]}"
  if [[ -f "$TEMPORAL_ENV" ]]; then load_env "$TEMPORAL_ENV" FLEET_TEMPORAL_DB_PASSWORD; fi
  ok "本机配置 $ENV_FILE：香港地址$(filled "$FLEET_WG_HK_ENDPOINT")，香港公钥$(filled "$FLEET_WG_HK_PUBLIC_KEY")"
}

setup_packages() {
  step "装包（PostgreSQL 用 Ubuntu 自带的源，吃得到自动安全更新）"
  # 早先的版本加过 PostgreSQL 的 PGDG 源：撤掉。已经从 PGDG 装上的包不会因此变，读回会查出来
  local removed=0
  remove_legacy /etc/apt/sources.list.d/pgdg.sources "早先加的 PGDG 源"
  removed=$((removed || WROTE))
  remove_legacy /etc/apt/keyrings/pgdg.asc "早先加的 PGDG 签名公钥"
  removed=$((removed || WROTE))
  if ((removed)); then APT_UPDATED=0; fi
  # rsync、openssh-client：发布脚本经隧道往香港传驾驶舱静态文件
  ensure_pkgs "postgresql-$PG_MAJOR" wireguard-tools nftables rsync openssh-client
}

setup_wireguard() {
  step "WireGuard 客户端（法国主动连香港，不开入站端口）"
  local key_changed conf
  ensure_dir /etc/wireguard root:root 700
  ensure_wg_key "$WG_IF"
  key_changed=$WROTE
  echo "  法国公钥：$WG_PUBLIC_KEY（填进香港 /etc/fleet-dao/hk.env 的 FLEET_WG_FRANCE_PUBLIC_KEY）"
  if [[ -z "$FLEET_WG_HK_PUBLIC_KEY" || -z "$FLEET_WG_HK_ENDPOINT" ]]; then
    # 读回那一步会记「待配」
    echo "  缺香港的公钥或地址（$ENV_FILE），隧道先不起"
    return 0
  fi
  if ! valid_wg_key "$FLEET_WG_HK_PUBLIC_KEY"; then
    red "$ENV_FILE 的 FLEET_WG_HK_PUBLIC_KEY 不像 WireGuard 公钥（应为 44 个字符、以 = 结尾）"
    return 1
  fi
  if [[ ! "$FLEET_WG_HK_ENDPOINT" =~ ^[A-Za-z0-9.-]+:[0-9]{1,5}$ ]]; then
    red "$ENV_FILE 的 FLEET_WG_HK_ENDPOINT 应为 <地址>:<端口>"
    return 1
  fi
  conf="# fleet-dao 两机隧道，法国这头（客户端）。deploy/france.sh 生成，别手改；私钥在 /etc/wireguard/$WG_IF.key。
# 只有出站：法国主动连香港，每 25 秒发一次保活，香港回来的包走的是这条连接，法国不用开任何入站端口。
[Interface]
Address = $WG_ADDR
PostUp = wg set %i private-key /etc/wireguard/%i.key

[Peer]
# 香港
PublicKey = $FLEET_WG_HK_PUBLIC_KEY
Endpoint = $FLEET_WG_HK_ENDPOINT
AllowedIPs = $WG_HK_ADDR/32
PersistentKeepalive = 25"
  put_file "/etc/wireguard/$WG_IF.conf" root:root 600 "$conf"
  ensure_unit_running "wg-quick@$WG_IF.service" $((key_changed || WROTE))
}

# 以 postgres 超级用户跑 psql。先 cd /：postgres 进不了 root 的家目录，会多打一行警告
pg_admin() { (cd / && runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -tA "$@"); }

temporal_login_ok() {
  env -i PATH=/usr/bin:/bin PGPASSWORD="$FLEET_TEMPORAL_DB_PASSWORD" PGCONNECT_TIMEOUT=5 \
    psql -X -q -h 127.0.0.1 -p "$PG_PORT" -U temporal -d temporal -tAc 'select 1' >/dev/null 2>&1
}

setup_postgres() {
  step "PostgreSQL $PG_MAJOR"
  local conf_dir=/etc/postgresql/$PG_MAJOR/main port restart unit_changed=0 i role db owner
  # 集群平时由装包顺手建好；包是后换的（比如从别的源换回来）时可能没有，补上
  if [[ -z "$(pg_lsclusters -h | awk -v v="$PG_MAJOR" '$1 == v && $2 == "main"')" ]]; then
    pg_createcluster "$PG_MAJOR" main >/dev/null
    changed "建集群 $PG_MAJOR/main"
  fi
  port=$(pg_lsclusters -h | awk -v v="$PG_MAJOR" '$1 == v && $2 == "main" { print $3 }')
  if [[ "$port" != "$PG_PORT" ]]; then
    red "集群 $PG_MAJOR/main 的端口是「$port」，不是 $PG_PORT"
    return 1
  fi
  put_file "$conf_dir/conf.d/fleet.conf" root:root 644 "# deploy/france.sh 写的：只听本机（法国不对外开端口，隧道那头也没人要直连库）。改了要重启库。
listen_addresses = 'localhost'"
  restart=$WROTE
  ensure_dir "/etc/systemd/system/$PG_UNIT.d" root:root 755
  # 装包自带的集群单元是 Restart=no：进程没了就一直躺着。always 连干净退出也拉起来（审计 P06）
  put_file "/etc/systemd/system/$PG_UNIT.d/fleet.conf" root:root 644 "# deploy/france.sh 写的：库的进程没了（崩了、被杀了、干净退出了）都拉起来。
[Service]
Restart=always
RestartSec=5"
  unit_changed=$WROTE
  # 早先的版本让库排在隧道之后起：wg-quick 起动没有超时，会把库一起拖住，而隧道上也没人连库
  remove_legacy "/etc/systemd/system/$PG_UNIT.d/fleet-wireguard.conf" "早先让库等隧道的 drop-in"
  unit_changed=$((unit_changed || WROTE))
  if ((unit_changed)); then systemctl daemon-reload; fi
  # 集群单元由 postgresql.service 按 Debian 的方式拉起（装包时已启用），这里只管它在跑
  if [[ "$(systemctl is-active "$PG_UNIT" 2>/dev/null)" != active ]]; then
    systemctl start "$PG_UNIT"
    changed "启动 $PG_UNIT"
  elif ((restart)); then
    systemctl restart "$PG_UNIT"
    changed "重启 $PG_UNIT（监听地址变了）"
  fi
  for ((i = 0; i < 30; i++)); do
    if pg_isready -q -h 127.0.0.1 -p "$PG_PORT"; then break; fi
    sleep 1
  done
  if ! pg_isready -q -h 127.0.0.1 -p "$PG_PORT"; then
    red "库 30 秒还没就绪：journalctl -u $PG_UNIT -n 50"
    return 1
  fi

  # 口令只在 root 和 fleet 读得到的文件里；首次生成，之后不再动
  if [[ ! -s "$TEMPORAL_ENV" ]]; then
    put_file "$TEMPORAL_ENV" root:fleet 640 "# Temporal 连库的口令：deploy/france.sh 首次生成，之后不再动。
FLEET_TEMPORAL_DB_PASSWORD=$(openssl rand -hex 24)"
  else
    fix_meta "$TEMPORAL_ENV" root:fleet 640
  fi
  load_env "$TEMPORAL_ENV" FLEET_TEMPORAL_DB_PASSWORD
  if [[ ! "$FLEET_TEMPORAL_DB_PASSWORD" =~ ^[0-9a-f]{48}$ ]]; then
    red "$TEMPORAL_ENV 里的 FLEET_TEMPORAL_DB_PASSWORD 不是装机脚本生成的样子"
    return 1
  fi

  # 角色：fleet 走本机 socket 的 peer 认证（操作系统用户 fleet = 库角色 fleet），不设口令；temporal 走 127.0.0.1 + 口令
  for role in fleet temporal; do
    if [[ "$(pg_admin -c "select 1 from pg_roles where rolname = '$role'")" != 1 ]]; then
      pg_admin -c "create role $role login"
      changed "建库角色 $role"
    fi
  done
  for db in fleet:fleet temporal:temporal temporal_visibility:temporal; do
    owner=${db#*:}
    db=${db%%:*}
    if [[ "$(pg_admin -c "select 1 from pg_database where datname = '$db'")" != 1 ]]; then
      pg_admin -c "create database $db owner $owner"
      changed "建库 $db（属主 $owner）"
    fi
    if [[ "$(pg_admin -c "select pg_get_userbyid(datdba) from pg_database where datname = '$db'")" != "$owner" ]]; then
      red "库 $db 的属主不是 $owner——不是装机脚本建的？停下等人看"
      return 1
    fi
  done
  if ! temporal_login_ok; then
    # 口令走标准输入，不进任何进程的命令行
    printf "alter role temporal with login password '%s';\n" "$FLEET_TEMPORAL_DB_PASSWORD" | pg_admin -f -
    changed "设置库角色 temporal 的口令（来自 $TEMPORAL_ENV）"
    if ! temporal_login_ok; then
      red "temporal 用口令从 127.0.0.1 还是登不上：看 $conf_dir/pg_hba.conf"
      return 1
    fi
  fi
  ok "库 fleet / temporal / temporal_visibility 与角色 fleet / temporal 就位"
}

# 下载发布包、核对 sha256、只解出要的几个文件；标记文件（.sha256）最后才写，半截安装下次会重来。
# 要的文件写它在包里的路径（可以带一层目录，比如 uv 的包），装进目录时只留文件名
fetch_release() { # 目录 下载地址 sha256 要的文件…
  local dir=$1 url=$2 sum=$3 tmp m
  shift 3
  WROTE=0
  if [[ -f "$dir/.sha256" ]] && (cd "$dir" && sha256sum --quiet --status -c .sha256); then
    ok "已装 $dir"
    return 0
  fi
  tmp=$(mktemp -d /var/tmp/fleet-dao-download.XXXXXX)
  if ! curl -fsSL --retry 3 --max-time 900 -o "$tmp/pkg.tgz" "$url"; then
    rm -rf -- "$tmp"
    red "下载失败：$url"
    return 1
  fi
  if ! printf '%s  %s\n' "$sum" "$tmp/pkg.tgz" | sha256sum --quiet --status -c -; then
    rm -rf -- "$tmp"
    red "sha256 对不上，不装：$url"
    return 1
  fi
  tar -xzf "$tmp/pkg.tgz" -C "$tmp" "$@"
  install -d -o root -g root -m 755 "$dir"
  for m in "$@"; do install -o root -g root -m 755 "$tmp/$m" "$dir/${m##*/}"; done
  (cd "$dir" && sha256sum "${@##*/}" >.sha256)
  rm -rf -- "$tmp"
  changed "装 ${url##*/}（sha256 已核对）到 $dir"
}

sql_tool() {
  env -i PATH=/usr/bin:/bin SQL_PASSWORD="$FLEET_TEMPORAL_DB_PASSWORD" "$TEMPORAL_HOME/bin/temporal-sql-tool" \
    --plugin postgres12 --ep 127.0.0.1 -p "$PG_PORT" -u temporal "$@"
}

schema_version() { pg_admin -d "$1" -c 'select curr_version from schema_version' 2>/dev/null || true; }

# 运维命令行（只连 fleet-dao 这套）。不带调用者的环境，免得 HOME 里的配置或残留的 TEMPORAL_* 变量掺进来
tcli() { env -i HOME=/root PATH=/usr/bin:/bin /usr/local/bin/fleet-temporal "$@"; }

json_get() { # JSON 点分路径
  printf '%s' "$1" | /usr/bin/node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v; try { v = JSON.parse(s); } catch { return; }
      for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
      if (v !== undefined) process.stdout.write(String(v));
    });' "$2"
}

setup_temporal() {
  step "Temporal 服务端 $TEMPORAL_SERVER_VERSION（前端 127.0.0.1:$TEMPORAL_FRONTEND_PORT）"
  local restart=0 db name before after log pids main port i desc ttl want
  ensure_dir "$TEMPORAL_HOME" root:root 755
  ensure_dir "$TEMPORAL_HOME/bin" root:root 755
  fetch_release "$TEMPORAL_HOME/server-$TEMPORAL_SERVER_VERSION" \
    "https://github.com/temporalio/temporal/releases/download/v$TEMPORAL_SERVER_VERSION/temporal_${TEMPORAL_SERVER_VERSION}_linux_amd64.tar.gz" \
    "$TEMPORAL_SERVER_SHA256" temporal-server temporal-sql-tool
  fetch_release "$TEMPORAL_HOME/cli-$TEMPORAL_CLI_VERSION" \
    "https://github.com/temporalio/cli/releases/download/v$TEMPORAL_CLI_VERSION/temporal_cli_${TEMPORAL_CLI_VERSION}_linux_amd64.tar.gz" \
    "$TEMPORAL_CLI_SHA256" temporal
  ensure_symlink "$TEMPORAL_HOME/bin/temporal-server" "../server-$TEMPORAL_SERVER_VERSION/temporal-server"
  restart=$((restart || WROTE))
  ensure_symlink "$TEMPORAL_HOME/bin/temporal-sql-tool" "../server-$TEMPORAL_SERVER_VERSION/temporal-sql-tool"
  ensure_symlink "$TEMPORAL_HOME/bin/temporal" "../cli-$TEMPORAL_CLI_VERSION/temporal"
  render "$DEPLOY_DIR/france/fleet-temporal-cli.sh" FRONTEND_PORT="$TEMPORAL_FRONTEND_PORT"
  put_file /usr/local/bin/fleet-temporal root:root 755 "$RENDERED"

  # 表结构：没有版本表就先建，再升到这个版本自带的最新；前后版本号一样就是没动
  for db in temporal temporal_visibility; do
    name=postgresql/v12/temporal
    if [[ "$db" == temporal_visibility ]]; then name=postgresql/v12/visibility; fi
    before=$(schema_version "$db")
    log=$(mktemp)
    if [[ -z "$before" ]] && ! sql_tool --db "$db" setup-schema -v 0.0 >"$log" 2>&1; then
      red "给库 $db 建版本表失败：$(tail -3 "$log" | tr '\n' ' ')"
      rm -f -- "$log"
      return 1
    fi
    if ! sql_tool --db "$db" update-schema --schema-name "$name" >"$log" 2>&1; then
      red "升级库 $db 的表结构失败：$(tail -3 "$log" | tr '\n' ' ')"
      rm -f -- "$log"
      return 1
    fi
    rm -f -- "$log"
    after=$(schema_version "$db")
    if [[ "$before" == "$after" ]]; then
      ok "库 $db 表结构版本 $after"
    else
      changed "库 $db 表结构 ${before:-（空）} → $after"
    fi
  done

  render "$DEPLOY_DIR/france/temporal.yaml" PG_PORT="$PG_PORT" \
    FRONTEND_PORT="$TEMPORAL_FRONTEND_PORT" FRONTEND_MEMBERSHIP_PORT="$TEMPORAL_FRONTEND_MEMBERSHIP_PORT" \
    HISTORY_PORT="$TEMPORAL_HISTORY_PORT" HISTORY_MEMBERSHIP_PORT="$TEMPORAL_HISTORY_MEMBERSHIP_PORT" \
    MATCHING_PORT="$TEMPORAL_MATCHING_PORT" MATCHING_MEMBERSHIP_PORT="$TEMPORAL_MATCHING_MEMBERSHIP_PORT" \
    WORKER_PORT="$TEMPORAL_WORKER_PORT" WORKER_MEMBERSHIP_PORT="$TEMPORAL_WORKER_MEMBERSHIP_PORT"
  put_file "$TEMPORAL_CONFIG" root:fleet 640 "$RENDERED"
  restart=$((restart || WROTE))
  put_file /etc/systemd/system/fleet-temporal.service root:root 644 "$(<"$DEPLOY_DIR/france/fleet-temporal.service")"
  if ((WROTE)); then
    systemctl daemon-reload
    restart=1
  fi

  # 端口先查清：没人占，或者占着的正是我们自己的服务端（审计 P10：被占了要说出是谁）
  main=$(unit_prop fleet-temporal.service MainPID)
  for port in "${TEMPORAL_PORTS[@]}"; do
    pids=$(port_pids tcp "$port")
    if [[ -n "$pids" && " $pids" != *" $main "* ]]; then
      red "端口 $port 被别的进程占着：$(ps -o pid=,user=,comm= -p "${pids// /,}" 2>/dev/null | tr -s ' ' | tr '\n' ';')"
      return 1
    fi
  done
  ensure_unit_running fleet-temporal.service "$restart"

  # 服务端刚起来时前端要一会儿才就绪：有界地等，等不到不当成功（审计 P09）
  for ((i = 0; i < 60; i++)); do
    if [[ "$(tcli operator cluster health 2>/dev/null)" == *SERVING* ]]; then break; fi
    sleep 1
  done
  if [[ "$(tcli operator cluster health 2>/dev/null)" != *SERVING* ]]; then
    red "Temporal 前端 60 秒还没就绪：journalctl -u fleet-temporal -n 80"
    return 1
  fi

  # 命名空间 fleet，已结束的工作流保留 30 天（默认只有 24 小时）
  want="$((RETENTION_HOURS * 3600))s"
  desc=$(tcli operator namespace describe --namespace "$NAMESPACE" -o json 2>/dev/null) || desc=""
  if [[ -z "$desc" ]]; then
    tcli operator namespace create --namespace "$NAMESPACE" --retention "${RETENTION_HOURS}h" >/dev/null
    changed "建命名空间 $NAMESPACE（已结束的工作流保留 ${RETENTION_HOURS} 小时）"
    # 新命名空间要等服务端的缓存刷新才查得到
    for ((i = 0; i < 30; i++)); do
      desc=$(tcli operator namespace describe --namespace "$NAMESPACE" -o json 2>/dev/null) || desc=""
      if [[ -n "$desc" ]]; then break; fi
      sleep 1
    done
  fi
  ttl=$(json_get "$desc" config.workflowExecutionRetentionTtl)
  if [[ "$ttl" != "$want" ]]; then
    tcli operator namespace update --namespace "$NAMESPACE" --retention "${RETENTION_HOURS}h" >/dev/null
    changed "命名空间 $NAMESPACE 的保留期「${ttl:-读不到}」→ $want"
  fi
}

setup_slice() {
  step "AI 会话资源池 fleet-agents.slice（池子只记账；每个会话的上限由引擎起会话时给）"
  put_file /etc/systemd/system/fleet-agents.slice root:root 644 "$(<"$DEPLOY_DIR/france/fleet-agents.slice")"
  if ((WROTE)); then systemctl daemon-reload; fi
  ensure_unit_running fleet-agents.slice 0
  # 引擎（fleet）自己建不了系统级 scope，会话还得换成会话用户：给它一个只做这件事的 root 脚本，sudoers 只放行这一个。
  # polkit 管不窄——systemd 255 建临时单元时不把单元名交给 polkit，放行就等于放行任何单元、任何身份。
  put_file "$AGENT_SCOPE_BIN" root:root 755 "$(<"$DEPLOY_DIR/france/fleet-agent-scope.sh")"
  local tmp
  tmp=$(mktemp)
  cp -- "$DEPLOY_DIR/france/sudoers-fleet-dao" "$tmp"
  # sudoers 写坏了会把 sudo 整个弄瘫：先单独验这一份，过了才放进去
  if ! visudo -cqf "$tmp" >/dev/null 2>&1; then
    rm -f -- "$tmp"
    red "deploy/france/sudoers-fleet-dao 过不了 visudo -c，不装"
    return 1
  fi
  rm -f -- "$tmp"
  put_file "$SUDOERS_FILE" root:root 440 "$(<"$DEPLOY_DIR/france/sudoers-fleet-dao")"
  if ! visudo -cq >/dev/null 2>&1; then
    rm -f -- "$SUDOERS_FILE"
    red "放进 $SUDOERS_FILE 之后整套 sudoers 验不过，已撤回"
    return 1
  fi
}

setup_firewall() {
  step "防火墙（隧道上放行香港访问驾驶舱后端；本机上 Temporal、库、后端只许 root 和 fleet 连）"
  # 驾驶舱后端的端口只对隧道那头的香港开：规则挂在隧道网卡上，公网照旧一个入站端口都不开
  local rule="allow in on $WG_IF from $WG_HK_ADDR to ${WG_ADDR%/*} port $API_PORT proto tcp" ports tmp err file_changed unit_changed
  if command -v ufw >/dev/null && [[ "$(ufw status 2>/dev/null | head -1)" == "Status: active" ]]; then
    if [[ "$(ufw show added 2>/dev/null)" == *"ufw $rule"* ]]; then
      ok "ufw 已有：$rule"
    else
      # shellcheck disable=SC2086 # 规则按词拆开传给 ufw
      ufw $rule comment 'fleet-dao cockpit api over wireguard' >/dev/null
      changed "ufw $rule"
    fi
  else
    ok "这台没开 ufw，隧道上不用另外放行"
  fi
  # 本机上谁能连 Temporal、库、驾驶舱后端：只许 root 和 fleet（按连接发起方的属主）。会话用户连上去就被复位
  ports=$(printf '%s, ' "${PROTECTED_PORTS[@]}")
  render "$DEPLOY_DIR/france/fleet-dao.nft" PORTS="${ports%, }" FLEET_UID="$(id -u fleet)"
  tmp=$(mktemp)
  printf '%s\n' "$RENDERED" >"$tmp"
  # 规则写错了载不进去：先验这一份，过了才放上去
  if ! err=$(nft -c -f "$tmp" 2>&1); then
    rm -f -- "$tmp"
    red "deploy/france/fleet-dao.nft 渲染后过不了 nft -c：$(head -3 <<<"$err" | tr '\n' ' ')"
    return 1
  fi
  rm -f -- "$tmp"
  put_file "$NFT_FILE" root:fleet 640 "$RENDERED"
  file_changed=$WROTE
  put_file /etc/systemd/system/fleet-firewall.service root:root 644 "$(<"$DEPLOY_DIR/france/fleet-firewall.service")"
  unit_changed=$WROTE
  if ((unit_changed)); then systemctl daemon-reload; fi
  if [[ "$(systemctl is-active fleet-firewall.service 2>/dev/null)" == active ]] && ((file_changed || unit_changed)); then
    # 表是在一个事务里删了重建的，reload 不会有空窗；restart 会先删表，中间有一小段谁都能连
    systemctl reload fleet-firewall.service
    changed "重载 fleet-firewall（nft 表换成新规则）"
  fi
  ensure_unit_running fleet-firewall.service 0
}

pnpm_want() { /usr/bin/node -p 'require(process.argv[1]).packageManager' "$DEPLOY_DIR/../package.json"; }
pnpm_have() { as_user fleet env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version 2>/dev/null || true; }

setup_pnpm() {
  local want ver
  want=$(pnpm_want)
  ver=${want#pnpm@}
  step "pnpm $ver（fleet 用户，corepack）"
  if [[ ! "$want" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    red "仓根 package.json 的 packageManager 是「$want」，认不出 pnpm 版本"
    return 1
  fi
  if [[ "$(pnpm_have)" == "$ver" ]]; then
    ok "fleet 用户的 pnpm 是 $ver"
    return 0
  fi
  # 垫片装在 fleet 自己的 ~/.local/bin，不动 /usr/bin：旧系统的用户看不到这个 pnpm。写家目录的事都以 fleet 身份做（审计 P01）
  as_user fleet mkdir -p /home/fleet/.local/bin
  as_user fleet corepack enable --install-directory /home/fleet/.local/bin pnpm
  as_user fleet env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack install -g "$want" >/dev/null
  if [[ "$(pnpm_have)" != "$ver" ]]; then
    red "装完 fleet 用户的 pnpm 还不是 $ver（读到「$(pnpm_have)」）"
    return 1
  fi
  changed "fleet 用户装 pnpm $ver（corepack，垫片在 /home/fleet/.local/bin）"
}

setup_app_config() {
  step "应用的本机配置（/etc/fleet-dao 下的环境文件；应用本身由 deploy/release.sh 发布）"
  local name spec file key what
  # 样例只在第一次照着建：之后这些文件归人改（填飞书、GitHub 的凭据，选本机起哪些服务），脚本只管属主和权限
  for name in "${APP_ENV_FILES[@]}"; do
    file=/etc/fleet-dao/$name.env
    if [[ -e "$file" ]]; then
      fix_meta "$file" root:fleet 640
    else
      put_file "$file" root:fleet 640 "$(<"$DEPLOY_DIR/france/$name.env.example")"
    fi
  done
  # 随机密钥：首次生成，之后不再动（换了会让已发出的登录、通行证全部作废；真要换就删掉文件再跑）。值不进日志
  for spec in "${APP_SECRETS[@]}"; do
    IFS=: read -r name key what <<<"$spec"
    file=/etc/fleet-dao/$name.env
    if [[ -s "$file" ]]; then
      fix_meta "$file" root:fleet 640
    else
      put_file "$file" root:fleet 640 "# $what。deploy/france.sh 首次生成的随机值，之后不再动；不进 git，别打印。
$key=$(openssl rand -hex 32)"
    fi
  done
}

# 发布脚本登香港用的钥匙：没有就生成（只有 root 读得到），打印公钥给香港登记。公钥随时能从私钥导出，不另存一份
ensure_deploy_key() { # 私钥文件 注释 香港 hk.env 里的键 用途
  if [[ ! -s "$1" ]]; then
    rm -f -- "$1" "$1.pub"
    ssh-keygen -q -t ed25519 -N '' -C "$2" -f "$1" >/dev/null
    rm -f -- "$1.pub"
    changed "生成$4的钥匙 $1"
  fi
  fix_meta "$1" root:root 600
  echo "  $4的公钥：$(ssh-keygen -y -f "$1")（整行填进香港 /etc/fleet-dao/hk.env 的 $3）"
}

setup_web_upload() {
  step "发布脚本登香港用的钥匙（香港只许它们经隧道来：一把只能往 /srv/fleet-dao-web 写，一把只能发飞书网关）"
  local line re
  ensure_deploy_key "$WEB_UPLOAD_KEY" fleet-dao-web-upload FLEET_WEB_UPLOAD_PUBLIC_KEY 传静态文件
  ensure_deploy_key "$GATEWAY_DEPLOY_KEY" fleet-dao-gateway-deploy FLEET_GATEWAY_DEPLOY_PUBLIC_KEY 发飞书网关
  # 香港 sshd 的主机钥匙：经隧道取（隧道两头靠 WireGuard 钥匙互认，那头只可能是香港），钉住之后只认这一把
  if [[ -s "$HK_KNOWN_HOSTS" ]]; then
    fix_meta "$HK_KNOWN_HOSTS" root:root 600
    return 0
  fi
  if ! ping -c 1 -W 2 -q "$WG_HK_ADDR" >/dev/null 2>&1; then
    # 读回那一步会记「待配」
    echo "  隧道还没通，香港 sshd 的主机钥匙等隧道通了再取"
    return 0
  fi
  line=$(ssh-keyscan -T 5 -t ed25519 "$WG_HK_ADDR" 2>/dev/null) || line=""
  re="^${WG_HK_ADDR//./\\.} ssh-ed25519 [A-Za-z0-9+/]+=*$"
  if [[ ! "$line" =~ $re ]]; then
    red "经隧道取不到香港 sshd 的主机钥匙（读到「${line:0:80}」）"
    return 1
  fi
  put_file "$HK_KNOWN_HOSTS" root:root 600 "# 香港 sshd 的主机钥匙：deploy/france.sh 经隧道取的。发布脚本往香港传静态文件时只认这一把；香港真换了主机钥匙就删掉本文件重跑。
$line"
}

# 跑一遍同步脚本（packages/agents-sync），把它逐行的结论接进本脚本的账：↻ 改了、✗ 红、… 没查成、✓ 对、· 没装跳过。
# 它以 --user 换成那个用户再动手，写出来的东西归那个用户。
# 写（--apply）的时候只记「改了」，✗ 和 … 照打不记账：读回那一步的 --check 会把同一件事再判一次，记两遍就重了
agents_sync() { # 模式 用户
  local mode=$1 u=$2 out rc=0 line said=0
  out=$(/usr/bin/node "$AGENTS_SYNC" "$mode" --user "$u" 2>&1) || rc=$?
  while IFS= read -r line; do
    case $line in
    '  ↻ '*) changed "$u ${line#  ↻ }" ;;
    '  ✗ '*)
      said=1
      if [[ "$mode" == --check ]]; then red "$u ${line#  ✗ }"; else printf '  ✗ %s %s\n' "$u" "${line#  ✗ }"; fi
      ;;
    '  … '*)
      said=1
      if [[ "$mode" == --check ]]; then pending "$u ${line#  … }"; else printf '  … %s %s\n' "$u" "${line#  … }"; fi
      ;;
    '  ✓ '*) ok "$u ${line#  ✓ }" ;;
    '  · '*) if [[ "$mode" == --check ]]; then printf '  · %s %s\n' "$u" "${line#  · }"; fi ;;
    esac
  done <<<"$out"
  # 退出码不是 0 却一行 ✗、… 都没给（崩了、node 起不来）：别当成没事
  if ((rc != 0 && said == 0)); then
    red "$u：同步脚本 $mode 退出 $rc，没给出逐项结论：$(tail -3 <<<"$out" | tr '\n' ' ')"
  fi
}

setup_agent_rules() {
  step "各家 AI 的全局说明与方法类 skill（${AGENT_RULES_USERS[*]}；仓根 AGENTS.md 的通用段、agents/skills/，外加 ddgs）"
  local u
  fetch_release "$UV_HOME/$UV_VERSION" \
    "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz" \
    "$UV_SHA256" uv-x86_64-unknown-linux-gnu/uv
  for u in "${AGENT_RULES_USERS[@]}"; do
    if ! id "$u" >/dev/null 2>&1; then
      pending "$u 这个用户还没有，全局说明没写（建了再跑一遍）"
      continue
    fi
    agents_sync --apply "$u"
    # skill docs-lookup 首选的搜索命令行，分发过去就得能用
    ensure_ddgs "$u" "$UV_HOME/$UV_VERSION/uv" "$DDGS_VERSION"
  done
}

readback_agent_rules() {
  local u
  for u in "${AGENT_RULES_USERS[@]}"; do
    if ! id "$u" >/dev/null 2>&1; then
      pending "$u 这个用户还没有，全局说明没查"
      continue
    fi
    agents_sync --check "$u"
    check_ddgs "$u" "$DDGS_VERSION"
  done
}

readback() {
  step "读回"
  readback_secrets_dir
  readback_dirs
  readback_postgres
  readback_temporal
  readback_slice
  readback_session_users
  readback_pilot
  readback_agent_rules
  readback_sessions
  readback_pnpm
  readback_wireguard
  readback_firewall
  readback_app_config
  readback_web_upload
  readback_proxy_headers
  readback_service_home
}

# 香港往法国转发时要清掉 Authorization 与 X-Fleet-Acting-Feishu（飞书网关的通行证和代表谁）：从公网带着这两个头
# 请求 /api，看法国收到的请求里有没有。驾驶舱后端没在跑：在隧道地址上临时起一个回显，直接看收到了哪些头，另带一个
# 探针头证明请求确实到了这里；后端在跑：看它怎么答——收到 Authorization 答 bearer_not_allowed，没收到答
# unauthenticated（packages/api 的 session.ts）
readback_proxy_headers() {
  local domain url nonce tmp pid i out code body verdict
  domain=$(read_key /etc/fleet-dao/release.env FLEET_DOMAIN 2>/dev/null) || domain=""
  if [[ ! "$domain" =~ ^[a-z0-9.-]+$ ]]; then
    pending "没读到驾驶舱域名（/etc/fleet-dao/release.env 的 FLEET_DOMAIN），香港清不清请求头这项没查"
    return 0
  fi
  url=https://$domain/api/fleet-dao-probe
  local probe=(-H 'Authorization: Bearer fleet-dao-probe' -H 'X-Fleet-Acting-Feishu: fleet-dao-probe')
  if [[ -n "$(ss -Hltn "src ${WG_ADDR%/*} and sport = :$API_PORT" 2>/dev/null)" ]]; then
    if [[ "$(systemctl is-active fleet-api.service 2>/dev/null)" != active ]]; then
      pending "${WG_ADDR%/*}:$API_PORT 被别的程序占着（不是 fleet-api），香港清不清请求头这项没查"
      return 0
    fi
    out=$(curl -sS --max-time 15 "${probe[@]}" -w '\n%{http_code}' "https://$domain/api/me" 2>&1) || out=$'\n000'
    code=${out##*$'\n'}
    body=${out%$'\n'*}
    if [[ "$code" == 401 && "$body" == *'"unauthenticated"'* ]]; then
      ok "从公网带着 Authorization、X-Fleet-Acting-Feishu 请求 /api：后端答「没登录」，没收到这两个头"
    elif [[ "$body" == *bearer_not_allowed* || "$body" == *acting_missing* ]]; then
      red "香港把 Authorization 转给了后端（后端答的是网关通行证不对）：香港 nginx 没清这个头"
    else
      pending "从公网带头请求 /api，后端的回答认不出（HTTP $code），香港清不清请求头这项没查成"
    fi
    return 0
  fi
  nonce=$(openssl rand -hex 8)
  tmp=$(mktemp)
  # setpriv 直接换身份再 exec，记下的进程号就是回显本身（runuser 会多隔一层，杀它不一定连带杀掉回显、端口会被占着）
  (cd / && exec setpriv --reuid=fleet --regid=fleet --init-groups /usr/bin/node -e '
    const [host, port] = process.argv.slice(1);
    const srv = require("node:http").createServer((req, res) => {
      const body = JSON.stringify({ headers: Object.keys(req.headers), probe: req.headers["x-fleet-probe"] ?? null });
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(body, () => process.exit(0));
    });
    srv.listen(Number(port), host);
    setTimeout(() => process.exit(3), 30000);' "${WG_ADDR%/*}" "$API_PORT") >"$tmp" 2>&1 &
  pid=$!
  for ((i = 0; i < 50; i++)); do
    if [[ -n "$(ss -Hltn "src ${WG_ADDR%/*} and sport = :$API_PORT" 2>/dev/null)" ]]; then break; fi
    sleep 0.1
  done
  out=$(curl -sS --max-time 15 "${probe[@]}" -H "X-Fleet-Probe: $nonce" "$url" 2>&1) || out=""
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f -- "$tmp"
  # shellcheck disable=SC2016 # 单引号里是给 node 的 JS，模板字符串不归 shell 展开
  verdict=$(printf '%s' "$out" | /usr/bin/node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let r; try { r = JSON.parse(s); } catch { return console.log("unreadable"); }
      if (r.probe !== process.argv[1]) return console.log("no-probe");
      const leaked = (r.headers || []).filter((h) => h === "authorization" || h === "x-fleet-acting-feishu");
      console.log(leaked.length ? `leaked ${leaked.join(",")}` : "clean");
    });' "$nonce")
  case $verdict in
  clean) ok "从公网带着 Authorization、X-Fleet-Acting-Feishu 请求 /api：法国收到的请求里没有这两个头（探针头到了，临时回显已收）" ;;
  leaked*) red "香港把 ${verdict#leaked } 转到了法国：香港 nginx 没清这个头" ;;
  *) pending "从公网请求 $url 没走到法国的临时回显（读到「${out:0:120}」），香港清不清请求头这项没查成" ;;
  esac
}

# 应用的环境文件都在、属主权限对；随机密钥是生成的样子、互不相同（后端要求）。只比对，不打印值
readback_app_config() {
  local name spec file key what bad=0 values=() v
  for name in "${APP_ENV_FILES[@]}"; do
    if [[ ! -f "/etc/fleet-dao/$name.env" ]]; then
      red "没有 /etc/fleet-dao/$name.env"
      bad=1
    fi
  done
  for spec in "${APP_SECRETS[@]}"; do
    IFS=: read -r name key what <<<"$spec"
    file=/etc/fleet-dao/$name.env
    v=$(read_key "$file" "$key" 2>/dev/null) || v=""
    if [[ ! "$v" =~ ^[0-9a-f]{64}$ ]]; then
      red "$file 里的 $key 不是装机脚本生成的样子（64 位十六进制）"
      bad=1
    fi
    values+=("$v")
  done
  if [[ "${values[0]}" == "${values[1]}" || "${values[0]}" == "${values[2]}" || "${values[1]}" == "${values[2]}" ]]; then
    red "三个随机密钥有两个一样：后端会拒绝启动"
    bad=1
  fi
  if ((bad == 0)); then ok "应用的环境文件都在（${APP_ENV_FILES[*]}），三个随机密钥已生成、互不相同（值不打印）"; fi
}

# 只当数据读一个键（不 source）：值只进变量，不进日志
read_key() { # 文件 键
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$2="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$1"
}

# 往香港传静态文件的通路：用发布脚本同一套参数试跑一次 rsync（-n，什么都不传）
readback_web_upload() {
  local empty rc=0 out
  if [[ ! -s "$WEB_UPLOAD_KEY" ]]; then
    red "没有上传钥匙 $WEB_UPLOAD_KEY"
    return 0
  fi
  if [[ ! -s "$HK_KNOWN_HOSTS" ]]; then
    pending "还没钉住香港 sshd 的主机钥匙（隧道通了再跑一遍 france.sh）"
    return 0
  fi
  empty=$(mktemp -d)
  out=$(rsync -n -r -e "$(web_upload_ssh "$WEB_UPLOAD_KEY" "$HK_KNOWN_HOSTS")" "$empty/" "root@$WG_HK_ADDR:/" 2>&1) || rc=$?
  rmdir -- "$empty"
  if ((rc == 0)); then
    ok "法国经隧道往香港 /srv/fleet-dao-web 传文件的通路是通的（试跑，没传东西）"
  elif [[ "$out" == *"Permission denied"* ]]; then
    pending "香港还没认这把上传钥匙：把上面打印的公钥填进香港 hk.env 的 FLEET_WEB_UPLOAD_PUBLIC_KEY，重跑 hk.sh"
  else
    red "试着往香港传文件没成（rsync 退出码 $rc）：$(tail -2 <<<"$out" | tr '\n' ' ')"
  fi
  # 发网关的那把：问一次香港网关的状态（只读）
  if [[ ! -s "$GATEWAY_DEPLOY_KEY" ]]; then
    red "没有发网关用的钥匙 $GATEWAY_DEPLOY_KEY"
    return 0
  fi
  rc=0
  out=$(gateway_ssh "$GATEWAY_DEPLOY_KEY" "$HK_KNOWN_HOSTS" "root@$WG_HK_ADDR" status 2>&1) || rc=$?
  if ((rc == 0)) && [[ "$out" == *$'\n'config=* || "$out" == config=* ]]; then
    ok "法国经隧道问得到香港飞书网关的状态（fleet-gateway-deploy status）"
  elif [[ "$out" == *"Permission denied"* ]]; then
    pending "香港还没认发网关的钥匙：把上面打印的公钥填进香港 hk.env 的 FLEET_GATEWAY_DEPLOY_PUBLIC_KEY，重跑 hk.sh"
  else
    red "问香港飞书网关的状态没成（退出码 $rc）：$(tail -2 <<<"$out" | tr '\n' ' ')"
  fi
}

# 会话用户：没有 sudo、只在自己的组里、家里没有 GitHub 凭据；reclaude 登录要创始人在浏览器里点，没登录记「待配」
readback_session_users() {
  local u home bad f
  for u in "${SESSION_USERS[@]}"; do
    home=$(getent passwd "$u" | cut -d: -f6)
    bad=""
    if [[ "$(sudo -l -U "$u" 2>&1)" != *"not allowed to run sudo"* ]]; then bad+="有 sudo 条目；"; fi
    if [[ "$(id -nG "$u")" != "$u" ]]; then bad+="附加组「$(id -nG "$u")」；"; fi
    for f in .config/gh .git-credentials .netrc .ssh; do
      if [[ -e "$home/$f" ]]; then bad+="家里有 ~/$f；"; fi
    done
    if [[ -n "$bad" ]]; then
      red "$u：$bad"
    else
      ok "$u：没有 sudo、只在自己的组里、家里没有 GitHub 凭据和 ssh 钥匙"
    fi
    if [[ ! -x "$home/.local/bin/reclaude" ]]; then
      pending "$u 还没有 reclaude 二进制（~/.local/bin/reclaude）：见 docs/ops.md「会话用户登录 reclaude」"
    elif [[ ! -s "$home/.reclaude/device.json" ]]; then
      pending "$u 的 reclaude 还没登录：要创始人在浏览器里授权，见 docs/ops.md「会话用户登录 reclaude」"
    else
      ok "$u 的 reclaude 已登录"
    fi
  done
}

# 创始人的登录用户：判据在 lib/login-user.sh。reclaude 登没登录、家里放了什么钥匙是创始人自己的事，不查
readback_pilot() {
  local line
  if check_login_user "$PILOT_USER"; then
    ok "$PILOT_USER：在，家目录 750，只在自己的组和 $LOGIN_USER_LOG_GROUP 里，没有 sudo，reclaude 执行得了、登录 shell 里找得到"
    return 0
  fi
  for line in "${LOGIN_USER_BAD[@]}"; do red "$PILOT_USER：${line#*$'\t'}"; done
}

# 真起一个会话走一遍：fleet 经 sudo 调脚本 → 落进 fleet-agents.slice 下自己的 scope → 身份是会话用户、不带 root 组、
# 提不了权（NoNewPrivs=1）、上限写进了 cgroup
readback_sessions() {
  local id out want_cg user=${SESSION_USERS[0]} lines=()
  if [[ "$(sudo -l -U fleet 2>/dev/null)" == *"NOPASSWD: $AGENT_SCOPE_BIN"* ]]; then
    ok "sudoers：fleet 只能以 root 跑 $AGENT_SCOPE_BIN"
  else
    red "sudo -l -U fleet 里没有 $AGENT_SCOPE_BIN"
  fi
  REC_VIOLATIONS=()
  rec_check_path "sudo:fleet" "$AGENT_SCOPE_BIN" 程序
  if ((${#REC_VIOLATIONS[@]})); then red "${REC_VIOLATIONS[0]//$'\t'/ | }"; fi
  id=readback-$$
  want_cg="0::/fleet.slice/fleet-agents.slice/fleet-agent-$id.scope"
  # shellcheck disable=SC2016 # 单引号里的东西要在会话里展开，不是在这里
  out=$(as_user fleet /usr/bin/sudo -n "$AGENT_SCOPE_BIN" run "$id" --user "$user" --memory-max 64M --tasks-max 16 -- \
    /bin/sh -c 'id -un; id -G; cat /proc/self/cgroup; cat "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.max"; awk "/^NoNewPrivs/ { print \$2 }" /proc/self/status' 2>&1) || true
  mapfile -t lines <<<"$out"
  if [[ "${lines[0]:-}" == "$user" && " ${lines[1]:-0} " != *" 0 "* && "${lines[2]:-}" == "$want_cg" && "${lines[3]:-}" == 67108864 && "${lines[4]:-}" == 1 ]]; then
    ok "起会话走得通：fleet → sudo → $user（不带 root 组、提不了权），落在 ${want_cg#0::}，上限写进了 cgroup"
  else
    red "起会话没走通，读到：$(tr '\n' '|' <<<"$out")"
  fi
}

# 以某个用户去连本机某个端口：连上返回 0；被拒、超时都返回非 0
connect_as() { # 用户 端口
  (cd / && runuser -u "$1" -- timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$2") >/dev/null 2>&1
}

readback_firewall() {
  local rule="allow in on $WG_IF from $WG_HK_ADDR to ${WG_ADDR%/*} port $API_PORT proto tcp" u port bad=0
  if command -v ufw >/dev/null && [[ "$(ufw status 2>/dev/null | head -1)" == "Status: active" ]]; then
    if [[ "$(ufw show added 2>/dev/null)" == *"ufw $rule"* ]]; then
      ok "ufw 只在隧道网卡上给香港开了 $API_PORT"
    else
      red "ufw 里没有「$rule」：香港转过来的驾驶舱请求会被挡"
    fi
  fi
  if [[ "$(systemctl is-active fleet-firewall.service 2>/dev/null)" != active ]] || ! nft list table inet fleet_dao >/dev/null 2>&1; then
    red "nft 表 inet fleet_dao 不在：会话能直接连 Temporal 给工作流发信号"
    return 0
  fi
  # 真连一次：会话用户和登录用户 pilot 都连不上 Temporal 前端和库，fleet 连得上
  for u in "${SESSION_USERS[@]}" "$PILOT_USER"; do
    id "$u" >/dev/null 2>&1 || continue
    for port in "$TEMPORAL_FRONTEND_PORT" "$PG_PORT"; do
      if connect_as "$u" "$port"; then
        red "$u 连得上 127.0.0.1:$port"
        bad=1
      fi
    done
  done
  if ((bad == 0)); then ok "会话用户和 $PILOT_USER 都连不上 Temporal（$TEMPORAL_FRONTEND_PORT）和库（$PG_PORT）"; fi
  if connect_as fleet "$TEMPORAL_FRONTEND_PORT" && connect_as fleet "$PG_PORT"; then
    ok "fleet 连得上 Temporal 和库"
  else
    red "fleet 连不上 Temporal 或库：nft 表拦错了人"
  fi
  if [[ "$(systemctl is-enabled nftables.service 2>/dev/null)" == enabled ]]; then
    red "nftables.service 被启用了：它开机会 flush ruleset，把 ufw 的规则和这张表一起冲掉"
  fi
}

readback_dirs() {
  local spec path want have bad=0
  for spec in "/srv/fleet-dao root:root 755" "$RELEASES_DIR root:root 755" "/var/lib/fleet-dao fleet:fleet 750" "/var/log/fleet-dao fleet:fleet 750" \
    "/opt/fleet-dao root:root 755" "/home/fleet fleet:fleet 750" "$TEMPORAL_ENV root:fleet 640" "$TEMPORAL_CONFIG root:fleet 640"; do
    path=${spec%% *}
    want=${spec#* }
    have=$(stat -c '%U:%G %a' -- "$path" 2>/dev/null) || have="不存在"
    if [[ "$have" != "$want" ]]; then
      red "$path 是「$have」，应为 $want"
      bad=1
    fi
  done
  if ((bad == 0)); then ok "目录与配置文件的属主、权限都对"; fi
}

readback_postgres() {
  local listen version restart
  if [[ "$(systemctl is-active "$PG_UNIT" 2>/dev/null)" != active ]]; then
    red "$PG_UNIT 没在跑"
    return 0
  fi
  if pg_isready -q -h 127.0.0.1 -p "$PG_PORT"; then ok "库在 127.0.0.1:$PG_PORT 就绪"; else red "库在 127.0.0.1:$PG_PORT 没就绪"; fi
  listen=$(ss -Hltn "sport = :$PG_PORT" 2>/dev/null | awk '{ print $4 }' | sort | tr '\n' ' ')
  if [[ "$listen" == "127.0.0.1:$PG_PORT [::1]:$PG_PORT " ]]; then
    ok "库只听本机：$listen"
  else
    red "库在听「$listen」，应只听 127.0.0.1 和 ::1"
  fi
  restart=$(unit_prop "$PG_UNIT" Restart)
  if [[ "$restart" == always ]]; then ok "库的进程没了会被拉起（Restart=always）"; else red "$PG_UNIT 是 Restart=$restart，进程没了就一直躺着"; fi
  version=$(dpkg-query -W -f '${Version}' "postgresql-$PG_MAJOR" 2>/dev/null) || version=""
  if [[ "$version" == *pgdg* || -e /etc/apt/sources.list.d/pgdg.sources ]]; then
    red "postgresql-$PG_MAJOR $version 是从 PGDG 源装的：吃不到 Ubuntu 的自动安全更新"
  else
    ok "postgresql-$PG_MAJOR $version（Ubuntu 自带的源）"
  fi
  if temporal_login_ok; then ok "temporal 角色用口令登得上"; else red "temporal 角色用 $TEMPORAL_ENV 里的口令登不上"; fi
}

readback_temporal() {
  local main port pids bad=0 health desc ttl state
  if [[ "$(systemctl is-active fleet-temporal.service 2>/dev/null)" != active ]]; then
    red "fleet-temporal 没在跑"
    return 0
  fi
  main=$(unit_prop fleet-temporal.service MainPID)
  ok "fleet-temporal 在跑（pid $main，累计自动重启 $(unit_prop fleet-temporal.service NRestarts) 次）"
  for port in "${TEMPORAL_PORTS[@]}"; do
    pids=$(port_pids tcp "$port")
    if [[ " $pids" != *" $main "* ]]; then
      red "端口 $port 不是 fleet-temporal 在听（在听的：${pids:-没人}）"
      bad=1
    elif [[ "$(ss -Hltn "sport = :$port" | awk '{ print $4 }' | sort -u | tr '\n' ' ')" != "127.0.0.1:$port " ]]; then
      red "端口 $port 没有只绑 127.0.0.1"
      bad=1
    fi
  done
  if ((bad == 0)); then ok "端口 ${TEMPORAL_PORTS[*]} 都由它在 127.0.0.1 上听"; fi
  health=$(tcli operator cluster health 2>/dev/null) || health=""
  if [[ "$health" == *SERVING* ]]; then ok "fleet-temporal operator cluster health：SERVING"; else red "集群健康检查没过：「$health」"; fi
  desc=$(tcli operator namespace describe --namespace "$NAMESPACE" -o json 2>/dev/null) || desc=""
  ttl=$(json_get "$desc" config.workflowExecutionRetentionTtl)
  state=$(json_get "$desc" namespaceInfo.state)
  if [[ "$ttl" == "$((RETENTION_HOURS * 3600))s" ]]; then
    ok "命名空间 $NAMESPACE：$state，保留 $ttl"
  else
    red "命名空间 $NAMESPACE 读回「${state:-读不到}」，保留期「${ttl:-读不到}」，应为 $((RETENTION_HOURS * 3600))s"
  fi
}

readback_slice() {
  local props
  if [[ "$(systemctl is-active fleet-agents.slice 2>/dev/null)" != active ]]; then
    red "fleet-agents.slice 没在"
    return 0
  fi
  props=$(systemctl show fleet-agents.slice -p CPUAccounting,MemoryAccounting,TasksAccounting,IOAccounting,MemoryHigh,MemoryMax,TasksMax,CPUQuotaPerSecUSec |
    sort | tr '\n' ' ')
  if [[ "$props" == "CPUAccounting=yes CPUQuotaPerSecUSec=infinity IOAccounting=yes MemoryAccounting=yes MemoryHigh=infinity MemoryMax=infinity TasksAccounting=yes TasksMax=infinity " ]]; then
    ok "fleet-agents.slice：记账全开，没有任何上限"
  else
    red "fleet-agents.slice 的设置不是「只记账」：$props"
  fi
}

readback_pnpm() {
  local want have
  want=$(pnpm_want)
  have=$(pnpm_have)
  if [[ "$have" == "${want#pnpm@}" ]]; then ok "fleet 用户的 pnpm 是 $have"; else red "fleet 用户的 pnpm 是「$have」，应为 ${want#pnpm@}"; fi
}

readback_wireguard() {
  local latest
  if [[ -z "$FLEET_WG_HK_PUBLIC_KEY" || -z "$FLEET_WG_HK_ENDPOINT" ]]; then
    pending "WireGuard 待配：照香港 hk.sh 打印的提示，把香港公钥和 <香港公网IP>:<端口> 填进 $ENV_FILE，再跑一遍（法国公钥：$(wg pubkey <"/etc/wireguard/$WG_IF.key" 2>/dev/null || echo 读不到)）"
    return 0
  fi
  if [[ "$(systemctl is-active "wg-quick@$WG_IF.service" 2>/dev/null)" != active ]]; then
    red "wg-quick@$WG_IF 没在跑"
    return 0
  fi
  if ping -c 3 -W 2 -q "$WG_HK_ADDR" >/dev/null 2>&1; then
    ok "ping $WG_HK_ADDR（香港）通"
    return 0
  fi
  latest=$(wg show "$WG_IF" latest-handshakes 2>/dev/null | awk '{ print $2 }') || latest=""
  if [[ -z "$latest" || "$latest" == 0 ]]; then
    pending "隧道还没握上手：香港 hk.env 填了法国公钥、重跑过 hk.sh 了吗？$ENV_FILE 里的端口是 hk.sh 打印的那个吗（香港上游只放行少数 UDP 端口，见 docs/ops.md）？"
  else
    red "隧道握过手（$(($(date +%s) - latest)) 秒前），但 ping $WG_HK_ADDR 不通"
  fi
}

# 审计 P01：root 在服务用户的目录里留下的文件，之后会以各种不像权限问题的样子出错
readback_service_home() {
  local found
  # 不接 head：find 被管道截断会让整条命令算失败，结果就被当成「没找到」
  local homes=(/home/fleet /var/lib/fleet-dao /var/log/fleet-dao "$PILOT_HOME") u
  for u in "${SESSION_USERS[@]}"; do homes+=("/home/$u"); done
  found=$(find "${homes[@]}" -user root 2>/dev/null || true)
  if [[ -n "$found" ]]; then
    red "fleet、会话用户或 $PILOT_USER 的目录里有 $(wc -l <<<"$found") 个 root 属主的文件，比如：$(head -3 <<<"$found" | tr '\n' ' ')"
  else
    ok "fleet、会话用户和 $PILOT_USER 的目录里没有 root 属主的文件"
  fi
}

main() {
  local before=""
  preflight
  if ((CHECK_ONLY == 0)); then
    before=$(snapshot_others)
    setup_identity
    setup_pilot
    load_config
    setup_packages
    setup_wireguard
    setup_postgres
    setup_temporal
    setup_slice
    setup_firewall
    setup_pnpm
    setup_app_config
    setup_web_upload
    setup_agent_rules
  else
    load_config
  fi
  readback
  self_check_root_exec
  if ((CHECK_ONLY == 0)); then compare_others "$before"; fi
  finish
}

main "$@"
