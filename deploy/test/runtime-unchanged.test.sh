#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # CACHE、SHA、ON_MAIN 是给 source 进来的 release.sh 读的
# 发版前按路径白名单判：改动全在文档或测试里就不暂停、不重启。不需要 root。
# 看门狗那段要 Node 22 的类型擦除。release.sh 把 NODE 钉在 /usr/bin/node（法国那台有）；
# CI 用 sudo 跑，镜像上的 node 在 /usr/local/bin，/usr/bin/node 没有。找不到就退出 2，不当通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e # release.sh 开了 -e；这里自己判每一步
# sudo 会把 PATH 收成安全路径，setup-node 加进去的那份不在上面。和别的 deploy 测试一样，把这几个地方都看一遍。
NODE=""
for n in "$(command -v node 2>/dev/null || true)" /usr/local/bin/node /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node; do
  [[ -x "$n" ]] || continue
  major=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
  if [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 22)); then
    NODE=$n
    break
  fi
done
if [[ -z "$NODE" ]]; then
  echo "runtime-unchanged：没跑成：找不到 Node 22（看门狗那段要类型擦除）"
  exit 2
fi
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
activate() { echo "$ENGINE_UNCHANGED$API_UNCHANGED" >"$TMP/flag"; }
saved_health_gate=$(declare -f health_gate)
health_gate() { :; }
prune() { :; }
do_release "$docs_sha" >"$TMP/out" 2>&1
check "只改文档：没暂停" "$(<"$TMP/pauses")" 0
check "只改文档：日志写了引擎没重启" "$(grep -cF '引擎运行内容没变，没重启（只改了文档或测试）' "$TMP/out")" 1
check "只改文档：日志写了后端没重启" "$(grep -cF '后端运行内容没变，没重启（只改了文档或测试）' "$TMP/out")" 1
check "只改文档：activate 两个都不重启" "$(<"$TMP/flag")" 11
echo 0 >"$TMP/pauses"
do_release "$src_sha" >"$TMP/out" 2>&1
check "改了源码：暂停了" "$(<"$TMP/pauses")" 1
check "改了源码：不写没重启" "$(grep -cF '引擎运行内容没变，没重启' "$TMP/out")" 0
check "改了源码：activate 照旧" "$(<"$TMP/flag")" 00
check "改了源码：写明要停引擎、为什么" "$(grep -cF '要停引擎：' "$TMP/out")" 1
# 这一版目录里有引用闭包的脚本（#2797）：按它的退出码判。0 不停引擎；10 停、原因照抄；别的（算不出）照旧停、写明没算成。
# 这里放替身脚本只核接线，真判法在 runtime-closure.test.mjs。
fake_closure() { # 退出码 输出
  mkdir -p "$RELEASES/$src_sha/deploy/lib"
  printf 'console.log(%s); process.exit(%s);\n' "$(printf '%s' "$2" | "$NODE" -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')" "$1" \
    >"$RELEASES/$src_sha/deploy/lib/runtime-closure.mjs"
  UNCHANGED_RC=()
  echo 0 >"$TMP/pauses"
  do_release "$src_sha" >"$TMP/out" 2>&1
}
fake_closure 0 '改的 1 个文件都不在引擎的引用闭包里'
check "闭包说没碰：没暂停" "$(<"$TMP/pauses")" 0
check "闭包说没碰：两个都不重启" "$(<"$TMP/flag")" 11
check "闭包说没碰：原因照抄" "$(grep -cF '引擎运行内容没变，没重启（改的 1 个文件都不在引擎的引用闭包里）' "$TMP/out")" 1
fake_closure 10 '改了 引擎运行要读的文件：packages/engine/src/a.ts'
check "闭包说碰了：暂停了" "$(<"$TMP/pauses")" 1
check "闭包说碰了：原因照抄" "$(grep -cF '要停引擎：改了 引擎运行要读的文件：packages/engine/src/a.ts' "$TMP/out")" 1
fake_closure 2 '判不了：tsc 没跑成'
check "闭包算不出：照旧停" "$(<"$TMP/pauses")" 1
check "闭包算不出：写明没算成" "$(grep -cF '引用闭包没算成（退出码 2：判不了：tsc 没跑成），照旧重启' "$TMP/out")" 1
rm -rf -- "${RELEASES:?}/$src_sha"
UNCHANGED_RC=()

# 故意造出的发布：主进程留在上一版目录。只改文档应退出 0、current 指向新版、历史不记不健康；
# 改了源码却没重启仍判红。看门狗用真判法（judgeReleaseAttention），不在这里重写。
eval "$saved_health_gate"
settle_services() { :; }
check_api() { :; }
check_engine() { :; }
check_web() { :; }
check_chain() { :; }
curl() { return 0; }
running_release() { printf '%s' "$(<"$TMP/proc")"; }
activate() { # 提交号 事件：切 current、记历史，主进程不动（模拟没重启）
  local sha=$1 how=$2
  if [[ "$(readlink -- "$RELEASES/current" 2>/dev/null)" != "$sha" ]]; then
    ln -sfn -- "$sha" "$RELEASES/current"
    record "$sha" "$how"
  fi
  if has_service fleet-api; then api_wait_up || return 1; fi
}
FLEET_SERVICES="fleet-engine fleet-api"
printf '%s' "$RELEASES/$BASE" >"$TMP/proc"
ROOT=$(cd -- "$HERE/../.." && pwd)
# 接活脚本 phaseRelease：退出码 0 或 2 不当失败，其余记 failed
train_status_for() {
  if [[ "$1" == 0 || "$1" == 2 ]]; then printf '%s' 'done'; else printf '%s' 'failed'; fi
}
write_train() { # 状态 这一趟的提交
  mkdir -p -- "$RELEASES/.train" "$RELEASES/.auto"
  "$NODE" -e '
    const fs = require("fs");
    const [dir, status, sha] = process.argv.slice(1);
    const note = status === "failed" ? "上一趟发版是「failed」状态，要人看，不自动再发" : "在用的就是主线头";
    fs.writeFileSync(dir + "/.train/release-train.json", JSON.stringify({
      schema: 1, status, phase: status === "done" ? 8 : 4,
      startedAt: "2026-10-16T02:06:00.000Z",
      target: { kind: "sha", value: sha },
    }) + "\n");
    fs.writeFileSync(dir + "/.auto/state.json", JSON.stringify({ auto: { note } }) + "\n");
  ' "$RELEASES" "$1" "$2"
}
cat >"$TMP/judge.mjs" <<'EOF'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [mod, trainFile] = process.argv.slice(2);
const { judgeReleaseAttention } = await import(pathToFileURL(mod).href);
const train = JSON.parse(readFileSync(trainFile, 'utf8'));
const v = judgeReleaseAttention(
  {
    trainStatus: typeof train.status === 'string' ? train.status : null,
    trainSince: typeof train.startedAt === 'string' ? train.startedAt : null,
    trainSha: train.target && typeof train.target.value === 'string' ? train.target.value : null,
  },
  new Date('2026-10-16T02:15:00.000Z'),
);
process.stdout.write(`${v.kind}\t${v.kind === 'alert' ? v.title : ''}\n`);
EOF
judge_watch() {
  "$NODE" --experimental-strip-types "$TMP/judge.mjs" \
    "$ROOT/packages/engine/src/jobs/release-watch.ts" \
    "$RELEASES/.train/release-train.json"
}
train_status() {
  "$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).status)' \
    "$RELEASES/.train/release-train.json"
}
release_rc() { # 提交号 日志：子 shell 里跑完再 finish；先摘掉 EXIT，免得 finish 退出时删掉临时目录
  (
    trap - EXIT
    DRAIN_WROTE=0
    ENGINE_STOPPED=0
    RESUME_ON_FINISH=0
    REDS=()
    CHANGES=()
    PENDING=()
    do_release "$1" >"$2" 2>&1
    finish >>"$2" 2>&1
  )
}

rm -f -- "$HISTORY"
ln -sfn -- "$BASE" "$RELEASES/current"
release_rc "$docs_sha" "$TMP/docs.out"
docs_rc=$?
check "只改文档：发布退出 0" "$docs_rc" 0
check "只改文档：current 指向新版" "$(current_sha)" "$docs_sha"
check "只改文档：历史不记不健康" "$(grep -cE 'unhealthy|auto-rollback' "$HISTORY" || true)" 0
check "只改文档：不写「重启后」" "$(grep -c '重启后' "$TMP/docs.out" || true)" 0
check "只改文档：写了沿用上一版进程" "$(grep -cF '没重启，沿用上一版进程' "$TMP/docs.out")" 1
check "只改文档：两个服务都核运行内容一致" "$(grep -cF '运行内容一致' "$TMP/docs.out")" 2
ENGINE_UNCHANGED=0
API_UNCHANGED=0
UNCHANGED_RC=()
REDS=()
check_running_release "$docs_sha" >"$TMP/check.out" 2>&1
check "只改文档：另一次进程没有标志也认可沿用" "$?" 0
docs_train=$(train_status_for "$docs_rc")
write_train "$docs_train" "$docs_sha"
check "只改文档：发版记录按退出码写" "$(train_status)" "$docs_train"
check "只改文档：发版记录不是 failed" "$([[ "$docs_train" != failed ]] && printf yes)" yes
docs_watch=$(judge_watch)
check "只改文档：看门狗读不到失败" "${docs_watch%%$'\t'*}" fine
check "只改文档：看门狗不说新版没发成或退回了" "$(grep -c '新版没发成或退回了' <<<"$docs_watch" || true)" 0

rm -f -- "$HISTORY"
ln -sfn -- "$BASE" "$RELEASES/current"
printf '%s' "$RELEASES/$BASE" >"$TMP/proc"
release_rc "$src_sha" "$TMP/src.out"
src_rc=$?
check "改了源码、没重启：发布退出 1" "$src_rc" 1
grep -qF '主进程跑的不是这一版' "$TMP/src.out"
check "改了源码、没重启：仍要求主进程在新版目录" "$?" 0
grep -q " ${src_sha} unhealthy" "$HISTORY"
check "改了源码、没重启：历史记不健康" "$?" 0
check "改了源码、没重启：已退回上一版" "$(current_sha)" "$BASE"
src_train=$(train_status_for "$src_rc")
write_train "$src_train" "$src_sha"
check "改了源码、没重启：发版记录是 failed" "$(train_status)" failed
src_watch=$(judge_watch)
check "改了源码、没重启：发版没成由接活脚本报，看门狗不再多报一条" "${src_watch%%$'\t'*}" fine

printf '%s' "$RELEASES/$BASE" >"$TMP/proc"
ENGINE_UNCHANGED=1
API_UNCHANGED=1
REDS=()
check_running_release "$src_sha" >"$TMP/flag-src.out" 2>&1
check "改了源码：标志不能把内容不同说成一致" "$?" 1
printf '' >"$TMP/proc"
REDS=()
check_running_release "$docs_sha" >"$TMP/empty.out" 2>&1
check "主进程没在跑：只改文档也判红" "$?" 1
grep -qF '没在跑' "$TMP/empty.out"
check "主进程没在跑：写明没在跑" "$?" 0

if ((fail)); then echo "runtime-unchanged：不通过"; echo '--- docs ---'; cat "$TMP/docs.out"; echo '--- src ---'; cat "$TMP/src.out"; exit 1; fi
echo "runtime-unchanged：通过"
