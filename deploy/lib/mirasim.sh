#!/usr/bin/env bash
# shellcheck disable=SC2034 # MIRASIM_RUN_DIR、MIRASIM_SERVER_BIN 是给调用方和测试读写的
# 会话用户自己的 Mirasim 服务（#345 接上引擎；design 第十四节：经 Mirasim 起的会话工具是在 Mirasim 服务的进程里执行的，
# 所以要给会话用户单独起一份，不借旧系统那份）。服务端本体不是装机脚本装的——Mirasim 没有能自动跑的无头安装脚本，
# 官方给的路是它自己的桌面端以 SSH 远程模式（或 `mirasim ssh connect`）连上服务器现装，装完顺带就是登录好的
# （docs/ops.md 第五节「会话用户的 Mirasim」），要创始人或帅位做一次。这个文件管两层：
#   - check_mirasim：认这个会话用户家里有没有恰好一份 <家>/.mirasim/run/local-<端口>.token（引擎连哪个端口、读哪份
#     令牌就看它，packages/engine/src/real/index.ts 的 discoverMirasimEndpoint），不读令牌内容、不管服务进程在不在跑
#     （那是路由探针的事：调度台哪个阶段挂着 Mirasim 的路由、开着，下一轮就真连一次）。
#   - mirasim_server_installed / check_mirasim_session_unit（#424）：服务端本体装没装，装了就该有一个常驻的本地模式
#     单元（deploy/france/fleet-mirasim-session.service，france.sh 装）帮它一直开着，这两个函数管「常驻单元该不该
#     装、装了活没活」这一层，和 check_mirasim 管的「令牌」是两回事：服务端本体没装，常驻单元这轮不装（待配，不算
#     坏）；装了却没常驻、/api/health 不通才判红。
# france.sh 共用；要先 source common.sh（ok、changed、red、pending）。

# 会话用户家里放 Mirasim 令牌的目录（{user} 换成会话用户）。和 packages/engine/src/real/index.ts 的
# DEFAULT_MIRASIM_HOME 拼出同一个位置（那边是 <FLEET_MIRASIM_HOME>/.mirasim/run，这里默认 FLEET_MIRASIM_HOME 就是
# /home/{user}）：deploy/test/mirasim.test.sh 核对两边一样。
MIRASIM_RUN_DIR='/home/{user}/.mirasim/run'

mirasim_run_dir() { printf '%s' "${MIRASIM_RUN_DIR//\{user\}/$1}"; } # 会话用户

# 读回：这个会话用户自己的 Mirasim 服务在不在。只看 <目录>/local-<端口>.token 恰好有一份，不读令牌内容——认不认由路由
# 探针判（真连一次、问一句 OK）。目录不在、一份都没有：待配（还没装，不是坏了）；不止一份：判红（认不出该用哪份，只该
# 有一份 Mirasim 服务，可能是重装了一次没清掉旧的）。以那个用户的身份看（和别的读回一个道理：他看得到的才算数）。
check_mirasim() { # 用户
  local u=$1 dir out rc
  dir=$(mirasim_run_dir "$u")
  local fix="创始人从自己电脑上的 Mirasim 桌面端以 SSH 远程模式连 $u@这台机器，装起来、登一次账号（docs/ops.md 第五节「会话用户的 Mirasim」）；装好之前 Mirasim 路由派不出去"
  # 目录不在也算「还没装」（待配，不是坏了）：ls 找不到目录退出 2，和 runuser 本身跑不起来（用户没有、权限不对）分不清——
  # 两层 stderr（内层 ls、外层 runuser）都并进 out，退出非 0 时看文字认是不是「目录不在」，不靠退出码本身区分。
  # 「|| rc=$?」不能拆成下一行的 rc=$?：france.sh 挂着 ERR 陷阱，赋值里的命令一失败陷阱就先响、整个装机停下（09-28 撞过：
  # 目录不在本该是待配，结果把后面的读回全跳了）
  rc=0
  # shellcheck disable=SC2016 # 单引号里的 $1 在这个用户的 sh 里展开，不是这里
  out=$(runuser -u "$u" -- /bin/sh -c 'ls -1 -- "$1" 2>&1' sh "$dir" 2>&1) || rc=$?
  if ((rc != 0)); then
    if [[ "$out" == *'No such file or directory'* ]]; then
      pending "$u 还没有自己的 Mirasim 服务（没有 $dir）：$fix"
    else
      red "$u 的 $dir 查不了（runuser 退出 $rc：${out:-没有输出}）"
    fi
    return 0
  fi
  local names
  names=$(printf '%s\n' "$out" | grep -E '^local-[0-9]+\.token$') || true
  local n=0
  if [[ -n "$names" ]]; then n=$(printf '%s\n' "$names" | grep -c .); fi
  if ((n == 0)); then
    pending "$u 还没有自己的 Mirasim 服务（没有 $dir 下的 local-<端口>.token）：$fix"
  elif ((n > 1)); then
    # 不用 tr '\n' '、'、也不用 paste -d '、'：这两个都把分隔符当「按字节/按位置轮着用的列表」，'、' 是三字节的
    # UTF-8，会被拆开、每处只塞进一个字节，拼出读不出来的乱码（#345 review 撞过：CI 在 Linux 上真的读出了 U+FFFD；
    # 本机另外试过 paste -sd，同样的坏法，不是 tr 一家的问题）。改用逐行读、用 bash 自己的字符串拼接（+=），
    # 分隔符整段原样嵌进源码字面量，不会被当成要拆开的东西。
    local joined='' name first=1
    while IFS= read -r name; do
      if ((first)); then joined=$name; first=0; else joined+="、$name"; fi
    done <<<"$names"
    red "$u 的 $dir 下有 $n 份令牌（$joined）：认不出该用哪一份，只该有一份 Mirasim 服务——清掉多余的（可能是重装留下的旧令牌）"
  else
    local port=${names#local-}
    port=${port%.token}
    ok "$u 的 Mirasim 服务在：$dir/$names（端口 $port；内容没读，认不认由路由探针判）"
  fi
}

# 会话用户家里 Mirasim 远程模式装的服务端本体（{user} 换成会话用户）。不在，就是「还没到能起常驻服务这一步」——
# 第 1 步得先 mirasim ssh connect（或桌面端 SSH 远程模式）一次；在，france.sh 才把它做成常驻单元。
MIRASIM_SERVER_BIN='/home/{user}/.mirasim-remote/current/server.cjs'
mirasim_server_bin() { printf '%s' "${MIRASIM_SERVER_BIN//\{user\}/$1}"; } # 会话用户

# 纯判断：服务端本体在不在，不记账、不打印。以那个用户的身份看（和 check_mirasim 一个道理：他看得到的才算数——
# root 直接 stat 会绕过权限位，看到的不一定是他自己看到的那个文件）。返回 0 在、1 不在或查不了。
# 调用方要在 if / && / || 里用它（ERR 陷阱安全靠这个，见 check_mirasim 顶上「|| rc=$?」那条注释同样的道理）。
mirasim_server_installed() { # 用户
  local u=$1 bin rc=0
  bin=$(mirasim_server_bin "$u")
  # shellcheck disable=SC2016 # 单引号里的 $1 在这个用户的 sh 里展开，不是这里
  runuser -u "$u" -- /bin/sh -c 'test -f "$1"' sh "$bin" >/dev/null 2>&1 || rc=$?
  ((rc == 0))
}

# 读回：会话用户自己的 Mirasim 常驻单元（fleet-mirasim-session.service，france.sh 装）这一层装没装、活没活。
# 和 check_mirasim（认令牌）分开：这条管 france.sh 自己装的那个单元，不是创始人手装的服务端本体。
# 服务端本体不在：待配，不算坏——这轮 france.sh 不装单元，是「装服务端本体」这一步（要创始人或帅位做）还没做，
# 不是这个单元坏了。本体在但单元没起、没活、/api/health 不通：判红——这时候是「该常驻却没常驻」。
check_mirasim_session_unit() { # 用户 单元名 端口
  local u=$1 unit=$2 port=$3
  local fix="创始人或帅位用 mirasim ssh connect（或桌面端 SSH 远程模式）连 $u@这台机器装一次服务端本体（docs/ops.md 第五节「会话用户的 Mirasim」）；装好前这个单元不装、Mirasim 路由派不出去"
  if ! mirasim_server_installed "$u"; then
    pending "$u 还没有 Mirasim 服务端本体（没有 $(mirasim_server_bin "$u")）：$fix"
    return 0
  fi
  if [[ "$(systemctl is-active "$unit" 2>/dev/null)" != active ]]; then
    red "$unit 没在跑（服务端本体已装）：journalctl -u $unit -n 50 看现场"
    return 0
  fi
  local health rc=0
  health=$(curl -fsS --max-time 5 "http://127.0.0.1:$port/api/health" 2>&1) || rc=$?
  if ((rc != 0)); then
    red "$unit 在跑但 http://127.0.0.1:$port/api/health 连不上或没回（curl 退出 $rc）：$(tail -c 300 <<<"$health")"
    return 0
  fi
  if [[ "$health" != *'"ok":true'* ]]; then
    red "$unit 的 /api/health 回了但不是 ok:true：$(tail -c 300 <<<"$health")"
    return 0
  fi
  ok "$unit 在跑，http://127.0.0.1:$port/api/health 回 ok:true"
}
