#!/usr/bin/env bash
# shellcheck disable=SC2034 # MIRASIM_RUN_DIR 是给调用方和测试读写的
# 会话用户自己的 Mirasim 服务（#345 接上引擎；design 第十四节：经 Mirasim 起的会话工具是在 Mirasim 服务的进程里执行的，
# 所以要给会话用户单独起一份，不借旧系统那份）。这份不像 lib/grok.sh、lib/cursor-agent.sh：装、登录一步做完，装机脚本
# 装不了——Mirasim 没有能自动跑的无头安装脚本，官方给的路是它自己的桌面端以 SSH 远程模式连上服务器现装、现登录账号
# （docs/ops.md 第五节「会话用户的 Mirasim」），要创始人在自己电脑上做。这个文件只有读回（check_mirasim）：认这个会话
# 用户家里有没有恰好一份 <家>/.mirasim/run/local-<端口>.token（引擎连哪个端口、读哪份令牌就看它，
# packages/engine/src/real/index.ts 的 discoverMirasimEndpoint），不读令牌内容、不管服务进程在不在跑
# （那是路由探针的事：调度台哪个阶段挂着 Mirasim 的路由、开着，下一轮就真连一次）。
# france.sh 共用；要先 source common.sh（ok、red、pending）。

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
  # shellcheck disable=SC2016 # 单引号里的 $1 在这个用户的 sh 里展开，不是这里
  out=$(runuser -u "$u" -- /bin/sh -c 'ls -1 -- "$1" 2>&1' sh "$dir" 2>&1)
  rc=$?
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
    red "$u 的 $dir 下有 $n 份令牌（$(printf '%s' "$names" | tr '\n' '、')）：认不出该用哪一份，只该有一份 Mirasim 服务——清掉多余的（可能是重装留下的旧令牌）"
  else
    local port=${names#local-}
    port=${port%.token}
    ok "$u 的 Mirasim 服务在：$dir/$names（端口 $port；内容没读，认不认由路由探针判）"
  fi
}
