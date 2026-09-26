#!/usr/bin/env bash
# fleet-agent-scope 的 adopt 子命令（把工作树交给会话用户：不在就建、在就改属主）和 remove。
# 校验失败路径不需要真的会话用户，靠 AGENT_SCOPE_TEST_WORK_BASE 把工作树的根换成临时目录、
# AGENT_SCOPE_TEST_PROTECTED_HARDLINKS_PATH 把 fs.protected_hardlinks 的读取路径换成临时文件就能测。
# 正常路径（chown、建）要建、删系统账号 fleet-agent-carpool（法国唯一的会话用户），只在明确
# 开了 FLEET_TEST_SYSTEM_USERS=1 时跑（sudo 默认清环境变量，CI 里要 sudo FLEET_TEST_SYSTEM_USERS=1 bash ...）；
# 没开这个开关、或这个用户/组/家目录有任何一个已经在（不是这条测试建的，不碰）、或这台没有 useradd/userdel，
# 都跳过、打「没跑成」。只收拾这条测试自己建出来的东西：建之前先记下要建哪些，退出时只删这些。
# 真机上 adopt 还没有 e2e 覆盖（deploy/test/agent-scope.e2e.sh 只测 run/stop/list 那条通路）。
# 用法：sudo bash deploy/test/agent-scope-adopt.test.sh。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BIN=$HERE/../france/fleet-agent-scope.sh
fail=0
skipped=0

if ((EUID != 0)); then
  echo "没跑成：要 root"
  exit 2
fi

pass() { echo "  ✓ $*"; }
flunk() {
  echo "  ✗ $*"
  fail=1
}

WORK=$(mktemp -d)
OUTSIDE=$(mktemp -d)
HARDLINKS_ON=$(mktemp)
printf '1\n' >"$HARDLINKS_ON"
trap 'rm -rf -- "$WORK" "$OUTSIDE"; rm -f -- "$HARDLINKS_ON"' EXIT
export AGENT_SCOPE_TEST_WORK_BASE=$WORK
# 下面除了专门测「没开」「读不到」的两条，都当 fs.protected_hardlinks 是开着的（1），不看这台真的设成什么
export AGENT_SCOPE_TEST_PROTECTED_HARDLINKS_PATH=$HARDLINKS_ON

echo "== 校验失败路径（不需要真的会话用户）"

out=$(bash "$BIN" adopt "repo1/task1" --user fleet-agent-carpool 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"绝对路径"* ]]; then
  pass "相对路径：退出码 64"
else
  flunk "相对路径应退出码 64 且提到「绝对路径」：退出码 $rc，输出「$out」"
fi

out=$(bash "$BIN" adopt "$OUTSIDE/repo1/task1" --user fleet-agent-carpool 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"之下"* ]]; then
  pass "不在 $WORK 之下：退出码 64"
else
  flunk "落在别处的工作树应退出码 64：退出码 $rc，输出「$out」"
fi

out=$(bash "$BIN" adopt "$WORK/onlyonelevel" --user fleet-agent-carpool 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"两层"* ]]; then
  pass "只有一层：退出码 64"
else
  flunk "只有一层应退出码 64：退出码 $rc，输出「$out」"
fi

mkdir -p "$WORK/symrepo/real"
ln -s real "$WORK/symrepo/linked"
out=$(bash "$BIN" adopt "$WORK/symrepo/linked" --user fleet-agent-carpool 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"符号链接"* ]]; then
  pass "路径上有符号链接：退出码 64"
else
  flunk "带符号链接的路径应退出码 64：退出码 $rc，输出「$out」"
fi

out=$(bash "$BIN" adopt "$WORK/repo1/task-bad-user" --user nobody 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"会话用户"* ]]; then
  pass "--user 不是会话用户：退出码 64"
else
  flunk "--user 不对应退出码 64：退出码 $rc，输出「$out」"
fi

out=$(bash "$BIN" adopt "$WORK/repo1/task-retired" --user fleet-agent-dedicated 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"会话用户"* ]] && [[ ! -e "$WORK/repo1/task-retired" ]]; then
  pass "--user 是已停用的 fleet-agent-dedicated：退出码 64，工作树没建"
else
  flunk "--user fleet-agent-dedicated 应退出码 64 且不建树：退出码 $rc，输出「$out」"
fi

# 只有一个会话用户以后不拷过程记录了：旧调用方还带 --from / --session 要明确拒，不能悄悄当成只改属主
for opt in --from --session; do
  out=$(bash "$BIN" adopt "$WORK/repo1/task-old-args" --user fleet-agent-carpool "$opt" x 2>&1)
  rc=$?
  if ((rc == 64)) && [[ "$out" == *"不认识的参数"* ]]; then
    pass "$opt 已不收：退出码 64"
  else
    flunk "$opt 应报不认识的参数、退出码 64：退出码 $rc，输出「$out」"
  fi
done

# 要值的选项后面什么都不给：以前 shift 2 在只剩这一个参数时会直接把脚本炸出去（set -e 接住 shift 的非零
# 退出码），不会走到 die，得不到用法错误、退出码也不对；现在要先报用法错误、退出码 64。
out=$(bash "$BIN" adopt "$WORK/repo1/task-noval" --user 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"后面要给一个值"* ]]; then
  pass "--user 后面没给值：退出码 64"
else
  flunk "--user 后面没给值应退出码 64 且报用法：退出码 $rc，输出「$out」"
fi

touch "$WORK/afile"
out=$(bash "$BIN" adopt "$WORK/afile/task" --user fleet-agent-carpool 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"不是目录"* ]]; then
  pass "中间一级是文件：退出码 64"
else
  flunk "中间一级是文件应退出码 64：退出码 $rc，输出「$out」"
fi

out=$(bash "$BIN" adopt "$WORK/repo1/a b" --user fleet-agent-carpool 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"只许字母"* ]]; then
  pass "路径里有空格：退出码 64"
else
  flunk "路径里有空格应退出码 64：退出码 $rc，输出「$out」"
fi

echo "== remove（以 root 删，不需要会话用户）"

out=$(bash "$BIN" remove "repo1/task1" 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"绝对路径"* ]]; then pass "remove 相对路径：退出码 64"; else flunk "remove 相对路径应 64：$rc「$out」"; fi

out=$(bash "$BIN" remove "$OUTSIDE/repo1/task1" 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"之下"* ]]; then pass "remove 不在根下：退出码 64"; else flunk "remove 不在根下应 64：$rc「$out」"; fi

out=$(bash "$BIN" remove "$WORK/onlyonelevel" 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"两层"* ]]; then pass "remove 只有一层：退出码 64"; else flunk "remove 只有一层应 64：$rc「$out」"; fi

out=$(bash "$BIN" remove "$WORK/repo1/../repo2" 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *".."* ]]; then pass "remove 带 ..：退出码 64"; else flunk "remove 带 .. 应 64：$rc「$out」"; fi

out=$(bash "$BIN" remove "$WORK/symrepo/linked" 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"符号链接"* ]] && [[ -d "$WORK/symrepo/real" ]]; then
  pass "remove 符号链接：退出码 64，链接指向的目录还在"
else
  flunk "remove 符号链接应 64 且不碰目标：$rc「$out」"
fi

out=$(bash "$BIN" remove "$WORK/repo9/never-was" 2>/dev/null)
rc=$?
if ((rc == 0)) && [[ "$(tail -n 1 <<<"$out")" == "gone $WORK/repo9/never-was" ]]; then
  pass "remove 本来就不在：退出码 0，报 gone"
else
  flunk "remove 本来就不在应 0 + gone：$rc「$out」"
fi

mkdir -p "$WORK/repo8/done-task/sub"
echo x >"$WORK/repo8/done-task/sub/file"
out=$(bash "$BIN" remove "$WORK/repo8/done-task" 2>/dev/null)
rc=$?
if ((rc == 0)) && [[ "$(tail -n 1 <<<"$out")" == "removed $WORK/repo8/done-task" ]] && [[ ! -e "$WORK/repo8/done-task" ]] &&
  [[ -d "$WORK/repo8" ]]; then
  pass "remove 在的：退出码 0，报 removed，整棵删了、上一级还在"
else
  flunk "remove 在的应 0 + removed 且删干净：$rc「$out」"
fi

echo "== fs.protected_hardlinks（chown -R 前的内核前提，不需要真的会话用户——校验在 chown 之前就拦下）"

mkdir -p "$WORK/repo1/task-hardlinks"
HARDLINKS_OFF=$(mktemp)
printf '0\n' >"$HARDLINKS_OFF"
out=$(AGENT_SCOPE_TEST_PROTECTED_HARDLINKS_PATH=$HARDLINKS_OFF bash "$BIN" adopt "$WORK/repo1/task-hardlinks" \
  --user fleet-agent-carpool 2>&1)
rc=$?
if ((rc == 1)) && [[ "$out" == *protected_hardlinks* ]]; then
  pass "fs.protected_hardlinks=0：拒绝 chown -R，退出码 1"
else
  flunk "fs.protected_hardlinks=0 应拒绝：退出码 $rc，输出「$out」"
fi
rm -f -- "$HARDLINKS_OFF"

out=$(AGENT_SCOPE_TEST_PROTECTED_HARDLINKS_PATH="$WORK/no-such-hardlinks-file" bash "$BIN" adopt \
  "$WORK/repo1/task-hardlinks" --user fleet-agent-carpool 2>&1)
rc=$?
if ((rc == 1)) && [[ "$out" == *protected_hardlinks* ]]; then
  pass "fs.protected_hardlinks 读不到：当没开处理，拒绝，退出码 1（不许当成「开着」）"
else
  flunk "fs.protected_hardlinks 读不到应拒绝：退出码 $rc，输出「$out」"
fi

echo "== 正常路径（chown、建）"

U=fleet-agent-carpool
sysusers_reason=""
if [[ "${FLEET_TEST_SYSTEM_USERS:-}" != 1 ]]; then
  sysusers_reason="没给 FLEET_TEST_SYSTEM_USERS=1（这段要建、删系统账号，只在明确开了这个开关时跑——CI 里
      sudo FLEET_TEST_SYSTEM_USERS=1 bash deploy/test/run.sh；sudo 默认清环境变量，得显式带过去）"
elif id "$U" >/dev/null 2>&1; then
  sysusers_reason="$U 已经存在——这条测试只在它不存在的机器（CI 的一次性容器）上临时建，不碰已经存在的真账号；
      真机上 adopt 还没有 e2e 覆盖"
elif getent group "$U" >/dev/null 2>&1; then
  sysusers_reason="$U 的组已经在（用户不在但组在，状态不对）——不碰"
elif [[ -e /home/$U ]]; then
  sysusers_reason="/home/$U 已经在（用户不在但家目录在，状态不对）——不碰"
elif ! command -v useradd >/dev/null || ! command -v userdel >/dev/null; then
  sysusers_reason="这台没有 useradd/userdel，建不了临时会话用户"
fi

if [[ -n "$sysusers_reason" ]]; then
  echo "  没跑成：$sysusers_reason"
  skipped=1
else
  # 只收拾这条测试自己建出来的东西：上面已经确认用户、组、家目录原本都不在
  cleanup_sysusers() {
    userdel -r "$U" 2>/dev/null
    groupdel "$U" 2>/dev/null
    rm -rf -- "$WORK" "$OUTSIDE"
    rm -f -- "$HARDLINKS_ON"
  }
  trap cleanup_sysusers EXIT

  groupadd --system "$U"
  useradd --system --gid "$U" --home-dir "/home/$U" --create-home --shell /bin/bash "$U"

  WT1=$WORK/repo1/task1
  mkdir -p "$WT1/sub"
  touch "$WT1/sub/file"
  out=$(bash "$BIN" adopt "$WT1" --user "$U" 2>&1)
  rc=$?
  owner=$(stat -c '%U:%G' "$WT1" 2>/dev/null)
  inner=$(stat -c '%U:%G' "$WT1/sub/file" 2>/dev/null)
  if ((rc == 0)) && [[ "$owner" == "$U:$U" && "$inner" == "$U:$U" ]]; then
    pass "改属主：退出码 0，$WT1 连里面的文件都归 $U 了"
  else
    flunk "改属主没成功（退出码 $rc，属主「$owner」，里面的文件「$inner」）：$out"
  fi

  WT0=$WORK/newrepo/newtask
  out=$(bash "$BIN" adopt "$WT0" --user "$U" 2>&1)
  rc=$?
  parent=$(stat -c '%U:%G %a' "$WORK/newrepo" 2>/dev/null)
  leaf=$(stat -c '%U:%G %a' "$WT0" 2>/dev/null)
  if ((rc == 0)) && [[ "$parent" == "root:root 755" && "$leaf" == "$U:$U 700" ]]; then
    pass "不在就建：中间一级 root 755，工作树归会话用户 700"
  else
    flunk "不在就建没对（退出码 $rc，上一级「$parent」，工作树「$leaf」）：$out"
  fi
fi

if ((fail)); then
  echo "不通过"
  exit 1
fi
if ((skipped)); then
  echo "有没跑成的"
  exit 2
fi
echo "通过"
