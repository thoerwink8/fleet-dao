#!/usr/bin/env bash
# run.sh 的分台名单（SHARDS、NODE_TESTS）：每个测试文件恰好排进一台，漏了、排了两台、排了不存在的、node 测试没登记，
# 都要红；参数不对（台数和脚本里的不一样、写法认不出、和 --ops 一起用）退出 2。不真跑任何一台：把 deploy/ 拷进临时目录，
# 在拷贝上造错，只跑 run.sh --check-shards（只核名单）和认参数。
# 用法：bash deploy/test/shards.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$HERE/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

OUT=$TMP/out
RC=0
fresh() { # 每个场景一份干净的拷贝
  rm -rf -- "$TMP/repo"
  mkdir -p "$TMP/repo/docs"
  cp -R -- "$DEPLOY" "$TMP/repo/deploy"
  cp -- "$DEPLOY/../docs/ops.md" "$TMP/repo/docs/ops.md"
}
run() { # run.sh 的参数
  bash "$TMP/repo/deploy/test/run.sh" "$@" >"$OUT" 2>&1
  RC=$?
}
has() { grep -cF -- "$1" "$OUT" | tr -d ' '; }

echo "== 原样：每个测试文件恰好排进一台"
fresh
run --check-shards
check "退出码" "$RC" 0
check "说了几台几项" "$(has '分台名单：3 台')" 1
if ((RC != 0)); then cat -- "$OUT"; fi

echo "== 故意造错：新加一个测试文件、没排进任何一台"
fresh
: >"$TMP/repo/deploy/test/zz-new.test.sh"
run --check-shards
check "退出码" "$RC" 1
check "点名没排进台的" "$(has '没排进任何一台')" 1
check "点出是 zz-new" "$(grep -c 'zz-new' "$OUT" | tr -d ' ')" 1

echo "== 故意造错：排了的测试文件被删了"
fresh
rm -- "$TMP/repo/deploy/test/login-user.test.sh"
run --check-shards
check "退出码" "$RC" 1
check "点名排了却没有文件的" "$(has '排进了台，却没有这个测试文件')" 1
check "点出是 login-user" "$(grep -c 'login-user' "$OUT" | tr -d ' ')" 1

echo "== 故意造错：同一项排在两台"
fresh
sed -i "s/^  'cli-tools session-pnpm/  'cli-tools login-user session-pnpm/" "$TMP/repo/deploy/test/run.sh"
check "拷贝里真改了" "$(grep -c "'cli-tools login-user session-pnpm" "$TMP/repo/deploy/test/run.sh" | tr -d ' ')" 1
run --check-shards
check "退出码" "$RC" 1
check "点名排了不止一台的" "$(has '排了不止一台')" 1
check "点出是 login-user" "$(grep -c 'login-user' "$OUT" | tr -d ' ')" 1

echo "== 故意造错：新加的 node 测试没登记"
fresh
: >"$TMP/repo/deploy/test/zz-node.test.mjs"
run --check-shards
check "退出码" "$RC" 1
check "点名没登记的 node 测试" "$(has 'zz-node.test.mjs 没登记进 NODE_TESTS')" 1

echo "== 故意造错：登记的 node 测试没有文件"
fresh
rm -- "$TMP/repo/deploy/test/config.test.mjs"
run --check-shards
check "退出码" "$RC" 1
check "点名没有文件的" "$(has 'NODE_TESTS 里的 config 没有 config.test.mjs')" 1

echo "== 参数：认不出的、台数不对的、越界的、和 --ops 一起用的，都退出 2、不跑任何一项"
fresh
for args in "--shard" "--shard abc" "--shard 0/3" "--shard 1/2" "--shard 4/3" "--shard 1/3 --ops" "--frobnicate"; do
  # shellcheck disable=SC2086 # 故意拆词：每个场景是一串参数
  run $args
  check "「$args」退出码" "$RC" 2
  check "「$args」说了没跑成" "$(has '没跑成：')" 1
  check "「$args」一项都没跑（没有 ⏱ 行）" "$(has '⏱')" 0
done

if ((fail)); then
  echo "shards：不通过"
  exit 1
fi
echo "shards：通过"
