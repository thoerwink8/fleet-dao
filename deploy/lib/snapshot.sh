#!/usr/bin/env bash
# 机器状态快照，只读。用法：bash deploy/lib/snapshot.sh others|ours
#   others  不归 fleet-dao 管的单元与监听端口。装机前后各拍一次，diff 应为空——证明旧系统没被碰。
#   ours    fleet-dao 管的东西（文件指纹、包、单元、库、命名空间）。连跑两遍装机，两遍之间各拍一次，diff 应为空。
# 这份判据故意不复用装机脚本自己的比较逻辑：自己查自己查不出错。
# 装机脚本也 source 本文件，在开头和结尾各拍一次 others 并比较。
set -uo pipefail

# fleet-dao 自己的单元。改名或新增单元时同步改这里，否则新单元会被当成「旧系统变了」。
SNAPSHOT_OURS_UNITS_RE='^(fleet-.*|postgresql.*|wg-quick@wg-fleet[.]service)$'
# 会随登录会话、临时命令自然变化的单元，不算旧系统的状态。packagekit、fwupd 是按需拉起、闲了自己退的系统守护进程
# （apt 装完包会通过 D-Bus 把 packagekit 叫起来）。
SNAPSHOT_NOISE_UNITS_RE='^(run-.*|session-.*|user@.*|user-runtime-dir@.*|systemd-.*[.]service|.*[.]device|packagekit[.]service|fwupd[.]service)$'

snapshot_others() {
  local units
  units=$(systemctl list-units --all --plain --no-legend --type=service,timer,socket,path 2>/dev/null |
    awk -v ours="$SNAPSHOT_OURS_UNITS_RE" -v noise="$SNAPSHOT_NOISE_UNITS_RE" \
      '$1 !~ ours && $1 !~ noise {print $1}' | sort -u)
  echo "## units"
  if [[ -n "$units" ]]; then
    # shellcheck disable=SC2086 # 单元名不含空白，按词拆开传给 systemctl 正是要的
    systemctl show -p Id,Type,UnitFileState,ActiveState,SubState,MainPID,NRestarts $units 2>/dev/null |
      awk 'BEGIN { RS = ""; FS = "\n" }
        {
          delete p
          for (i = 1; i <= NF; i++) { k = substr($i, 1, index($i, "=") - 1); p[k] = substr($i, index($i, "=") + 1) }
          id = p["Id"]
          if (id ~ /\.(timer|socket|path)$/) print id, p["UnitFileState"], p["ActiveState"]
          else if (p["Type"] == "oneshot") print id, "oneshot", p["UnitFileState"]
          else print id, p["Type"], p["UnitFileState"], p["ActiveState"], p["SubState"], "pid=" p["MainPID"], "restarts=" p["NRestarts"]
        }' | sort
  fi
  echo "## listening"
  # 只记「协议 地址:端口 进程名」，不记 pid；fleet-dao 自己的进程（temporal-server、postgres）和内核里的 WireGuard 套接字不算。
  ss -H -ltnup 2>/dev/null |
    awk '{ proc = "-"; if (match($0, /users:\(\("[^"]+"/)) proc = substr($0, RSTART + 9, RLENGTH - 10)
           if (proc == "temporal-server" || proc == "postgres") next
           if ($1 == "udp" && proc == "-") next
           print $1, $5, proc }' | sort -u
  snapshot_firewall
}

snapshot_firewall() {
  echo "## firewall"
  # 挂在隧道网卡 wg-fleet 上的规则是 fleet-dao 自己加的，不算旧系统的状态
  if command -v ufw >/dev/null 2>&1; then
    printf 'ufw %s\n' "$(ufw status verbose 2>&1 | { grep -v -e 'wg-fleet' || true; } | sha256sum | cut -c1-16)"
  fi
  # 计数器和 fail2ban 的封禁条目每分钟都在变，不算状态
  printf 'iptables %s\n' "$({ iptables-save 2>/dev/null || true; } | { grep -v -e '^#' -e '-A f2b-' -e 'wg-fleet' || true; } |
    sed -E 's/\[[0-9]+:[0-9]+\]//' | sha256sum | cut -c1-16)"
}

snapshot_file_list() {
  # 每个文件一行：sha256 属主:组 权限 路径；符号链接记指向。只读，不存在的根目录直接跳过。
  local root
  for root in "$@"; do
    [[ -e "$root" || -L "$root" ]] || continue
    find "$root" \( -type f -o -type l -o -type d \) -print0 2>/dev/null | sort -z |
      while IFS= read -r -d '' f; do
        if [[ -L "$f" ]]; then
          printf 'link %s -> %s\n' "$f" "$(readlink "$f")"
        elif [[ -d "$f" ]]; then
          printf 'dir  %s %s\n' "$(stat -c '%U:%G %a' "$f")" "$f"
        else
          printf 'file %s %s %s\n' "$(sha256sum <"$f" | cut -c1-16)" "$(stat -c '%U:%G %a' "$f")" "$f"
        fi
      done
  done
}

snapshot_ours() {
  local u
  echo "## identity"
  for u in fleet fleet-agent-dedicated fleet-agent-carpool pilot; do
    getent passwd "$u" || echo "passwd $u: 无"
    getent group "$u" || echo "group $u: 无"
  done
  # pilot 在这个组里才看得了日志
  getent group systemd-journal || echo "group systemd-journal: 无"
  echo "## files"
  snapshot_file_list /etc/fleet-dao /opt/fleet-dao /srv/fleet-dao-web /var/www/fleet-dao-acme /home/pilot/.local/bin \
    /etc/wireguard /etc/postgresql/16/main /etc/apt/sources.list.d /etc/apt/keyrings \
    /usr/local/bin/fleet-temporal /usr/local/sbin/fleet-agent-scope /etc/sudoers.d/fleet-dao /home/fleet/.local/bin \
    /home/fleet-agent-dedicated/.local/bin /home/fleet-agent-carpool/.local/bin \
    /etc/nginx/sites-available/fleet-dao /etc/nginx/sites-enabled/fleet-dao
  echo "## nft"
  nft list table inet fleet_dao 2>&1 || true
  if command -v ufw >/dev/null 2>&1; then
    echo "## ufw（fleet-dao 加的）"
    ufw show added 2>/dev/null | grep -F 'wg-fleet' || echo "（无）"
  fi
  find /etc/systemd/system /etc/letsencrypt/live /etc/letsencrypt/renewal -maxdepth 2 -name '*fleet*' -print0 2>/dev/null |
    sort -z | while IFS= read -r -d '' f; do snapshot_file_list "$f"; done
  for d in /srv/fleet-dao /var/lib/fleet-dao /var/log/fleet-dao /home/fleet /home/fleet-agent-dedicated /home/fleet-agent-carpool /home/pilot; do
    if [[ -e "$d" ]]; then printf 'dir  %s %s\n' "$(stat -c '%U:%G %a' "$d")" "$d"; fi
  done
  echo "## packages"
  dpkg-query -W -f '${Package} ${Version} ${Status}\n' postgresql-16 postgresql-common libpq5 wireguard-tools \
    nftables nginx certbot 2>/dev/null | sort
  echo "## units"
  systemctl show -p Id,UnitFileState,ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestampMonotonic,Restart \
    fleet-temporal.service fleet-agents.slice fleet-firewall.service postgresql@16-main.service wg-quick@wg-fleet.service \
    nginx.service 2>/dev/null | awk 'BEGIN { RS = ""; FS = "\n"; OFS = " " } { $1 = $1; print }'
  echo "## postgres"
  # 先 cd /：runuser 不换当前目录，postgres 进不了 /root 会多打一行警告，混进快照
  if command -v psql >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
    (
      cd / || exit
      runuser -u postgres -- psql -X -tA -c "select 'role', rolname, rolcanlogin, rolsuper, (rolpassword is not null) from pg_authid where rolname in ('fleet','temporal') union all select 'db', datname, pg_get_userbyid(datdba), datallowconn, null from pg_database where datname in ('fleet','temporal','temporal_visibility') order by 1, 2" 2>&1
      for db in temporal temporal_visibility; do
        printf 'schema %s ' "$db"
        runuser -u postgres -- psql -X -tA -d "$db" -c "select curr_version from schema_version" 2>&1 | tr '\n' ' '
        echo
      done
      runuser -u postgres -- psql -X -tA -c "show listen_addresses" 2>&1
    )
  else
    echo "postgres: 没装"
  fi
  echo "## temporal"
  if [[ -x /usr/local/bin/fleet-temporal ]]; then
    /usr/local/bin/fleet-temporal operator namespace describe fleet -o json 2>&1 |
      grep -E '"(name|state|workflowExecutionRetentionTtl)"' | tr -d ' ,'
  else
    echo "temporal: 没装"
  fi
  echo "## pnpm"
  if id fleet >/dev/null 2>&1 && [[ -e /home/fleet/.local/bin/pnpm ]]; then
    (cd /home/fleet && runuser -u fleet -- env -i HOME=/home/fleet PATH=/home/fleet/.local/bin:/usr/bin:/bin \
      COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version 2>&1)
  else
    echo "pnpm: 没装"
  fi
  echo "## wireguard"
  if command -v wg >/dev/null 2>&1 && ip link show wg-fleet >/dev/null 2>&1; then
    # 握手时间和流量每秒都在变，不算状态
    wg show wg-fleet | grep -vE 'latest handshake|transfer'
  else
    echo "wg-fleet: 没起"
  fi
  snapshot_firewall
}

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  case "${1:-}" in
  others) snapshot_others ;;
  ours) snapshot_ours ;;
  *)
    echo "用法：bash $0 others|ours" >&2
    exit 64
    ;;
  esac
fi
