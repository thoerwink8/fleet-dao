#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 法国机器装机（以 root 跑；幂等：跑第二遍什么都不变）。装的是：系统用户 fleet 与目录、PostgreSQL 16（官方 PGDG 源）、
# Temporal 服务端 1.32.0（Postgres 持久化，端口和旧系统错开）、AI 会话资源池 fleet-agents.slice（只记账）、
# fleet 用户的 pnpm（corepack）、WireGuard 客户端（主动连香港，法国不开任何入站端口）。
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
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

# ── 钉死的版本与校验和：外部二进制装上机器就进了信任面，不用 latest ──
TEMPORAL_SERVER_VERSION=1.32.0
TEMPORAL_SERVER_SHA256=ca1ccbb1d1545b68eb4523de463c51ffcd80f7e0bccd14a9b2c56fc7e389e792
TEMPORAL_CLI_VERSION=1.9.1
TEMPORAL_CLI_SHA256=09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5
PG_MAJOR=16 # Temporal 官方测过的最高大版本（13.18/14.15/15.10/16.6）
PGDG_KEY_URL=https://www.postgresql.org/media/keys/ACCC4CF8.asc
PGDG_KEY_FPR=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8

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
ENV_FILE=/etc/fleet-dao/france.env
ENV_KEYS=(FLEET_WG_HK_ENDPOINT FLEET_WG_HK_PUBLIC_KEY)
TEMPORAL_HOME=/opt/fleet-dao/temporal
TEMPORAL_ENV=/etc/fleet-dao/temporal.env
TEMPORAL_CONFIG=/etc/fleet-dao/temporal.yaml
PG_UNIT=postgresql@$PG_MAJOR-main.service

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
  # 代码归 root、fleet 只读：以 fleet 身份跑的 AI 会话改不了引擎自己的代码
  ensure_dir /srv/fleet-dao root:root 755
  ensure_dir /var/lib/fleet-dao fleet:fleet 750
  ensure_dir /var/log/fleet-dao fleet:fleet 750
  ensure_dir /etc/fleet-dao root:fleet 750
  ensure_dir /opt/fleet-dao root:root 755
  if [[ -e "$ENV_FILE" ]]; then
    fix_meta "$ENV_FILE" root:fleet 640
  else
    put_file "$ENV_FILE" root:fleet 640 "$(<"$DEPLOY_DIR/france/france.env.example")"
  fi
}

load_config() {
  load_env "$ENV_FILE" "${ENV_KEYS[@]}"
  if [[ -f "$TEMPORAL_ENV" ]]; then load_env "$TEMPORAL_ENV" FLEET_TEMPORAL_DB_PASSWORD; fi
  ok "本机配置 $ENV_FILE：香港地址 ${FLEET_WG_HK_ENDPOINT:+已填}${FLEET_WG_HK_ENDPOINT:-（未填）}，香港公钥 ${FLEET_WG_HK_PUBLIC_KEY:+已填}${FLEET_WG_HK_PUBLIC_KEY:-（未填）}"
}

# 签名公钥的指纹。用一次性的 GNUPGHOME：不在 root 家里留下 ~/.gnupg
key_fpr() {
  local home out
  home=$(mktemp -d)
  out=$(GNUPGHOME=$home gpg --batch --quiet --show-keys --with-colons "$1" 2>/dev/null) || out=""
  rm -rf -- "$home"
  awk -F: '$1 == "fpr" { print $10; exit }' <<<"$out"
}

setup_packages() {
  step "装包（PostgreSQL 官方源 + WireGuard 工具）"
  local key=/etc/apt/keyrings/pgdg.asc tmp fpr
  ensure_dir /etc/apt/keyrings root:root 755
  if [[ -f "$key" && "$(key_fpr "$key")" == "$PGDG_KEY_FPR" ]]; then
    fix_meta "$key" root:root 644
  else
    tmp=$(mktemp)
    if ! curl -fsSL --retry 3 --max-time 60 -o "$tmp" "$PGDG_KEY_URL"; then
      rm -f -- "$tmp"
      red "下载 PGDG 签名公钥失败：$PGDG_KEY_URL"
      return 1
    fi
    fpr=$(key_fpr "$tmp")
    if [[ "$fpr" != "$PGDG_KEY_FPR" ]]; then
      rm -f -- "$tmp"
      red "下载到的 PGDG 签名公钥指纹是「$fpr」，应为 $PGDG_KEY_FPR——不装"
      return 1
    fi
    put_file "$key" root:root 644 "$(<"$tmp")"
    rm -f -- "$tmp"
  fi
  put_file /etc/apt/sources.list.d/pgdg.sources root:root 644 "# PostgreSQL 官方源（PGDG），deploy/france.sh 加的；签名公钥指纹 $PGDG_KEY_FPR。
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: $CODENAME-pgdg
Components: main
Signed-By: $key"
  if ((WROTE)); then APT_UPDATED=0; fi
  ensure_pkgs "postgresql-$PG_MAJOR" wireguard-tools
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

wg_addr_up() {
  local addrs
  addrs=$(ip -4 -o addr show dev "$WG_IF" 2>/dev/null) || addrs=""
  [[ "$addrs" == *" ${WG_ADDR%/*}/"* ]]
}

pg_listening_on() { [[ "$(ss -Hltn "sport = :$PG_PORT" 2>/dev/null)" == *" $1:$PG_PORT "* ]]; }

setup_postgres() {
  step "PostgreSQL $PG_MAJOR"
  local conf_dir=/etc/postgresql/$PG_MAJOR/main port restart i role db owner
  if [[ ! -f "$conf_dir/postgresql.conf" ]]; then
    red "没找到集群 $PG_MAJOR/main（$conf_dir）：装 postgresql-$PG_MAJOR 时它应当自动建好"
    return 1
  fi
  port=$(pg_lsclusters -h | awk -v v="$PG_MAJOR" '$1 == v && $2 == "main" { print $3 }')
  if [[ "$port" != "$PG_PORT" ]]; then
    red "集群 $PG_MAJOR/main 的端口是「$port」，不是 $PG_PORT"
    return 1
  fi
  put_file "$conf_dir/conf.d/fleet.conf" root:root 644 "# deploy/france.sh 写的：只听本机和 WireGuard 地址（法国不对公网开端口）。改了要重启库。
listen_addresses = 'localhost,${WG_ADDR%/*}'"
  restart=$WROTE
  ensure_dir "/etc/systemd/system/$PG_UNIT.d" root:root 755
  put_file "/etc/systemd/system/$PG_UNIT.d/fleet-wireguard.conf" root:root 644 "# deploy/france.sh 写的：库要在 WireGuard 地址起来之后再起，否则 listen_addresses 里那个地址绑不上（库照样起，但之后再也不听它）。
[Unit]
After=wg-quick@$WG_IF.service
Wants=wg-quick@$WG_IF.service"
  if ((WROTE)); then systemctl daemon-reload; fi
  # 集群单元由 postgresql.service 按 Debian 的方式拉起（装包时已启用），这里只管它在跑
  if [[ "$(systemctl is-active "$PG_UNIT" 2>/dev/null)" != active ]]; then
    systemctl start "$PG_UNIT"
    changed "启动 $PG_UNIT"
  elif ((restart)); then
    systemctl restart "$PG_UNIT"
    changed "重启 $PG_UNIT（监听地址变了）"
  fi
  if wg_addr_up && ! pg_listening_on "${WG_ADDR%/*}"; then
    systemctl restart "$PG_UNIT"
    changed "重启 $PG_UNIT：它比隧道先起，漏听了 ${WG_ADDR%/*}"
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

# 下载发布包、核对 sha256、只解出要的几个文件；标记文件（.sha256）最后才写，半截安装下次会重来
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
  for m in "$@"; do install -o root -g root -m 755 "$tmp/$m" "$dir/$m"; done
  (cd "$dir" && sha256sum "$@" >.sha256)
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
  step "AI 会话资源池 fleet-agents.slice（只记账，不设上限）"
  put_file /etc/systemd/system/fleet-agents.slice root:root 644 "$(<"$DEPLOY_DIR/france/fleet-agents.slice")"
  if ((WROTE)); then systemctl daemon-reload; fi
  ensure_unit_running fleet-agents.slice 0
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

readback() {
  step "读回"
  readback_secrets_dir
  readback_dirs
  readback_postgres
  readback_temporal
  readback_slice
  readback_pnpm
  readback_wireguard
  readback_service_home
}

readback_dirs() {
  local spec path want have bad=0
  for spec in "/srv/fleet-dao root:root 755" "/var/lib/fleet-dao fleet:fleet 750" "/var/log/fleet-dao fleet:fleet 750" \
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
  local listen
  if [[ "$(systemctl is-active "$PG_UNIT" 2>/dev/null)" != active ]]; then
    red "$PG_UNIT 没在跑"
    return 0
  fi
  if pg_isready -q -h 127.0.0.1 -p "$PG_PORT"; then ok "库在 127.0.0.1:$PG_PORT 就绪"; else red "库在 127.0.0.1:$PG_PORT 没就绪"; fi
  listen=$(ss -Hltn "sport = :$PG_PORT" 2>/dev/null | awk '{ print $4 }' | sort | tr '\n' ' ')
  if [[ " $listen" == *" 0.0.0.0:$PG_PORT "* || " $listen" == *" *:$PG_PORT "* || " $listen" == *" [::]:$PG_PORT "* ]]; then
    red "库在所有网卡上监听（$listen），应只听本机和 WireGuard 地址"
  else
    ok "库只听：$listen"
  fi
  if wg_addr_up && ! pg_listening_on "${WG_ADDR%/*}"; then red "隧道地址 ${WG_ADDR%/*} 起着，库却没在上面听"; fi
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
    pending "WireGuard 待配：把香港 hk.sh 打印的公钥和 <香港公网IP>:51820 填进 $ENV_FILE，再跑一遍（法国公钥：$(wg pubkey <"/etc/wireguard/$WG_IF.key" 2>/dev/null || echo 读不到)）"
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
    pending "隧道还没握上手：香港 hk.env 填了法国公钥、重跑过 hk.sh 了吗？香港 UDP 51820 从这里通吗？"
  else
    red "隧道握过手（$(($(date +%s) - latest)) 秒前），但 ping $WG_HK_ADDR 不通"
  fi
}

# 审计 P01：root 在服务用户的目录里留下的文件，之后会以各种不像权限问题的样子出错
readback_service_home() {
  local found
  # 不接 head：find 被管道截断会让整条命令算失败，结果就被当成「没找到」
  found=$(find /home/fleet /var/lib/fleet-dao /var/log/fleet-dao -user root 2>/dev/null || true)
  if [[ -n "$found" ]]; then
    red "fleet 的目录里有 $(wc -l <<<"$found") 个 root 属主的文件，比如：$(head -3 <<<"$found" | tr '\n' ' ')"
  else
    ok "fleet 的目录里没有 root 属主的文件"
  fi
}

main() {
  local before=""
  preflight
  if ((CHECK_ONLY == 0)); then
    before=$(snapshot_others)
    setup_identity
    load_config
    setup_packages
    setup_wireguard
    setup_postgres
    setup_temporal
    setup_slice
    setup_pnpm
  else
    load_config
  fi
  readback
  self_check_root_exec
  if ((CHECK_ONLY == 0)); then compare_others "$before"; fi
  finish
}

main "$@"
