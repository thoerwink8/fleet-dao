#!/usr/bin/env bash
# fleet-agent-scope 的 adopt 子命令（换会话用户接着干：改工作树属主，顺带拷过程记录）。
# 校验失败路径不需要真的会话用户，靠 AGENT_SCOPE_TEST_WORK_BASE 把工作树的根换成临时目录、
# AGENT_SCOPE_TEST_PROTECTED_HARDLINKS_PATH 把 fs.protected_hardlinks 的读取路径换成临时文件就能测。
# 正常路径（chown、拷会话记录）要建、删系统账号（fleet-agent-dedicated / fleet-agent-carpool），只在明确
# 开了 FLEET_TEST_SYSTEM_USERS=1 时跑（sudo 默认清环境变量，CI 里要 sudo FLEET_TEST_SYSTEM_USERS=1 bash ...）；
# 没开这个开关、或这两个用户/组/家目录有任何一个已经在（不是这条测试建的，不碰）、或这台没有 useradd/userdel，
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

out=$(bash "$BIN" adopt "repo1/task1" --user fleet-agent-dedicated 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"绝对路径"* ]]; then
  pass "相对路径：退出码 64"
else
  flunk "相对路径应退出码 64 且提到「绝对路径」：退出码 $rc，输出「$out」"
fi

out=$(bash "$BIN" adopt "$OUTSIDE/repo1/task1" --user fleet-agent-dedicated 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"之下"* ]]; then
  pass "不在 $WORK 之下：退出码 64"
else
  flunk "落在别处的工作树应退出码 64：退出码 $rc，输出「$out」"
fi

out=$(bash "$BIN" adopt "$WORK/onlyonelevel" --user fleet-agent-dedicated 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"两层"* ]]; then
  pass "只有一层：退出码 64"
else
  flunk "只有一层应退出码 64：退出码 $rc，输出「$out」"
fi

mkdir -p "$WORK/symrepo/real"
ln -s real "$WORK/symrepo/linked"
out=$(bash "$BIN" adopt "$WORK/symrepo/linked" --user fleet-agent-dedicated 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"符号链接"* ]]; then
  pass "路径上有符号链接：退出码 64"
else
  flunk "带符号链接的路径应退出码 64：退出码 $rc，输出「$out」"
fi

out=$(bash "$BIN" adopt "$WORK/repo1/task-bad-user" --user nobody 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"会话用户"* ]]; then
  pass "--user 不是两个会话用户之一：退出码 64"
else
  flunk "--user 不对应退出码 64：退出码 $rc，输出「$out」"
fi

out=$(bash "$BIN" adopt "$WORK/repo1/task-same" --user fleet-agent-dedicated --from fleet-agent-dedicated \
  --session 12345678-1234-4234-8234-123456789012 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"不能一样"* ]]; then
  pass "--from 和 --user 一样：退出码 64"
else
  flunk "--from 和 --user 一样应退出码 64：退出码 $rc，输出「$out」"
fi

out=$(bash "$BIN" adopt "$WORK/repo1/task-baduuid" --user fleet-agent-dedicated --from fleet-agent-carpool \
  --session not-a-uuid 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *UUID* ]]; then
  pass "--session 不是 UUID：退出码 64"
else
  flunk "--session 不是 UUID 应退出码 64：退出码 $rc，输出「$out」"
fi

# 要值的选项后面什么都不给：以前 shift 2 在只剩这一个参数时会直接把脚本炸出去（set -e 接住 shift 的非零
# 退出码），不会走到 die，得不到用法错误、退出码也不对；现在这三个都要先报用法错误、退出码 64。
for opt in --user --from --session; do
  out=$(bash "$BIN" adopt "$WORK/repo1/task-noval" "$opt" 2>&1)
  rc=$?
  if ((rc == 64)) && [[ "$out" == *"后面要给一个值"* ]]; then
    pass "$opt 后面没给值：退出码 64"
  else
    flunk "$opt 后面没给值应退出码 64 且报用法：退出码 $rc，输出「$out」"
  fi
done

touch "$WORK/afile"
out=$(bash "$BIN" adopt "$WORK/afile/task" --user fleet-agent-dedicated 2>&1)
rc=$?
if ((rc == 64)) && [[ "$out" == *"不是目录"* ]]; then
  pass "中间一级是文件：退出码 64"
else
  flunk "中间一级是文件应退出码 64：退出码 $rc，输出「$out」"
fi

out=$(bash "$BIN" adopt "$WORK/repo1/a b" --user fleet-agent-dedicated 2>&1)
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
  --user fleet-agent-dedicated 2>&1)
rc=$?
if ((rc == 1)) && [[ "$out" == *protected_hardlinks* ]]; then
  pass "fs.protected_hardlinks=0：拒绝 chown -R，退出码 1"
else
  flunk "fs.protected_hardlinks=0 应拒绝：退出码 $rc，输出「$out」"
fi
rm -f -- "$HARDLINKS_OFF"

out=$(AGENT_SCOPE_TEST_PROTECTED_HARDLINKS_PATH="$WORK/no-such-hardlinks-file" bash "$BIN" adopt \
  "$WORK/repo1/task-hardlinks" --user fleet-agent-dedicated 2>&1)
rc=$?
if ((rc == 1)) && [[ "$out" == *protected_hardlinks* ]]; then
  pass "fs.protected_hardlinks 读不到：当没开处理，拒绝，退出码 1（不许当成「开着」）"
else
  flunk "fs.protected_hardlinks 读不到应拒绝：退出码 $rc，输出「$out」"
fi

echo "== 正常路径（chown、拷会话记录）"

sysusers_reason=""
if [[ "${FLEET_TEST_SYSTEM_USERS:-}" != 1 ]]; then
  sysusers_reason="没给 FLEET_TEST_SYSTEM_USERS=1（这段要建、删系统账号，只在明确开了这个开关时跑——CI 里
      sudo FLEET_TEST_SYSTEM_USERS=1 bash deploy/test/run.sh；sudo 默认清环境变量，得显式带过去）"
elif id fleet-agent-dedicated >/dev/null 2>&1 || id fleet-agent-carpool >/dev/null 2>&1; then
  sysusers_reason="fleet-agent-dedicated / fleet-agent-carpool 已经存在——这条测试只在都不存在的机器（CI 的
      一次性容器）上临时建，不碰已经存在的真账号；真机上 adopt 还没有 e2e 覆盖"
elif getent group fleet-agent-dedicated >/dev/null 2>&1 || getent group fleet-agent-carpool >/dev/null 2>&1; then
  sysusers_reason="fleet-agent-dedicated / fleet-agent-carpool 的组有一个已经在（用户不在但组在，状态不对）——不碰"
elif [[ -e /home/fleet-agent-dedicated || -e /home/fleet-agent-carpool ]]; then
  sysusers_reason="/home/fleet-agent-dedicated 或 /home/fleet-agent-carpool 已经在（用户不在但家目录在，状态不对）——不碰"
elif ! command -v useradd >/dev/null || ! command -v userdel >/dev/null; then
  sysusers_reason="这台没有 useradd/userdel，建不了临时会话用户"
fi

if [[ -n "$sysusers_reason" ]]; then
  echo "  没跑成：$sysusers_reason"
  skipped=1
else
  # 只收拾这条测试自己建出来的东西：上面已经确认这四样原本都不在，建之前先记下都要建哪些
  built_groups=(fleet-agent-dedicated fleet-agent-carpool)
  built_users=(fleet-agent-dedicated fleet-agent-carpool)
  cleanup_sysusers() {
    local u
    for u in "${built_users[@]}"; do userdel -r "$u" 2>/dev/null; done
    for u in "${built_groups[@]}"; do groupdel "$u" 2>/dev/null; done
    rm -rf -- "$WORK" "$OUTSIDE"
    rm -f -- "$HARDLINKS_ON"
  }
  trap cleanup_sysusers EXIT

  groupadd --system fleet-agent-dedicated
  useradd --system --gid fleet-agent-dedicated --home-dir /home/fleet-agent-dedicated --create-home \
    --shell /bin/bash fleet-agent-dedicated
  groupadd --system fleet-agent-carpool
  useradd --system --gid fleet-agent-carpool --home-dir /home/fleet-agent-carpool --create-home \
    --shell /bin/bash fleet-agent-carpool

  WT1=$WORK/repo1/task1
  mkdir -p "$WT1"
  out=$(bash "$BIN" adopt "$WT1" --user fleet-agent-dedicated 2>&1)
  rc=$?
  owner=$(stat -c '%U:%G' "$WT1" 2>/dev/null)
  if ((rc == 0)) && [[ "$owner" == "fleet-agent-dedicated:fleet-agent-dedicated" ]]; then
    pass "只改属主：退出码 0，$WT1 归 fleet-agent-dedicated 了"
  else
    flunk "只改属主没成功（退出码 $rc，属主「$owner」）：$out"
  fi

  WT0=$WORK/newrepo/newtask
  out=$(bash "$BIN" adopt "$WT0" --user fleet-agent-dedicated 2>&1)
  rc=$?
  parent=$(stat -c '%U:%G %a' "$WORK/newrepo" 2>/dev/null)
  leaf=$(stat -c '%U:%G %a' "$WT0" 2>/dev/null)
  if ((rc == 0)) && [[ "$parent" == "root:root 755" && "$leaf" == "fleet-agent-dedicated:fleet-agent-dedicated 700" ]]; then
    pass "不在就建：中间一级 root 755，工作树归会话用户 700"
  else
    flunk "不在就建没对（退出码 $rc，上一级「$parent」，工作树「$leaf」）：$out"
  fi

  from_home=$(getent passwd fleet-agent-carpool | cut -d: -f6)
  to_home=$(getent passwd fleet-agent-dedicated | cut -d: -f6)
  SESSION=$(cat /proc/sys/kernel/random/uuid)
  PROJECT_DIR=myproject
  mkdir -p "$from_home/.claude/projects/$PROJECT_DIR"
  echo '{"type":"summary"}' >"$from_home/.claude/projects/$PROJECT_DIR/$SESSION.jsonl"
  chown -R fleet-agent-carpool:fleet-agent-carpool "$from_home/.claude"

  WT2=$WORK/repo1/task2
  mkdir -p "$WT2"
  out=$(bash "$BIN" adopt "$WT2" --user fleet-agent-dedicated --from fleet-agent-carpool --session "$SESSION" 2>&1)
  rc=$?
  dest="$to_home/.claude/projects/$PROJECT_DIR/$SESSION.jsonl"
  origin="$from_home/.claude/projects/$PROJECT_DIR/$SESSION.jsonl"
  if ((rc == 0)) && [[ -f "$dest" ]] && diff -q "$dest" "$origin" >/dev/null 2>&1; then
    pass "会话记录拷过去了，内容一致，项目目录名（$PROJECT_DIR）照旧"
  else
    flunk "会话记录没拷对（退出码 $rc）：$out"
  fi
  if [[ -f "$origin" ]]; then
    pass "旧用户名下的原始记录还在（拷贝，不是搬移）"
  else
    flunk "旧用户名下的原始记录被删了"
  fi
  fmode=$(stat -c '%a' "$dest" 2>/dev/null)
  dmode=$(stat -c '%a' "$(dirname -- "$dest")" 2>/dev/null)
  if [[ "$fmode" == 600 && "$dmode" == 700 ]]; then
    pass "新文件 600、新目录 700（umask 077）"
  else
    flunk "权限不对：文件 $fmode，目录 $dmode"
  fi

  WT3=$WORK/repo1/task3
  mkdir -p "$WT3"
  out=$(bash "$BIN" adopt "$WT3" --user fleet-agent-dedicated --from fleet-agent-carpool \
    --session "$(cat /proc/sys/kernel/random/uuid)" 2>&1)
  rc=$?
  if ((rc == 65)); then
    pass "会话记录没找到（编造的会话编号）：退出码 65"
  else
    flunk "会话记录没找到应退出码 65：退出码 $rc，输出「$out」"
  fi

  # 旧用户那边读失败（chmod 000）：以前右边照样能拿空输入把 mkdir+cat+chmod 走成功，退出码虽然对（pipefail
  # 接住了左边的失败），却会在目标位置留一个空的 <会话>.jsonl；现在写的是临时文件，读失败要连临时文件一起删。
  WT4=$WORK/repo1/task4
  mkdir -p "$WT4"
  SESSION4=$(cat /proc/sys/kernel/random/uuid)
  PROJECT_DIR4=blockedproject
  mkdir -p "$from_home/.claude/projects/$PROJECT_DIR4"
  echo '{"type":"summary"}' >"$from_home/.claude/projects/$PROJECT_DIR4/$SESSION4.jsonl"
  chown -R fleet-agent-carpool:fleet-agent-carpool "$from_home/.claude/projects/$PROJECT_DIR4"
  chmod 000 "$from_home/.claude/projects/$PROJECT_DIR4/$SESSION4.jsonl"
  out=$(bash "$BIN" adopt "$WT4" --user fleet-agent-dedicated --from fleet-agent-carpool --session "$SESSION4" 2>&1)
  rc=$?
  dest4="$to_home/.claude/projects/$PROJECT_DIR4/$SESSION4.jsonl"
  tmp4="$to_home/.claude/projects/$PROJECT_DIR4/.$SESSION4.jsonl.tmp"
  if ((rc == 1)) && [[ ! -e "$dest4" ]] && [[ ! -e "$tmp4" ]]; then
    pass "旧用户读不了会话记录（chmod 000）：退出码 1，没留空的 .jsonl，没留临时文件"
  else
    flunk "旧用户读不了应退出码 1 且不留文件（退出码 $rc，dest 在$([[ -e "$dest4" ]] && echo 是 || echo 否)，tmp 在$([[ -e "$tmp4" ]] && echo 是 || echo 否)）：$out"
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
