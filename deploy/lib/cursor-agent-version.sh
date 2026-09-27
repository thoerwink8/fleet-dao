#!/bin/sh
# 以会话用户的身份跑（lib/cursor-agent.sh 读出正文、经 sh -c 交给他；参数是版本目录）：照引擎起 cursor-agent 的找法挑出
# 引擎会跑的那一个，先打一行它的路径，再 exec 它 --version；一个能跑的都没有就什么都不打、退出 127。
# 改这里之前必须知道：找法必须和 packages/engine/src/real/hosts.ts 的 CURSOR_LAUNCH_SCRIPT 一样（先 current，再按版本号
# 倒序挑第一个能跑的；目录名只认「数字.数字」开头的，安装时的临时目录不认）。engine 的 hosts.test.ts 拿同一批版本目录把
# 两边都真跑一遍，挑的不一样就红。
dir=$1
bin=
if [ -x "$dir/current/cursor-agent" ]; then
  bin=$dir/current/cursor-agent
else
  # shellcheck disable=SC2010 # 照引擎那段原样：认的目录名是版本号的样子（没有空格），sort -V 要一行一个
  for v in $(ls -1 "$dir" 2>/dev/null | grep -E '^[0-9]+\.[0-9][0-9A-Za-z._-]*$' | sort -rV); do
    if [ -x "$dir/$v/cursor-agent" ]; then
      bin=$dir/$v/cursor-agent
      break
    fi
  done
fi
if [ -z "$bin" ]; then exit 127; fi
printf '%s\n' "$bin"
exec "$bin" --version
