#!/usr/bin/env bash
# shellcheck disable=SC2034 # CURSOR_AGENT_HAVE、CURSOR_AGENT_BIN、CURSOR_AGENT_ABSENT 是给调用方读的
# 给会话用户装、查 cursor-agent（#212 接上的第二家执行方式；引擎每次起 Cursor 会话，由会话用户在他家里的版本目录里现找）。
# 装：照引擎的找法一个能跑的都找不到时才装，用官方安装脚本、以这个用户自己的身份跑，装在他家里
# （~/.local/share/cursor-agent/versions/<版本>/，命令链到 ~/.local/bin/cursor-agent），写出来的都归他；找得到就不动
# （不重装、不升级），之后它自己升级（升级会删掉旧版本目录，所以不钉版本）。登录不在这里：要创始人在浏览器里批准
# （docs/ops.md 第五节）。
# 安装脚本和它下的包都不核校验和：官方没给，安装脚本里写死了当时的版本号、每次发版换一份；它只以会话用户的身份跑，
# 出了事也只在会话用户自己家里——会话用户本来就要跑 cursor-agent，cursor-agent 自己升级也从同一处下、一样不核。
# 安装脚本先整个下下来再跑（不 curl | bash：它没包在函数里，下到一半断了会跑半截）；它自己不查每一步成没成，
# 退出 0 也不算装成，装完照读回的判法再核一遍。
# 查：以这个用户的身份照引擎的找法挑出引擎会跑的那一个、跑它的 --version（lib/cursor-agent-version.sh）。
# france.sh 和 deploy/test/cursor-agent.test.sh 共用；要先 source common.sh（ok、changed、red）和 cli-tools.sh（tool_path）。

CURSOR_AGENT_HAVE=""             # cursor_agent_version 读到的版本号
CURSOR_AGENT_BIN=""              # 引擎会跑的那一个
CURSOR_AGENT_BAD=""              # 没读成的原因
CURSOR_AGENT_ABSENT=0            # 没读成时：1＝一个能跑的都没有（没装），0＝有、但跑不成，或者没查成
CURSOR_AGENT_TIMEOUT=20          # --version 等几秒
CURSOR_AGENT_INSTALL_TIMEOUT=900 # 安装脚本等几秒（要下一百多兆的包）
CURSOR_AGENT_PROBE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/cursor-agent-version.sh
CURSOR_AGENT_VERSION_RE='^[0-9]+\.[0-9][0-9A-Za-z._-]*$' # 和版本目录名一个样子（2026.09.26-dd393fe）

# 以那个用户的身份跑一条命令：环境和 cli-tools.sh 的 as_tool_user 一样清干净；照 ddgs_version 防卡——不带控制终端
# （setsid：不和 root 共用终端，抢终端会被挂起），到点叫停、不理叫停的再过 5 秒强杀（被强杀时 timeout 连自己一起杀掉，
# 退出码是 137 而不是 124）；标准输出、标准错误落进 root 建的两个文件（不走 $(...) 的管道：他留个后台进程占着写端，
# 管道就一直等）。返回命令的退出码
cursor_agent_as() { # 用户 家目录 秒数 标准输出文件 标准错误文件 命令…
  local u=$1 home=$2 secs=$3 out=$4 err=$5
  shift 5
  (cd -- "$home" && runuser -u "$u" -- env -i HOME="$home" USER="$u" LOGNAME="$u" PATH="$(tool_path "$home")" \
    LANG=C.UTF-8 /usr/bin/setsid -w /usr/bin/timeout -k 5 "$secs" "$@") </dev/null >"$out" 2>"$err"
}

# 报错里带的那几行：去掉终端控制符（安装脚本不管有没有终端都打光标上移），\r 刷新的进度条拆成行，留最后 3 行非空的
cursor_agent_tail() { # 文本
  local t
  # shellcheck disable=SC2001 # 按正则去终端控制符，${//} 做不了
  t=$(sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' <<<"$1" | tr '\r' '\n' | grep -v '^[[:space:]]*$' | tail -3 | tr '\n' ' ') || true
  t=${t% }
  t=${t:-（没有输出）}
  printf '%s' "${t:0:300}"
}

# 以那个用户的身份、照引擎的找法跑一次 --version。读成了返回 0，版本进 CURSOR_AGENT_HAVE、路径进 CURSOR_AGENT_BIN；
# 没装、跑不起来、卡住、输出认不出、没查成都返回 1，原因进 CURSOR_AGENT_BAD，其中没装的另把 CURSOR_AGENT_ABSENT 记成 1
# （只认「一个能跑的都没有」：找的那段什么都不打、退出 127；别的起不来也退出 127 的会在标准错误里留话，算没跑成）
cursor_agent_version() { # 用户 版本目录
  local u=$1 dir=$2 home script tmp out err rc=0 rest what=cursor-agent lines=()
  CURSOR_AGENT_HAVE="" CURSOR_AGENT_BIN="" CURSOR_AGENT_BAD="" CURSOR_AGENT_ABSENT=0
  if ! script=$(cat -- "$CURSOR_AGENT_PROBE" 2>/dev/null) || [[ -z "$script" ]]; then
    CURSOR_AGENT_BAD="读不到 $CURSOR_AGENT_PROBE，cursor-agent 没查成"
    return 1
  fi
  home=$(getent passwd "$u" | cut -d: -f6) || home=""
  if [[ -z "$home" ]]; then
    CURSOR_AGENT_BAD="getent 查不到 $u 的家目录，cursor-agent 没查成"
    return 1
  fi
  if ! tmp=$(mktemp -d "${TMPDIR:-/var/tmp}/fleet-dao-cursor-probe.XXXXXX" 2>/dev/null); then
    CURSOR_AGENT_BAD="建不了放 cursor-agent --version 输出的临时目录（${TMPDIR:-/var/tmp}），没查成"
    return 1
  fi
  cursor_agent_as "$u" "$home" "$CURSOR_AGENT_TIMEOUT" "$tmp/out" "$tmp/err" /bin/sh -c "$script" cursor-agent "$dir" || rc=$?
  out=$(cat -- "$tmp/out") || out=""
  err=$(cat -- "$tmp/err") || err=""
  rm -rf -- "$tmp"
  if ((rc == 124 || rc == 137)); then
    if [[ -n "$out" ]]; then what=${out%%$'\n'*}; fi
    CURSOR_AGENT_BAD="$what --version 卡住，被 timeout 叫停（退出码 $rc：124＝到 $CURSOR_AGENT_TIMEOUT 秒叫停，137＝不理叫停、再过 5 秒被强杀）"
    return 1
  fi
  if [[ -z "$out" ]]; then
    if ((rc == 127)) && [[ -z "$err" ]]; then
      CURSOR_AGENT_ABSENT=1
      CURSOR_AGENT_BAD="没装 cursor-agent（$dir 下既没有 current，也没有能跑的版本目录）"
    else
      CURSOR_AGENT_BAD="以 $u 的身份找 cursor-agent 没跑成（退出 $rc）：$(cursor_agent_tail "$err")"
    fi
    return 1
  fi
  mapfile -t lines <<<"$out"
  if [[ "${lines[0]}" != "$dir"/*/cursor-agent ]]; then
    CURSOR_AGENT_BAD="找 cursor-agent 的输出认不出（第一行该是 $dir 下的路径）：「${out:0:120}」"
    return 1
  fi
  CURSOR_AGENT_BIN=${lines[0]}
  if ((rc != 0)); then
    CURSOR_AGENT_BAD="$CURSOR_AGENT_BIN --version 退出 $rc：$(cursor_agent_tail "$err")"
    return 1
  fi
  if ((${#lines[@]} != 2)) || [[ ! "${lines[1]}" =~ $CURSOR_AGENT_VERSION_RE ]]; then
    rest=""
    if ((${#lines[@]} > 1)); then rest=$(printf '%s ' "${lines[@]:1}"); fi
    rest=${rest% }
    CURSOR_AGENT_BAD="$CURSOR_AGENT_BIN --version 的输出认不出（该是一行版本号）：「${rest:0:120}」"
    return 1
  fi
  CURSOR_AGENT_HAVE=${lines[1]}
}

# 装 cursor-agent：照引擎的找法找得到能跑的就不动；一个都没有才以这个用户的身份下官方安装脚本、跑它，装完再核一遍。
# 装着却跑不成、没查成的不重装、不删，只记红（先看清是什么）。都只记红、不中断装机（一个执行方式不值得停下整台机器的
# 装机），读回还会再判一次
ensure_cursor_agent() { # 用户 版本目录 安装脚本地址
  local u=$1 dir=$2 url=$3 home tmp rc=0 log
  if cursor_agent_version "$u" "$dir"; then
    ok "$u 已有 cursor-agent $CURSOR_AGENT_HAVE（引擎会跑的是 $CURSOR_AGENT_BIN），不重装（之后它自己升级）"
    return 0
  fi
  if ((CURSOR_AGENT_ABSENT == 0)); then
    red "$u 的 cursor-agent：$CURSOR_AGENT_BAD；不重装、不删，先看清是什么"
    return 0
  fi
  home=$(getent passwd "$u" | cut -d: -f6) || home=""
  if ! tmp=$(mktemp -d "${TMPDIR:-/var/tmp}/fleet-dao-cursor-install.XXXXXX" 2>/dev/null); then
    red "建不了放 cursor-agent 安装输出的临时目录（${TMPDIR:-/var/tmp}），$u 的 cursor-agent 没装"
    return 0
  fi
  # 这个用户自己的 shell 里：安装脚本下进他自己的临时文件、下全了再跑，标准错误并进标准输出（按先后留在一个文件里）
  # shellcheck disable=SC2016 # 单引号里的东西要在这个用户的 shell 里展开
  cursor_agent_as "$u" "$home" "$CURSOR_AGENT_INSTALL_TIMEOUT" "$tmp/out" "$tmp/err" /bin/sh -c 'exec 2>&1
    t=$(mktemp) || exit 1
    if ! curl -fsSL --retry 3 --max-time 120 -o "$t" "$1"; then rm -f "$t"; echo "下不到安装脚本：$1"; exit 1; fi
    /bin/bash "$t"
    rc=$?
    rm -f "$t"
    exit "$rc"' cursor-install "$url" || rc=$?
  log=$(cat -- "$tmp/err" "$tmp/out" 2>/dev/null) || true
  rm -rf -- "$tmp"
  if ((rc == 124 || rc == 137)); then
    red "$u 装 cursor-agent 卡住，被 timeout 叫停（退出码 $rc：124＝到 $CURSOR_AGENT_INSTALL_TIMEOUT 秒叫停，137＝不理叫停、再过 5 秒被强杀）：$(cursor_agent_tail "$log")"
    return 0
  fi
  if ((rc != 0)); then
    red "$u 装 cursor-agent 没装上（官方安装脚本 $url 退出 $rc）：$(cursor_agent_tail "$log")"
    return 0
  fi
  if ! cursor_agent_version "$u" "$dir"; then
    red "$u 跑完官方安装脚本（$url），cursor-agent 还是用不了：$CURSOR_AGENT_BAD"
    return 0
  fi
  changed "$u 装 cursor-agent $CURSOR_AGENT_HAVE（官方安装脚本 $url，以他自己的身份装在 ${CURSOR_AGENT_BIN%/cursor-agent}）"
}

# 读回：引擎找得到、跑得起来（以这个用户的身份照引擎的找法跑 --version）；没装、跑不成、卡住、输出认不出、没查成都判红。
# 登没登录不查（登录由创始人在浏览器里批准；在不在线由引擎的路由探针判，docs/ops.md 第五节）
check_cursor_agent() { # 用户 版本目录
  local u=$1 dir=$2
  if cursor_agent_version "$u" "$dir"; then
    ok "$u 的 cursor-agent 是 $CURSOR_AGENT_HAVE（引擎会跑的是 $CURSOR_AGENT_BIN）"
  elif ((CURSOR_AGENT_ABSENT)); then
    red "$u：$CURSOR_AGENT_BAD，引擎起不了 Cursor 会话：重跑 bash deploy/france.sh 装上"
  else
    red "$u：$CURSOR_AGENT_BAD"
  fi
}
