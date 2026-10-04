#!/usr/bin/env bash
# 本机档（fleet-local，#731）：把发往 127.0.0.0/8 的 TCP、UDP 留在 WSL 本机，只空出 Windows 上要用的口。
# 为什么：WSL 的 VirtioProxy、mirrored 网络由它自己的 /init 装了几条策略路由——`ip rule` 优先级 1 的
# `ipproto tcp|udp lookup 127`，127 号表是 `127.0.0.1 via <对端> dev loopback0`——发往 127.0.0.1 的包一律绕去 Windows、
# 再由 Windows 那头转回来（上游 microsoft/WSL#14063）。后果：nft 表 inet fleet_dao 按 oifname "lo" 和发起用户认的规则管
# 不着（会话用户连得上 Temporal、库），临时端口段上的回环监听自己连自己也连不上（探针的口、reclaude 的本地代理口都在这一段）。
# docs/ops.md 第十三节「这台本机现在的样子」有实测。
# 修法：在它们前面（优先级 0）加几条规则，发往 127.0.0.0/8 的 TCP、UDP 查本机的 local 表、留在 lo 上；只空出
# WSL_LOOPBACK_WINDOWS_PORTS（Clash 的 7890：本机上网经它，它只听 Windows 的 127.0.0.1），发往这些口的照旧由 WSL 自己的
# 规则送去 Windows。
# 改这里之前必须知道：
# - 用端口段把 Windows 的口空出来，不靠「同一优先级里谁先加」：WSL 什么时候、按什么顺序重装它自己那几条，都排不到这几条
#   前面，这几条之间也没有先后。#14063 给的不分端口的整段（`to 127.0.0.0/8 lookup local`）会连 7890 一起留在本机，
#   Clash 就够不着了，apply 见到就删。
# - 内核的规则只认到 65534 的端口段（fib_rule_port_range_valid 要 end < 0xffff）：65535 管不着、还是会被绕走；临时端口段
#   （ip_local_port_range）到 60999，用不到它。
# - ip rule del 没写的条件当通配：删一条不分端口的，会先删到排在它前面、带端口的那几条。所以不齐的时候整组删了重加
#   （带端口的先删），不挨条增删。
# - 改动正在用的路由，规则加上之前经 Windows 绕着连上的回环连接（Temporal 连库这类）会断，它们自己重连、之后就走 lo 了。
# - 规则在内核里，WSL 一停就没了：开机由 fleet-wsl-loopback.service 补上（排在 network-pre.target 前面，库、Temporal
#   起来之前），之后 fleet-wsl-loopback.timer 每分钟再跑一次 apply——WSL 网络变动时要是冲掉了，最多一分钟补回来，
#   补的那一次在日志里有一行。
# - 换了 Windows 上代理的口：改 WSL_LOOPBACK_WINDOWS_PORTS，和 deploy/local 下那几份代理样例一起改。
#
# 用法（以 root；装在 /usr/local/sbin/fleet-wsl-loopback，由 deploy/local/install.sh 装和读回）：
#   fleet-wsl-loopback apply   齐了一条不动、什么都不打；不齐就整组换成期望的那几条、ip route flush cache，加了、删了
#                              哪条各打一行「changed …」；出错打「red …」、退出 1
#   fleet-wsl-loopback check   只读：规则齐不齐、127.0.0.1 上几个口实际走哪，每项一行「ok …」或「red …」；有红退出 1，
#                              没查成（ip 跑不成）退出 2
# deploy/test/wsl-loopback.test.sh 在一次性的网络命名空间里照 WSL 的样子摆好它那几条，把这里每条判据真跑一遍。
set -uo pipefail

# Windows 上要用的口：发往它们的不留在本机。升序、不重复，1–65534
WSL_LOOPBACK_WINDOWS_PORTS=(7890)
# 读回时看这几个口实际走哪：Temporal 前端、库（会话用户该被 nft 拦下的两个固定口）；临时端口段的两头另外现读
WSL_LOOPBACK_PROBE_PORTS=(7243 5432)
WSL_LOOPBACK_NET=127.0.0.0/8
# 本仓认作「把回环留在本机」的规则（ip rule 打出来的样子，去掉「0:」）：优先级 0、发往 127.0.0.0/8、查 local 表
WSL_LOOPBACK_OURS_RE='^from all to 127\.0\.0\.0/8( ipproto (tcp|udp))?( dport [0-9]+(-[0-9]+)?)? lookup local$'
# 测试换成跑不成的
WSL_LOOPBACK_IP=ip
WSL_LOOPBACK_PORT_RANGE=/proc/sys/net/ipv4/ip_local_port_range

# 空出的口：1–65534 的整数、升序、不重复；不对返回 1
wsl_loopback_ports_ok() { # 口…
  local p prev=0
  if (($# == 0)); then return 1; fi
  for p in "$@"; do
    if [[ ! "$p" =~ ^[1-9][0-9]{0,4}$ ]] || ((p > 65534 || p <= prev)); then return 1; fi
    prev=$p
  done
}

# 1–65534 里去掉空出的口剩下的几段，一行一段（ip rule 打出来的写法：一个口写一个数，否则「起-止」）
wsl_loopback_ranges() { # 空出的口…（升序、不重复）
  local lo=1 p
  for p in "$@"; do
    if ((p - 1 == lo)); then
      printf '%s\n' "$lo"
    elif ((p - 1 > lo)); then
      printf '%s-%s\n' "$lo" "$((p - 1))"
    fi
    lo=$((p + 1))
  done
  if ((lo == 65534)); then
    printf '%s\n' "$lo"
  elif ((lo < 65534)); then
    printf '%s-%s\n' "$lo" 65534
  fi
}

# 期望的规则（ip rule 打出来的样子，去掉「0:」），一行一条：TCP、UDP 各几段
wsl_loopback_want() {
  local proto r ranges
  ranges=$(wsl_loopback_ranges "${WSL_LOOPBACK_WINDOWS_PORTS[@]}")
  for proto in tcp udp; do
    while IFS= read -r r; do
      printf 'from all to %s ipproto %s dport %s lookup local\n' "$WSL_LOOPBACK_NET" "$proto" "$r"
    done <<<"$ranges"
  done
}

# 内核里优先级 0 的规则，一行一条（去掉「0:」）；ip 跑不成返回 1，原话打到标准输出
wsl_loopback_have() {
  local out
  if ! out=$("$WSL_LOOPBACK_IP" -4 rule list pref 0 2>&1); then
    printf '%s\n' "$out"
    return 1
  fi
  sed -E 's/^0:[[:space:]]+//; s/[[:space:]]+$//' <<<"$out"
}

# 一条规则（ip rule 打出来的样子）换成 ip rule add / del 的参数：去掉开头的「from all」
wsl_loopback_selector() { # 规则
  local s=${1#from all }
  printf '%s' "$s"
}

wsl_loopback_apply() {
  local want have ours line n=0
  if ! wsl_loopback_ports_ok "${WSL_LOOPBACK_WINDOWS_PORTS[@]}"; then
    echo "red 空出的口写错了（要 1–65534 的整数、升序、不重复）：「${WSL_LOOPBACK_WINDOWS_PORTS[*]}」，规则一条没动"
    return 1
  fi
  want=$(wsl_loopback_want)
  if ! have=$(wsl_loopback_have); then
    echo "red 列不出优先级 0 的规则（ip rule 没跑成）：$(head -1 <<<"$have")"
    return 1
  fi
  ours=$(grep -E "$WSL_LOOPBACK_OURS_RE" <<<"$have" || true)
  if [[ "$(sort <<<"$ours")" == "$(sort <<<"$want")" ]]; then return 0; fi
  # 带端口的先删（见开头：ip rule del 没写的条件当通配）
  while IFS= read -r line; do
    if [[ -z "$line" ]]; then continue; fi
    # shellcheck disable=SC2046 # 选择条件按词拆开传给 ip
    if ! "$WSL_LOOPBACK_IP" -4 rule del pref 0 $(wsl_loopback_selector "$line") 2>/dev/null; then
      echo "red 删不掉规则「$line」（ip rule del 没成），没往下加"
      return 1
    fi
    if ! grep -qxF -- "$line" <<<"$want"; then
      echo "changed 删掉回环规则「$line」（不在期望里）"
      n=$((n + 1))
    fi
  done < <(grep ' dport ' <<<"$ours"; grep -v ' dport ' <<<"$ours")
  while IFS= read -r line; do
    # shellcheck disable=SC2046 # 选择条件按词拆开传给 ip
    if ! "$WSL_LOOPBACK_IP" -4 rule add pref 0 $(wsl_loopback_selector "$line") 2>/dev/null; then
      echo "red 加不上规则「$line」（ip rule add 没成）"
      return 1
    fi
    if ! grep -qxF -- "$line" <<<"$ours"; then
      echo "changed 加上回环规则「$line」"
      n=$((n + 1))
    fi
  done <<<"$want"
  # 已经连着的套接字记着旧路由：让它们下一个包重新查一遍
  if ! "$WSL_LOOPBACK_IP" -4 route flush cache 2>/dev/null; then
    echo "red 规则换好了，但 ip route flush cache 没成：已经连着的套接字还照旧路由走"
    return 1
  fi
  if ((n == 0)); then echo "changed 回环规则重排了一遍（有重复的）：$(wc -l <<<"$want") 条"; fi
}

# 127.0.0.1 上这个口的 TCP 实际走哪（ip route get 打出来的第一行）；ip 跑不成返回 1
wsl_loopback_route() { # 口
  local out
  if ! out=$("$WSL_LOOPBACK_IP" -4 route get 127.0.0.1 ipproto tcp dport "$1" 2>&1); then
    printf '%s' "$(head -1 <<<"$out")"
    return 1
  fi
  printf '%s' "$(head -1 <<<"$out" | sed -E 's/[[:space:]]+$//')"
}

wsl_loopback_check() {
  local want have ours missing extra route p lo hi bad=0 local_ports=() windows=""
  if ! wsl_loopback_ports_ok "${WSL_LOOPBACK_WINDOWS_PORTS[@]}"; then
    echo "red 空出的口写错了（要 1–65534 的整数、升序、不重复）：「${WSL_LOOPBACK_WINDOWS_PORTS[*]}」"
    return 1
  fi
  want=$(wsl_loopback_want)
  if ! have=$(wsl_loopback_have); then
    echo "pending 列不出优先级 0 的规则（ip rule 没跑成：$(head -1 <<<"$have")），回环规则没查成"
    return 2
  fi
  ours=$(grep -E "$WSL_LOOPBACK_OURS_RE" <<<"$have" || true)
  missing=$(comm -23 <(sort -u <<<"$want") <(sort -u <<<"$ours") | grep . || true)
  extra=$( (comm -13 <(sort -u <<<"$want") <(sort -u <<<"$ours"); sort <<<"$ours" | uniq -d) | grep . || true)
  if [[ -n "$missing" ]]; then
    echo "red 少了 $(wc -l <<<"$missing") 条把回环留在本机的规则（$(tr '\n' ';' <<<"$missing" | sed 's/;$//')）：发往 127.0.0.1 的会被 WSL 绕去 Windows，fleet-wsl-loopback apply 补上（timer 每分钟也会补）"
    bad=1
  fi
  if [[ -n "$extra" ]]; then
    echo "red 多了 $(wc -l <<<"$extra") 条回环规则（$(tr '\n' ';' <<<"$extra" | sed 's/;$//')）：不分端口的整段会连 Windows 上的口一起留在本机，fleet-wsl-loopback apply 换成期望的"
    bad=1
  fi
  if ((bad == 0)); then
    echo "ok 优先级 0 有 $(wc -l <<<"$want") 条把回环留在本机的规则：127.0.0.0/8 的 TCP、UDP 查 local 表，只空出 ${WSL_LOOPBACK_WINDOWS_PORTS[*]}"
  fi
  # 规则在不等于走对了：实际查一遍几个口走哪
  lo=32768 hi=60999
  if [[ -r "$WSL_LOOPBACK_PORT_RANGE" ]]; then read -r lo hi <"$WSL_LOOPBACK_PORT_RANGE" || true; fi
  local_ports=("${WSL_LOOPBACK_PROBE_PORTS[@]}" "$lo" "$hi")
  for p in "${local_ports[@]}"; do
    if ! route=$(wsl_loopback_route "$p"); then
      echo "pending 查不了 127.0.0.1:$p 走哪（ip route get 没跑成：$route）"
      return 2
    fi
    if [[ "$route" != "local 127.0.0.1 dev lo "* ]]; then
      echo "red 127.0.0.1:$p（TCP）没留在本机的 lo 上（$route）：绕出去的连接 nft 认不出是谁发的，会话用户连得上 Temporal、库，临时端口段上的口自己连不上"
      bad=1
    fi
  done
  for p in "${WSL_LOOPBACK_WINDOWS_PORTS[@]}"; do
    if ! route=$(wsl_loopback_route "$p"); then
      echo "pending 查不了 127.0.0.1:$p 走哪（ip route get 没跑成：$route）"
      return 2
    fi
    if [[ "$route" == "local 127.0.0.1 dev lo "* || "$route" == "local 127.0.0.1 dev lo" ]]; then
      echo "red 127.0.0.1:$p（TCP）留在了本机（$route）：Windows 上的代理够不着，本机出不了网"
      bad=1
    else
      windows+="${windows:+；}$p 走「${route}」"
    fi
  done
  if ((bad)); then return 1; fi
  echo "ok 127.0.0.1 的 ${WSL_LOOPBACK_PROBE_PORTS[*]} 和临时端口段两头（$lo、$hi）走本机的 lo；$windows（去 Windows）"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
  apply)
    wsl_loopback_apply
    exit $?
    ;;
  check)
    wsl_loopback_check
    exit $?
    ;;
  *)
    echo "用法：fleet-wsl-loopback apply|check" >&2
    exit 64
    ;;
  esac
fi
