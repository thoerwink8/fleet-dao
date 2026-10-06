#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2016 # SESSION_PORTS_*、PROBE_*、NFT_SAME_WHY 是给调用方和测试读、改的；单引号里是交给 node、bash、sh、awk 的代码，在那头展开
# 会话用户在本机回环上开的口只许它自己和 root 连（#35）：规则在 deploy/france/fleet-dao.nft，这里是装的时候收旧连接、
# 读回的判据。要先 source common.sh（ok / changed / red / pending）。deploy/test/session-ports.test.sh 在一次性的网络
# 命名空间里载入真模板，以临时用户把每条路径真连一遍、把每种判红和没查成都造一遍。
#
# 为什么要挡：会话用户的 reclaude 守护在 127.0.0.1 的临时端口上开 HTTP 代理（会话的 HTTPS_PROXY 指它），代理不认
# 客户端是谁，本机别的用户连上去就能用会话用户的订阅额度（2026-09-27 法国实测：pilot、fleet 连上去发 CONNECT，回 502）。
# 判「通」要读到对面发来的一行，光 connect 成功不算：SYN 洪水下握手能过、数据过不去（规则第 4 条）。
# 规则只管新连接（标记打在第一个 SYN 上）：规则载上之前就连着的，装的时候由 session_ports_cut 断掉，读回也查。

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

# 以某个用户在某个地址上起一个探针监听，端口不给就让内核挑（和 reclaude 一样落在临时端口段）：每接一个连接，日志里记
# 一行 accept、先回一行问候，之后收到什么回什么，对面关了它才关。起好了端口号放进 PROBE_PORT、进程号放进 PROBE_PID、
# 日志放进 PROBE_LOG，返回 0；起不来返回 1（原因在 PROBE_LOG 那个文件里，调用方记「没查成」）。
# 它 60 秒后自己退：调用方忘了收也不会留下常驻的进程。
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
      c.on("end", () => c.end());
      c.write(`${hello}\n`);
      c.pipe(c, { end: false });
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

# 以某个用户连一次：返回 0 读到了探针的问候；1 连不上、等不到、读到的不对（被挡、被拒、超时）；
# 2 没以他的身份跑起来（查不到这个用户、runuser 没成）——这种不能当成「连不上」，不然用户没了读回也说挡住了
session_ports_greets() { # 用户 地址 端口
  session_ports_try "$1" '
    exec 3<>"/dev/tcp/$1/$2" || exit 1
    IFS= read -r line <&3 || exit 1
    [[ "$line" == "$3" ]]' "$2" "$3" "$SESSION_PORTS_HELLO"
}

# 以某个用户连一次，connect 成功就返回 0（给不回问候的口用：reclaude 的代理口、MITM 口）；1、2 同上
session_ports_connects() { # 用户 地址 端口
  session_ports_try "$1" 'exec 3<>"/dev/tcp/$1/$2"' "$2" "$3"
}

# 以某个用户、限时跑一段 bash：先打一行 ran 证明真以他的身份跑起来了，再跑那一段。0 那一段成了，1 没成，2 没跑起来
session_ports_try() { # 用户 bash 代码 参数…
  local user=$1 code=$2 out rc=0
  shift 2
  out=$(cd / && runuser -u "$user" -- env -i PATH=/usr/bin:/bin timeout "$SESSION_PORTS_WAIT" bash -c \
    "echo ran; $code" _ "$@" 2>/dev/null) || rc=$?
  if [[ "$out" != ran* ]]; then return 2; fi
  if ((rc == 0)); then return 0; fi
  return 1
}

# 这台上在听的、连着的 TCP 口，带属主（ss -e 的 uid:N；root 的不带）。单拎出来，测试换成读不出的样子
session_ports_ss() { ss -Htne state listening; }
session_ports_ss_est() { ss -Htne state established; }
# 断掉一条连接：断发起方那头的套接字（ss -K，内核要开 SOCK_DESTROY），两头都收到复位。单拎出来，测试换成断不掉的样子
session_ports_kill() { ss -K -Htn state established src "$1" dst "$2" >/dev/null 2>&1; }

# 给 awk 用：从 ss 的一行里认出本端、对端（头两个带冒号的字段）和属主（uid:N，没有就是 root 的 0）。
# 不按第几列取：ss 带不带状态那一列、有没有 timer 那一段，列数都不一样
SESSION_PORTS_AWK='
function parse(   i, n) {
  n = 0; LOCAL = ""; PEER = ""; OWNER = 0
  for (i = 1; i <= NF; i++) {
    if ($i ~ /^uid:[0-9]+$/) OWNER = substr($i, 5) + 0
    else if (n < 2 && $i ~ /:/ && $i !~ /^(timer|ino|sk|cgroup|users|skmem):/) { if (n++ == 0) LOCAL = $i; else PEER = $i }
  }
}
function port(a) { sub(/.*:/, "", a); return a }
function host(a) { sub(/:[^:]*$/, "", a); gsub(/^\[|\]$/, "", a); sub(/%.*/, "", a); return a }'

# 某个 uid 此刻在听的 TCP 口：一行一个「地址 端口」。通配地址换成回环（本机别的用户就是从回环连它），[::1] 去掉方括号。
# ss 跑不成返回 1（不当成「一个口都没开」）
session_ports_listening() { # uid
  local out
  out=$(session_ports_ss 2>&1) || return 1
  awk -v want="$1" "$SESSION_PORTS_AWK"'
    { parse() }
    LOCAL == "" || OWNER != want + 0 { next }
    {
      a = host(LOCAL)
      if (a == "0.0.0.0" || a == "*") a = "127.0.0.1"
      if (a == "::") a = "::1"
      print a, port(LOCAL)
    }' <<<"$out"
}

# 连着会话用户在听的口、发起方是 root 和会话用户以外的人的连接：一行一条「发起方的 uid 发起方那头 会话用户那头」
# （两头都是 ss 的「地址:端口」写法）。规则载上以后这种连接新的连不上，还在的就是规则载上之前连上的。
# 认法：会话用户那头的套接字本端口是它在听的口，对端那个套接字（本端、对端倒过来）也在这台上、属主不是 root 和它。
# ss 跑不成返回 1
session_ports_foreign() { # 会话用户的 uid
  local lis est
  lis=$(session_ports_ss 2>&1) || return 1
  est=$(session_ports_ss_est 2>&1) || return 1
  printf 'L %s\nE %s\n' "${lis//$'\n'/$'\n'L }" "${est//$'\n'/$'\n'E }" | awk -v me="$1" "$SESSION_PORTS_AWK"'
    { tag = $1; $1 = ""; parse() }
    LOCAL == "" { next }
    tag == "L" { if (OWNER == me + 0) lport[port(LOCAL)] = 1; next }
    { own[LOCAL " " PEER] = OWNER; if (OWNER == me + 0) mine[LOCAL " " PEER] = 1 }
    END {
      for (k in mine) {
        split(k, s, " ")
        if (!(port(s[1]) in lport)) continue
        c = s[2] " " s[1]
        if ((c in own) && own[c] != 0 && own[c] != me + 0) print own[c], s[2], s[1]
      }
    }' | sort
}

# uid 换成用户名，查不到就还是 uid
session_ports_name() { getent passwd "$1" 2>/dev/null | cut -d: -f1 | grep . || echo "uid $1"; }

# 装的时候收旧连接：规则载上之前就连着会话用户的口、由别人发起的连接，规则管不到（标记只打在新连接的第一个 SYN 上），
# 在这里断掉。断了几条记一笔改动；查不成、断不掉判红、返回 1
session_ports_cut() { # 会话用户
  local session=$1 uid list left cuid csock ssock n=0
  if ! uid=$(id -u -- "$session" 2>/dev/null); then
    red "查不到会话用户 $session，规则载上之前就连着它的口的连接没查、没断"
    return 1
  fi
  if ! list=$(session_ports_foreign "$uid"); then
    red "ss 跑不成，规则载上之前就连着 $session 的口的连接没查、没断"
    return 1
  fi
  while read -r cuid csock ssock; do
    if [[ -z "$ssock" ]]; then continue; fi
    session_ports_kill "$csock" "$ssock" || true
    n=$((n + 1))
  done <<<"$list"
  if ((n == 0)); then return 0; fi
  if ! left=$(session_ports_foreign "$uid"); then
    red "断完再查时 ss 跑不成：规则载上之前就连着 $session 的口的 $n 条连接断没断没查成"
    return 1
  fi
  if [[ -n "$left" ]]; then
    red "断不掉规则载上之前就连着 $session 的口的连接（ss -K 没成，内核要开 SOCK_DESTROY）：$(head -3 <<<"$left" | tr '\n' ';')"
    return 1
  fi
  changed "断掉 $n 条规则载上之前就连着 $session 的口、由别人发起的连接"
}

# 读回：会话用户在回环上开的口只许它自己和 root 连（#35）。
#   0. 规则载上之前就连着它的口、由别人发起的连接：有就红（规则管不到，重跑 france.sh 会断掉）；
#   1. 它此刻真在听的口（reclaude 的代理口、MITM 口，会话里起的服务）：别的用户逐个去连，connect 成功就红；
#   2. 以它的身份现起一个探针监听（落在临时端口段，和 reclaude 一样）：别的用户读不到问候、它自己读得到；
#   3. 以第一个别的用户起探针、最后一个别的用户去连，读得到问候：规则只挡会话用户的口，没挡多。
# 连得上判红；查不到用户、ss 跑不成、起不了探针、没以某个用户的身份跑起来记待配（没查成，不当成挡住了）。
check_session_ports() { # 会话用户 别的用户…
  local session=$1 uid u addr port list foreign names cuid csock ssock rc bad=0 unsure=0 n=0
  shift
  local others=()
  if ! uid=$(id -u -- "$session" 2>/dev/null); then
    pending "查不到会话用户 $session，它开的口别人连不连得上没查"
    return 0
  fi
  for u in "$@"; do
    if id -u -- "$u" >/dev/null 2>&1; then
      others+=("$u")
    else
      pending "查不到用户 $u，拿他连 $session 的口这一项没查"
      unsure=1
    fi
  done
  if ((${#others[@]} == 0)); then
    pending "没有能拿来试的别的用户（给的 $* 都不在），$session 开的口别人连不连得上没查"
    unsure=1
  fi
  if ! foreign=$(session_ports_foreign "$uid") || ! list=$(session_ports_listening "$uid"); then
    pending "ss 跑不成，$session 此刻在听的口没逐个试、规则载上之前就连着它的连接没查"
    unsure=1
    foreign="" list=""
  fi
  while read -r cuid csock ssock; do
    if [[ -z "$ssock" ]]; then continue; fi
    red "$(session_ports_name "$cuid") 手上有一条规则载上之前就连着 $session 的口的连接（$csock → $ssock）：规则只管新连接，重跑 france.sh 会断掉它"
    bad=1
  done <<<"$foreign"
  while read -r addr port; do
    if [[ -z "$port" ]]; then continue; fi
    n=$((n + 1))
    for u in "${others[@]}"; do
      rc=0
      session_ports_connects "$u" "$addr" "$port" || rc=$?
      if ((rc == 0)); then
        red "$u 连得上 $session 在听的 $addr:$port（reclaude 的代理口就是这样被借走的）：nft 表 inet fleet_dao 挡会话口的规则没生效"
        bad=1
      elif ((rc == 2)); then
        pending "没以 $u 的身份跑起来（runuser 没成），他连 $session 在听的 $addr:$port 这一项没查成"
        unsure=1
      fi
    done
  done <<<"$list"
  if ! session_ports_listen "$session" 127.0.0.1; then
    pending "起不了 $session 的探针监听（$(tr '\n' ' ' <"$PROBE_LOG" 2>/dev/null | cut -c1-120)），它开的口别人连不连得上没查成"
    session_ports_stop
    return 0
  fi
  for u in "${others[@]}"; do
    rc=0
    session_ports_greets "$u" 127.0.0.1 "$PROBE_PORT" || rc=$?
    if ((rc == 0)); then
      red "$u 连得上 $session 开的口（探针 127.0.0.1:$PROBE_PORT）：它的 reclaude 代理谁都借得到，nft 表 inet fleet_dao 挡会话口的规则没生效"
      bad=1
    elif ((rc == 2)); then
      pending "没以 $u 的身份跑起来（runuser 没成），他连 $session 的探针这一项没查成"
      unsure=1
    fi
  done
  rc=0
  session_ports_greets "$session" 127.0.0.1 "$PROBE_PORT" || rc=$?
  if ((rc == 1)); then
    red "$session 连不上自己开的口（探针 127.0.0.1:$PROBE_PORT）：规则挡错了人，会话连不上自己的 reclaude"
    bad=1
  elif ((rc == 2)); then
    pending "没以 $session 的身份跑起来（runuser 没成），它连不连得上自己的口没查成"
    unsure=1
  fi
  session_ports_stop
  if ((${#others[@]})); then
    rc=0
    if ! session_ports_listen "${others[0]}" 127.0.0.1; then
      rc=2
    else
      session_ports_greets "${others[-1]}" 127.0.0.1 "$PROBE_PORT" || rc=$?
    fi
    if ((rc == 1)); then
      red "${others[-1]} 连不上 ${others[0]} 开的临时口（探针 127.0.0.1:$PROBE_PORT）：规则挡多了，只该挡会话用户的口"
      bad=1
    elif ((rc == 2)); then
      pending "起不了 ${others[0]} 的探针监听、或没以 ${others[-1]} 的身份跑起来，规则有没有挡多没查成"
      unsure=1
    fi
    session_ports_stop
  fi
  if ((bad == 0 && unsure == 0)); then
    printf -v names '%s、' "${others[@]}"
    ok "别的用户（${names%、}）连不上 $session 在本机开的口（现起的探针，和它此刻在听的 $n 个口），也没有规则载上之前连上的；它自己连得上；别人之间照常通"
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
