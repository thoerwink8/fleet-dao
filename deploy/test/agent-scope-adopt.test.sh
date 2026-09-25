#!/usr/bin/env bash
# fleet-agent-scope 的 adopt 子命令（换会话用户接着干：改工作树属主，顺带拷过程记录）。
# 校验失败路径不需要真的会话用户，靠 AGENT_SCOPE_TEST_WORK_BASE 把工作树的根换成临时目录就能测。
# 正常路径（chown、拷会话记录）要两个真的会话用户：只在 fleet-agent-dedicated / fleet-agent-carpool 都还不存在的
# 机器上（CI 的一次性容器）临时建、跑完删掉；这两个用户已经存在（真机）就跳过，不碰真账号——
# 真机上的正常路径见 deploy/france/agent-scope.e2e.sh。
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
trap 'rm -rf -- "$WORK" "$OUTSIDE"' EXIT
export AGENT_SCOPE_TEST_WORK_BASE=$WORK

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

echo "== 正常路径（chown、拷会话记录）"

if id fleet-agent-dedicated >/dev/null 2>&1 || id fleet-agent-carpool >/dev/null 2>&1; then
  echo "  没跑成：fleet-agent-dedicated / fleet-agent-carpool 已经存在——这条测试只在都不存在的机器（CI 的一次性容器）上
      临时建，不碰已经存在的真账号；真机验收见 deploy/france/agent-scope.e2e.sh"
  skipped=1
elif ! command -v useradd >/dev/null || ! command -v userdel >/dev/null; then
  echo "  没跑成：这台没有 useradd/userdel，建不了临时会话用户"
  skipped=1
else
  groupadd --system fleet-agent-dedicated
  useradd --system --gid fleet-agent-dedicated --home-dir /home/fleet-agent-dedicated --create-home \
    --shell /bin/bash fleet-agent-dedicated
  groupadd --system fleet-agent-carpool
  useradd --system --gid fleet-agent-carpool --home-dir /home/fleet-agent-carpool --create-home \
    --shell /bin/bash fleet-agent-carpool
  trap 'userdel -r fleet-agent-dedicated 2>/dev/null; userdel -r fleet-agent-carpool 2>/dev/null;
    groupdel fleet-agent-dedicated 2>/dev/null; groupdel fleet-agent-carpool 2>/dev/null;
    rm -rf -- "$WORK" "$OUTSIDE"' EXIT

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
