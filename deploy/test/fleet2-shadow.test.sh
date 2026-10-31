#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 影子工人的出网限制（deploy/france/fleet2-shadow.nft，#3775）：拿真模板在一次性的网络命名空间里载入，
# 建一个临时 cgroup 扮 fleet2-shadow.slice，在它里面和它外面各连一次，看规则：
#   在 slice 里：发往外面 443 的被重定向到出网关的口；发往外面别的口的被复位；回环照常通。
#   不在 slice 里：不受影响（不重定向）。
# 不碰宿主的防火墙和连接：全在 unshare --net 起的命名空间里；临时 cgroup 跑完删掉。
# 要 root。用法：sudo bash deploy/test/fleet2-shadow.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$HERE/.." && pwd)
# shellcheck source=../lib/common.sh
source "$DEPLOY/lib/common.sh"

EGRESS_PORT=7344 # 扮出网关
LOCAL_PORT=7345  # 扮回环上的 MCP
FAR=192.0.2.2    # 扮外面的地址（文档保留段，挂在临时的 dummy 网卡后面，没人应答）

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
skip() {
  echo "fleet2-shadow：没跑成：$*"
  exit 2
}

((EUID == 0)) || skip "要 root（载 nft、建 cgroup）"
NODE=$(command -v node) || skip "没有 node"
for c in nft unshare ip; do command -v "$c" >/dev/null || skip "没有 $c"; done
[[ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" == cgroup2fs ]] || skip "/sys/fs/cgroup 不是 cgroup2"

if [[ "${1-}" != --inner ]]; then
  exec unshare --net bash "${BASH_SOURCE[0]}" --inner
fi

echo "== 0. slice 名换成 cgroup 树里的路径和层数"
slice_cgroup_path fleet2-shadow.slice
check "fleet2-shadow.slice" "$SLICE_LEVEL $SLICE_PATH" "2 fleet2.slice/fleet2-shadow.slice"
slice_cgroup_path fleet.slice
check "fleet.slice" "$SLICE_LEVEL $SLICE_PATH" "1 fleet.slice"
slice_cgroup_path a-b-c.slice
check "a-b-c.slice" "$SLICE_LEVEL $SLICE_PATH" "3 a.slice/a-b.slice/a-b-c.slice"
slice_cgroup_path fleet2-shadow >/dev/null 2>&1
check "不带 .slice 的拒" "$?" 1
slice_cgroup_path a--b.slice >/dev/null 2>&1
check "连着两个横杠的拒" "$?" 1

T=$(mktemp -d)
# 和真的 fleet2-shadow.slice 一样套两层，规则按真路径和层数认
TOP=f2test$$
slice_cgroup_path "$TOP-shadow.slice" || skip "算不出临时 slice 的路径"
CG=$SLICE_PATH CG_LEVEL=$SLICE_LEVEL
LISTEN_PIDS=()
cleanup() {
  for p in "${LISTEN_PIDS[@]}"; do kill "$p" 2>/dev/null; done
  rmdir "/sys/fs/cgroup/$CG" "/sys/fs/cgroup/$TOP.slice" 2>/dev/null
  rm -rf -- "$T"
}
trap cleanup EXIT
mkdir -p "/sys/fs/cgroup/$CG" || skip "建不了临时 cgroup /sys/fs/cgroup/$CG"
ip link set lo up || skip "起不了新命名空间里的回环"
if ! { ip link add d0 type dummy && ip addr add 192.0.2.1/24 dev d0 && ip link set d0 up; }; then
  skip "建不了 dummy 网卡"
fi

render "$DEPLOY/france/fleet2-shadow.nft" SLICE="$TOP-shadow.slice" SLICE_PATH="$CG" SLICE_LEVEL="$CG_LEVEL" \
  EGRESS_PORT="$EGRESS_PORT" >/dev/null || skip "模板渲染不了"
printf '%s\n' "$RENDERED" >"$T/fleet2-shadow.nft"

# 在本机回环上听一个口，每接一个连接往日志写一行
listen() { # 端口 日志
  "$NODE" -e '
    const [port, log] = process.argv.slice(1);
    require("node:net").createServer((s) => { require("node:fs").appendFileSync(log, "got\n"); s.end(); })
      .listen(Number(port), "127.0.0.1", () => console.log("ready"));' "$1" "$2" >"$T/listen-$1.out" 2>&1 &
  LISTEN_PIDS+=("$!")
  local i
  for ((i = 0; i < 30; i++)); do
    grep -q ready "$T/listen-$1.out" 2>/dev/null && return 0
    sleep 0.1
  done
  return 1
}
# 连一次：连上打 ok，被拒打错误码，1.5 秒没结果打 timeout
CONNECT='
  const [host, port] = process.argv.slice(1);
  const s = require("node:net").connect(Number(port), host);
  const done = (w) => { console.log(w); process.exit(0); };
  s.on("connect", () => done("ok"));
  s.on("error", (e) => done(e.code));
  setTimeout(() => done("timeout"), 1500);'
conn() { "$NODE" -e "$CONNECT" "$@"; }
# 先把自己放进临时 cgroup 再连
conn_shadow() { bash -c 'echo $$ >"/sys/fs/cgroup/$1/cgroup.procs" && shift && exec "$@"' _ "$CG" "$NODE" -e "$CONNECT" "$@"; }
count() { grep -c got "$1" 2>/dev/null || echo 0; }

echo "== 1. 真模板载得进去（slice 在的时候）"
nft -f "$T/fleet2-shadow.nft"
check "nft -f 渲染好的 fleet2-shadow.nft" "$?" 0
listen "$EGRESS_PORT" "$T/egress.log" || skip "起不了扮出网关的监听"
listen "$LOCAL_PORT" "$T/local.log" || skip "起不了扮 MCP 的监听"

echo "== 2. 在影子 slice 里"
check "连外面的 443：被重定向到出网关" "$(conn_shadow "$FAR" 443)" ok
check "出网关接到了这一个连接" "$(count "$T/egress.log")" 1
check "连外面的 80：被复位" "$(conn_shadow "$FAR" 80)" ECONNREFUSED
check "连外面的 22：被复位" "$(conn_shadow "$FAR" 22)" ECONNREFUSED
check "回环上的 MCP 口照常通" "$(conn_shadow 127.0.0.1 "$LOCAL_PORT")" ok

echo "== 3. 不在影子 slice 里（引擎会话、别的进程）"
check "连外面的 443：不重定向（外面没人应答，等满时限）" "$(conn "$FAR" 443)" timeout
check "出网关没多接连接" "$(count "$T/egress.log")" 1

echo "== 4. slice 不在时载不进（所以单元排在 slice 之后）"
render "$DEPLOY/france/fleet2-shadow.nft" SLICE="$TOP-missing.slice" SLICE_PATH="$TOP.slice/$TOP-missing.slice" \
  SLICE_LEVEL=2 EGRESS_PORT="$EGRESS_PORT" >/dev/null
printf '%s\n' "$RENDERED" >"$T/missing.nft"
nft -f "$T/missing.nft" 2>/dev/null
check "cgroup 路径不在：nft -f 失败" "$(($? != 0))" 1

nft delete table inet fleet2_shadow 2>/dev/null
if ((fail)); then
  echo "fleet2-shadow：不通过"
  exit 1
fi
echo "fleet2-shadow：通过"
