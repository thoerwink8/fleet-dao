#!/usr/bin/env bash
# 真机验收（法国，root 跑）：会话通路 fleet → sudo → fleet-agent-scope → 会话专用用户 真跑一遍。
#   1. 落点与身份：两个会话用户各起一次，会话在 fleet-agents.slice 下自己的 scope 里，身份对、只在自己的组里、提不了权、上限写进 cgroup
#   2. 会话里的边界：读不到 /etc/fleet-dao、sudo 失败、没有 GitHub 凭据（调用方塞了也带不进去）、连得上 fleet 命令接口、
#      连不上 Temporal 和库
#   3. 上限生效：内存（连 swap 一起封）超了只杀它，进程数到顶 fork 失败
#   4. 引擎崩了会话留在自己的 scope 里、按名字找回收掉；引擎正常停会话跟着退
#   5. 不该放行的参数
# 用法：sudo bash deploy/test/agent-scope.e2e.sh。退出码 0 通过、1 不通过、2 没跑成。只起临时单元，结束时收干净。
set -uo pipefail
BIN=/usr/local/sbin/fleet-agent-scope
SESSION_USERS=(fleet-agent-dedicated fleet-agent-carpool)
U=${SESSION_USERS[0]}
AGENT_API_PORT=8788 # fleet 命令接口（packages/api 的 FLEET_AGENT_LISTEN）
TAG=e2e-$$
fail=0

if ((EUID != 0)); then
  echo "没跑成：要 root"
  exit 2
fi
if [[ ! -x "$BIN" ]] || ! id fleet >/dev/null 2>&1 || ! id "$U" >/dev/null 2>&1; then
  echo "没跑成：先跑 deploy/france.sh（要有 $BIN、用户 fleet 和会话用户）"
  exit 2
fi

pass() { echo "  ✓ $*"; }
flunk() {
  echo "  ✗ $*"
  fail=1
}
# 以引擎的身份调脚本：干净环境、当前目录是 fleet 自己的家；额外的环境变量跟在后面（env 的写法）
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
  local u
  for u in $(systemctl list-units --all --plain --no-legend "fleet-engine-$TAG*.service" "fleet-e2e-api-$TAG.service" \
    "fleet-agent-$TAG*.scope" | awk '{ print $1 }'); do
    systemctl stop "$u" 2>/dev/null
    systemctl reset-failed "$u" 2>/dev/null
  done
}
trap cleanup EXIT

echo "== 1. 落点与身份"
for user in "${SESSION_USERS[@]}"; do
  id=$TAG-$user
  as_fleet sudo -n "$BIN" run "$id" --user "$user" --memory-high 48M --memory-max 64M --tasks-max 32 --cpu-weight 50 -- /bin/sleep 300 &
  if wait_scope "$id" active; then
    pid=$(scope_pids "$id" | head -1)
    cg=/sys/fs/cgroup$(systemctl show -p ControlGroup --value "fleet-agent-$id.scope")
    if [[ "$(ps -o user:32= -p "$pid" | tr -d ' ')" == "$user" ]]; then pass "$user：会话进程 $pid 的身份对"; else flunk "$user：会话进程身份是「$(ps -o user:32= -p "$pid")」"; fi
    if [[ "$(awk '/^Groups:/ { $1 = ""; print }' "/proc/$pid/status" | xargs)" == "$(id -g "$user")" ]]; then
      pass "$user：只在自己的组里（不带 root 组、不在 orca 组）"
    else
      flunk "$user：附加组是「$(awk '/^Groups:/' "/proc/$pid/status")」"
    fi
    if [[ "$(awk '/^NoNewPrivs:/ { print $2 }' "/proc/$pid/status")" == 1 ]]; then pass "$user：NoNewPrivs=1，提不了权"; else flunk "$user：没设 NoNewPrivs"; fi
    if [[ "$(cat "/proc/$pid/cgroup")" == "0::/fleet.slice/fleet-agents.slice/fleet-agent-$id.scope" ]]; then
      pass "$user：落在 /fleet.slice/fleet-agents.slice/fleet-agent-$id.scope"
    else
      flunk "$user：落在 $(cat "/proc/$pid/cgroup")"
    fi
    limits="$(cat "$cg/memory.high") $(cat "$cg/memory.max") $(cat "$cg/pids.max") $(cat "$cg/cpu.weight")"
    if [[ "$limits" == "50331648 67108864 32 50" ]]; then pass "$user：上限写进了 cgroup"; else flunk "$user：cgroup 里的上限是 $limits"; fi
    as_fleet sudo -n "$BIN" stop "$id" >/dev/null
    if wait_scope "$id" gone && ! kill -0 "$pid" 2>/dev/null; then pass "$user：stop 之后 scope 和进程都没了"; else flunk "$user：stop 之后还在"; fi
  else
    flunk "$user：scope 没起来"
  fi
  wait 2>/dev/null # 后台那条 sudo 是被 stop 收掉的，shell 会报一句 Terminated，不是错
done

echo "== 2. 会话里的边界"
# 起一个临时的 fleet 命令接口（真的在跑就直接用）
api_temp=0
if [[ -z "$(ss -Hltn "sport = :$AGENT_API_PORT")" ]]; then
  systemd-run --quiet --collect --unit="fleet-e2e-api-$TAG" --uid=fleet --gid=fleet \
    /usr/bin/python3 -m http.server "$AGENT_API_PORT" --bind 127.0.0.1 >/dev/null
  api_temp=1
  for ((i = 0; i < 50; i++)); do
    if [[ -n "$(ss -Hltn "sport = :$AGENT_API_PORT")" ]]; then break; fi
    sleep 0.2
  done
fi
# 调用方故意把 GitHub 凭据塞进环境：会话里一样都不该有
# shellcheck disable=SC2016 # 单引号里的东西要在会话里展开
out=$(as_fleet GH_TOKEN=leak-gh GITHUB_TOKEN=leak-github GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper \
  GIT_CONFIG_VALUE_0=leak FLEET_TOKEN=task-token sudo -n "$BIN" run "$TAG-edge" --user "$U" -- /bin/bash -c '
  if ls /etc/fleet-dao >/dev/null 2>&1 || cat /etc/fleet-dao/temporal.env >/dev/null 2>&1; then echo "secrets=readable"; else echo "secrets=denied"; fi
  if sudo -n true >/dev/null 2>&1; then echo "sudo=ok"; else echo "sudo=denied"; fi
  echo "gh_env=${GH_TOKEN:-}${GITHUB_TOKEN:-}${GIT_CONFIG_COUNT:-}"
  echo "fleet_token=${FLEET_TOKEN:-}"
  if [ -e "$HOME/.config/gh" ] || [ -e "$HOME/.git-credentials" ] || git config --global --get-regexp "^credential" >/dev/null 2>&1; then echo "gh_files=present"; else echo "gh_files=none"; fi
  for p in '"$AGENT_API_PORT"' 7243 5432; do
    if timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$p" 2>/dev/null; then echo "port_$p=open"; else echo "port_$p=closed"; fi
  done' 2>&1)
has() { [[ $'\n'"$out"$'\n' == *$'\n'"$1"$'\n'* ]]; }
if has secrets=denied; then pass "会话读不到 /etc/fleet-dao"; else flunk "会话读得到 /etc/fleet-dao"; fi
if has sudo=denied; then pass "会话里 sudo 失败"; else flunk "会话里 sudo 成功了"; fi
if has gh_env= && has gh_files=none; then
  pass "会话里没有 GitHub 凭据（调用方塞的 GH_TOKEN、GITHUB_TOKEN、GIT_CONFIG_* 都没带进去，家里也没有）"
else
  flunk "会话里有 GitHub 凭据：$(grep '^gh_' <<<"$out" | tr '\n' ' ')"
fi
if has fleet_token=task-token; then pass "FLEET_* 照常带进会话"; else flunk "FLEET_TOKEN 没带进会话"; fi
if has "port_$AGENT_API_PORT=open"; then pass "会话连得上 fleet 命令接口 127.0.0.1:$AGENT_API_PORT"; else flunk "会话连不上 fleet 命令接口（$out）"; fi
if has port_7243=closed && has port_5432=closed; then pass "会话连不上 Temporal（7243）和库（5432）"; else flunk "会话连得上 Temporal 或库：$(grep '^port_' <<<"$out" | tr '\n' ' ')"; fi
if ((api_temp)); then systemctl stop "fleet-e2e-api-$TAG" 2>/dev/null; fi

echo "== 3. 上限生效"
# 只给 --memory-max 时超出的部分被换进 swap、会话照样跑完（这台有 swap）；要真封顶得连 swap 一起封
id=$TAG-swap
as_fleet sudo -n "$BIN" run "$id" --user "$U" --memory-max 64M -- /usr/bin/python3 -c 'b = bytearray(256 * 1024 * 1024)' 2>/dev/null
rc=$?
if ((rc == 0)); then pass "只封 memory.max：256M 的会话换进 swap 跑完了（所以要连 swap 一起封）"; else echo "  · 只封 memory.max 时退出码 $rc（这台可能没开 swap）"; fi
id=$TAG-mem
since=$(date '+%Y-%m-%d %H:%M:%S')
as_fleet sudo -n "$BIN" run "$id" --user "$U" --memory-max 64M --memory-swap-max 0 -- /usr/bin/python3 -c 'b = bytearray(512 * 1024 * 1024)' 2>/dev/null
rc=$?
if ((rc == 137)) && journalctl -k --since "$since" --no-pager 2>/dev/null | grep -q "oom_memcg=/fleet.slice/fleet-agents.slice/fleet-agent-$id.scope"; then
  pass "memory.max 64M + swap 0：要 512M 的会话被 OOM 杀掉（退出码 137），内核记的是它自己的 scope"
else
  flunk "内存上限没生效（退出码 $rc）"
fi
id=$TAG-pids
out=$(as_fleet sudo -n "$BIN" run "$id" --user "$U" --tasks-max 8 -- /usr/bin/python3 -c '
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

# 假引擎：以 fleet 身份跑的临时服务（名字带会话编号，跑完自动回收），经 sudo 起一个会话然后自己挂着
start_fake_engine() { # 会话编号
  systemd-run --quiet --collect --unit="fleet-engine-$1" --uid=fleet --gid=fleet -p WorkingDirectory=/home/fleet \
    /bin/bash -c "sudo -n $BIN run $1 --user $U -- /bin/sleep 600 & sleep 600"
}

echo "== 4. 引擎崩掉（SIGKILL）：会话留在自己的 scope 里，新引擎按名字找回并收掉"
id=$TAG-orphan
start_fake_engine "$id"
if wait_scope "$id" active; then
  pid=$(scope_pids "$id" | head -1)
  systemctl kill --signal=SIGKILL "fleet-engine-$id.service"
  sleep 1
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

echo "== 4b. 引擎正常停（SIGTERM）：sudo 把信号转给会话，会话跟着退，不留孤儿"
id=$TAG-graceful
start_fake_engine "$id"
if wait_scope "$id" active; then
  systemctl stop "fleet-engine-$id.service"
  if wait_scope "$id" gone; then pass "引擎一停，会话收到 SIGTERM 退了，scope 自动回收"; else flunk "引擎停了，会话还挂着"; fi
else
  flunk "假引擎起的会话 scope 没起来"
fi

echo "== 5. 不该放行的"
if as_fleet sudo -n "$BIN" run "$TAG-bad" --user "$U" -- sleep 1 2>/dev/null; then flunk "相对路径的命令被放行了"; else pass "相对路径的命令被拒"; fi
if as_fleet sudo -n "$BIN" run "../x" --user "$U" -- /bin/true 2>/dev/null; then flunk "带 ../ 的编号被放行了"; else pass "带 ../ 的编号被拒"; fi
if as_fleet sudo -n "$BIN" run "$TAG-cwd" --user "$U" --cwd /root -- /bin/true 2>/dev/null; then flunk "会话用户进不去的目录被放行了"; else pass "会话用户进不去的 --cwd /root 被拒"; fi
if as_fleet sudo -n "$BIN" run "$TAG-orca" --user orca -- /bin/true 2>/dev/null; then flunk "--user orca 被放行了"; else pass "--user 只认两个会话用户（orca 被拒）"; fi
if as_fleet sudo -n "$BIN" run "$TAG-nouser" -- /bin/true 2>/dev/null; then flunk "没给 --user 也放行了"; else pass "没给 --user 被拒"; fi
if as_fleet sudo -n /bin/true 2>/dev/null; then flunk "fleet 能 sudo 别的命令"; else pass "fleet 不能 sudo 别的命令"; fi

if ((fail)); then
  echo "不通过"
  exit 1
fi
echo "通过"
