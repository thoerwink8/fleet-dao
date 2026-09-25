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
#   sudo -n fleet-agent-scope adopt <工作树> --user <会话用户> [--from <会话用户> --session <会话编号>]
#                                    换会话用户接着干：改工作树属主，给了 --session 就顺带把过程记录拷过去
#                                    （--from 和 --session 要么都给要么都不给）。退出码：0 成功；64 校验不过；
#                                    65 会话记录没找到或不唯一；其余失败 1。
#
# 两个会话用户各挂一个 reclaude 组织、永不切号：fleet-agent-dedicated（独享）、fleet-agent-carpool（拼车）；
# 引擎按选中的账号池挑用户。reclaude 的组织写在各自家里的 ~/.reclaude/device.json，对这个用户的所有会话一起生效。
# 内存要真封顶，--memory-max 和 --memory-swap-max 得一起给：只给前者，超出的部分会被换进 swap，会话不会被杀（法国实测）。
# run 会 exec 成会话本身：进程号、标准输入输出都还是调用方拿着的那一份。会话看得到的环境：HOME/USER/LOGNAME/SHELL 是会话用户的；
# PATH 取 FLEET_SESSION_PATH（没给就用默认）；另外原样带上 FLEET_*、LANG、LANGUAGE、LC_*、TZ、TERM、GIT_TERMINAL_PROMPT。
# 会话里不许有 GitHub 凭据：推分支、开 PR 由引擎在会话外做，GH_TOKEN 之类一概不放。
# 降权用 setpriv --init-groups --no-new-privs：systemd-run --uid 在 scope 里不清附加组，会话会带着 root 组（法国实测）；
# no-new-privs 让会话里的 sudo、setuid 程序都提不了权。
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
SESSION_USERS=(fleet-agent-dedicated fleet-agent-carpool)
SLICE=fleet-agents.slice
PREFIX=fleet-agent-
ENV_RE='^(FLEET_[A-Z0-9_]+|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|GIT_TERMINAL_PROMPT)$'
# AI 会话工作树的根（docs/design.md 第十四节「安全」）。测试专用开关，故意不叫 FLEET_*：sudoers 的 env_keep
# 把 fleet 用户环境里的 FLEET_* 原样带进这个以 root 跑的脚本，这个开关要是也叫 FLEET_*，fleet 用户自己在调用
# sudo 前设一个同名变量就能把生产上的落点边界改掉；不在 env_keep 白名单里的名字，sudo 会在进来之前就擦掉它。
WORK_BASE=${AGENT_SCOPE_TEST_WORK_BASE:-/var/lib/fleet-work}

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
  path=${FLEET_SESSION_PATH:-$home/.local/bin:/usr/local/bin:/usr/bin:/bin}
  [[ "$path" =~ ^/[^:]*(:/[^:]*)*$ ]] || die "FLEET_SESSION_PATH 的每一段都要是绝对路径"
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

# 换会话用户接着干（docs/design.md 第十四节）：工作树路径不变，只改属主；给了 --session 就把过程记录也拷过去，
# 新用户按同一个路径算出的项目目录名和旧用户一样，fork 续会话时就能接着找到它。
# 退出码：0 成功；64 用法/校验不过（下面全部经 die）；65 会话记录没找到或不唯一；其余失败 1。
adopt() {
  local dir=${1:-} user="" from="" session="" u ok=0 rel real from_home to_home src project_dir dest_dir
  local -a hits=() pstat=()
  [[ -n "$dir" ]] || die "用法：fleet-agent-scope adopt <工作树> --user <会话用户> [--from <会话用户> --session <会话编号>]"
  shift
  while (($#)); do
    case $1 in
    --user)
      user=${2:-}
      shift 2
      ;;
    --from)
      from=${2:-}
      shift 2
      ;;
    --session)
      session=${2:-}
      shift 2
      ;;
    *) die "不认识的参数：「$1」" ;;
    esac
  done
  # 先验和文件系统无关的：user/from/session 的形状，不用等工作树存在就能测
  for u in "${SESSION_USERS[@]}"; do if [[ "$user" == "$u" ]]; then ok=1; fi; done
  ((ok)) || die "--user 只能是 ${SESSION_USERS[*]} 之一，给的是「$user」"
  if [[ -n "$from" || -n "$session" ]]; then
    [[ -n "$from" && -n "$session" ]] || die "--from 和 --session 要么都给，要么都不给（拷会话记录要知道从哪个用户拷）"
    ok=0
    for u in "${SESSION_USERS[@]}"; do if [[ "$from" == "$u" ]]; then ok=1; fi; done
    ((ok)) || die "--from 只能是 ${SESSION_USERS[*]} 之一，给的是「$from」"
    [[ "$from" != "$user" ]] || die "--from 和 --user 不能一样：「$user」"
    [[ "$session" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||
      die "--session 要是 UUID：「$session」"
  fi
  # 工作树落点：绝对路径、在 WORK_BASE 之下、至少两层（仓/任务）、路径上每一段都不是符号链接、是目录
  [[ "$dir" == /* ]] || die "工作树要写绝对路径：「$dir」"
  case $dir in
  "$WORK_BASE"/*) ;;
  *) die "工作树要在 $WORK_BASE 之下：「$dir」" ;;
  esac
  rel=${dir#"$WORK_BASE"/}
  [[ "$rel" == */* ]] || die "工作树至少要在 $WORK_BASE 下两层（仓/任务）：「$dir」"
  real=$(realpath -e -- "$dir" 2>/dev/null) || die "工作树不存在：「$dir」"
  [[ "$real" == "$dir" ]] || die "工作树路径上有符号链接：「$dir」解析成「$real」"
  [[ -d "$dir" ]] || die "工作树不是目录：「$dir」"

  chown -R --no-dereference "$user:$user" -- "$dir" || {
    echo "fleet-agent-scope：改属主失败：$dir" >&2
    exit 1
  }

  if [[ -n "$session" ]]; then
    from_home=$(getent passwd "$from" | cut -d: -f6) || die "找不到用户 $from 的家目录"
    to_home=$(getent passwd "$user" | cut -d: -f6) || die "找不到用户 $user 的家目录"
    # 不以 root 读旧用户的文件：旧用户能把文件换成指向 /etc/shadow 这类的链接，改由它自己的身份去找、去读
    mapfile -t hits < <(as_session_user "$from" /usr/bin/find "$from_home/.claude/projects" \
      -mindepth 2 -maxdepth 2 -type f -name "$session.jsonl" 2>/dev/null)
    if ((${#hits[@]} != 1)); then
      echo "fleet-agent-scope：$from 名下找不到唯一的会话记录 $session.jsonl（命中 ${#hits[@]} 个）" >&2
      exit 65
    fi
    src=${hits[0]}
    # 项目目录名照旧的来：工作树路径没变，新用户按同一个路径算出的名字和旧用户一样，不用我们自己重算
    project_dir=$(basename -- "$(dirname -- "$src")")
    dest_dir="$to_home/.claude/projects/$project_dir"
    # pipefail 只留管道最后一段的退出码：右边就算读到空输入也能 mkdir+cat 成功，会把左边（旧用户）读失败
    # 盖成「成功」，写出一份空的会话记录。两段的退出码都要看，用 PIPESTATUS（在 if 判完的下一句立刻取，
    # 再跑别的命令它就被冲掉了）。
    # shellcheck disable=SC2016 # $1 要由降权后的 sh 展开，不是这一层的
    if ! as_session_user "$from" cat -- "$src" |
      as_session_user "$user" /bin/sh -c 'umask 077 && mkdir -p -- "$(dirname -- "$1")" && cat >"$1"' sh \
        "$dest_dir/$session.jsonl"; then
      pstat=("${PIPESTATUS[@]}")
      echo "fleet-agent-scope：拷会话记录失败（读 ${pstat[0]}，写 ${pstat[1]}）：$src → $dest_dir/$session.jsonl" >&2
      exit 1
    fi
  fi
  echo "已把 $dir 交给 $user"
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
adopt)
  shift
  adopt "$@"
  ;;
*) die "用法：fleet-agent-scope run <编号> --user <会话用户> [选项] -- /绝对路径/命令 参数… | stop <编号> | list | adopt <工作树> --user <会话用户> [--from <会话用户> --session <会话编号>]" ;;
esac
