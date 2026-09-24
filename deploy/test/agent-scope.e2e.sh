#!/usr/bin/env bash
# 真机验收（法国，root 跑）：会话通路 fleet → sudo → fleet-agent-scope → orca 真跑一遍。
#   1. 落点与身份：会话在 fleet-agents.slice 下自己的 scope 里，身份是 orca、不带 root 组，上限写进了 cgroup
#   2. 上限生效：内存超了只杀它（OOM），进程数到顶 fork 失败
#   3. 引擎重启：假引擎（fleet 身份的临时服务）起了会话后被停掉，会话还在；新引擎按 scope 名 list 找回、stop 收掉
# 用法：sudo bash deploy/test/agent-scope.e2e.sh。退出码 0 通过、1 不通过、2 没跑成。只起临时单元，结束时收干净。
set -uo pipefail
BIN=/usr/local/sbin/fleet-agent-scope
TAG=e2e-$$
fail=0

if ((EUID != 0)); then
  echo "没跑成：要 root"
  exit 2
fi
if [[ ! -x "$BIN" ]] || ! id fleet >/dev/null 2>&1 || ! id orca >/dev/null 2>&1; then
  echo "没跑成：先跑 deploy/france.sh（要有 $BIN、用户 fleet 和 orca）"
  exit 2
fi

pass() { echo "  ✓ $*"; }
flunk() {
  echo "  ✗ $*"
  fail=1
}
# 以引擎的身份调脚本：干净环境、当前目录是 fleet 自己的家
as_fleet() { (cd /home/fleet && runuser -u fleet -- env -i HOME=/home/fleet PATH=/usr/bin:/bin LANG=C.UTF-8 "$@"); }
scope_pids() { cat "/sys/fs/cgroup$(systemctl show -p ControlGroup --value "fleet-agent-$1.scope")/cgroup.procs" 2>/dev/null; }
wait_scope() { # 编号 要的状态（active / gone）
  local i state
  for ((i = 0; i < 50; i++)); do
    state=$(systemctl show -p ActiveState --value "fleet-agent-$1.scope" 2>/dev/null)
    if [[ "$2" == active && "$state" == active ]] || [[ "$2" == gone && "$state" != active ]]; then return 0; fi
    sleep 0.2
  done
  return 1
}
cleanup() {
  systemctl stop fleet-engine-$TAG.service 2>/dev/null
  for u in $(systemctl list-units --all --plain --no-legend "fleet-agent-$TAG*.scope" | awk '{ print $1 }'); do systemctl stop "$u"; done
}
trap cleanup EXIT

echo "== 1. 落点与身份"
id=$TAG-a
as_fleet sudo -n "$BIN" run "$id" --memory-high 48M --memory-max 64M --tasks-max 32 --cpu-weight 50 -- /bin/sleep 300 &
if wait_scope "$id" active; then
  pid=$(scope_pids "$id" | head -1)
  cg=/sys/fs/cgroup$(systemctl show -p ControlGroup --value "fleet-agent-$id.scope")
  if [[ "$(ps -o user= -p "$pid" | tr -d ' ')" == orca ]]; then pass "会话进程 $pid 的身份是 orca"; else flunk "会话进程身份是「$(ps -o user= -p "$pid")」"; fi
  if [[ " $(awk '/^Groups:/ { $1 = ""; print }' "/proc/$pid/status") " != *" 0 "* ]]; then pass "不带 root 组"; else flunk "带着 root 组"; fi
  if [[ "$(cat "/proc/$pid/cgroup")" == "0::/fleet.slice/fleet-agents.slice/fleet-agent-$id.scope" ]]; then
    pass "落在 /fleet.slice/fleet-agents.slice/fleet-agent-$id.scope"
  else
    flunk "落在 $(cat "/proc/$pid/cgroup")"
  fi
  limits="$(cat "$cg/memory.high") $(cat "$cg/memory.max") $(cat "$cg/pids.max") $(cat "$cg/cpu.weight")"
  if [[ "$limits" == "50331648 67108864 32 50" ]]; then pass "上限写进了 cgroup（memory.high 48M、memory.max 64M、pids.max 32、cpu.weight 50）"; else flunk "cgroup 里的上限是 $limits"; fi
  as_fleet sudo -n "$BIN" stop "$id" >/dev/null
  if wait_scope "$id" gone && ! kill -0 "$pid" 2>/dev/null; then pass "stop 之后 scope 和进程都没了"; else flunk "stop 之后还在"; fi
else
  flunk "scope 没起来"
fi
wait

echo "== 2. 上限生效"
id=$TAG-mem
since=$(date '+%Y-%m-%d %H:%M:%S')
as_fleet sudo -n "$BIN" run "$id" --memory-max 64M -- /usr/bin/python3 -c 'b = bytearray(512 * 1024 * 1024)' 2>/dev/null
rc=$?
if ((rc == 137)) && journalctl -k --since "$since" --no-pager 2>/dev/null | grep -q "oom_memcg=/fleet.slice/fleet-agents.slice/fleet-agent-$id.scope"; then
  pass "要 512M 的会话被 OOM 杀掉（退出码 137），内核记的是它自己的 scope"
else
  flunk "内存上限没生效（退出码 $rc）"
fi
id=$TAG-pids
out=$(as_fleet sudo -n "$BIN" run "$id" --tasks-max 8 -- /usr/bin/python3 -c '
import os, time
ok = bad = 0
for _ in range(20):
    try:
        if os.fork() == 0:
            time.sleep(3); os._exit(0)
        ok += 1
    except OSError:
        bad += 1
print(ok, bad)' 2>/dev/null)
read -r forked refused <<<"$out"
if ((${forked:-99} < 8 && ${refused:-0} > 0)); then pass "进程数到顶：20 次 fork 成功 $forked、被拒 $refused"; else flunk "进程数上限没生效（$out）"; fi

# 假引擎：以 fleet 身份跑的临时服务，经 sudo 起一个会话然后自己挂着
start_fake_engine() { # 会话编号
  systemd-run --quiet --unit="fleet-engine-$TAG" --uid=fleet --gid=fleet -p WorkingDirectory=/home/fleet \
    /bin/bash -c "sudo -n $BIN run $1 -- /bin/sleep 600 & sleep 600"
}

echo "== 3. 引擎崩掉（SIGKILL）：会话留在自己的 scope 里，新引擎按名字找回并收掉"
id=$TAG-orphan
start_fake_engine "$id"
if wait_scope "$id" active; then
  pid=$(scope_pids "$id" | head -1)
  systemctl kill --signal=SIGKILL "fleet-engine-$TAG.service"
  sleep 1
  systemctl stop "fleet-engine-$TAG.service" 2>/dev/null
  if kill -0 "$pid" 2>/dev/null && [[ "$(systemctl show -p ActiveState --value "fleet-agent-$id.scope")" == active ]]; then
    pass "假引擎崩掉后，会话（pid $pid）还在自己的 scope 里，没跟着引擎的 cgroup 一起没"
  else
    flunk "假引擎一崩，会话也没了（它没在自己的 scope 里）"
  fi
  if as_fleet sudo -n "$BIN" list | grep -qx "$id active"; then pass "新引擎用 list 找回了它"; else flunk "list 里找不到 $id"; fi
  as_fleet sudo -n "$BIN" stop "$id" >/dev/null
  if wait_scope "$id" gone && ! kill -0 "$pid" 2>/dev/null; then pass "新引擎 stop 收掉了它"; else flunk "stop 没收掉"; fi
  if [[ "$(as_fleet sudo -n "$BIN" stop "$id")" == *"已经不在了"* ]]; then pass "再收一次已经没了的会话：正常返回"; else flunk "收已经没了的会话没有正常返回"; fi
else
  flunk "假引擎起的会话 scope 没起来"
fi

echo "== 3b. 引擎正常停（SIGTERM）：sudo 把信号转给会话，会话跟着退，不留孤儿"
id=$TAG-graceful
start_fake_engine "$id"
if wait_scope "$id" active; then
  systemctl stop "fleet-engine-$TAG.service"
  if wait_scope "$id" gone; then pass "引擎一停，会话收到 SIGTERM 退了，scope 自动回收"; else flunk "引擎停了，会话还挂着"; fi
else
  flunk "假引擎起的会话 scope 没起来"
fi

echo "== 4. 不该放行的"
if as_fleet sudo -n "$BIN" run "$TAG-bad" --memory-max 1G -- sleep 1 2>/dev/null; then flunk "相对路径的命令被放行了"; else pass "相对路径的命令被拒"; fi
if as_fleet sudo -n "$BIN" run "../x" -- /bin/true 2>/dev/null; then flunk "带 ../ 的编号被放行了"; else pass "带 ../ 的编号被拒"; fi
if as_fleet sudo -n "$BIN" run "$TAG-cwd" --cwd /root -- /bin/true 2>/dev/null; then flunk "orca 进不去的目录被放行了"; else pass "orca 进不去的 --cwd /root 被拒"; fi
if as_fleet sudo -n /bin/true 2>/dev/null; then flunk "fleet 能 sudo 别的命令"; else pass "fleet 不能 sudo 别的命令"; fi

if ((fail)); then
  echo "不通过"
  exit 1
fi
echo "通过"
