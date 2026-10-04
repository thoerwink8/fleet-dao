#!/usr/bin/env bash
# shellcheck disable=SC2034 # GROK_HAVE、GROK_ABSENT、GROK_AUTH_FILE 是给调用方读的
# 给会话用户装、查 grok 命令行（#266 接上的第三家执行方式：SuperGrok 订阅的 Grok Build；引擎每次起 grok 会话，由会话用户
# 先看他家里的 ~/.grok/bin/grok 是不是能跑的文件，packages/engine/src/real/hosts.ts 的 grokLaunchCommand）。
# 装：~/.grok/bin/grok 不在、不能跑才装：用官方安装脚本、以这个用户自己的身份跑，装在他家里（二进制在
# ~/.grok/downloads/grok-linux-<架构>，~/.grok/bin/grok 链过去），写出来的都归他；在就不动（不重装、不升级）。
# 不钉版本：安装脚本装当时最新的稳定版（docs/reference/deploy.md P33：跟最新、只留一份）。之后不自己升级：插头起 grok 时关了
# 更新检查（GROK_DISABLE_AUTOUPDATER=1，免得会话半路换二进制），要升级以会话用户跑 grok update（docs/ops.md 第五节）。
# 装的时候 PATH 里只有系统目录、SHELL 给 /bin/sh：安装脚本会往 PATH 上他写得动的目录（~/.local/bin）里链 grok 和 agent——
# agent 这个名字 cursor-agent 的安装脚本也在用，会被盖掉——SHELL 是 bash、zsh、fish 还会改它们的启动文件。SHELL 不能不给：
# 安装脚本是 bash 跑的，bash 起来时 SHELL 空着会自己照 passwd 填上他的登录 shell（CI 实测）。这样它就只写 ~/.grok 下面。
# 安装脚本和它下的二进制都不核校验和：官方没给（安装脚本只核下下来的能跑 --version）；它只以会话用户的身份跑，出了事也只在
# 会话用户自己家里——会话用户本来就要跑 grok。安装脚本先整个下下来再跑（不 curl | bash：下到一半断了会跑半截），退出 0 也
# 不算装成，装完照读回的判法再核一遍。
# 登录：创始人以会话用户跑一次 grok login --device-code（docs/ops.md 第五节「会话用户的 grok」）。登录态是他家里的
# ~/.grok/auth.json：grok 自己写成 600、自己续期，是普通文件，没有桌面也存得下、重启还在。这里只看它在不在、是不是真文件、
# 属主、权限、大小，不读内容；grok 认不认、续没续上期由引擎的路由探针真起一次会话判。
# france.sh 和 deploy/test/grok.test.sh 共用；要先 source common.sh（ok、changed、red、pending）、profile.sh（会话代理）。

# 会话用户家里的 grok 和它的登录态（{user} 换成会话用户）。GROK_BIN 和 packages/engine/src/real/hosts.ts 的 DEFAULT_GROK_BIN
# 一样（engine 的 hosts.test.ts 核对，改一边另一边跟着改）；engine.env 别改 FLEET_GROK_BIN：改了引擎就找不到这里装的
GROK_BIN='/home/{user}/.grok/bin/grok'
GROK_AUTH_FILE='/home/{user}/.grok/auth.json'

GROK_HAVE=""             # grok_version 读到的版本号
GROK_BAD=""              # 没读成的原因
GROK_ABSENT=0            # 没读成时：1＝不在、不是文件、不能跑（没装），0＝在、但跑不成，或者没查成
GROK_TIMEOUT=20          # --version 等几秒
GROK_INSTALL_TIMEOUT=900 # 安装脚本等几秒（要下一百多兆的二进制）
# grok --version 的样子：grok 1.0.41 (4220f3b224a6)
GROK_VERSION_RE='^grok ([0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._]+)?)( \([0-9a-f]+\))?$'

grok_bin() { printf '%s' "${GROK_BIN//\{user\}/$1}"; }             # 会话用户
grok_auth_file() { printf '%s' "${GROK_AUTH_FILE//\{user\}/$1}"; } # 会话用户

# 以那个用户的身份跑一条命令：环境清干净，PATH 只有系统目录、SHELL 是 /bin/sh（为什么见开头）；这一档登记了会话代理就
# 带上那几个代理变量（profile.sh 的 session_proxy_load：本机档直连 x.ai 不通、要经 Windows 上的 Clash，#731；调用者自己
# 环境里的代理不带）；照 lib/cursor-agent.sh 的 cursor_agent_as 防卡——不带控制终端（setsid），到点叫停、不理叫停的再过 5 秒
# 强杀（被强杀时 timeout 连自己一起杀掉，退出码是 137 而不是 124）；标准输出、标准错误落进 root 建的两个文件（不走 $(...)
# 的管道：他留个后台进程占着写端，管道就一直等）。返回命令的退出码
grok_as() { # 用户 家目录 秒数 标准输出文件 标准错误文件 命令…
  local u=$1 home=$2 secs=$3 out=$4 err=$5 proxy=()
  shift 5
  # 登记的代理读不出就不带：查版本不出网；装之前 ensure_grok 已判红、不装
  if session_proxy_load; then proxy=("${SESSION_PROXY_VARS[@]}"); fi
  (cd -- "$home" && runuser -u "$u" -- env -i HOME="$home" USER="$u" LOGNAME="$u" PATH=/usr/local/bin:/usr/bin:/bin \
    SHELL=/bin/sh LANG=C.UTF-8 "${proxy[@]}" /usr/bin/setsid -w /usr/bin/timeout -k 5 "$secs" "$@") </dev/null >"$out" 2>"$err"
}

# 报错里带的那几行：去掉终端控制符，\r 刷新的进度条拆成行，留最后 3 行非空的
grok_tail() { # 文本
  local t
  # shellcheck disable=SC2001 # 按正则去终端控制符，${//} 做不了
  t=$(sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' <<<"$1" | tr '\r' '\n' | grep -v '^[[:space:]]*$' | tail -3 | tr '\n' ' ') || true
  t=${t% }
  t=${t:-（没有输出）}
  printf '%s' "${t:0:300}"
}

# 以那个用户的身份、照引擎的判法（grokLaunchCommand：是文件、能跑）跑一次 --version。读成了返回 0，版本进 GROK_HAVE；
# 没装、跑不起来、卡住、输出认不出、没查成都返回 1，原因进 GROK_BAD，其中没装的另把 GROK_ABSENT 记成 1（只认「不在、
# 不是文件、不能跑」：看的那段什么都不打、退出 127；别的起不来也退出 127 的会在标准错误里留话，算没跑成）
grok_version() { # 用户 grok 的位置
  local u=$1 bin=$2 home tmp out err rc=0
  GROK_HAVE="" GROK_BAD="" GROK_ABSENT=0
  home=$(getent passwd "$u" | cut -d: -f6) || home=""
  if [[ -z "$home" ]]; then
    GROK_BAD="getent 查不到 $u 的家目录，grok 没查成"
    return 1
  fi
  if ! tmp=$(mktemp -d "${TMPDIR:-/var/tmp}/fleet-dao-grok-probe.XXXXXX" 2>/dev/null); then
    GROK_BAD="建不了放 grok --version 输出的临时目录（${TMPDIR:-/var/tmp}），没查成"
    return 1
  fi
  # shellcheck disable=SC2016 # 单引号里的 $1 在这个用户的 sh 里展开
  grok_as "$u" "$home" "$GROK_TIMEOUT" "$tmp/out" "$tmp/err" /bin/sh -c \
    'if [ ! -f "$1" ] || [ ! -x "$1" ]; then exit 127; fi; exec "$1" --version' grok-version "$bin" || rc=$?
  out=$(cat -- "$tmp/out") || out=""
  err=$(cat -- "$tmp/err") || err=""
  rm -rf -- "$tmp"
  if ((rc == 124 || rc == 137)); then
    GROK_BAD="$bin --version 卡住，被 timeout 叫停（退出码 $rc：124＝到 $GROK_TIMEOUT 秒叫停，137＝不理叫停、再过 5 秒被强杀）"
    return 1
  fi
  if ((rc == 127)) && [[ -z "$out" && -z "$err" ]]; then
    GROK_ABSENT=1
    GROK_BAD="没装 grok 命令行（$bin 不在、不是文件或不能跑）"
    return 1
  fi
  if ((rc != 0)); then
    GROK_BAD="$bin --version 退出 $rc：$(grok_tail "$err")"
    return 1
  fi
  if [[ ! "$out" =~ $GROK_VERSION_RE ]]; then
    out=${out//$'\n'/ ⏎ }
    GROK_BAD="$bin --version 的输出认不出（该是一行「grok 版本号 (提交)」）：「${out:0:120}」"
    return 1
  fi
  GROK_HAVE=${BASH_REMATCH[1]}
}

# 装 grok：在、能跑就不动；不在、不能跑才以这个用户的身份下官方安装脚本、跑它，装完再核一遍。在却跑不成、没查成的不重装、
# 不删，只记红（先看清是什么）。这一档登记的会话代理读不出：先判红、不查不装（不拿直连顶）。都只记红、不中断装机（一个
# 执行方式不值得停下整台机器的装机），读回还会再判一次
ensure_grok() { # 用户 grok 的位置 安装脚本地址
  local u=$1 bin=$2 url=$3 home tmp rc=0 log
  if ! session_proxy_load; then
    red "这一档登记的会话代理没读成（$SESSION_PROXY_WHY）：$u 的 grok 没查也没装"
    return 0
  fi
  if grok_version "$u" "$bin"; then
    ok "$u 已有 grok $GROK_HAVE（$bin），不重装（要升级以他的身份跑 grok update）"
    return 0
  fi
  if ((GROK_ABSENT == 0)); then
    red "$u 的 grok：$GROK_BAD；不重装、不删，先看清是什么"
    return 0
  fi
  home=$(getent passwd "$u" | cut -d: -f6) || home=""
  if ! tmp=$(mktemp -d "${TMPDIR:-/var/tmp}/fleet-dao-grok-install.XXXXXX" 2>/dev/null); then
    red "建不了放 grok 安装输出的临时目录（${TMPDIR:-/var/tmp}），$u 的 grok 没装"
    return 0
  fi
  # 这个用户自己的 shell 里：安装脚本下进他自己的临时文件、下全了再跑，标准错误并进标准输出（按先后留在一个文件里）
  # shellcheck disable=SC2016 # 单引号里的东西要在这个用户的 shell 里展开
  grok_as "$u" "$home" "$GROK_INSTALL_TIMEOUT" "$tmp/out" "$tmp/err" /bin/sh -c 'exec 2>&1
    t=$(mktemp) || exit 1
    if ! curl -fsSL --retry 3 --max-time 120 -o "$t" "$1"; then rm -f "$t"; echo "下不到安装脚本：$1"; exit 1; fi
    /bin/bash "$t"
    rc=$?
    rm -f "$t"
    exit "$rc"' grok-install "$url" || rc=$?
  log=$(cat -- "$tmp/err" "$tmp/out" 2>/dev/null) || true
  rm -rf -- "$tmp"
  if ((rc == 124 || rc == 137)); then
    red "$u 装 grok 卡住，被 timeout 叫停（退出码 $rc：124＝到 $GROK_INSTALL_TIMEOUT 秒叫停，137＝不理叫停、再过 5 秒被强杀）：$(grok_tail "$log")"
    return 0
  fi
  if ((rc != 0)); then
    red "$u 装 grok 没装上（官方安装脚本 $url 退出 $rc）：$(grok_tail "$log")"
    return 0
  fi
  if ! grok_version "$u" "$bin"; then
    red "$u 跑完官方安装脚本（$url），grok 还是用不了：$GROK_BAD"
    return 0
  fi
  changed "$u 装 grok $GROK_HAVE（官方安装脚本 $url，以他自己的身份装在 $bin）；还要创始人以他的身份登录一次（docs/ops.md 第五节「会话用户的 grok」）"
}

# 读回：引擎起得来（以这个用户的身份照引擎的判法跑 --version）；没装、跑不成、卡住、输出认不出、没查成都判红
check_grok() { # 用户 grok 的位置
  local u=$1 bin=$2
  if grok_version "$u" "$bin"; then
    ok "$u 的 grok 是 $GROK_HAVE（$bin）"
  elif ((GROK_ABSENT)); then
    red "$u：$GROK_BAD，引擎起不了 Grok 会话：重跑 bash deploy/france.sh 装上"
  else
    red "$u：$GROK_BAD"
  fi
}

# 读回：grok 的登录态只看在不在、是不是真文件、属主、权限、大小，不读内容。还没登录记「待配」（要创始人以会话用户登录一次）；
# 在却不对判红。grok 认不认、续没续上期不在这里查：路由探针真起一次会话判
check_grok_login() { # 用户 登录态文件 grok 的位置
  local u=$1 f=$2 bin=$3 meta owner mode size bad=""
  local login="sudo -iu $u $bin login --device-code"
  local relogin="删掉它，以 $u 的身份重新登录一次：$login（docs/ops.md 第五节「会话用户的 grok」）"
  if [[ -L "$f" ]]; then
    red "$u 的 grok 登录态 $f 是符号链接（grok 自己写的是真文件）：$relogin"
    return 0
  fi
  if [[ ! -e "$f" ]]; then
    pending "$u 还没登录 grok（没有 $f）：创始人跑 $login，在任意设备的浏览器里打开它给的链接、确认那串码（docs/ops.md 第五节「会话用户的 grok」）；登录之前 Grok 的路由探不通"
    return 0
  fi
  if [[ ! -f "$f" ]]; then
    red "$u 的 grok 登录态 $f 不是普通文件：$relogin"
    return 0
  fi
  if ! meta=$(stat -c '%U %a %s' -- "$f" 2>/dev/null) || [[ -z "$meta" ]]; then
    red "查不了 $u 的 grok 登录态 $f 的属主和权限（stat 没跑成）"
    return 0
  fi
  read -r owner mode size <<<"$meta"
  if [[ "$owner" != "$u" ]]; then bad+="属主是 $owner（要 $u）；"; fi
  if [[ "$mode" != 600 ]]; then bad+="权限是 $mode（要 600）；"; fi
  if [[ "$size" == 0 ]]; then bad+="是空的；"; fi
  if [[ -n "$bad" ]]; then
    red "$u 的 grok 登录态 $f：${bad%；}（内容没读）：改回属 $u、600，空的就$relogin"
  else
    ok "$u 的 grok 登录态在：$f 属 $u、600、$size 字节（内容没读；grok 认不认由路由探针判）"
  fi
}
