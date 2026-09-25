#!/bin/bash
# fleet-agent-scope：引擎（fleet 用户）经 sudo 调它，把一个 AI 会话以会话专用用户的身份放进 fleet-agents.slice 下它自己的
# scope，或者收掉一个（引擎重启后按 scope 名找回旧会话再收）。deploy/france.sh 装到 /usr/local/sbin/（root 755），
# /etc/sudoers.d/fleet-dao 只放行 fleet 以 root 跑这一个文件。
# 它以 root 跑，所以只做这一件事：身份只能是下面两个会话用户之一、slice 写死、单元名写死 fleet-agent-<编号>.scope，
# 参数逐个按白名单验。环境变量不走命令行（sudo 会把命令行记进日志，/proc 里谁都看得到），只收 sudoers 的 env_keep 放过来的那几类。
#
#   sudo -n fleet-agent-scope run <编号> --user <会话用户> [--memory-high 大小] [--memory-max 大小] [--memory-swap-max 大小]
#                                 [--tasks-max 数] [--cpu-weight 数] [--cwd 目录] -- /绝对路径/命令 参数…
#   sudo -n fleet-agent-scope stop <编号>     没有这个会话也算收好，返回 0
#   sudo -n fleet-agent-scope list            在册的会话：编号 状态，一行一个
#
# 两个会话用户各挂一个 reclaude 组织、永不切号：fleet-agent-dedicated（独享）、fleet-agent-carpool（拼车）；
# 引擎按选中的账号池挑用户。reclaude 的组织写在各自家里的 ~/.reclaude/device.json，对这个用户的所有会话一起生效。
# 内存要真封顶，--memory-max 和 --memory-swap-max 得一起给：只给前者，超出的部分会被换进 swap，会话不会被杀（法国实测）。
# run 会 exec 成会话本身：进程号、标准输入输出都还是调用方拿着的那一份。会话看得到的环境：HOME/USER/LOGNAME/SHELL 是会话用户的；
# PATH 取 FLEET_SESSION_PATH（没给就用默认），最前面总加上会话用户家里的 ~/.local/bin（引擎传来的是它自己的 PATH，
# 里面没有；ddgs 这些各用户自己装的命令在那儿）；另外原样带上 FLEET_*、LANG、LANGUAGE、LC_*、TZ、TERM、GIT_TERMINAL_PROMPT。
# 会话里不许有 GitHub 凭据：推分支、开 PR 由引擎在会话外做，GH_TOKEN 之类一概不放。
# 降权用 setpriv --init-groups --no-new-privs：systemd-run --uid 在 scope 里不清附加组，会话会带着 root 组（法国实测）；
# no-new-privs 让会话里的 sudo、setuid 程序都提不了权。
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
SESSION_USERS=(fleet-agent-dedicated fleet-agent-carpool)
SLICE=fleet-agents.slice
PREFIX=fleet-agent-
ENV_RE='^(FLEET_[A-Z0-9_]+|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|GIT_TERMINAL_PROMPT)$'

die() {
  printf 'fleet-agent-scope：%s\n' "$*" >&2
  exit 64
}

check_id() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$ ]] || die "会话编号只许字母、数字、_ 和 -，最长 63 个字符：「$1」"
}

as_session_user() { # 用户 命令…：降成会话用户，附加组只留它自己的，且再也提不了权
  local user=$1
  shift
  /usr/bin/setpriv --reuid="$user" --regid="$user" --init-groups --no-new-privs -- "$@"
}

run() {
  local id=${1:-} user="" cwd=/ props=() keep=() home path k u ok=0
  check_id "$id"
  shift
  while (($#)); do
    case $1 in
    --user)
      user=${2:-}
      shift 2
      ;;
    --memory-high | --memory-max | --memory-swap-max)
      [[ "${2:-}" =~ ^(0|[1-9][0-9]*[KMGT]?)$ ]] || die "$1 要形如 1536M，给的是「${2:-}」"
      case $1 in
      --memory-high) props+=(-p "MemoryHigh=$2") ;;
      --memory-max) props+=(-p "MemoryMax=$2") ;;
      *) props+=(-p "MemorySwapMax=$2") ;;
      esac
      shift 2
      ;;
    --tasks-max)
      [[ "${2:-}" =~ ^[1-9][0-9]{0,5}$ ]] || die "--tasks-max 要是正整数，给的是「${2:-}」"
      props+=(-p "TasksMax=$2")
      shift 2
      ;;
    --cpu-weight)
      if [[ ! "${2:-}" =~ ^[1-9][0-9]{0,4}$ ]] || ((10#$2 > 10000)); then die "--cpu-weight 要在 1–10000 之间，给的是「${2:-}」"; fi
      props+=(-p "CPUWeight=$2")
      shift 2
      ;;
    --cwd)
      cwd=${2:-}
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *) die "不认识的参数：「$1」" ;;
    esac
  done
  for u in "${SESSION_USERS[@]}"; do if [[ "$user" == "$u" ]]; then ok=1; fi; done
  ((ok)) || die "--user 只能是 ${SESSION_USERS[*]} 之一，给的是「$user」"
  (($#)) || die "-- 后面要有要跑的命令"
  [[ "$1" == /* ]] || die "命令要写绝对路径：「$1」"
  [[ "$cwd" == /* ]] || die "--cwd 要写绝对路径：「$cwd」"
  # 先以会话用户的身份进一次这个目录：root 先 cd 进去再降权，会让会话占着一个它自己本来进不去的目录
  # shellcheck disable=SC2016 # $1 要由降权后的 sh 展开
  as_session_user "$user" /bin/sh -c 'cd -- "$1"' sh "$cwd" 2>/dev/null || die "$user 进不去这个目录：$cwd"
  cd -- "$cwd"
  home=$(getent passwd "$user" | cut -d: -f6)
  path=${FLEET_SESSION_PATH:-/usr/local/bin:/usr/bin:/bin}
  [[ "$path" =~ ^/[^:]*(:/[^:]*)*$ ]] || die "FLEET_SESSION_PATH 的每一段都要是绝对路径"
  path=$home/.local/bin:$path
  # 把自己的环境清成会话该看到的样子，再一路 exec 下去：值只在环境里传，不上命令行
  for k in $(compgen -e); do
    if [[ "$k" =~ $ENV_RE ]]; then keep+=("$k"); else unset "$k" 2>/dev/null || true; fi
  done
  export HOME="$home" USER="$user" LOGNAME="$user" SHELL=/bin/bash PATH="$path"
  if [[ -z "${LANG:-}" ]]; then export LANG=C.UTF-8; fi
  exec /usr/bin/systemd-run --quiet --scope --collect --slice="$SLICE" --unit="$PREFIX$id" -p TimeoutStopSec=15s \
    "${props[@]}" -- /usr/bin/setpriv --reuid="$user" --regid="$user" --init-groups --no-new-privs -- "$@"
}

stop() {
  local id=${1:-} unit state
  check_id "$id"
  unit=$PREFIX$id.scope
  state=$(systemctl show -p ActiveState --value "$unit" 2>/dev/null) || state=""
  # 已经没了就算收好：清理动作碰上已消失的对象要正常返回，不然调用方会一轮轮重来
  if [[ -z "$state" || "$state" == inactive ]]; then
    echo "$unit 已经不在了"
    return 0
  fi
  systemctl stop "$unit"
  echo "已收掉 $unit"
}

list() {
  systemctl list-units --type=scope --all --plain --no-legend "$PREFIX*.scope" |
    awk -v p="$PREFIX" '{ id = $1; sub("^" p, "", id); sub(/[.]scope$/, "", id); print id, $3 }'
}

case ${1:-} in
run)
  shift
  run "$@"
  ;;
stop)
  shift
  stop "$@"
  ;;
list) list ;;
*) die "用法：fleet-agent-scope run <编号> --user <会话用户> [选项] -- /绝对路径/命令 参数… | stop <编号> | list" ;;
esac
