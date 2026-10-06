#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # CACHE、DISPATCH_OFF_STATE、DB_ENV 这些是给 source 进来的 release.sh 里的函数读写的
# deploy/release.sh 的 dispatch_off_on_milestone（#1050）：新的里程碑（v<N> tag）发布成功后，所有项目的「让 AI 接活」回到关；
# 同一个 tag 重跑不再关；小版本（主线上 tag 之后的提交）不碰开关；没关成判红、不记「已关」。
# 判「新里程碑」用的是真 git（临时仓里造 c1 打 v3、c2、c3 打 v4、c4），关的那一步（fleet-api dispatch --all off）换成桩，
# 只记收到的提交号和原因；库、systemd 都不碰。
# 故意造出来的失败：关没成功（桩退出 1）、读不到 tag（取代码的仓不在）、记录文件被改坏（不是数字）、记录文件写不进。
# 用法：bash deploy/test/release-dispatch.test.sh。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e # release.sh 开了 -e；这里自己判每一步
mkdir -p "$RELEASES"

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

# ── 临时仓：c1(v3) ← c2 ← c3(v4) ← c4；c0 在 v3 之前 ──
CACHE=$TMP/cache
git init -q "$CACHE"
g() { git -C "$CACHE" -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }
commit() { g commit -q --allow-empty -m "$1" && g rev-parse HEAD; }
C0=$(commit c0)
C1=$(commit c1)
g tag v3
C2=$(commit c2)
C3=$(commit c3)
g tag v4
C4=$(commit c4)
g tag not-a-version # v<N> 以外的 tag 不算
g tag v4-rc1 "$C4"  # 带后缀的也不算（和自动发布只认纯整数同一个规矩）
g tag v5-rc "$C4"

# 每个提交一份构建完成标记（dispatch_off_on_milestone 读 on_main）
mark() { # 提交号 on_main
  mkdir -p "$RELEASES/$1"
  printf 'commit=%s\non_main=%s\n' "$1" "$2" >"$RELEASES/$1/.fleet-release"
}
for s in "$C0" "$C1" "$C2" "$C3" "$C4"; do mark "$s" 1; done

# 关那一步的桩：记「提交号头 7 位 原因」一行一条进文件（发布脚本在命令替换里调它，变量带不回来）；STUB_RC 非 0 就当没关成
RUNS_FILE=$TMP/runs
STUB_RC=0
dispatch_off_run() {
  printf '%s %s\n' "${1:0:7}" "$2" >>"$RUNS_FILE"
  if ((STUB_RC)); then
    echo "example/canary：没改成：写库时库出错（57014：statement timeout）"
    return 1
  fi
  echo "1 个仓都已关着"
}
reset() {
  REDS=()
  CHANGES=()
  PENDING=()
  : >"$RUNS_FILE"
}
runs() { grep -c . "$RUNS_FILE"; }
run_line() { sed -n "${1:-1}p" "$RUNS_FILE"; }
state() { if [[ -f "$DISPATCH_OFF_STATE" ]]; then cat "$DISPATCH_OFF_STATE"; else echo 无; fi; }

echo "== 头一次发带 v3 的提交：关一次，记下 v3"
reset
dispatch_off_on_milestone "$C1" >/dev/null
check "关了一次" "$(runs)" 1
check "原因写明是发版 v3 和提交" "$(run_line 1)" "${C1:0:7} 发版 v3 自动置关（release.sh ${C1:0:12}）"
check "记下 v3" "$(state)" 3
check "没有红" "${#REDS[@]}" 0
check "改动里有一条" "${#CHANGES[@]}" 1

echo "== 同一个 tag 重跑发布：不再关（开过的不会被再关）"
reset
dispatch_off_on_milestone "$C1" >/dev/null
check "没有关" "$(runs)" 0
check "记录没变" "$(state)" 3
check "改动 0 处" "${#CHANGES[@]}" 0

echo "== 小版本（v3 之后、v4 之前的提交）：不碰开关"
reset
dispatch_off_on_milestone "$C2" >/dev/null
check "没有关" "$(runs)" 0
check "记录没变" "$(state)" 3
check "没有红" "${#REDS[@]}" 0

echo "== 新的 tag v4：关一次，记下 v4"
reset
dispatch_off_on_milestone "$C3" >/dev/null
check "关了一次" "$(runs)" 1
check "原因写明发版 v4" "$(run_line 1)" "${C3:0:7} 发版 v4 自动置关（release.sh ${C3:0:12}）"
check "记下 v4" "$(state)" 4

echo "== v4 之后的提交（还带着 v4-rc1、v5-rc、不是版本的 tag）：都不算新里程碑，不碰开关"
reset
dispatch_off_on_milestone "$C4" >/dev/null
check "没有关" "$(runs)" 0
check "记录还是 4" "$(state)" 4

echo "== 直接发 v4 之后更后面的提交、跳过了 v4 那个提交：照样认出跨过了 v4（头一次时记录是 v3）"
printf '3\n' >"$DISPATCH_OFF_STATE"
reset
dispatch_off_on_milestone "$C4" >/dev/null
check "关了一次" "$(runs)" 1
check "记下 v4" "$(state)" 4

echo "== 发一个比记录更老的版本（回退）：不关"
reset
dispatch_off_on_milestone "$C1" >/dev/null
check "没有关" "$(runs)" 0
check "记录还是 4" "$(state)" 4

echo "== 一个 tag 都不含的提交：不碰开关，也不写记录"
rm -f "$DISPATCH_OFF_STATE"
reset
dispatch_off_on_milestone "$C0" >/dev/null
check "没有关" "$(runs)" 0
check "没写记录" "$(state)" 无
check "没有红" "${#REDS[@]}" 0

echo "== --unmerged 发的（不在主线上）：不碰开关"
mark "$C3" 0
reset
dispatch_off_on_milestone "$C3" >/dev/null
check "没有关" "$(runs)" 0
check "没写记录" "$(state)" 无
mark "$C3" 1

echo "== 【故意造出的失败】关没成功：判红、不记「已关」；下一次发布再试，成功了才记"
reset
STUB_RC=1
dispatch_off_on_milestone "$C3" >/dev/null
check "试了一次" "$(runs)" 1
check "判红" "$((${#REDS[@]} > 0))" 1
check "红里说了没全部关上" "$(printf '%s\n' "${REDS[@]}" | grep -c '没能全部关上')" 1
check "没记已关" "$(state)" 无
reset
STUB_RC=0
dispatch_off_on_milestone "$C3" >/dev/null
check "再发一遍又试、这次关上" "$(runs)" 1
check "没有红" "${#REDS[@]}" 0
check "记下 v4" "$(state)" 4

echo "== 【故意造出的失败】记录文件被改坏（不是数字）：判红、不关，不拿「0」顶"
printf '不是数字\n' >"$DISPATCH_OFF_STATE"
reset
dispatch_off_on_milestone "$C3" >/dev/null
check "没有关" "$(runs)" 0
check "判红" "$((${#REDS[@]} > 0))" 1
rm -f "$DISPATCH_OFF_STATE"

echo "== 【故意造出的失败】记录文件是符号链接：判红、不关"
echo 3 >"$TMP/elsewhere"
ln -s "$TMP/elsewhere" "$DISPATCH_OFF_STATE"
if [[ -L "$DISPATCH_OFF_STATE" ]]; then # Windows 的 Git Bash 里 ln -s 会变成复制，这一段只在真有符号链接的系统上验
  reset
  dispatch_off_on_milestone "$C3" >/dev/null
  check "没有关" "$(runs)" 0
  check "判红" "$((${#REDS[@]} > 0))" 1
else
  echo "  - 这个系统建不了符号链接，这一段不验（CI 的 Linux 上验）"
fi
rm -f "$DISPATCH_OFF_STATE"

echo "== 【故意造出的失败】关上了但记录写不进：判红（下一次发布会再关一遍，关着的不改不记）"
reset
real_state=$DISPATCH_OFF_STATE
DISPATCH_OFF_STATE=$TMP/no-such-dir/state
dispatch_off_on_milestone "$C3" >/dev/null
check "关了一次" "$(runs)" 1
check "判红" "$((${#REDS[@]} > 0))" 1
DISPATCH_OFF_STATE=$real_state

echo "== 【故意造出的失败】读不到 tag（取代码的仓不在）：判红、不关，不当成「没有 tag」"
real_cache=$CACHE
CACHE=$TMP/no-such-repo
reset
dispatch_off_on_milestone "$C3" >/dev/null
check "没有关" "$(runs)" 0
check "判红" "$((${#REDS[@]} > 0))" 1
check "红里说了读不到" "$(printf '%s\n' "${REDS[@]}" | grep -c '读不到')" 1
CACHE=$real_cache

if ((fail)); then
  echo "release-dispatch：不通过"
  exit 1
fi
echo "release-dispatch：通过"
