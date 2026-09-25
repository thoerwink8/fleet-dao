#!/usr/bin/env bash
# shellcheck disable=SC2034 # DDGS_HAVE、CLI_TOOL_BAD 是给调用方读的
# 给一个用户装、查 ddgs（skill docs-lookup 首选的搜索命令行）：以他自己的身份 uv tool install，装在他自己家里
# （~/.local/share/uv/tools/ddgs，命令链到 ~/.local/bin/ddgs），写出来的都归他。只用系统的 Python，不让 uv 另下一个。
# france.sh 和 deploy/test/cli-tools.test.sh 共用；要先 source common.sh（as_user、ok、changed、red）。

DDGS_HAVE=""    # ddgs_version 读到的版本号
CLI_TOOL_BAD="" # ddgs_version 没读成时的原因

# 装着的 ddgs 是哪一版：以那个用户的身份、用 as_user 的 PATH（家里的 .local/bin 在最前）跑 ddgs version。
# 读成了返回 0、版本进 DDGS_HAVE；没装、跑不起来、输出认不出都返回 1，原因进 CLI_TOOL_BAD（不拿空当「没问题」）
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

# 装 ddgs：已经是钉住的那一版就不动；否则以那个用户的身份 uv tool install --force 那一版，装完再读一遍版本。
# 没装上只记红、不中断装机（一个搜索工具不值得停下整台机器的装机），读回那一步还会再判一次
ensure_ddgs() { # 用户 uv 的路径 版本
  local u=$1 uv=$2 want=$3 log rc=0
  if ddgs_version "$u" && [[ "$DDGS_HAVE" == "$want" ]]; then
    ok "$u 的 ddgs 是 $want"
    return 0
  fi
  log=$(as_user "$u" "$uv" --no-cache --python-preference only-system tool install --force "ddgs==$want" 2>&1) || rc=$?
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
  changed "$u 装 ddgs $want（uv tool install，装在他自己家里）"
}

# 读回：ddgs 在不在、是不是钉住的那一版
check_ddgs() { # 用户 版本
  if ! ddgs_version "$1"; then
    red "$1：$CLI_TOOL_BAD"
  elif [[ "$DDGS_HAVE" != "$2" ]]; then
    red "$1 的 ddgs 是 $DDGS_HAVE，应为 $2"
  else
    ok "$1 的 ddgs 是 $DDGS_HAVE（docs-lookup 首选的搜索命令行）"
  fi
}
