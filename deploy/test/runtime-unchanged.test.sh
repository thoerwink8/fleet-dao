#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # CACHE、SHA、ON_MAIN 是给 source 进来的 release.sh 读的
# 发版前按路径白名单判：改动全在文档或测试里就不暂停、不重启。不需要 root。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e # release.sh 开了 -e；这里自己判每一步
fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then printf '  ✓ %s\n' "$1"
  else printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"; fail=1; fi
}
REPO=$TMP/repo
git init -q -b main "$REPO"
git -C "$REPO" config user.email t@example.com
git -C "$REPO" config user.name t
git -C "$REPO" config commit.gpgsign false
mkdir -p "$REPO/packages/engine/src"
printf 'base\n' >"$REPO/packages/engine/src/keep.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m base
BASE=$(git -C "$REPO" rev-parse HEAD)
CACHE=$REPO
new_commit() { # 在 BASE 上改这些路径，打印新提交号
  local p
  git -C "$REPO" checkout -q --detach "$BASE" || return 1
  for p in "$@"; do
    mkdir -p -- "$REPO/$(dirname -- "$p")" && printf 'x\n' >"$REPO/$p" && git -C "$REPO" add -- "$p" || return 1
  done
  git -C "$REPO" commit -q -m t && git -C "$REPO" rev-parse HEAD
}
judge() { runtime_unchanged "$BASE" "$1"; check "$2" "$?" "$3"; }
docs_sha=$(new_commit docs/only.md) || exit 1
test_sha=$(new_commit packages/engine/test/a.ts) || exit 1
src_sha=$(new_commit packages/engine/src/a.ts) || exit 1
mix_sha=$(new_commit docs/mix.md packages/engine/src/b.ts) || exit 1
nest_sha=$(new_commit packages/engine/src/test/a.ts) || exit 1
ok_sha=$(new_commit docs/a.md specs/a.txt README.md packages/web/test/a.ts agents/test/a.sh deploy/test/a.sh) || exit 1
judge "$docs_sha" "只改 docs/*.md 不重启" 0
judge "$test_sha" "只改 packages/engine/test/ 不重启" 0
judge "$src_sha" "改了 packages/engine/src/ 要重启" 1
judge "$mix_sha" "文档加源码混改要重启" 1
judge "$nest_sha" "src 下面的 test 目录要重启" 1
judge "$ok_sha" "白名单上的路径放一起不重启" 0
CACHE=$TMP/not-a-repo
judge "$docs_sha" "清单读不出要重启" 1
CACHE=$REPO
runtime_unchanged "" "$docs_sha"
check "在用版本取不到要重启" "$?" 1
# 计数写文件：do_release 的输出用重定向接走，暂停次数不丢
mkdir -p "$RELEASES"
ln -sfn "$BASE" "$RELEASES/current"
echo 0 >"$TMP/pauses"
fetch_code() { SHA=$1; ON_MAIN=1; }
build_release() { :; }
hk_reachable() { :; }
schema_allows() { :; }
drain_request() { :; }
pause_tasks() { echo $(($(<"$TMP/pauses") + 1)) >"$TMP/pauses"; }
drain_engine() { :; }
upgrade_cli_tools() { :; }
migrate() { :; }
load_catalog() { :; }
load_routing() { :; }
api_report_before() { :; }
apply_config() { :; }
activate() { echo "$RUNTIME_UNCHANGED" >"$TMP/flag"; }
health_gate() { :; }
prune() { :; }
do_release "$docs_sha" >"$TMP/out" 2>&1
check "只改文档：没暂停" "$(<"$TMP/pauses")" 0
check "只改文档：日志写了没重启" "$(grep -cF '只改了文档或测试，引擎运行内容没变，没重启' "$TMP/out")" 1
check "只改文档：activate 不重启" "$(<"$TMP/flag")" 1
echo 0 >"$TMP/pauses"
do_release "$src_sha" >"$TMP/out" 2>&1
check "改了源码：暂停了" "$(<"$TMP/pauses")" 1
check "改了源码：不写没重启" "$(grep -cF '引擎运行内容没变，没重启' "$TMP/out")" 0
check "改了源码：activate 照旧" "$(<"$TMP/flag")" 0
if ((fail)); then echo "runtime-unchanged：不通过"; cat "$TMP/out"; exit 1; fi
echo "runtime-unchanged：通过"
