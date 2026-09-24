#!/usr/bin/env bash
# 自检（审计 P02）：以 root 执行的文件，文件本身和每一级父目录都必须属 root、且组和其他人不可写；
# 否则谁能改那个文件，谁就能拿到 root。
# 判据读 systemctl show 的有效配置（合并了 drop-in）：只读单元正文会被 drop-in 里的 User=root 骗过。
# 查哪些路径——有效身份是 root 的单元：全部 Exec* 命令的程序、参数里的脚本（有执行位、脚本扩展名、
# 或解释器后面的第一个操作数；还不存在的也算，别人能在它的目录里造出来）、EnvironmentFile、WorkingDirectory。
# 非 root 单元里带 + 或 ! 前缀的命令照样以 root 跑，同样查。参数里的数据文件（日志之类）不算「执行」。
#
# 单独跑：bash deploy/lib/root-exec-check.sh   只读；干净退出 0，有违规退出 1，没查成退出 2。
# 测试时用 ROOT_EXEC_CHECK_SHOW=<文件> 喂一份假的 systemctl show 输出。

REC_PROPS=Id,LoadState,User,DynamicUser,WorkingDirectory,EnvironmentFiles,ExecConditionEx,ExecStartPreEx,ExecStartEx,ExecStartPostEx,ExecReloadEx,ExecStopEx,ExecStopPostEx
REC_INTERP_RE='^(node|nodejs|bun|deno|tsx|python[0-9.]*|bash|sh|dash|zsh|perl|ruby|php[0-9.]*|lua[0-9.]*)$'
REC_SCRIPT_RE='[.](sh|bash|js|mjs|cjs|ts|mts|cts|py|pl|rb|php|lua|jar|nft)$'
declare -gA REC_NODE=()    # 路径节点 → 违规原因（空 = 干净）；每个节点只 stat 一次
declare -gA REC_VERDICT=() # 被查路径 → 违规原因（空 = 干净）
declare -gA REC_CULPRIT=() # 被查路径 → 出问题的那个节点（文件本身或某级父目录）
REC_VIOLATIONS=()          # 每条：单元<TAB>路径（用途）<TAB>原因<TAB>出问题的节点
REC_WHY=""
REC_AT="" # 最近一次判出问题的节点

rec_show() {
  if [[ -n "${ROOT_EXEC_CHECK_SHOW:-}" ]]; then
    cat -- "$ROOT_EXEC_CHECK_SHOW"
    return
  fi
  local units
  # 装了但没加载的单元文件也要查：它下次开机或被定时器拉起时照样以 root 跑。模板本身（foo@.service）查不了，查它加载着的实例。
  units=$({
    systemctl list-units --all --plain --no-legend --type=service
    systemctl list-unit-files --type=service --no-legend
  } | awk '$1 ~ /[.]service$/ && $1 !~ /@[.]service$/ { print $1 }' | sort -u)
  [[ -n "$units" ]] || return 1
  # shellcheck disable=SC2086 # 单元名不含空白，按词拆开正是要的
  systemctl show -p "$REC_PROPS" $units
}

# 把 systemctl show 的输出摊平成一行一件事：
#   U|单元|LoadState|User|DynamicUser    W|单元|WorkingDirectory    E|单元|EnvironmentFile
#   X|单元|flags|程序路径|argv（空格分隔）
rec_flatten() {
  awk 'BEGIN { RS = ""; FS = "\n" }
    {
      id = ""; load = ""; user = ""; dyn = ""; n = 0
      for (i = 1; i <= NF; i++) {
        line = $i; eq = index(line, "="); k = substr(line, 1, eq - 1); v = substr(line, eq + 1)
        if (k == "Id") id = v
        else if (k == "LoadState") load = v
        else if (k == "User") user = v
        else if (k == "DynamicUser") dyn = v
        else if (k == "WorkingDirectory" && v != "") out[++n] = "W|" v
        else if (k == "EnvironmentFiles" && v != "") { sub(/ [(].*$/, "", v); out[++n] = "E|" v }
        else if (k ~ /^Exec.*Ex$/ && v ~ /^[{] /) {
          inner = substr(v, 3); sub(/ [}]$/, "", inner)
          m = split(inner, parts, " ; "); path = ""; argv = ""; flags = ""
          for (j = 1; j <= m; j++) {
            if (parts[j] ~ /^path=/) path = substr(parts[j], 6)
            else if (parts[j] ~ /^argv\[\]=/) argv = substr(parts[j], 8)
            else if (parts[j] ~ /^flags=/) flags = substr(parts[j], 7)
          }
          out[++n] = "X|" flags "|" path "|" argv
        }
      }
      if (id == "") next
      print "U|" id "|" load "|" user "|" dyn
      for (j = 1; j <= n; j++) print substr(out[j], 1, 2) id substr(out[j], 2)
      delete out
    }'
}

# 一个节点本身：属 root，且组和其他人都不能写。符号链接只看属主（链接本身的权限位没有意义）。
rec_node() {
  local f=$1 uid mode
  if [[ -n "${REC_NODE[$f]+查过}" ]]; then
    REC_WHY=${REC_NODE[$f]}
    return 0
  fi
  REC_WHY=""
  if ! read -r uid mode < <(stat -c '%u %a' -- "$f" 2>/dev/null) || [[ -z "$mode" ]]; then
    REC_WHY="$f 读不到属主和权限"
  elif [[ -L "$f" ]]; then
    if ((uid != 0)); then REC_WHY="$f 属主不是 root（uid $uid）"; fi
  else
    if ((uid != 0)); then
      REC_WHY="$f 属主不是 root（$(stat -c '%U:%G' -- "$f") $mode）"
    elif ((8#$mode & 8#022)); then
      REC_WHY="$f 组或其他人可写（$(stat -c '%U:%G' -- "$f") $mode）"
    fi
  fi
  REC_NODE[$f]=$REC_WHY
  return 0
}

# 路径本身（在的话）和每一级存在的父目录；往上第一个存在的目录要是别人能写，别人就能在里面把这个路径造出来。
rec_chain() {
  local d=$1
  REC_WHY=""
  REC_AT=""
  if [[ -e "$d" || -L "$d" ]]; then
    rec_node "$d"
    if [[ -n "$REC_WHY" ]]; then
      REC_AT=$d
      return 0
    fi
  fi
  while [[ "$d" != / ]]; do
    d=${d%/*}
    d=${d:-/}
    if [[ -e "$d" ]]; then
      rec_node "$d"
      if [[ -n "$REC_WHY" ]]; then
        REC_AT=$d
        return 0
      fi
    fi
  done
  return 0
}

rec_check_path() { # 单元 路径 用途
  local unit=$1 p=$2 use=$3 real
  [[ "$p" == /* ]] || return 0
  if [[ -n "${REC_VERDICT[$p]+查过}" ]]; then
    REC_WHY=${REC_VERDICT[$p]}
    REC_AT=${REC_CULPRIT[$p]}
  else
    rec_chain "$p"
    if [[ -z "$REC_WHY" ]]; then
      # 链接的另一头也查：/bin → usr/bin 这类
      real=$(realpath -m -- "$p" 2>/dev/null) || real=$p
      if [[ "$real" != "$p" ]]; then rec_chain "$real"; fi
    fi
    REC_VERDICT[$p]=$REC_WHY
    REC_CULPRIT[$p]=$REC_AT
  fi
  if [[ -n "$REC_WHY" ]]; then REC_VIOLATIONS+=("$unit	$p（$use）	$REC_WHY	$REC_AT"); fi
  return 0
}

rec_check_argv() { # 单元 程序 argv
  local unit=$1 prog=$2 tok p toks operand=0 is_operand
  read -r -a toks <<<"$3" # 按空白拆，不做通配展开
  if [[ "${prog##*/}" =~ $REC_INTERP_RE ]]; then operand=1; fi
  for tok in "${toks[@]:1}"; do # argv[0] 就是程序本身
    tok=${tok#[\"\']}
    tok=${tok%[\"\';]}
    is_operand=0
    if ((operand)) && [[ "$tok" != -* ]]; then
      is_operand=1
      operand=0
    fi
    p=""
    if [[ "$tok" == /* ]]; then
      p=$tok
    elif [[ "$tok" =~ ^-[^=]*=(/.*)$ ]]; then
      p=${BASH_REMATCH[1]}
    fi
    [[ -n "$p" ]] || continue
    if ((is_operand)) || [[ "$p" =~ $REC_SCRIPT_RE ]] || [[ -f "$p" && -x "$p" ]]; then
      rec_check_path "$unit" "$p" 参数
    fi
  done
  return 0
}

# 跑一遍：违规记进 REC_VIOLATIONS。返回 0 干净、1 有违规、2 没查成（拿不到 systemctl show 的输出）。
root_exec_check() {
  local shown kind unit a b c is_root=-1
  REC_VIOLATIONS=()
  shown=$(rec_show) || return 2
  [[ -n "$shown" ]] || return 2
  while IFS='|' read -r kind unit a b c; do
    case $kind in
    U)
      # a=LoadState b=User c=DynamicUser；没写 User= 就是 root。没加载成（masked、not-found）的不会跑，跳过。
      if [[ "$a" != loaded ]]; then
        is_root=-1
      elif [[ "$c" != yes && ("$b" == "" || "$b" == root || "$b" == 0) ]]; then
        is_root=1
      else
        is_root=0
      fi
      ;;
    X)
      # a=flags b=程序 c=argv；+ 前缀是 privileged，! 前缀是 no-setuid：都照样以 root 跑
      if ((is_root == 1)) || { ((is_root == 0)) && [[ "$a" == *privileged* || "$a" == *no-setuid* ]]; }; then
        rec_check_path "$unit" "$b" 程序
        rec_check_argv "$unit" "$b" "$c"
      fi
      ;;
    E)
      if ((is_root == 1)); then rec_check_path "$unit" "${a#-}" EnvironmentFile; fi
      ;;
    W)
      if ((is_root == 1)) && [[ "$a" != "~" ]]; then rec_check_path "$unit" "${a#[-!]}" WorkingDirectory; fi
      ;;
    esac
  done < <(printf '%s\n' "$shown" | rec_flatten)
  if ((${#REC_VIOLATIONS[@]})); then return 1; fi
  return 0
}

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  set -uo pipefail
  root_exec_check
  rc=$?
  if ((rc == 2)); then
    echo "没查成：拿不到 systemctl show 的输出" >&2
    exit 2
  fi
  if ((rc == 1)); then
    printf '以 root 执行、但别人能改的路径 %d 处：\n' "${#REC_VIOLATIONS[@]}"
    printf '  %s\n' "${REC_VIOLATIONS[@]}"
    exit 1
  fi
  echo "干净：以 root 执行的文件全链属 root 且组和其他人不可写"
fi
