#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# FLEET_WORK_DIR/_tmp 要归跑 fleet-engine 的用户：冷验收在下面 mkdir verify-*。
# 旧机器上这一层是 root:root 755，引擎用户建不了目录。
#   1. 还没有：建出来，根仍是 root:root 755，_tmp 归引擎用户；以这个非 root 用户 mkdir 再 rmdir
#   2. 已是 root:root 755：只改这一层；改之前 mkdir 失败且报错里有目录路径；读回只报、不改权限；
#      里面已有的会话目录属主不动；改完引擎用户 mkdir 再 rmdir 成功
#   3. 已经归引擎用户：再跑不改权限、不报红；读回不误报
# 不碰真的 /var/lib/fleet-work。要 root（建临时用户、改属主）。
# 用法：sudo bash deploy/test/work-tmp.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/human-tier.sh
source "$HERE/../lib/human-tier.sh"

if ((EUID != 0)); then
  echo "work-tmp：没跑成：要 root（得建临时用户、改属主、以引擎用户 mkdir）"
  exit 2
fi
for c in useradd userdel runuser; do
  if ! command -v "$c" >/dev/null; then
    echo "work-tmp：没跑成：没有 $c"
    exit 2
  fi
done

U=fleet-wt-$$
T=$(mktemp -d /var/tmp/fleet-work-tmp.XXXXXX)
cleanup() {
  pkill -KILL -u "$U" >/dev/null 2>&1 || true
  userdel "$U" >/dev/null 2>&1 || true
  rm -rf -- "$T"
}
trap cleanup EXIT
chmod 755 "$T"
umask 022
if ! useradd --system --user-group --home-dir "$T/home" --create-home --shell /bin/bash "$U" >/dev/null 2>&1; then
  echo "work-tmp：没跑成：建不了临时用户 $U"
  exit 2
fi
# human-tier.sh 被 source 时把 ENGINE_USER 设成 fleet；这里换成临时用户，不碰真的 fleet
ENGINE_USER=$U

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」（目录 %s）\n' "$1" "$2" "$3" "${WORK_DIR:-}/_tmp"
    fail=1
  fi
}
meta() { stat -c '%U:%G %a' -- "$1" 2>/dev/null || printf '不存在'; }

# 以引擎用户在 parent 下 mkdir 再 rmdir。失败时打印的句子里有目录路径。
roundtrip() {
  local parent=$1 name rc=0 err
  name=$parent/verify-assert-$$
  err=$(runuser -u "$U" -- mkdir -- "$name" 2>&1) || rc=$?
  if ((rc != 0)); then
    printf '  ✗ 引擎用户 %s 在 %s 下 mkdir 失败（%s）：%s\n' "$U" "$parent" "$name" "$err"
    fail=1
    return 1
  fi
  rc=0
  err=$(runuser -u "$U" -- rmdir -- "$name" 2>&1) || rc=$?
  if ((rc != 0)); then
    printf '  ✗ 引擎用户 %s 在 %s 下 rmdir 失败（%s）：%s\n' "$U" "$parent" "$name" "$err"
    rm -rf -- "$name"
    fail=1
    return 1
  fi
  printf '  ✓ 引擎用户在 %s 下 mkdir 再 rmdir\n' "$parent"
}

echo "== 1. 还没有 _tmp：建出来，引擎用户能 mkdir 再 rmdir，根仍归 root"
WORK_DIR=$T/fresh
CHANGES=() REDS=()
rc=0
ensure_work_tmp >"$T/out" || rc=$?
check "返回 0" "$rc" 0
check "没有红" "${#REDS[@]}" 0
check "工作树根 root:root 755" "$(meta "$WORK_DIR")" "root:root 755"
check "_tmp 归引擎用户 755" "$(meta "$WORK_DIR/_tmp")" "$U:$U 755"
check "探针目录不留" "$(find "$WORK_DIR/_tmp" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" 0
roundtrip "$WORK_DIR/_tmp"
rc=0
runuser -u "$U" -- mkdir -- "$WORK_DIR/not-here" 2>"$T/err" || rc=$?
check "引擎用户仍不能在工作树根下建目录" "$rc" 1

echo "== 2. 已是 root:root 755：改之前 mkdir 失败且报错带路径；读回只报不改；改完能写，会话目录不动"
WORK_DIR=$T/repair
mkdir -m 755 "$WORK_DIR" "$WORK_DIR/_tmp"
sess=$WORK_DIR/_tmp/sess-keep
mkdir -m 700 "$sess"
echo keep >"$sess/note"
chown 61234:61235 "$sess" "$sess/note"
before=$(meta "$WORK_DIR/_tmp")
check "夹具是 root:root 755" "$before" "root:root 755"
rc=0
err=$(runuser -u "$U" -- mkdir -- "$WORK_DIR/_tmp/verify-before" 2>&1) || rc=$?
if ((rc == 0)); then
  rm -rf -- "$WORK_DIR/_tmp/verify-before"
  printf '  ✗ 修之前不该建得成：%s/_tmp\n' "$WORK_DIR"
  fail=1
elif [[ "$err" != *"$WORK_DIR/_tmp"* ]]; then
  printf '  ✗ 失败信息没有目录路径 %s/_tmp：「%s」\n' "$WORK_DIR" "$err"
  fail=1
else
  printf '  ✓ 修之前 mkdir 失败，信息里有 %s/_tmp\n' "$WORK_DIR"
fi
REDS=()
rc=0
readback_work_tmp >"$T/out" || rc=$?
check "读回判红" "$rc" 1
check "读回不改权限" "$(meta "$WORK_DIR/_tmp")" "$before"
if [[ ${REDS[*]-} == *"$WORK_DIR/_tmp"* ]]; then
  printf '  ✓ 读回的红里有目录路径\n'
else
  printf '  ✗ 读回的红里没有目录路径 %s/_tmp：「%s」\n' "$WORK_DIR" "${REDS[*]-}"
  fail=1
fi
CHANGES=() REDS=()
rc=0
ensure_work_tmp >"$T/out" || rc=$?
check "修复返回 0" "$rc" 0
check "修复没有红" "${#REDS[@]}" 0
check "修复后 _tmp 归引擎用户" "$(meta "$WORK_DIR/_tmp")" "$U:$U 755"
check "工作树根没被改成引擎用户" "$(meta "$WORK_DIR")" "root:root 755"
check "会话目录属主不动" "$(stat -c '%u:%g %a' -- "$sess")" "61234:61235 700"
check "会话目录里的文件不动" "$(stat -c '%u:%g' -- "$sess/note")" "61234:61235"
check "会话目录里的内容还在" "$(cat -- "$sess/note")" "keep"
roundtrip "$WORK_DIR/_tmp"
check "探针没把会话目录删掉" "$(stat -c '%u:%g %a' -- "$sess")" "61234:61235 700"

echo "== 3. 已经归引擎用户：再跑不改权限、不报红，读回不误报"
snap_tmp=$(meta "$WORK_DIR/_tmp")
snap_root=$(meta "$WORK_DIR")
snap_sess=$(stat -c '%u:%g %a' -- "$sess")
CHANGES=() REDS=()
rc=0
ensure_work_tmp >"$T/out" || rc=$?
check "第二遍返回 0" "$rc" 0
check "第二遍零改动" "${#CHANGES[@]}" 0
check "第二遍不报红" "${#REDS[@]}" 0
check "_tmp 权限没变" "$(meta "$WORK_DIR/_tmp")" "$snap_tmp"
check "根权限没变" "$(meta "$WORK_DIR")" "$snap_root"
check "会话目录没变" "$(stat -c '%u:%g %a' -- "$sess")" "$snap_sess"
REDS=()
rc=0
readback_work_tmp >"$T/out" || rc=$?
check "读回不误报" "$rc" 0
check "读回没有红" "${#REDS[@]}" 0
roundtrip "$WORK_DIR/_tmp"

if ((fail)); then
  echo "work-tmp：不通过"
  exit 1
fi
echo "work-tmp：通过"
