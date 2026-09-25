#!/usr/bin/env bash
# shellcheck disable=SC2034 # DDGS_HAVE、CLI_TOOL_BAD 是给调用方读的
# 给一个用户装、查 ddgs（skill docs-lookup 首选的搜索命令行）：以他自己的身份 uv tool install，装在他自己家里
# （~/.local/share/uv/tools/ddgs，命令链到 ~/.local/bin/ddgs），写出来的都归他。只用系统的 Python，不让 uv 另下一个。
# ddgs 自己和它的依赖都钉死版本（依赖里 primp、lxml 带编译好的二进制，不钉就是每次新装拿当时最新的）；
# 这些是 PyPI 上的包，只钉版本、不核校验和。装和查都按虚拟环境里实际装着的逐个核对，不只看 ddgs 自己的版本号。
# 他家里的东西他自己改得动（会话用户就是 AI 会话），所以：PATH 里他写得动的 ~/.local/bin 排最后（和 fleet-agent-scope
# 给会话的一样），uv 不读他家里的配置（--no-config），读回防他让 ddgs 卡住（见 ddgs_version）。
# france.sh 和 deploy/test/cli-tools.test.sh 共用；要先 source common.sh（ok、changed、red）。

DDGS_HAVE=""    # ddgs_version 读到的版本号
CLI_TOOL_BAD="" # ddgs_version 没读成、ddgs_pinned 对不上时的原因

# 和 fleet-agent-scope 给会话的默认 PATH 一样：系统目录在前，他自己写得动的 ~/.local/bin 接在最后
# （放在前面，他放个同名的 python3、timeout 就能顶掉系统的）
tool_path() { printf '/usr/local/bin:/usr/bin:/bin:%s/.local/bin' "$1"; } # 家目录

# 以那个用户的身份跑一条命令：环境清干净（和 common.sh 的 as_user 一样），只是 PATH 用 tool_path
as_tool_user() { # 用户 命令…
  local user=$1 home
  shift
  home=$(getent passwd "$user" | cut -d: -f6)
  (cd -- "$home" && runuser -u "$user" -- env -i HOME="$home" USER="$user" LOGNAME="$user" \
    PATH="$(tool_path "$home")" LANG=C.UTF-8 "$@")
}

# 装着的 ddgs 是哪一版：以那个用户的身份跑 ddgs version。读成了返回 0、版本进 DDGS_HAVE；
# 没装、跑不起来、卡住、输出认不出都返回 1，原因进 CLI_TOOL_BAD。
# 照 login-user.sh 问登录 shell 的做法防卡：输出落进 root 建的临时文件，不走 $(...) 的管道（他留个后台进程占着写端，
# 管道就一直等）；setsid 不带控制终端（不和 root 共用终端，抢终端会被挂起）；timeout 到 10 秒叫停，不理叫停的再过
# 5 秒强杀——被强杀时 timeout 连自己一起杀掉，退出码是 137 而不是 124
ddgs_version() { # 用户
  local u=$1 home out rc=0 probe
  DDGS_HAVE=""
  CLI_TOOL_BAD=""
  home=$(getent passwd "$u" | cut -d: -f6)
  if ! probe=$(mktemp "${TMPDIR:-/var/tmp}/fleet-dao-ddgs-probe.XXXXXX" 2>/dev/null); then
    CLI_TOOL_BAD="建不了放 ddgs version 输出的临时文件（${TMPDIR:-/var/tmp}），没查成"
    return 1
  fi
  (cd -- "$home" && runuser -u "$u" -- env -i HOME="$home" USER="$u" LOGNAME="$u" PATH="$(tool_path "$home")" \
    LANG=C.UTF-8 /usr/bin/setsid -w /usr/bin/timeout -k 5 10 ddgs version </dev/null >"$probe" 2>&1) || rc=$?
  out=$(<"$probe")
  rm -f -- "$probe"
  if ((rc == 127)); then
    CLI_TOOL_BAD="没装 ddgs（PATH 和 ~/.local/bin 里都没有）"
    return 1
  fi
  if ((rc == 124 || rc == 137)); then
    CLI_TOOL_BAD="ddgs version 卡住，被 timeout 叫停（退出码 $rc：124＝到 10 秒叫停，137＝不理叫停、再过 5 秒被强杀）"
    return 1
  fi
  if ((rc != 0)); then
    CLI_TOOL_BAD="ddgs version 退出 $rc：$(tail -2 <<<"$out" | tr '\n' ' ')"
    return 1
  fi
  if [[ ! "$out" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    CLI_TOOL_BAD="ddgs version 的输出认不出：「${out:0:80}」"
    return 1
  fi
  DDGS_HAVE=$out
}

# 「名==版本」一行一个，规范成同一个写法：名字里的 - 和 . 换成 _，整行转小写，排好序。
# 装着的（dist-info 目录名）和钉住的（france.sh 顶部写的）两边都过这一道再比
ddgs_norm() {
  local line name
  while IFS= read -r line; do
    if [[ -z "$line" ]]; then continue; fi
    name=${line%%==*}
    line="${name//[-.]/_}==${line#*==}"
    printf '%s\n' "${line,,}"
  done | LC_ALL=C sort
}

# ddgs 的虚拟环境里实际装着哪些包：照 dist-info 目录名（「名-版本.dist-info」）读成规范过的「名==版本」
ddgs_installed() { # 用户
  local home d
  home=$(getent passwd "$1" | cut -d: -f6) || home=""
  for d in "$home"/.local/share/uv/tools/ddgs/lib/python3*/site-packages/*.dist-info; do
    if [[ ! -d "$d" ]]; then continue; fi
    d=${d##*/}
    d=${d%.dist-info}
    printf '%s==%s\n' "${d%%-*}" "${d#*-}"
  done | ddgs_norm
}

# 装着的和钉住的一模一样（ddgs 自己加各个依赖）才返回 0；否则返回 1，原因进 CLI_TOOL_BAD
ddgs_pinned() { # 用户 版本 依赖（名==版本）…
  local u=$1 want have
  shift
  want=$(printf '%s\n' "ddgs==$1" "${@:2}" | ddgs_norm)
  have=$(ddgs_installed "$u")
  if [[ "$have" == "$want" ]]; then return 0; fi
  CLI_TOOL_BAD="ddgs 的虚拟环境里装的是「${have//$'\n'/ }」，应为「${want//$'\n'/ }」"
  return 1
}

# 装 ddgs：命令能跑、版本对、虚拟环境里的包和钉住的一样，就不动；否则以那个用户的身份 uv tool install --force，
# 依赖用 --with 写死版本一起装，装完再核一遍。uv 失败只记红、不中断装机（一个搜索工具不值得停下整台机器的装机），
# 读回那一步还会再判一次。下载 uv 本身失败的，france.sh 按装机的规矩停下：那一步排在装机最后，规矩已经写完
ensure_ddgs() { # 用户 uv 的路径 版本 依赖（名==版本）…
  local u=$1 uv=$2 want=$3 log rc=0 dep
  shift 3
  local with=()
  for dep in "$@"; do with+=(--with "$dep"); done
  if ddgs_version "$u" && [[ "$DDGS_HAVE" == "$want" ]] && ddgs_pinned "$u" "$want" "$@"; then
    ok "$u 的 ddgs 是 $want，依赖和钉住的一样"
    return 0
  fi
  log=$(as_tool_user "$u" "$uv" --no-config --no-cache --python-preference only-system \
    tool install --force "ddgs==$want" "${with[@]}" 2>&1) || rc=$?
  if ((rc != 0)); then
    red "$u 装 ddgs $want 没装上（uv 退出 $rc）：$(tail -3 <<<"$log" | tr '\n' ' ')"
    return 0
  fi
  if ! ddgs_version "$u"; then
    red "$u 装完 ddgs 还是用不了（应为 $want）：$CLI_TOOL_BAD"
    return 0
  fi
  if [[ "$DDGS_HAVE" != "$want" ]]; then
    red "$u 装完 ddgs 是 $DDGS_HAVE，应为 $want"
    return 0
  fi
  if ! ddgs_pinned "$u" "$want" "$@"; then
    red "$u 装完：$CLI_TOOL_BAD"
    return 0
  fi
  changed "$u 装 ddgs $want（依赖 $* 一起钉住；uv tool install，装在他自己家里）"
}

# 读回：ddgs 在不在、是不是钉住的那一版、虚拟环境里的依赖对不对
check_ddgs() { # 用户 版本 依赖（名==版本）…
  local u=$1 want=$2
  shift 2
  if ! ddgs_version "$u"; then
    red "$u：$CLI_TOOL_BAD"
  elif [[ "$DDGS_HAVE" != "$want" ]]; then
    red "$u 的 ddgs 是 $DDGS_HAVE，应为 $want"
  elif ! ddgs_pinned "$u" "$want" "$@"; then
    red "$u：$CLI_TOOL_BAD"
  else
    ok "$u 的 ddgs 是 $DDGS_HAVE，依赖和钉住的一样（docs-lookup 首选的搜索命令行）"
  fi
}
