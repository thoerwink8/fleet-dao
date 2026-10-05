#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # PROFILE、DB_ENV 这些是给 source 进来的 release.sh 里的函数读写的
# deploy/release.sh 的 engine_off_after_release（#1086）：每次往法国发版成功后，引擎总开关回到关；本机档（WSL）的小版本更新不动它；
# --unmerged 发的不碰；没关成判红、不假装关了。
# 关的那一步（fleet-api engine off）换成桩，只记收到的提交号和原因；库、systemd 都不碰。
# 故意造出来的失败：关没成功（桩退出 1）、档位认不出时按法国办（不是悄悄不关）。
# 用法：bash deploy/test/release-engine-off.test.sh。退出码：0 通过，1 不通过。
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

C1=1111111111111111111111111111111111111111
C2=2222222222222222222222222222222222222222
# 每个提交一份构建完成标记（engine_off_after_release 读 on_main）
mark() { # 提交号 on_main
  mkdir -p "$RELEASES/$1"
  printf 'commit=%s\non_main=%s\n' "$1" "$2" >"$RELEASES/$1/.fleet-release"
}
mark "$C1" 1
mark "$C2" 0

# 关那一步的桩：记「提交号头 7 位 原因」一行一条进文件（发布脚本在命令替换里调它，变量带不回来）；STUB_RC 非 0 就当没关成
RUNS_FILE=$TMP/runs
STUB_RC=0
engine_off_run() {
  printf '%s %s\n' "${1:0:7}" "$2" >>"$RUNS_FILE"
  if ((STUB_RC)); then
    echo "没改成（什么都没改）：库出错（57014：statement timeout）"
    return 1
  fi
  echo "已关上：引擎总开关：关着"
}
reset() {
  REDS=()
  CHANGES=()
  PENDING=()
  : >"$RUNS_FILE"
}
runs() { grep -c . "$RUNS_FILE"; }
run_line() { sed -n "${1:-1}p" "$RUNS_FILE"; }

echo "== 法国档发版成功：关一次，原因写明发版和提交"
reset
PROFILE=france
engine_off_after_release "$C1" >/dev/null
check "关了一次" "$(runs)" 1
check "原因写明提交" "$(run_line 1)" "${C1:0:7} 发版 ${C1:0:12} 自动置关总开关（release.sh）"
check "没有红" "${#REDS[@]}" 0
check "改动里有一条" "${#CHANGES[@]}" 1

echo "== 每次发版都关（不像项目开关只在新里程碑才关）：同一个提交再发一次，再关一次"
reset
engine_off_after_release "$C1" >/dev/null
check "又关了一次" "$(runs)" 1

echo "== 本机档（WSL）的小版本更新：不动总开关"
reset
PROFILE=local
engine_off_after_release "$C1" >/dev/null
check "没有关" "$(runs)" 0
check "没有红" "${#REDS[@]}" 0
check "没有改动" "${#CHANGES[@]}" 0

echo "== 档位还没定下来（PROFILE 没设）：按法国办，照样关（不是悄悄不关）"
reset
unset PROFILE
engine_off_after_release "$C1" >/dev/null
check "关了一次" "$(runs)" 1

echo "== 人手动 --unmerged 发的（不在主线上）：不碰"
reset
PROFILE=france
engine_off_after_release "$C2" >/dev/null
check "没有关" "$(runs)" 0
check "没有红" "${#REDS[@]}" 0

echo "== 【故意造出的失败】关没成功（库出错）：发布结论判红，原话打出来，返回 1，不记「已关」"
reset
STUB_RC=1
engine_off_after_release "$C1" >"$TMP/out" 2>&1
rc=$?
STUB_RC=0
check "返回 1" "$rc" 1
check "红了一条" "${#REDS[@]}" 1
check "红里写明总开关没关上" "$([[ "${REDS[0]:-}" == *"引擎总开关没能关上"* ]] && echo 是 || echo 否)" 是
check "原话打出来了" "$(grep -c 'statement timeout' "$TMP/out")" 1
check "没有记「回到关」的改动" "${#CHANGES[@]}" 0

if ((fail)); then
  echo "不通过"
  exit 1
fi
echo "通过"
