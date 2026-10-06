#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2016,SC2317,SC2329 # 单引号里是给 node 的代码；替身函数由被测代码间接调用，shellcheck 看不出来（CI 上的旧版报的是 2317）
# 会话用户在本机开的口只许它自己和 root 连（#35）：拿真模板 deploy/france/fleet-dao.nft 在一次性的网络命名空间里载入，
# 以三个临时用户（扮会话用户、fleet、pilot）真连一遍、内核真判，再拿 deploy/lib/session-ports.sh 的读回判一遍：
#   1. 规则在：别人连不上会话用户的口（127.0.0.1、::1 都试），会话用户和 root 连得上，别人之间照常通，Temporal 这类
#      固定端口照旧只许 root 和 fleet；被挡的连接一个都没到会话用户那头
#   2. 强制 syncookie（SYN 洪水下内核就这么做）：别人照样连不上、一个连接都到不了会话用户那头；同一场景拿掉第 4 条规则，
#      会话用户那头就接到了别人的连接——那条规则挡的是真口子。代价也钉住：这时别人之间连临时口也被复位
#   3. 读回：规则在全绿；表没装、挡错了人、挡多了都判红；它此刻真在听的口逐个试；查不到会话用户、起不了探针、ss 跑不成
#      记没查成、不说全绿；别的用户查不到、没以他的身份跑起来，都记没查成；内核里的表被手改过、和文件对不上判出来，
#      文件载不进去、表不在记没查成
#   4. 规则载上之前就连着的连接（第二意见 #343 第 1 轮）：规则管不到、照样通；读回判红写清是谁；装的时候断掉，断不掉、
#      ss 跑不成判红；断完读回全绿
# 不碰宿主的防火墙和连接：全在 unshare --net 起的命名空间里（回环是新的，宿主的 nft 表、连接跟踪都看不到）。
# 要 root（建临时用户、载 nft、换身份）。用法：sudo bash deploy/test/session-ports.test.sh。退出码：0 通过，1 不通过，2 没跑成。
# 在已有账号上验（不建临时用户，比如在法国真机上拿真的三个账号验规则）：
#   unshare --net bash deploy/test/session-ports.test.sh --inner <会话用户> <扮 fleet 的> <扮 pilot 的> <node>
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$HERE/.." && pwd)
# shellcheck source=../lib/common.sh
source "$DEPLOY/lib/common.sh"
# shellcheck source=../lib/session-ports.sh
source "$DEPLOY/lib/session-ports.sh"

FIXED_PORT=7243 # 扮 Temporal 前端：规则第一道只许 root 和 fleet 连的固定端口

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
has() { # 说明 文本 要有的（grep -E）
  if grep -qE -- "$3" <<<"$2"; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：「%s」里没有「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
lacks() { # 说明 文本 不该有的（grep -F）
  if grep -qF -- "$3" <<<"$2"; then
    printf '  ✗ %s：「%s」里不该有「%s」\n' "$1" "$2" "$3"
    fail=1
  else
    printf '  ✓ %s\n' "$1"
  fi
}
greet() { # 用户 地址 端口：读得到问候打 yes，读不到打 no，没以他的身份跑起来打 not-run
  local rc=0
  session_ports_greets "$@" || rc=$?
  case $rc in
  0) echo yes ;;
  1) echo no ;;
  *) echo not-run ;;
  esac
}
# 探针接到的连接数：到了要的数就停（接连接和写日志差几毫秒），最多等 2 秒，打出最后数到的
accepts_settle() { # 要的数
  local i n=0
  for ((i = 0; i < 20; i++)); do
    n=$(session_ports_accepts)
    n=${n:-0}
    if ((n >= $1)); then break; fi
    sleep 0.1
  done
  printf '%s' "$n"
}
skip() {
  echo "session-ports：没跑成：$*"
  exit 2
}
# 以某个用户连上去不放：读到问候后每 0.1 秒发一行 ping N，对面回了记一行 pong N；断了记 closed 或 error <原因>。
# 进程号放进 HOLD_PID，20 秒后它自己退
HOLD_PID=""
hold_as() { # 用户 端口 日志
  local gid
  gid=$(id -g -- "$1") || return 1
  (cd / && exec setpriv --reuid="$1" --regid="$gid" --init-groups env -i PATH=/usr/bin:/bin "$SESSION_PORTS_NODE" -e '
    const [port] = process.argv.slice(1);
    let buf = "";
    let n = 0;
    let timer;
    const c = require("node:net").connect(Number(port), "127.0.0.1");
    c.on("data", (d) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        console.log(line.startsWith("ping ") ? `pong ${line.slice(5)}` : `hello ${line}`);
        if (!timer) timer = setInterval(() => c.write(`ping ${++n}\n`), 100);
      }
    });
    c.on("error", (e) => {
      console.log(`error ${e.code}`);
      process.exit(0);
    });
    c.on("close", () => {
      console.log("closed");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 20000);' "$2") >"$3" 2>&1 &
  HOLD_PID=$!
}
# 日志里出现要的那一行（grep -E）就返回 0，最多等 3 秒
wait_log() { # 日志 要有的
  local i
  for ((i = 0; i < 30; i++)); do
    if grep -qE -- "$2" "$1" 2>/dev/null; then return 0; fi
    sleep 0.1
  done
  return 1
}
pongs() { grep -c '^pong ' "$1" 2>/dev/null || true; }

inner() { # 会话用户 扮fleet 扮pilot node
  local S=$1 F=$2 P=$3 s_uid f_uid rl_pid rl_port rl_log handle out n rc=0
  SESSION_PORTS_NODE=$4
  SESSION_PORTS_WAIT=1 # 回环上连得通是毫秒级的事，被挡的每次都要等满，测试里短一点
  T=$(mktemp -d)
  trap 'session_ports_stop; rm -rf -- "$T"' EXIT
  if ! s_uid=$(id -u -- "$S") || ! f_uid=$(id -u -- "$F") || ! id -u -- "$P" >/dev/null; then
    skip "查不到 $S、$F、$P 的 uid"
  fi
  ip link set lo up || skip "起不了新命名空间里的回环"
  sysctl -qw net.ipv4.tcp_syncookies=1 || skip "改不了新命名空间里的 net.ipv4.tcp_syncookies"
  render "$DEPLOY/france/fleet-dao.nft" PORTS="$FIXED_PORT" FLEET_UID="$f_uid" SESSION_UID="$s_uid" >/dev/null || skip "模板渲染不了"
  NFT_FILE=$T/nftables.nft
  printf '%s\n' "$RENDERED" >"$NFT_FILE"
  load() { nft -f "$NFT_FILE"; }

  echo "== 0. 真模板载得进去"
  load
  check "nft -f 渲染好的 fleet-dao.nft" "$?" 0

  echo "== 1. 规则在：会话用户的口只许它自己和 root 连"
  session_ports_listen "$S" 127.0.0.1 || skip "起不了会话用户的探针监听：$(cat "$PROBE_LOG")"
  check "扮 pilot 的连不上会话用户的口（127.0.0.1:$PROBE_PORT）" "$(greet "$P" 127.0.0.1 "$PROBE_PORT")" no
  check "扮 fleet 的连不上会话用户的口" "$(greet "$F" 127.0.0.1 "$PROBE_PORT")" no
  check "会话用户自己连得上" "$(greet "$S" 127.0.0.1 "$PROBE_PORT")" yes
  check "root 连得上" "$(greet root 127.0.0.1 "$PROBE_PORT")" yes
  check "被挡的连接一个都没到会话用户那头（只接了会话用户、root 两个）" "$(accepts_settle 2)" 2
  session_ports_stop
  if session_ports_listen "$S" ::1; then
    check "::1 上也挡：扮 pilot 的连不上" "$(greet "$P" ::1 "$PROBE_PORT")" no
    check "::1 上会话用户自己连得上" "$(greet "$S" ::1 "$PROBE_PORT")" yes
  else
    echo "  ✗ 没跑成：新命名空间的回环上起不了 ::1 的监听（$(cat "$PROBE_LOG")）"
    rc=2
  fi
  session_ports_stop
  session_ports_listen "$F" 127.0.0.1 || skip "起不了扮 fleet 的探针监听"
  check "别人之间照常通：扮 pilot 的连扮 fleet 的临时口" "$(greet "$P" 127.0.0.1 "$PROBE_PORT")" yes
  check "扮 fleet 的连自己的临时口照常通" "$(greet "$F" 127.0.0.1 "$PROBE_PORT")" yes
  session_ports_stop
  session_ports_listen "$F" 127.0.0.1 "$FIXED_PORT" || skip "起不了固定端口 $FIXED_PORT 的监听"
  check "固定端口 $FIXED_PORT 照旧只许 fleet：扮 fleet 的连得上" "$(greet "$F" 127.0.0.1 "$FIXED_PORT")" yes
  check "固定端口：会话用户连不上" "$(greet "$S" 127.0.0.1 "$FIXED_PORT")" no
  check "固定端口：扮 pilot 的连不上" "$(greet "$P" 127.0.0.1 "$FIXED_PORT")" no
  session_ports_stop

  echo "== 2. 强制 syncookie（SYN 洪水下内核就这么做）：SYN-ACK 不挂套接字，第 2 条认不出应答的是谁"
  sysctl -qw net.ipv4.tcp_syncookies=2
  session_ports_listen "$S" 127.0.0.1 || skip "起不了会话用户的探针监听"
  check "扮 pilot 的照样连不上会话用户的口" "$(greet "$P" 127.0.0.1 "$PROBE_PORT")" no
  check "会话用户自己连得上" "$(greet "$S" 127.0.0.1 "$PROBE_PORT")" yes
  check "别人的连接一个都没到会话用户那头（只接了会话用户一个）" "$(accepts_settle 1)" 1
  session_ports_stop
  session_ports_listen "$F" 127.0.0.1 || skip "起不了扮 fleet 的探针监听"
  check "代价（规则注释里写着）：这时别人之间连临时口也被复位" "$(greet "$P" 127.0.0.1 "$PROBE_PORT")" no
  session_ports_stop
  session_ports_listen "$F" 127.0.0.1 "$FIXED_PORT" || skip "起不了固定端口 $FIXED_PORT 的监听"
  check "固定端口不受这个代价影响：扮 fleet 的照常连得上" "$(greet "$F" 127.0.0.1 "$FIXED_PORT")" yes
  session_ports_stop
  grep -v 'dport >= 32768' "$NFT_FILE" >"$T/no-rule-4.nft"
  nft -f "$T/no-rule-4.nft"
  session_ports_listen "$S" 127.0.0.1 || skip "起不了会话用户的探针监听"
  greet "$P" 127.0.0.1 "$PROBE_PORT" >/dev/null
  # 拿 syncookie 的 ACK 当握手完成，他收尾的 FIN 每重传一次、会话用户那头就又接一次，所以只数有没有
  n=$(accepts_settle 1)
  check "对照：拿掉第 4 条，扮 pilot 的连接到了会话用户那头（盲送数据的口子）" "$((n > 0))" 1
  session_ports_stop
  sysctl -qw net.ipv4.tcp_syncookies=1
  load

  echo "== 3. 读回（lib/session-ports.sh 的 check_session_ports）"
  # 扮 reclaude：会话用户另开一个不回问候的口，读回要把它也逐个试
  session_ports_listen "$S" 127.0.0.1 || skip "起不了扮 reclaude 的监听"
  rl_pid=$PROBE_PID rl_port=$PROBE_PORT rl_log=$PROBE_LOG
  PROBE_PID="" PROBE_PORT="" PROBE_LOG=""
  REDS=() PENDING=()
  out=$(check_session_ports "$S" "$F" "$P" 2>&1; printf '\n%s %s' "${#REDS[@]}" "${#PENDING[@]}")
  check "规则在：没有红、没有没查成" "${out##*$'\n'}" "0 0"
  has "规则在：全绿，写清试了它此刻在听的 1 个口" "$out" "✓ 别的用户（$F、$P）连不上 $S 在本机开的口（现起的探针，和它此刻在听的 1 个口）"
  nft delete table inet fleet_dao
  out=$(check_session_ports "$S" "$F" "$P" 2>&1; printf '\n%s %s' "${#REDS[@]}" "${#PENDING[@]}")
  has "表没装：扮 pilot 的连得上它在听的口，判红" "$out" "✗ $P 连得上 $S 在听的 127.0.0.1:$rl_port"
  has "表没装：扮 fleet 的连得上探针，判红" "$out" "✗ $F 连得上 $S 开的口（探针 127.0.0.1:[0-9]+）"
  lacks "表没装：没有全绿" "$out" "✓"
  load
  nft add rule inet fleet_dao output oifname lo tcp dport '>=' 32768 meta skuid "$s_uid" reject with tcp reset
  out=$(check_session_ports "$S" "$F" "$P" 2>&1)
  has "挡错了人（会话用户连不上自己）：判红" "$out" "✗ $S 连不上自己开的口"
  load
  nft add rule inet fleet_dao output oifname lo tcp dport '>=' 32768 tcp flags '&' '(syn | ack)' == syn meta skuid != "{ 0, $s_uid }" reject with tcp reset
  out=$(check_session_ports "$S" "$F" "$P" 2>&1)
  has "挡多了（别人之间的临时口也挡）：判红" "$out" "✗ $P 连不上 $F 开的临时口.*挡多了"
  load
  kill "$rl_pid" 2>/dev/null
  wait "$rl_pid" 2>/dev/null
  rm -f -- "$rl_log"
  REDS=() PENDING=()
  out=$(check_session_ports no-such-user-35 "$F" "$P" 2>&1; printf '\n%s %s' "${#REDS[@]}" "${#PENDING[@]}")
  has "查不到会话用户：记没查成" "$out" "… 查不到会话用户 no-such-user-35"
  check "查不到会话用户：不判红、只一笔没查成" "${out##*$'\n'}" "0 1"
  out=$(
    SESSION_PORTS_NODE=$T/no-such-node
    check_session_ports "$S" "$F" "$P" 2>&1
    printf '\n%s %s' "${#REDS[@]}" "${#PENDING[@]}"
  )
  has "起不了探针：记没查成" "$out" "… 起不了 $S 的探针监听"
  lacks "起不了探针：不说全绿" "$out" "✓"
  check "起不了探针：不判红" "${out##*$'\n'}" "0 1"
  out=$(
    session_ports_ss() {
      echo "ss: 故意跑不成" >&2
      return 1
    }
    check_session_ports "$S" "$F" "$P" 2>&1
    printf '\n%s %s' "${#REDS[@]}" "${#PENDING[@]}"
  )
  has "ss 跑不成：记没查成" "$out" "… ss 跑不成，$S 此刻在听的口没逐个试"
  lacks "ss 跑不成：不说全绿" "$out" "✓"
  check "ss 跑不成：探针那段照样查了、没有红" "${out##*$'\n'}" "0 1"
  session_ports_greets no-such-user-35 127.0.0.1 "$FIXED_PORT"
  check "查不到的用户去连：返回 2（没跑起来），不当成连不上" "$?" 2
  out=$(check_session_ports "$S" "$F" no-such-user-35 2>&1; printf '\n%s %s' "${#REDS[@]}" "${#PENDING[@]}")
  has "别的用户里有查不到的：记没查成" "$out" "… 查不到用户 no-such-user-35"
  lacks "别的用户里有查不到的：不说全绿" "$out" "✓"
  check "别的用户里有查不到的：不判红、只一笔没查成（查得到的照样查了）" "${out##*$'\n'}" "0 1"
  out=$(
    session_ports_try() { return 2; }
    check_session_ports "$S" "$F" "$P" 2>&1
    printf '\n%s %s' "${#REDS[@]}" "${#PENDING[@]}"
  )
  has "runuser 没成：记没查成、写清是谁" "$out" "… 没以 $F 的身份跑起来"
  lacks "runuser 没成：不说全绿" "$out" "✓"
  check "runuser 没成：不当成连不上、不判红" "$(cut -d' ' -f1 <<<"${out##*$'\n'}")" 0

  echo "== 4. 规则载上之前就连着的连接：规则管不到，装的时候断掉，读回判出来"
  nft delete table inet fleet_dao
  session_ports_listen "$S" 127.0.0.1 || skip "起不了会话用户的探针监听"
  hold_as "$P" "$PROBE_PORT" "$T/hold.log" || skip "起不了扮 pilot 的长连接"
  wait_log "$T/hold.log" '^pong 3$' || skip "扮 pilot 的长连接没连上（$(tr '\n' ' ' <"$T/hold.log")）"
  load
  n=$(pongs "$T/hold.log")
  wait_log "$T/hold.log" "^pong $((n + 3))\$"
  check "对照：规则载上以后，扮 pilot 早先连上的那条照样通（规则只管新连接）" "$?" 0
  check "认得出这条（发起方是扮 pilot 的）" "$(session_ports_foreign "$s_uid" | cut -d' ' -f1)" "$(id -u -- "$P")"
  out=$(check_session_ports "$S" "$F" "$P" 2>&1)
  has "读回判红，写清是谁、哪条" "$out" "✗ $P 手上有一条规则载上之前就连着 $S 的口的连接（127\.0\.0\.1:[0-9]+ → 127\.0\.0\.1:$PROBE_PORT）"
  out=$(
    session_ports_kill() { return 0; }
    CHANGES=() REDS=()
    session_ports_cut "$S" 2>&1
    printf '\n%s %s %s' "$?" "${#CHANGES[@]}" "${#REDS[@]}"
  )
  check "断不掉（ss -K 没成）：返回 1、不记改动、记一笔红" "${out##*$'\n'}" "1 0 1"
  has "断不掉：红里写清" "$out" "✗ 断不掉规则载上之前就连着 $S 的口的连接"
  out=$(
    session_ports_ss_est() {
      echo "ss: 故意跑不成" >&2
      return 1
    }
    CHANGES=() REDS=()
    session_ports_cut "$S" 2>&1
    printf '\n%s %s %s' "$?" "${#CHANGES[@]}" "${#REDS[@]}"
  )
  check "ss 跑不成：返回 1、不记改动、记一笔红" "${out##*$'\n'}" "1 0 1"
  has "ss 跑不成：红里写清" "$out" "✗ ss 跑不成，规则载上之前就连着 $S 的口的连接没查、没断"
  CHANGES=() REDS=()
  session_ports_cut "$S" >"$T/cut.out" 2>&1
  check "装的时候断掉：返回 0" "$?" 0
  check "装的时候断掉：记一笔改动、没有红" "${#CHANGES[@]} ${#REDS[@]}" "1 0"
  has "改动写清断了几条" "$(cat "$T/cut.out")" "↻ 断掉 1 条规则载上之前就连着 $S 的口"
  wait_log "$T/hold.log" '^(closed|error)'
  check "扮 pilot 那条真断了" "$?" 0
  check "断完再查一条都没有" "$(session_ports_foreign "$s_uid")" ""
  CHANGES=() REDS=()
  session_ports_cut "$S" >/dev/null 2>&1
  check "没有要断的：返回 0、不记改动" "$? ${#CHANGES[@]}" "0 0"
  out=$(check_session_ports "$S" "$F" "$P" 2>&1; printf '\n%s %s' "${#REDS[@]}" "${#PENDING[@]}")
  check "断完读回：没有红、没有没查成" "${out##*$'\n'}" "0 0"
  kill "$HOLD_PID" 2>/dev/null
  wait "$HOLD_PID" 2>/dev/null
  session_ports_stop

  echo "== 3. 读回：内核里的表就是文件那一份"
  nft_table_same_as_file inet fleet_dao "$NFT_FILE"
  check "刚载的：一样（返回 0）" "$?" 0
  handle=$(nft -a list chain inet fleet_dao output | awk '/dport >= 32768/ { print $NF }')
  nft delete rule inet fleet_dao output handle "$handle"
  nft_table_same_as_file inet fleet_dao "$NFT_FILE"
  check "手删了第 4 条：不一样（返回 1）" "$?" 1
  printf 'table inet fleet_dao {\n' >"$T/broken.nft"
  nft_table_same_as_file inet fleet_dao "$T/broken.nft"
  check "文件载不进去：没查成（返回 2）" "$?" 2
  has "文件载不进去：写清原因" "$NFT_SAME_WHY" "载不进去"
  nft delete table inet fleet_dao
  nft_table_same_as_file inet fleet_dao "$NFT_FILE"
  check "内核里没这张表：没查成（返回 2）" "$?" 2
  has "内核里没这张表：写清原因" "$NFT_SAME_WHY" "列不出内核里的表"

  if ((fail)); then
    echo "session-ports：不通过"
    exit 1
  fi
  if ((rc == 2)); then
    echo "session-ports：没跑成（上面标了没跑成的那几项）"
    exit 2
  fi
  echo "session-ports：通过"
  exit 0
}

if [[ "${1-}" == --inner ]]; then
  shift
  if (($# != 4)); then skip "--inner 要四个参数：会话用户 扮fleet 扮pilot node"; fi
  inner "$@"
fi

if ((EUID != 0)); then skip "要 root（建临时用户、载 nft、换身份）"; fi
for n in nft unshare setpriv runuser ss timeout useradd userdel pkill ip sysctl; do
  command -v "$n" >/dev/null || skip "这台没有 $n"
done
# sudo 会换掉 PATH，CI 里 setup-node 装的那个不在上面，去它的缓存目录找
NODE=""
for n in "$(command -v node 2>/dev/null || true)" /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node /usr/local/bin/node; do
  if [[ -x "$n" ]]; then
    NODE=$n
    break
  fi
done
if [[ -z "$NODE" ]]; then skip "这台找不到 node"; fi
USERS=("fsp-s-$$" "fsp-f-$$" "fsp-p-$$") # 扮会话用户、fleet、pilot
cleanup() {
  local u
  for u in "${USERS[@]}"; do
    pkill -KILL -u "$u" >/dev/null 2>&1
    userdel "$u" >/dev/null 2>&1
  done
}
trap cleanup EXIT
for n in "${USERS[@]}"; do
  useradd --system --user-group --no-create-home --home-dir / --shell /usr/sbin/nologin "$n" >/dev/null 2>&1 ||
    skip "建不了临时用户 $n"
done
# 退出码就是里面那一趟的（EXIT 陷阱收临时用户，不改退出码）
unshare --net -- bash "$HERE/session-ports.test.sh" --inner "${USERS[@]}" "$NODE"
