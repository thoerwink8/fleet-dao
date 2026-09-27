#!/bin/bash
# fleet-agent-scope：引擎（fleet 用户）经 sudo 调它，把一个 AI 会话以会话专用用户的身份放进 fleet-agents.slice 下它自己的
# scope，或者收掉一个（引擎重启后按 scope 名找回旧会话再收）。deploy/france.sh 装到 /usr/local/sbin/（root 755），
# /etc/sudoers.d/fleet-dao 只放行 fleet 以 root 跑这一个文件。
# 它以 root 跑，所以只做这一件事：身份只能是下面的会话用户、slice 写死、单元名写死 fleet-agent-<编号>.scope，
# 参数逐个按白名单验。环境变量不走命令行（sudo 会把命令行记进日志，/proc 里谁都看得到），只收 sudoers 的 env_keep 放过来的那几类。
#
#   sudo -n fleet-agent-scope run <编号> --user <会话用户> [--memory-high 大小] [--memory-max 大小] [--memory-swap-max 大小]
#                                 [--tasks-max 数] [--cpu-weight 数] [--cwd 目录] -- /绝对路径/命令 参数…
#   sudo -n fleet-agent-scope stop <编号>     没有这个会话也算收好，返回 0
#   sudo -n fleet-agent-scope list            在册的会话：编号 状态，一行一个
#   sudo -n fleet-agent-scope adopt <工作树> --user <会话用户>
#                                    把工作树交给这个会话用户：不在就建（中间各级 root:root 755，最后一级归它、700），
#                                    在就改属主。退出码：0 成功；64 校验不过；其余失败 1。
#   sudo -n fleet-agent-scope remove <工作树>  删掉一棵工作树（不跟随符号链接、不跨文件系统）。本来就不在也返回 0；
#                                    标准输出最后一行是 removed <路径> 或 gone <路径>。退出码同 adopt。
#   sudo -n fleet-agent-scope org-use <carpool|solo> --user <会话用户>
#                                    把会话用户挂的 reclaude 组织切到拼车（org list 里类型 team）或独享（personal）：以它的身份
#                                    跑它家里的 reclaude，那一类的组织要恰好一个；已经挂着就不动。切完再读一遍 org list 核对
#                                    （org use 退出码不是 0 也可能已经切了，docs/reference/adapters.md CC-07），没切成就切回原来那个。
#                                    切号会让这个家目录下在跑的 Claude 会话全断：等手上没有在跑的会话再调，由引擎管（#157）。
#                                    整个流程总时限 ORG_BUDGET 秒，每一步只给剩下的时间，切之前给核对留够、不够就不切。
#                                    组织编号、名字、邮箱一概不打出来。标准输出最后一行：switched <类型> / already <类型>；
#                                    没成是 failed <现在挂的类型：carpool、solo、other 或 unknown>。退出码：0 成功；64 校验不过；
#                                    其余失败 1。
#
# 法国只有一个会话用户 fleet-agent-carpool（reclaude 一个账户最多挂 4 台设备、一个家目录算一台，创始人 2026-09-26；
# 名字是历史沿用）。它的组织写在家里的 ~/.reclaude/device.json，对它的所有会话一起生效：平时挂拼车，用满切独享、恢复了
# 切回，由引擎在手上没有 Claude 会话时经 org-use 切（#157；切的那一刻在跑的会话 fork 续上是 #59）。
# 原先的 fleet-agent-dedicated 已停用、已删，这里不再认。
# 内存要真封顶，--memory-max 和 --memory-swap-max 得一起给：只给前者，超出的部分会被换进 swap，会话不会被杀（法国实测）。
# run 会 exec 成会话本身：进程号、标准输入输出都还是调用方拿着的那一份。会话看得到的环境：HOME/USER/LOGNAME/SHELL 是会话用户的；
# PATH 取 FLEET_SESSION_PATH（没给就用默认），末尾总接上会话用户家里的 ~/.local/bin（引擎传来的是它自己的 PATH，
# 里面没有；ddgs 这些各用户自己装的命令在那儿）。会话自己写得动的目录一律排最后：放在前面，会话放个同名程序就能顶掉
# fleet 命令和系统命令。另外原样带上 FLEET_*、LANG、LANGUAGE、LC_*、TZ、TERM、GIT_TERMINAL_PROMPT。
# 会话里不许有 GitHub 凭据：推分支、开 PR 由引擎在会话外做，GH_TOKEN 之类一概不放。
# 降权用 setpriv --init-groups --no-new-privs：systemd-run --uid 在 scope 里不清附加组，会话会带着 root 组（法国实测）；
# no-new-privs 让会话里的 sudo、setuid 程序都提不了权。
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
SESSION_USERS=(fleet-agent-carpool)
SLICE=fleet-agents.slice
PREFIX=fleet-agent-
ENV_RE='^(FLEET_[A-Z0-9_]+|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|GIT_TERMINAL_PROMPT)$'
# AI 会话工作树的根（docs/design.md 第十四节「安全」）。测试专用开关，故意不叫 FLEET_*：sudoers 的 env_keep
# 把 fleet 用户环境里的 FLEET_* 原样带进这个以 root 跑的脚本，这个开关要是也叫 FLEET_*，fleet 用户自己在调用
# sudo 前设一个同名变量就能把生产上的落点边界改掉；不在 env_keep 白名单里的名字，sudo 会在进来之前就擦掉它。
WORK_BASE=${AGENT_SCOPE_TEST_WORK_BASE:-/var/lib/fleet-work}
# fs.protected_hardlinks 的读取路径，理由同上：测试专用开关，故意不叫 FLEET_*。
PROTECTED_HARDLINKS_PATH=${AGENT_SCOPE_TEST_PROTECTED_HARDLINKS_PATH:-/proc/sys/fs/protected_hardlinks}
# org-use 用的，理由同上、故意不叫 FLEET_*：换 reclaude 的路径（默认会话用户家里的 ~/.local/bin/reclaude）；
# direct = 不降权直接跑、家目录用 AGENT_SCOPE_TEST_HOME（不经 sudo 直接跑这个脚本的测试用，测试机上没有会话用户）。
RECLAUDE_TEST_BIN=${AGENT_SCOPE_TEST_RECLAUDE:-}
AS_USER_TEST=${AGENT_SCOPE_TEST_AS_USER:-}
HOME_TEST=${AGENT_SCOPE_TEST_HOME:-}
# 一次 reclaude 最多等多久：平时不到 1 秒；reclaude 更新后首跑先「Syncing config…」，要上百秒（引擎的探针也给 150 秒）。
RECLAUDE_TIMEOUT=150
# org-use 整个流程的总时限（秒）：读、切、切完回读核对，没切成还要往回切、再读，加起来不超过它。每一步只给剩下的时间，
# 切之前给切完的核对留 ORG_VERIFY_RESERVE 秒、不够就不切；时间用完照实报「不知道现在挂的是哪个」，不会被调用方半道掐掉
# （adapters 的 switchSessionOrg 等 300 秒，packages/adapters/test/adopt.test.ts 核对它比这里的总时限长）。
# 两个测试专用开关，理由同上、故意不叫 FLEET_*。
ORG_BUDGET=${AGENT_SCOPE_TEST_ORG_BUDGET:-270}
ORG_VERIFY_RESERVE=${AGENT_SCOPE_TEST_ORG_RESERVE:-60}
# timeout 到点先发 TERM，这么多秒还不走再 KILL：算每一步给多少时间时一起扣掉。
RECLAUDE_KILL_AFTER=5
ORG_DEADLINE=0

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
      (($# >= 2)) || die "$1 后面要给一个值"
      user=$2
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
      (($# >= 2)) || die "$1 后面要给一个值"
      cwd=$2
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
  ((ok)) || die "--user 只能是会话用户 ${SESSION_USERS[*]}，给的是「$user」"
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
  path=$path:$home/.local/bin
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

# 把工作树交给会话用户（docs/design.md 第十四节）：不在就建，在就改属主。只有一个会话用户，续会话（含切号后的
# fork）都在同一个家目录里，过程记录不用拷。退出码：0 成功；64 用法/校验不过（下面全部经 die）；其余失败 1。
# 工作树落点（docs/design.md 第十四节）：绝对路径、在 WORK_BASE 之下、至少两层（仓/任务）、每一段只许字母数字和 . _ -
# （不许 . 和 ..）。WORK_BASE 和中间各级都归 root、别人写不进，会话用户没法在路径上塞符号链接；这里照样逐段核对。
check_tree_path() {
  local dir=$1 rel seg
  local -a segs=()
  [[ "$dir" == /* ]] || die "工作树要写绝对路径：「$dir」"
  case $dir in
  "$WORK_BASE"/*) ;;
  *) die "工作树要在 $WORK_BASE 之下：「$dir」" ;;
  esac
  rel=${dir#"$WORK_BASE"/}
  [[ "$rel" == */* ]] || die "工作树至少要在 $WORK_BASE 下两层（仓/任务）：「$dir」"
  IFS=/ read -r -a segs <<<"$rel"
  for seg in "${segs[@]}"; do
    [[ -n "$seg" && "$seg" != . && "$seg" != .. ]] || die "工作树路径里不许有空段、. 和 ..：「$dir」"
    [[ "$seg" =~ ^[A-Za-z0-9._-]+$ ]] || die "工作树路径每一段只许字母、数字和 . _ -：「$dir」"
  done
}

# 路径上 WORK_BASE 到上一级之间各段：不许是符号链接，在的要是目录；make=1 时不在的以 root:root 755 建。
walk_parents() {
  local dir=$1 make=$2 cur seg i
  local -a segs=()
  [[ -d "$WORK_BASE" && ! -L "$WORK_BASE" ]] || die "工作树的根不在或是符号链接：$WORK_BASE"
  IFS=/ read -r -a segs <<<"${dir#"$WORK_BASE"/}"
  cur=$WORK_BASE
  for ((i = 0; i < ${#segs[@]} - 1; i++)); do
    seg=${segs[i]}
    cur=$cur/$seg
    [[ ! -L "$cur" ]] || die "工作树路径上有符号链接：「$cur」"
    if [[ -e "$cur" ]]; then
      [[ -d "$cur" ]] || die "工作树路径上的「$cur」不是目录"
    elif ((make)); then
      install -d -o root -g root -m 755 -- "$cur" || {
        echo "fleet-agent-scope：建不了目录：$cur" >&2
        exit 1
      }
    fi
  done
}

# 把工作树交给 user：不在就建（归它、700），在就整棵改属主（不跟随符号链接）。
ensure_tree() {
  local dir=$1 user=$2 real hardlinks
  walk_parents "$dir" 1
  [[ ! -L "$dir" ]] || die "工作树路径上有符号链接：「$dir」"
  if [[ -e "$dir" ]]; then
    [[ -d "$dir" ]] || die "工作树不是目录：「$dir」"
    real=$(realpath -e -- "$dir" 2>/dev/null) || die "工作树不存在：「$dir」"
    [[ "$real" == "$dir" ]] || die "工作树路径上有符号链接：「$dir」解析成「$real」"
    # chown -R 前先核这台开没开硬链接保护：没开的话，工作树里的会话用户能对自己读不到、写不到的文件建
    # 硬链接，这次 chown -R 会连带把那个文件也改成会话用户的——读不到这个开关（没挂 procfs、路径不对……）
    # 一律当没开处理，不能当「开着」放过去。
    hardlinks=$(cat -- "$PROTECTED_HARDLINKS_PATH" 2>/dev/null) || hardlinks=""
    [[ "$hardlinks" == 1 ]] || {
      echo "fleet-agent-scope：fs.protected_hardlinks 没开（读到「${hardlinks:-读不到}」），不做 chown -R：$dir" >&2
      exit 1
    }
    chown -R --no-dereference "$user:$user" -- "$dir" || {
      echo "fleet-agent-scope：改属主失败：$dir" >&2
      exit 1
    }
  else
    install -d -o "$user" -g "$user" -m 700 -- "$dir" || {
      echo "fleet-agent-scope：建不了工作树：$dir" >&2
      exit 1
    }
  fi
}

# 删一棵工作树：以 root rm -rf，不跟随符号链接（rm 只删链接本身）、不跨文件系统。本来就不在算删好。
remove() {
  local dir=${1:-} real
  [[ -n "$dir" ]] || die "用法：fleet-agent-scope remove <工作树>"
  (($# == 1)) || die "remove 只收一个参数（工作树）"
  check_tree_path "$dir"
  walk_parents "$dir" 0
  if [[ ! -e "$dir" && ! -L "$dir" ]]; then
    echo "gone $dir"
    return 0
  fi
  [[ ! -L "$dir" ]] || die "工作树路径上有符号链接：「$dir」"
  [[ -d "$dir" ]] || die "工作树不是目录：「$dir」"
  real=$(realpath -e -- "$dir" 2>/dev/null) || die "工作树不存在：「$dir」"
  [[ "$real" == "$dir" ]] || die "工作树路径上有符号链接：「$dir」解析成「$real」"
  rm -rf --one-file-system -- "$dir" || {
    echo "fleet-agent-scope：删不掉：$dir" >&2
    exit 1
  }
  echo "removed $dir"
}

adopt() {
  local dir=${1:-} user="" u ok=0
  [[ -n "$dir" ]] || die "用法：fleet-agent-scope adopt <工作树> --user <会话用户>"
  shift
  while (($#)); do
    case $1 in
    --user)
      (($# >= 2)) || die "$1 后面要给一个值"
      user=$2
      shift 2
      ;;
    *) die "不认识的参数：「$1」" ;;
    esac
  done
  # 先验和文件系统无关的：user 的形状，不用等工作树存在就能测
  for u in "${SESSION_USERS[@]}"; do if [[ "$user" == "$u" ]]; then ok=1; fi; done
  ((ok)) || die "--user 只能是会话用户 ${SESSION_USERS[*]}，给的是「$user」"
  check_tree_path "$dir"
  ensure_tree "$dir" "$user"
  echo "已把 $dir 交给 $user"
}

# ---- org-use：切会话用户挂的 reclaude 组织（#157）。全程只认类型，组织编号只在这几个函数里过手，不打出来。

kind_name() { # 后面接「组织」两个字用
  case $1 in
  carpool) echo 拼车 ;;
  solo) echo 独享 ;;
  other) echo 类型认不出的 ;;
  *) echo 认不出的 ;;
  esac
}

# reclaude 的原话进引擎的日志和库之前：三位以上的数（组织编号就是这样的数）、邮箱抹掉，只留末尾一截、压成一行
scrub() {
  printf '%s' "$1" | sed -E 's/[^[:space:]]+@[^[:space:]]+/<邮箱>/g; s/[0-9]{3,}/<数>/g' | tr '\n\r\t' '   ' | tail -c 300
}

org_left() { echo $((ORG_DEADLINE - SECONDS)); }

rc_name() { # timeout 到点停掉的是 124（TERM 停下）或 137（等不及又 KILL）
  case $1 in
  124 | 137) echo "超时被停" ;;
  *) echo "退出码 $1" ;;
  esac
}

# 以会话用户跑它家里的 reclaude，环境清成它自己的，从 / 起。限时：一次最多 RECLAUDE_TIMEOUT，且不越过总时限
# （扣掉 KILL 的余量和要留给后面几步的秒数）；一点都不剩就不跑，回 124
reclaude_as() { # 留给后面的秒数 用户 家目录 参数…
  local reserve=$1 user=$2 home=$3 bin limit
  shift 3
  limit=$((ORG_DEADLINE - SECONDS - RECLAUDE_KILL_AFTER - reserve))
  ((limit <= RECLAUDE_TIMEOUT)) || limit=$RECLAUDE_TIMEOUT
  if ((limit < 1)); then
    echo "总时限 ${ORG_BUDGET} 秒只剩 $(org_left) 秒，这一步没跑"
    return 124
  fi
  bin=${RECLAUDE_TEST_BIN:-$home/.local/bin/reclaude}
  local -a envs=(HOME="$home" USER="$user" LOGNAME="$user" PATH="/usr/local/bin:/usr/bin:/bin:$home/.local/bin" LANG=C.UTF-8)
  if [[ "$AS_USER_TEST" == direct ]]; then
    (cd / && timeout --kill-after="$RECLAUDE_KILL_AFTER" "$limit" env -i "${envs[@]}" "$bin" "$@")
  else
    (cd / && timeout --kill-after="$RECLAUDE_KILL_AFTER" "$limit" /usr/bin/setpriv --reuid="$user" --regid="$user" \
      --init-groups --no-new-privs -- /usr/bin/env -i "${envs[@]}" "$bin" "$@")
  fi
}

# org list 的一行：「* 编号<Tab>名字<Tab>类型<Tab>邮箱」，带 * 的是现在挂的；前后的「Syncing config…」、提示之类都跳过。
# 读成 ORG_ROWS（一行一个「是否当前 编号 类型」，类型 carpool / solo / other）；读不了、一行都认不出回 1，原因在 ORG_WHY
org_rows() { # 用户 家目录
  local out rc line mark id type re=$'^[[:space:]]*(\\*?)[[:space:]]*([0-9]+)\t[^\t]*\t([^\t]*)'
  ORG_ROWS="" ORG_WHY=""
  if out=$(reclaude_as 0 "$1" "$2" org list 2>&1); then rc=0; else rc=$?; fi
  if ((rc != 0)); then
    ORG_WHY="org list 没跑成（$(rc_name "$rc")：$(scrub "$out")）"
    return 1
  fi
  while IFS= read -r line; do
    line=${line%$'\r'}
    [[ "$line" =~ $re ]] || continue
    mark=${BASH_REMATCH[1]:--} id=${BASH_REMATCH[2]} type=${BASH_REMATCH[3],,}
    type=${type//[[:space:]]/}
    case $type in
    team) type=carpool ;;
    personal) type=solo ;;
    *) type=other ;;
    esac
    ORG_ROWS+="$mark $id $type"$'\n'
  done <<<"$out"
  [[ -n "$ORG_ROWS" ]] || {
    ORG_WHY="org list 里一个组织都认不出"
    return 1
  }
}

# 从 ORG_ROWS 认出现在挂的（CUR_ID、CUR_KIND）和要切到的那一类（WANT_ID）：带 * 的、那一类的都要恰好一个。认不出回 1
org_pick() { # 要切到的类型
  local want=$1 mark id type ncur=0 nwant=0
  CUR_ID="" CUR_KIND="" WANT_ID=""
  while read -r mark id type; do
    [[ -n "$id" ]] || continue
    if [[ "$mark" == '*' ]]; then
      ncur=$((ncur + 1))
      CUR_ID=$id CUR_KIND=$type
    fi
    if [[ "$type" == "$want" ]]; then
      nwant=$((nwant + 1))
      WANT_ID=$id
    fi
  done <<<"$ORG_ROWS"
  if ((ncur != 1)); then
    ORG_WHY="org list 里带 * 的有 $ncur 行，认不出现在挂的是哪个"
    CUR_KIND=unknown
    return 1
  fi
  if ((nwant != 1)); then
    ORG_WHY="org list 里$(kind_name "$want")类型的组织有 $nwant 个，不知道切到哪个"
    return 1
  fi
}

org_fail() { # 现在挂的类型 原因：没切成（退出码 1），最后一行 failed <类型>
  printf 'fleet-agent-scope：%s\n' "$2" >&2
  echo "failed $1"
  exit 1
}

org_use() {
  local kind=${1:-} user="" u ok=0 home from_id from_kind out rc now
  [[ "$kind" == carpool || "$kind" == solo ]] || die "要切到哪一类只认 carpool（拼车）或 solo（独享），给的是「$kind」"
  shift
  while (($#)); do
    case $1 in
    --user)
      (($# >= 2)) || die "$1 后面要给一个值"
      user=$2
      shift 2
      ;;
    *) die "不认识的参数：「$1」" ;;
    esac
  done
  for u in "${SESSION_USERS[@]}"; do if [[ "$user" == "$u" ]]; then ok=1; fi; done
  ((ok)) || die "--user 只能是会话用户 ${SESSION_USERS[*]}，给的是「$user」"
  if [[ "$AS_USER_TEST" == direct ]]; then
    home=$HOME_TEST
  else
    home=$(getent passwd "$user" | cut -d: -f6) || home=""
  fi
  [[ "$home" == /* ]] || org_fail unknown "找不到 $user 的家目录"
  # 总时限从这里起算：读、切、核对（和没切成时的往回切、再读）都在它里面
  ORG_DEADLINE=$((SECONDS + ORG_BUDGET))
  org_rows "$user" "$home" || org_fail unknown "$ORG_WHY"
  org_pick "$kind" || org_fail "$CUR_KIND" "$ORG_WHY"
  if [[ "$CUR_ID" == "$WANT_ID" ]]; then
    echo "已经挂着$(kind_name "$kind")组织，不用切"
    echo "already $kind"
    return 0
  fi
  from_id=$CUR_ID from_kind=$CUR_KIND
  # 切之前看时间：切完一定要回读核对，剩下的不够「切 + 给核对留的」就不切（读得慢多半是 reclaude 首跑在同步配置）
  if (($(org_left) - RECLAUDE_KILL_AFTER - ORG_VERIFY_RESERVE < 1)); then
    org_fail "$from_kind" "总时限 ${ORG_BUDGET} 秒只剩 $(org_left) 秒，不够切完再核对，没切；现在挂的还是$(kind_name "$from_kind")组织"
  fi
  if out=$(reclaude_as "$ORG_VERIFY_RESERVE" "$user" "$home" org use "$WANT_ID" 2>&1); then rc=0; else rc=$?; fi
  # 不看退出码下结论，回读核对：退出码 1 也可能已经切了（CC-07），退出码 0 也要看真挂上了没有
  if ! org_rows "$user" "$home" || ! org_pick "$kind"; then
    org_fail unknown "org use $(rc_name "$rc")，切完回读核对不了（$ORG_WHY），不知道现在挂的是哪个，没敢往回切"
  fi
  if [[ "$CUR_ID" == "$WANT_ID" ]]; then
    echo "已从$(kind_name "$from_kind")组织切到$(kind_name "$kind")组织"
    echo "switched $kind"
    return 0
  fi
  # 没切成：挂着的已经不是原来那个了，切回去；再回读一次，照实说现在挂的是哪个
  if [[ "$CUR_ID" != "$from_id" ]]; then
    reclaude_as "$ORG_VERIFY_RESERVE" "$user" "$home" org use "$from_id" >/dev/null 2>&1 || true
  fi
  now=unknown
  if org_rows "$user" "$home" && org_pick "$kind"; then
    if [[ "$CUR_ID" == "$from_id" ]]; then
      org_fail "$from_kind" "没切成（org use $(rc_name "$rc")：$(scrub "$out")），现在挂的还是原来的$(kind_name "$from_kind")组织"
    fi
    now=$CUR_KIND
  fi
  org_fail "$now" "没切成（org use $(rc_name "$rc")：$(scrub "$out")），也没回到原来的$(kind_name "$from_kind")组织：现在挂的是$(kind_name "$now")组织"
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
remove)
  shift
  remove "$@"
  ;;
org-use)
  shift
  org_use "$@"
  ;;
*) die "用法：fleet-agent-scope run <编号> --user <会话用户> [选项] -- /绝对路径/命令 参数… | stop <编号> | list | adopt <工作树> --user <会话用户> | remove <工作树> | org-use <carpool|solo> --user <会话用户>" ;;
esac
