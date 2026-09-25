#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy/lib/agents-sync.sh（装机脚本把同步脚本的逐行结论记进账）的判据：--check 的 ✗ 记红、… 记没查成；
# --apply 的 ✗、… 只打不记（读回的 --check 会再判一次）；↻ 两边都记改动；· 只在 --check 里打；
# 同步脚本崩了（退出码不是 0、一行 ✗、… 都没给）判红；退出 0 却一行逐项结论都没有，也判红。
# 同步脚本换成假的：记下参数，照 $T/out、$T/err 打，照 $T/rc 退出。不用 root、不出网。
# 用法：bash deploy/test/agents-sync-account.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/agents-sync.sh
source "$HERE/../lib/agents-sync.sh"

if ! T=$(mktemp -d); then
  echo "agents-sync-account：没跑成：建不了临时目录"
  exit 2
fi
trap 'rm -rf -- "$T"' EXIT
# shellcheck disable=SC2016 # 单引号里是假同步脚本的正文，$* 要留给它自己
printf '#!/bin/sh\necho "$*" >"%s/args"\ncat "%s/out"\ncat "%s/err" >&2\nexit "$(cat "%s/rc")"\n' "$T" "$T" "$T" "$T" >"$T/fake"
chmod 755 "$T/fake"
AGENTS_SYNC_CMD=("$T/fake")

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
# 让假同步脚本打这些、退出这个码，以 alice 跑一遍；账记在 CHANGES、REDS、PENDING，打出来的进 $T/printed
run() { # 模式 退出码 标准输出 [标准错误]
  printf '%s' "$3" >"$T/out"
  printf '%s' "${4:-}" >"$T/err"
  echo "$2" >"$T/rc"
  CHANGES=() REDS=() PENDING=()
  agents_sync "$1" alice >"$T/printed"
}
printed_has() { grep -cF -- "$1" "$T/printed"; }
last_red() { if ((${#REDS[@]})); then printf '%s' "${REDS[-1]}"; fi; }

HEAD=$'agents-sync --check（查；alice 的家目录 /home/alice；Linux）\n通用段（AGENTS.md 上半段）\n'
DRIFT=$'  ✗ ~/.claude/CLAUDE.md：漂移（第 3 行起和仓里不一样）\n'
TRACE=$'node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\nError: Cannot find module \'/srv/x/main.ts\'\n'

echo "== 同步脚本崩了（只打堆栈、退出 1）：判红，写和查都一样"
for mode in --apply --check; do
  run "$mode" 1 "" "$TRACE"
  check "$mode：记一笔红" "${#REDS[@]}" 1
  check "$mode：红里说出退出码、没给逐项结论，带着报错" \
    "$(grep -c '同步脚本 '"$mode"' 退出 1，没给出逐项结论：.*Cannot find module' <<<"$(last_red)")" 1
  check "$mode：没记改动、没记没查成" "${#CHANGES[@]}:${#PENDING[@]}" 0:0
done
check "参数照传：模式、--user、用户" "$(cat "$T/args")" "--check --user alice"

echo "== --check 的 ✗ 记红（有逐项结论就不再为退出码另记一笔）"
run --check 1 "$HEAD  ✓ ~/.codex/AGENTS.md：一致（给 Codex）
$DRIFT结论：改动 0，一致 1，漂移 1；退出码 1
"
check "记一笔红" "${#REDS[@]}" 1
check "红里带着用户和那一项" "$(last_red)" "alice ~/.claude/CLAUDE.md：漂移（第 3 行起和仓里不一样）"
check "✓ 那一项照打" "$(printed_has '  ✓ alice ~/.codex/AGENTS.md：一致（给 Codex）')" 1

echo "== --apply 的 ✗、… 只打不记，↻ 记改动"
run --apply 1 "  ↻ ~/.codex/AGENTS.md：写上了
  ✗ ~/.claude/CLAUDE.md：没做成——EACCES
  … ~/.pi/agent/AGENTS.md：没查成——EIO
"
check "没记红、没记没查成" "${#REDS[@]}:${#PENDING[@]}" 0:0
check "记一笔改动" "${CHANGES[*]}" "alice ~/.codex/AGENTS.md：写上了"
check "✗ 照打，带着用户" "$(printed_has '  ✗ alice ~/.claude/CLAUDE.md：没做成——EACCES')" 1
check "… 照打，带着用户" "$(printed_has '  … alice ~/.pi/agent/AGENTS.md：没查成——EIO')" 1

echo "== --check 的 … 记没查成；· 只在 --check 里打"
run --check 2 "  … ~/.pi/agent/AGENTS.md：没查成——EIO
  · ~/.dsh/AGENTS.md：没装，跳过
"
check "记一笔没查成、没有红" "${#PENDING[@]}:${#REDS[@]}" 1:0
check "--check 打出没装的那项" "$(printed_has '  · alice ~/.dsh/AGENTS.md：没装，跳过')" 1
run --apply 0 "  · ~/.dsh/AGENTS.md：没装，跳过
"
check "--apply 不打没装的那项、也不判红" "$(printed_has '·'):${#REDS[@]}" 0:0

echo "== 退出 0 却一行逐项结论都没有：判红（输出认不出，不当成没事）"
run --check 0 "${HEAD}结论：改动 0；退出码 0
"
check "记一笔红" "${#REDS[@]}" 1
check "红里说出没给逐项结论" "$(grep -c '退出 0，却一行逐项结论都没给' <<<"$(last_red)")" 1

if ((fail)); then
  echo "agents-sync-account：不通过"
  exit 1
fi
echo "agents-sync-account：通过"
