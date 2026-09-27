#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2016 # SESSION_PORTS_*、PROBE_*、NFT_SAME_WHY 是给调用方和测试读、改的；单引号里是交给 node、bash、sh 的代码，在那头展开
# 会话用户在本机回环上开的口只许它自己和 root 连（#35）：规则在 deploy/france/fleet-dao.nft，这里是读回的判据。
# 要先 source common.sh（ok / red / pending）。deploy/test/session-ports.test.sh 在一次性的网络命名空间里载入真模板，
# 以临时用户把每条路径真连一遍、把每种判红和没查成都造一遍。
#
# 为什么要挡：会话用户的 reclaude 守护在 127.0.0.1 的临时端口上开 HTTP 代理（会话的 HTTPS_PROXY 指它），代理不认
# 客户端是谁，本机别的用户连上去就能用会话用户的订阅额度（2026-09-27 法国实测：pilot、fleet 连上去发 CONNECT，回 502）。
# 判「通」要读到对面发来的一行，光 connect 成功不算：SYN 洪水下握手能过、数据过不去（规则第 4 条）。

# 起探针监听用的 node（测试换成 CI 装的那个）
SESSION_PORTS_NODE=/usr/bin/node
# 连一次最多等几秒：回环上连得通是毫秒级的事；被挡的那头等不到应答，只能等满这个时限
SESSION_PORTS_WAIT=2
# 探针监听回的那一行
SESSION_PORTS_HELLO=fleet-dao-probe

PROBE_PORT=""
PROBE_PID=""
PROBE_LOG=""
NFT_SAME_WHY=""

# 以某个用户在某个地址上起一个探针监听，端口让内核挑（和 reclaude 一样落在临时端口段）：每接一个连接，日志里记一行
# accept、给对面回一行问候。起好了端口号放进 PROBE_PORT、进程号放进 PROBE_PID、日志放进 PROBE_LOG，返回 0；起不来返回 1
# （原因在 PROBE_LOG 那个文件里，调用方记「没查成」）。它 60 秒后自己退：调用方忘了收也不会留下常驻的进程。
session_ports_listen() { # 用户 地址 [端口]
  local user=$1 host=$2 port=${3:-0} gid i
  PROBE_PORT="" PROBE_PID="" PROBE_LOG=""
  PROBE_LOG=$(mktemp) || return 1
  if ! gid=$(id -g -- "$user" 2>/dev/null); then
    echo "查不到用户 $user" >"$PROBE_LOG"
    return 1
  fi
  # setpriv 换了身份直接 exec 成 node，记下的进程号就是监听本身（runuser 会多隔一层，杀它不一定连带杀掉监听）
  (cd / && exec setpriv --reuid="$user" --regid="$gid" --init-groups env -i PATH=/usr/bin:/bin "$SESSION_PORTS_NODE" -e '
    const [host, port, hello] = process.argv.slice(1);
    const srv = require("node:net").createServer((c) => {
      console.log(`accept ${c.remotePort}`);
      c.on("error", () => {});
      c.end(`${hello}\n`);
    });
    srv.on("error", (e) => {
      console.log(`listen ${e.code}`);
      process.exit(1);
    });
    srv.listen(Number(port), host, () => console.log(`port ${srv.address().port}`));
    setTimeout(() => process.exit(0), 60000);' "$host" "$port" "$SESSION_PORTS_HELLO") >>"$PROBE_LOG" 2>&1 &
  PROBE_PID=$!
  for ((i = 0; i < 100; i++)); do
    PROBE_PORT=$(sed -n 's/^port \([0-9][0-9]*\)$/\1/p' "$PROBE_LOG" 2>/dev/null) || PROBE_PORT=""
    if [[ -n "$PROBE_PORT" ]]; then return 0; fi
    if ! kill -0 "$PROBE_PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
  kill "$PROBE_PID" 2>/dev/null || true
  wait "$PROBE_PID" 2>/dev/null || true
  PROBE_PID=""
  return 1
}

# 收掉探针监听、删掉它的日志
session_ports_stop() {
  if [[ -n "$PROBE_PID" ]]; then
    kill "$PROBE_PID" 2>/dev/null || true
    wait "$PROBE_PID" 2>/dev/null || true
  fi
  if [[ -n "$PROBE_LOG" ]]; then rm -f -- "$PROBE_LOG"; fi
  PROBE_PORT="" PROBE_PID="" PROBE_LOG=""
}

# 探针监听接过几个连接（日志里的 accept 行数）
session_ports_accepts() { grep -c '^accept ' "$PROBE_LOG" 2>/dev/null || true; }

# 以某个用户连一次、读到探针的问候返回 0；连不上、等不到、读到的不对都返回非 0
session_ports_greets() { # 用户 地址 端口
  (cd / && runuser -u "$1" -- env -i PATH=/usr/bin:/bin timeout "$SESSION_PORTS_WAIT" bash -c '
    exec 3<>"/dev/tcp/$1/$2" || exit 1
    IFS= read -r line <&3 || exit 1
    [[ "$line" == "$3" ]]' _ "$2" "$3" "$SESSION_PORTS_HELLO") >/dev/null 2>&1
}

# 以某个用户连一次，connect 成功就返回 0（给不回问候的口用：reclaude 的代理口、MITM 口）
session_ports_connects() { # 用户 地址 端口
  (cd / && runuser -u "$1" -- env -i PATH=/usr/bin:/bin timeout "$SESSION_PORTS_WAIT" bash -c \
    'exec 3<>"/dev/tcp/$1/$2"' _ "$2" "$3") >/dev/null 2>&1
}

# 这台上在听的 TCP 口，带属主（ss -e 的 uid:N；root 的不带）。单拎出来，测试换成读不出的样子
session_ports_ss() { ss -Hltne; }

# 某个 uid 此刻在听的 TCP 口：一行一个「地址 端口」。通配地址换成回环（本机别的用户就是从回环连它），[::1] 去掉方括号。
# ss 跑不成返回 1（不当成「一个口都没开」）
session_ports_listening() { # uid
  local out
  out=$(session_ports_ss 2>&1) || return 1
  awk -v want="uid:$1" '
    { owner = ""; for (i = 6; i <= NF; i++) if ($i ~ /^uid:[0-9]+$/) owner = $i }
    owner != want { next }
    {
      addr = $4; port = addr; sub(/.*:/, "", port); sub(/:[^:]*$/, "", addr)
      gsub(/^\[|\]$/, "", addr); sub(/%.*/, "", addr)
      if (addr == "0.0.0.0" || addr == "*") addr = "127.0.0.1"
      if (addr == "::") addr = "::1"
      print addr, port
    }' <<<"$out"
}

# 读回：会话用户在回环上开的口只许它自己和 root 连（#35）。
#   1. 它此刻真在听的口（reclaude 的代理口、MITM 口，会话里起的服务）：别的用户逐个去连，connect 成功就红；
#   2. 以它的身份现起一个探针监听（落在临时端口段，和 reclaude 一样）：别的用户读不到问候、它自己读得到；
#   3. 以第一个别的用户起探针、最后一个别的用户去连，读得到问候：规则只挡会话用户的口，没挡多。
# 连得上判红；起不了探针、ss 跑不成记待配（没查成，不当成没事）。
check_session_ports() { # 会话用户 别的用户…
  local session=$1 uid u addr port list names bad=0 unsure=0 n=0
  shift
  local others=("$@")
  if ! uid=$(id -u -- "$session" 2>/dev/null); then
    pending "查不到会话用户 $session，它开的口别人连不连得上没查"
    return 0
  fi
  if ! list=$(session_ports_listening "$uid"); then
    pending "ss 跑不成，$session 此刻在听的口没逐个试"
    unsure=1
    list=""
  fi
  while read -r addr port; do
    if [[ -z "$port" ]]; then continue; fi
    n=$((n + 1))
    for u in "${others[@]}"; do
      if session_ports_connects "$u" "$addr" "$port"; then
        red "$u 连得上 $session 在听的 $addr:$port（reclaude 的代理口就是这样被借走的）：nft 表 inet fleet_dao 挡会话口的规则没生效"
        bad=1
      fi
    done
  done <<<"$list"
  if ! session_ports_listen "$session" 127.0.0.1; then
    pending "起不了 $session 的探针监听（$(tr '\n' ' ' <"$PROBE_LOG" 2>/dev/null | cut -c1-120)），它开的口别人连不连得上没查成"
    session_ports_stop
    return 0
  fi
  for u in "${others[@]}"; do
    if session_ports_greets "$u" 127.0.0.1 "$PROBE_PORT"; then
      red "$u 连得上 $session 开的口（探针 127.0.0.1:$PROBE_PORT）：它的 reclaude 代理谁都借得到，nft 表 inet fleet_dao 挡会话口的规则没生效"
      bad=1
    fi
  done
  if ! session_ports_greets "$session" 127.0.0.1 "$PROBE_PORT"; then
    red "$session 连不上自己开的口（探针 127.0.0.1:$PROBE_PORT）：规则挡错了人，会话连不上自己的 reclaude"
    bad=1
  fi
  session_ports_stop
  if ((${#others[@]})); then
    if ! session_ports_listen "${others[0]}" 127.0.0.1; then
      pending "起不了 ${others[0]} 的探针监听，规则有没有挡多没查成"
      unsure=1
    elif ! session_ports_greets "${others[-1]}" 127.0.0.1 "$PROBE_PORT"; then
      red "${others[-1]} 连不上 ${others[0]} 开的临时口（探针 127.0.0.1:$PROBE_PORT）：规则挡多了，只该挡会话用户的口"
      bad=1
    fi
    session_ports_stop
  fi
  if ((bad == 0 && unsure == 0)); then
    printf -v names '%s、' "${others[@]}"
    ok "别的用户（${names%、}）连不上 $session 在本机开的口（现起的探针，和它此刻在听的 $n 个口），它自己连得上；别人之间照常通"
  fi
}

# 内核里正在用的这张表和文件是不是一回事：把文件放进一个一次性的网络命名空间里载一遍、让 nft 列出来，再和内核里那张逐字
# 比——两边都是 nft 自己的写法，文件里的注释、空白、写法差别都不算。一样返回 0，不一样 1，没查成 2（原因在 NFT_SAME_WHY）
nft_table_same_as_file() { # 表族 表名 文件
  local have want
  NFT_SAME_WHY=""
  if ! have=$(nft list table "$1" "$2" 2>&1); then
    NFT_SAME_WHY="列不出内核里的表：$(head -1 <<<"$have")"
    return 2
  fi
  if ! want=$(unshare --net -- sh -c 'nft -f "$1" && nft list table "$2" "$3"' _ "$3" "$1" "$2" 2>&1); then
    NFT_SAME_WHY="$3 在一次性的网络命名空间里载不进去：$(head -1 <<<"$want")"
    return 2
  fi
  if [[ "$have" == "$want" ]]; then return 0; fi
  return 1
}
