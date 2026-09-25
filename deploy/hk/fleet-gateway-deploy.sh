#!/usr/bin/env bash
# fleet-gateway-deploy：香港上发布飞书网关的唯一入口（deploy/hk.sh 装到 /usr/local/sbin/fleet-gateway-deploy，root 755）。
# 法国的发布脚本经隧道用一把专用钥匙登上来；香港 root 的 authorized_keys2 把那把钥匙限死成只能跑本脚本、只许从隧道地址来。
# 要做的事从 SSH_ORIGINAL_COMMAND 读（本机 root 手动跑时从参数读），只认下面几种，别的一律拒：
#   has <提交号>               这一版的网关收下了没有（退出码 0 有、1 没有）
#   receive <提交号> <sha256>  从标准输入收这一版的 gateway.mjs，sha256 对上才落到 /srv/fleet-dao-gateway/<提交号>
#   activate <提交号>          配置备齐了才动：current 指过去，起或重启 fleet-feishu（主进程不在这一版的目录里、
#                              或环境文件改过才重启），只留最近几版
#   status                     当前状态，一行一项「键=值」；法国发布脚本的健康检查读它
# 每一版只有一个文件：法国把网关连同依赖打成一个 gateway.mjs（deploy/france/bundle-gateway.sh），香港不放仓库、不装依赖。
# 退出码：0 成，1 失败（原因在标准错误），64 用法不对。
set -Eeuo pipefail
umask 022

ROOT=/srv/fleet-dao-gateway
UNIT=fleet-feishu.service
FEISHU_ENV=/etc/fleet-dao/feishu.env
TOKEN_ENV=/etc/fleet-dao/gateway-token.env
# 网关起不来的配置（packages/feishu/src/config.ts 里必填的几项）；少一项就不起，免得起了就退、反复重启
REQUIRED_KEYS=(FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_FOUNDERS FEISHU_TEAM_CHAT_ID FLEET_BACKEND_URL FLEET_PUBLIC_URL
  FLEET_FEISHU_GATEWAY_TOKEN)
MAX_BYTES=$((64 * 1024 * 1024))
KEEP=5
# 长连接的三种日志（packages/feishu/src/main.ts、lark.ts）：status 看这次进程起来之后最后一条是哪种，判现在连着没有
CONNECTED_MARK='"message":"飞书网关已连上"'
RECONNECTED_MARK='"message":"飞书长连接重连上了"'
DISCONNECTED_MARK='"message":"飞书长连接断了，正在重连"'
# 网关处理完一条飞书消息打的那一行：数一数，看得到事件真的进来了
MESSAGE_MARK='"message":"消息处理完"'

fail() {
  echo "$*" >&2
  exit 1
}
is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

# 环境文件里某个键的值（只当数据读、不 source；值不打印）。没有就空
env_value() { # 键
  local f line v=""
  for f in "$FEISHU_ENV" "$TOKEN_ENV"; do
    [[ -f "$f" ]] || continue
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "$1="* ]]; then v=${line#*=}; fi
    done <"$f"
  done
  v=${v#\"}
  printf '%s' "${v%\"}"
}

missing_keys() {
  local k out=()
  for k in "${REQUIRED_KEYS[@]}"; do
    if [[ -z "$(env_value "$k")" ]]; then out+=("$k"); fi
  done
  printf '%s' "${out[*]}"
}

main_pid() { systemctl show -p MainPID --value "$UNIT" 2>/dev/null || echo 0; }

# 主进程跑的是哪一版：它的当前目录（单元的 WorkingDirectory 是 current，起进程那一刻解开成 <提交号> 目录）
running_sha() {
  local pid dir
  pid=$(main_pid)
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  dir=$(readlink -- "/proc/$pid/cwd" 2>/dev/null) || return 0
  if [[ "$dir" == "$ROOT/"* ]] && is_sha "${dir##*/}"; then printf '%s' "${dir##*/}"; fi
}

current_sha() {
  local s
  s=$(readlink -- "$ROOT/current" 2>/dev/null) || return 0
  if is_sha "$s"; then printf '%s' "$s"; fi
}

# 进程是什么时候起来的（秒）：/proc/<进程号>/stat 的第 22 项（开机后的时钟滴答）加开机时刻。
# 不用 systemctl show --timestamp=unix：香港的 systemd 249 不认（2026-09-25 真机撞到，读成空，连上了也判成没连上）
proc_start() { # 进程号
  local stat fields btime hz
  stat=$(<"/proc/$1/stat") || return 1
  # 第 2 项是括起来的程序名，里面可能有空格：从最后一个「) 」之后数，第 3 项起下标 0，第 22 项就是下标 19
  read -r -a fields <<<"${stat##*) }"
  btime=$(awk '$1 == "btime" { print $2 }' /proc/stat)
  hz=$(getconf CLK_TCK)
  [[ "${fields[19]:-}" =~ ^[0-9]+$ && "$btime" =~ ^[0-9]+$ && "$hz" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s' $((btime + fields[19] / hz))
}

# 环境文件在这次进程起来之后改过（hk.sh 补了键、人改了配置）：要重启才生效
env_changed_since_start() {
  local pid start f
  pid=$(main_pid)
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  start=$(proc_start "$pid") || return 1
  for f in "$FEISHU_ENV" "$TOKEN_ENV"; do
    if [[ -f "$f" ]] && (($(stat -c %Y -- "$f") > start)); then return 0; fi
  done
  return 1
}

cmd_has() { # 提交号
  [[ -f "$ROOT/$1/.complete" ]]
}

cmd_receive() { # 提交号 sha256
  local sha=$1 sum=$2 dest=$ROOT/$1 tmp size got
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || fail "sha256 不像 sha256：$sum"
  if [[ -f "$dest/.complete" ]]; then
    cat >/dev/null
    if [[ "$(<"$dest/.sha256")" == "$sum" ]]; then
      echo "ok 已收下过 ${sha:0:12}"
      return 0
    fi
    fail "${sha:0:12} 已经收下过、内容不一样：同一个提交号的网关不许换内容"
  fi
  install -d -o root -g root -m 755 "$ROOT"
  tmp=$(mktemp -d "$ROOT/.incoming.XXXXXX")
  # 收不全、校验不过都不留半截
  trap 'rm -rf -- "$tmp"' EXIT
  head -c $((MAX_BYTES + 1)) >"$tmp/gateway.mjs"
  size=$(stat -c %s -- "$tmp/gateway.mjs")
  ((size > 0)) || fail "收到的 gateway.mjs 是空的"
  ((size <= MAX_BYTES)) || fail "收到的 gateway.mjs 超过 $((MAX_BYTES / 1024 / 1024)) MB，不收"
  got=$(sha256sum <"$tmp/gateway.mjs" | cut -c1-64)
  [[ "$got" == "$sum" ]] || fail "收到的 gateway.mjs 的 sha256 对不上（传坏了？），不收"
  printf '%s\n' "$sum" >"$tmp/.sha256"
  chmod 644 -- "$tmp/gateway.mjs" "$tmp/.sha256"
  chmod 755 -- "$tmp"
  : >"$tmp/.complete"
  rm -rf -- "$dest"
  mv -T -- "$tmp" "$dest"
  trap - EXIT
  echo "changed 收下 ${sha:0:12}（$((size / 1024)) KB）"
}

cmd_activate() { # 提交号
  local sha=$1 missing pid running
  cmd_has "$sha" || fail "没有 ${sha:0:12} 这一版：先 receive"
  missing=$(missing_keys)
  [[ -z "$missing" ]] || fail "网关的配置没备齐（缺 $missing），不起：见 docs/ops.md 第十二节"
  if [[ "$(current_sha)" != "$sha" ]]; then
    ln -sfn -- "$sha" "$ROOT/.current.new"
    mv -Tf -- "$ROOT/.current.new" "$ROOT/current"
    printf '%s %s activate\n' "$(date -u +%FT%TZ)" "$sha" >>"$ROOT/.history"
    echo "changed 香港网关 current → ${sha:0:12}"
  fi
  if [[ "$(systemctl is-enabled "$UNIT" 2>/dev/null)" != enabled ]]; then
    systemctl enable --quiet "$UNIT"
    echo "changed 启用 fleet-feishu"
  fi
  running=$(running_sha)
  if [[ "$(systemctl is-active "$UNIT" 2>/dev/null)" != active ]]; then
    systemctl start "$UNIT" || fail "fleet-feishu 起不来：journalctl -u fleet-feishu -n 50"
    echo "changed 启动 fleet-feishu"
  elif [[ "$running" != "$sha" ]]; then
    systemctl restart "$UNIT" || fail "fleet-feishu 重启失败：journalctl -u fleet-feishu -n 50"
    echo "changed 重启 fleet-feishu（主进程在跑 ${running:-别处}，不是这一版）"
  elif env_changed_since_start; then
    systemctl restart "$UNIT" || fail "fleet-feishu 重启失败：journalctl -u fleet-feishu -n 50"
    echo "changed 重启 fleet-feishu（环境文件改过）"
  else
    pid=$(main_pid)
    echo "ok fleet-feishu 已在跑这一版（pid $pid）"
  fi
  prune
}

# 只留最近 KEEP 版：在用的一定留，再按最近切过的补满；没切过的（只收下没用）按收下的时间排在后面
prune() {
  local cur s d kept=() order=()
  cur=$(current_sha)
  if [[ -f "$ROOT/.history" ]]; then mapfile -t order < <(tac -- "$ROOT/.history" | awk '!seen[$2]++ { print $2 }'); fi
  while read -r _ d; do order+=("$d"); done < <(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn)
  for s in "$cur" "${order[@]}"; do
    if ! is_sha "$s" || [[ ! -d "$ROOT/$s" ]] || [[ " ${kept[*]} " == *" $s "* ]]; then continue; fi
    if ((${#kept[@]} < KEEP)) || [[ "$s" == "$cur" ]]; then kept+=("$s"); fi
  done
  for d in "$ROOT"/*; do
    s=${d##*/}
    if ! is_sha "$s" || [[ -L "$d" || ! -d "$d" ]]; then continue; fi
    if [[ " ${kept[*]} " != *" $s "* ]]; then
      rm -rf -- "$d"
      echo "changed 清掉香港网关的旧版 ${s:0:12}"
    fi
  done
  for d in "$ROOT"/.incoming.*; do
    if [[ -d "$d" ]]; then rm -rf -- "$d"; fi
  done
}

# 后端（经隧道）连不连得上：只试 TCP 连接。连得上 reachable；被拒 refused（法国后端没起）；超时 timeout（隧道断了）；
# 没配地址 unknown；地址认不出 invalid（要写成 http://主机:端口）。
# 地址是配置里的字、status 又是法国远程触发、以 root 跑：主机只认字母数字点横线、端口只认数字，而且只当参数交给 bash，
# 不拼进命令里——拼进去的话，地址里夹一段 $(…) 就会以 root 执行
backend_state() {
  local url host port rc=0
  url=$(env_value FLEET_BACKEND_URL)
  if [[ -z "$url" ]]; then
    echo unknown
    return 0
  fi
  if [[ ! "$url" =~ ^https?://([A-Za-z0-9.-]+):([0-9]{1,5})(/[^[:space:]]*)?$ ]]; then
    echo invalid
    return 0
  fi
  host=${BASH_REMATCH[1]}
  port=${BASH_REMATCH[2]}
  if ((10#$port < 1 || 10#$port > 65535)); then
    echo invalid
    return 0
  fi
  # shellcheck disable=SC2016 # 单引号是故意的：$1、$2 由里面那个 bash 展开成参数，不由这里拼
  timeout 3 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$host" "$port" 2>/dev/null || rc=$?
  case $rc in
  0) echo reachable ;;
  124) echo timeout ;;
  *) echo refused ;;
  esac
}

cmd_status() {
  local pid inv log="" last missing
  pid=$(main_pid)
  echo "current=$(current_sha)"
  echo "enabled=$(systemctl is-enabled "$UNIT" 2>/dev/null || true)"
  echo "active=$(systemctl is-active "$UNIT" 2>/dev/null || true)"
  echo "pid=$pid"
  echo "restarts=$(systemctl show -p NRestarts --value "$UNIT" 2>/dev/null || echo 0)"
  echo "running=$(running_sha)"
  # 这次进程起来之后的日志：按这次启动的编号（InvocationID）取，重启一次换一个编号，旧进程的日志混不进来
  inv=$(systemctl show -p InvocationID --value "$UNIT" 2>/dev/null) || inv=""
  if [[ "$pid" =~ ^[1-9][0-9]*$ && "$inv" =~ ^[0-9a-f]{32}$ ]]; then
    log=$(journalctl "_SYSTEMD_INVOCATION_ID=$inv" -o cat --no-pager 2>/dev/null) || log=""
  fi
  # yes 连着；reconnecting 断了、正在重连；no 这次起来之后还没连上过
  last=$(grep -F -e "$CONNECTED_MARK" -e "$RECONNECTED_MARK" -e "$DISCONNECTED_MARK" <<<"$log" | tail -1) || last=""
  case $last in
  *"$DISCONNECTED_MARK"*) echo "connected=reconnecting" ;;
  "") echo "connected=no" ;;
  *) echo "connected=yes" ;;
  esac
  echo "messages=$(grep -cF -- "$MESSAGE_MARK" <<<"$log" || true)"
  echo "backend=$(backend_state)"
  missing=$(missing_keys)
  if [[ -n "$missing" ]]; then echo "config=missing $missing"; else echo "config=ok"; fi
}

usage() {
  echo "用法：fleet-gateway-deploy has <提交号> | receive <提交号> <sha256> | activate <提交号> | status" >&2
  exit 64
}

main() {
  local words=()
  if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
    read -r -a words <<<"$SSH_ORIGINAL_COMMAND"
  else
    words=("$@")
  fi
  ((EUID == 0)) || fail "要 root"
  case "${words[0]:-}:${#words[@]}" in
  has:2 | activate:2 | receive:3)
    if ! is_sha "${words[1]}"; then usage; fi
    "cmd_${words[0]}" "${words[@]:1}"
    ;;
  status:1) cmd_status ;;
  *) usage ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
