#!/usr/bin/env bash
# shellcheck disable=SC2154 # AGENTS_SYNC_CMD 由调用方设
# 跑一遍同步脚本（packages/agents-sync），把它逐行的结论接进装机脚本的账（common.sh 的 changed、red、pending、ok）：
# ↻ 改了、✗ 红、… 没查成、✓ 对、· 没装跳过。它以 --user 换成那个用户再动手，写出来的东西归那个用户。
# 写（--apply）的时候只记「改了」，✗ 和 … 照打不记账：读回那一步的 --check 会把同一件事再判一次，记两遍就重了。
# 同步脚本没给出逐项结论（崩了、node 起不来、输出认不出）一律判红，不当成没事。
# 调用方先设 AGENTS_SYNC_CMD：怎么起同步脚本（france.sh 设成 /usr/bin/node 加 bin/agents-sync，测试换成假的）。
# france.sh 和 deploy/test/agents-sync-account.test.sh 共用；要先 source common.sh。

agents_sync() { # 模式 用户
  local mode=$1 u=$2 out rc=0 line said=0 seen=0
  out=$("${AGENTS_SYNC_CMD[@]}" "$mode" --user "$u" 2>&1) || rc=$?
  while IFS= read -r line; do
    case $line in
    '  ↻ '*)
      seen=1
      changed "$u ${line#  ↻ }"
      ;;
    '  ✗ '*)
      seen=1 said=1
      if [[ "$mode" == --check ]]; then red "$u ${line#  ✗ }"; else printf '  ✗ %s %s\n' "$u" "${line#  ✗ }"; fi
      ;;
    '  … '*)
      seen=1 said=1
      if [[ "$mode" == --check ]]; then pending "$u ${line#  … }"; else printf '  … %s %s\n' "$u" "${line#  … }"; fi
      ;;
    '  ✓ '*)
      seen=1
      ok "$u ${line#  ✓ }"
      ;;
    '  · '*)
      seen=1
      if [[ "$mode" == --check ]]; then printf '  · %s %s\n' "$u" "${line#  · }"; fi
      ;;
    esac
  done <<<"$out"
  if ((rc != 0 && said == 0)); then
    red "$u：同步脚本 $mode 退出 $rc，没给出逐项结论：$(tail -3 <<<"$out" | tr '\n' ' ')"
  elif ((rc == 0 && seen == 0)); then
    red "$u：同步脚本 $mode 退出 0，却一行逐项结论都没给（输出认不出）：$(tail -3 <<<"$out" | tr '\n' ' ')"
  fi
}
