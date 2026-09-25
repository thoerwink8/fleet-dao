#!/usr/bin/env bash
# shellcheck disable=SC2034 # DDGS_HAVE、CLI_TOOL_BAD 是给调用方读的
# 给一个用户装、查 ddgs（skill docs-lookup 首选的搜索命令行）：以他自己的身份 uv tool install，装在他自己家里
# （~/.local/share/uv/tools/ddgs，命令链到 ~/.local/bin/ddgs），写出来的都归他。只用系统的 Python，不让 uv 另下一个。
# ddgs 自己和它的依赖都钉死版本（依赖里 primp、lxml 带编译好的二进制，不钉就是每次新装拿当时最新的）；
# 这些是 PyPI 上的包，只钉版本、不核校验和。装和查都按虚拟环境里实际装着的逐个核对，不只看 ddgs 自己的版本号。
# france.sh 和 deploy/test/cli-tools.test.sh 共用；要先 source common.sh（as_user、ok、changed、red）。

DDGS_HAVE=""    # ddgs_version 读到的版本号
CLI_TOOL_BAD="" # ddgs_version 没读成、ddgs_pinned 对不上时的原因

# 装着的 ddgs 是哪一版：以那个用户的身份、用 as_user 的 PATH（家里的 .local/bin 在最前，和 fleet-agent-scope 给会话的一样）
# 跑 ddgs version。读成了返回 0、版本进 DDGS_HAVE；没装、跑不起来、输出认不出都返回 1，原因进 CLI_TOOL_BAD
ddgs_version() { # 用户
  local out rc=0
  DDGS_HAVE=""
  CLI_TOOL_BAD=""
  out=$(as_user "$1" timeout 30 ddgs version 2>&1) || rc=$?
  if ((rc == 127)); then
    CLI_TOOL_BAD="没装 ddgs（~/.local/bin 和 PATH 里都没有）"
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

# ddgs 的虚拟环境里实际装着哪些包：照 dist-info 目录名读成「名==版本」，一行一个、排好序（名字里的 - 在目录名里是 _）
ddgs_installed() { # 用户
  local home d
  home=$(getent passwd "$1" | cut -d: -f6) || home=""
  for d in "$home"/.local/share/uv/tools/ddgs/lib/python3*/site-packages/*.dist-info; do
    if [[ ! -d "$d" ]]; then continue; fi
    d=${d##*/}
    d=${d%.dist-info}
    printf '%s==%s\n' "${d%%-*}" "${d#*-}"
  done | LC_ALL=C sort
}

# 装着的和钉住的一模一样（ddgs 自己加各个依赖）才返回 0；否则返回 1，原因进 CLI_TOOL_BAD。
# 两边都规范成 dist-info 目录名的写法再比：小写，名字里的 - 和 . 换成 _
ddgs_pinned() { # 用户 版本 依赖（名==版本）…
  local u=$1 want="" have pin name
  shift
  for pin in "ddgs==$1" "${@:2}"; do
    name=${pin%%==*}
    want+="${name//[-.]/_}==${pin#*==}"$'\n'
  done
  want=$(printf '%s' "${want,,}" | LC_ALL=C sort)
  have=$(ddgs_installed "$u")
  have=${have,,}
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
  log=$(as_user "$u" "$uv" --no-cache --python-preference only-system tool install --force "ddgs==$want" "${with[@]}" 2>&1) || rc=$?
  if ((rc != 0)); then
    red "$u 装 ddgs $want 没装上（uv 退出 $rc）：$(tail -3 <<<"$log" | tr '\n' ' ')"
    return 0
  fi
  if ! ddgs_version "$u"; then
    red "$u 装完 ddgs 还是用不了：$CLI_TOOL_BAD"
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
