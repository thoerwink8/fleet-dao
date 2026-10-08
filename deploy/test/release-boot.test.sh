#!/usr/bin/env bash
# 发版车入口（#1294）：release-boot.sh 把目标提交的 deploy/ 解到按提交号命名的私有目录，再 exec 那一版的 release.sh。
# 裸仓 HEAD 停在「在用版」（行为和目标版不同）。发版必须跑目标版。
# 测：目标版和在用版行为不同时跑的是目标版；参数原样传；两次不同提交的发版同时来各跑各的（A 一定跑 A 版，
# 另一个发版换了提交也动不了它）；同一个提交同时来都成；旧目录清掉、这一版的留着。
# 【故意造出的失败】目标版没有 deploy/release.sh、对象读不出、是符号链接、提交号认不出、提交取不到：拒发，
# 不退回跑在用版，也不在 .boot 里留东西。
# 不连网、不需要 root（要 bash、git、node、mktemp -d、mv -T；锁在被 exec 的 release.sh 里，不在这里测）。
# 用法：bash deploy/test/release-boot.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BOOT=$HERE/../../agents/skills/commander/scripts/release-boot.sh
if [[ ! -f $BOOT ]]; then
  echo "release-boot：没跑成：没有 $BOOT"
  exit 2
fi
if ! command -v git >/dev/null || ! command -v node >/dev/null; then
  echo "release-boot：没跑成：这台没有 git 或 node"
  exit 2
fi
ROOT=$(cd -- "$HERE/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
mkdir -p "$FLEET_RELEASES_DIR"
CACHE=$FLEET_RELEASES_DIR/.repo.git
BOOTDIR=$FLEET_RELEASES_DIR/.boot
MARKER=$TMP/marker
GATE=$TMP/gate
export MARKER GATE
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
BOOT_TEXT=$(cat "$BOOT")

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

commit() { # 说明
  git -C "$CACHE" add -A
  git -C "$CACHE" commit -q -m "$1"
}

# .boot 里现有几项（含隐藏的临时目录）
boot_items() { find "$BOOTDIR" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' '; }

# 脚本正文。失败路径直接跑它。cwd 不在裸仓里，相对路径的旧脚本碰不到。
run_boot() {
  rm -f -- "$MARKER" "$MARKER.ran"
  (
    cd -- "$TMP" || exit
    bash -c "$BOOT_TEXT" fleet-release-boot "$@"
  ) >"$TMP/out" 2>"$TMP/err"
  ENTRY_RC=$?
}

# 成功路径走发版车真正 ssh 的那条命令（releaseBootCommand 把脚本单引号包起来），引用坏了就跑不起来。
run_train() {
  local cmd
  rm -f -- "$MARKER" "$MARKER.ran"
  if ! cmd=$(node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const mod = await import(pathToFileURL(process.argv[1]).href);
    process.stdout.write(mod.releaseBootCommand(process.argv[2]));
  ' "$ROOT/agents/skills/commander/scripts/release-train-lib.mjs" "$1" 2>"$TMP/node-err"); then
    cat "$TMP/node-err" >&2
    echo "release-boot：没跑成：拼不出发版车的命令" >&2
    exit 2
  fi
  (
    cd -- "$TMP" || exit
    bash -c "$cmd"
  ) >"$TMP/out" 2>"$TMP/err"
  ENTRY_RC=$?
}

# 造一个提交：deploy/release.sh 写成给定的 who（A、B…）。脚本启动后写 $MARKER.started，等 $GATE 出现（没设就不等），
# 然后在 $MARKER 里写它是谁、读 $0 看自己有没有被换掉，退出码 40 加它的序号
make_version() { # who 序号
  cat >"$CACHE/deploy/release.sh" <<EOF
#!/usr/bin/env bash
# tag-is-$1
printf 'started\n' >"\${MARKER:?}.started"
while [[ -n "\${GATE_WAIT:-}" && ! -f "\${GATE:?}" ]]; do sleep 0.1; done
printf 'who=$1 self=%s args=%s\n' "\$(grep -c '^# tag-is-$1\$' "\$0")" "\$*" >"\${MARKER:?}"
exit $((40 + $2))
EOF
  commit "版本 $1"
}

# 后台跑一次入口，标记文件 $1，其余是入口的参数；出口码写进 $1.rc
boot_bg() {
  local m=$1
  shift
  (
    cd -- "$TMP" || exit
    MARKER=$m bash -c "$BOOT_TEXT" fleet-release-boot "$@" >"$m.out" 2>"$m.err"
    printf '%s' "$?" >"$m.rc"
  ) &
}

git init -q -b main "$CACHE"
mkdir -p "$CACHE/deploy/lib"
printf '%s\n' '# 在用版的旁边文件' >"$CACHE/deploy/lib/common.sh"
cat >"$CACHE/deploy/release.sh" <<'EOF'
#!/usr/bin/env bash
# 在用版：从手放的旧位置装目录（这次要证明发版不跑这份）
printf 'behavior=in-use args=%s\n' "$*" >"${MARKER:?}"
printf 'in-use\n' >>"${MARKER:?}.ran"
exit 7
EOF
commit "在用版"
OLD=$(git -C "$CACHE" rev-parse HEAD)

cat >"$CACHE/deploy/release.sh" <<'EOF'
#!/usr/bin/env bash
# 目标版：目录从仓里装。发版车把包交给这里才算用了这一版。
printf 'behavior=target args=%s\n' "$*" >"${MARKER:?}"
printf 'target\n' >>"${MARKER:?}.ran"
printf '%s\n' "$(cd -- "$(dirname -- "$0")" && pwd)" >"${MARKER:?}.dir"
exit 42
EOF
commit "目标版"
NEW=$(git -C "$CACHE" rev-parse HEAD)
git -C "$CACHE" checkout -q -B main "$OLD"
OLD_BLOB=$(git -C "$CACHE" rev-parse "$OLD:deploy/release.sh")
NEW_BLOB=$(git -C "$CACHE" rev-parse "$NEW:deploy/release.sh")

echo "== 在用版（裸仓 HEAD）和目标版行为不同：发版车的命令用目标版"
run_train "$NEW"
check "跑的是目标版，不是在用版" "$(cat "$MARKER" 2>/dev/null)" "behavior=target args=$NEW"
check "没有先跑过在用版" "$(cat "$MARKER.ran" 2>/dev/null)" target
check "退出码是目标版的" "$ENTRY_RC" 42
check "在用版和目标版不是同一份脚本" "$([[ $OLD_BLOB == "$NEW_BLOB" ]] && echo yes || echo no)" no
check "裸仓 HEAD 仍是在用版" "$(git -C "$CACHE" rev-parse HEAD)" "$OLD"
check "目标版在按提交号命名的私有目录里跑" "$(cat "$MARKER.dir" 2>/dev/null)" "$BOOTDIR/$NEW/deploy"
check "目录里没有留下临时目录" "$(boot_items)" 1

echo "== 参数原样传（完整提交号在最前，--now、--unmerged 照带）；短提交号补成完整的"
run_boot "${NEW:0:10}" --now --unmerged
check "短号补成完整提交号再带参数" "$(cat "$MARKER" 2>/dev/null)" "behavior=target args=$NEW --now --unmerged"
check "已经解开过的目录直接用" "$(boot_items)" 1

echo "== 两次不同提交的发版同时来：A 一定跑 A 版，B 发完也动不了 A"
git -C "$CACHE" checkout -q -B va "$OLD"
make_version A 1
VA=$(git -C "$CACHE" rev-parse HEAD)
git -C "$CACHE" checkout -q -B vb "$OLD"
make_version B 2
VB=$(git -C "$CACHE" rev-parse HEAD)
git -C "$CACHE" checkout -q main
# A 先起、停在门口（它的目录里的 release.sh 此时已经 exec 了、正被 bash 一边读一边跑）
rm -f -- "$GATE" "$TMP"/a.* "$TMP"/b.*
GATE_WAIT=1 boot_bg "$TMP/a" "$VA"
for _ in $(seq 1 100); do
  if [[ -f $TMP/a.started ]]; then break; fi
  sleep 0.1
done
check "A 起来了、停在门口" "$([[ -f $TMP/a.started ]] && echo yes || echo no)" yes
# B 在 A 还没做完时整个跑完
boot_bg "$TMP/b" "$VB"
wait_b=0
for _ in $(seq 1 100); do
  if [[ -f $TMP/b.rc ]]; then
    wait_b=1
    break
  fi
  sleep 0.1
done
check "B 在 A 没做完时跑完了" "$wait_b" 1
check "B 跑的是 B 版" "$(cat "$TMP/b" 2>/dev/null)" "who=B self=1 args=$VB"
check "B 的退出码是 B 版的" "$(cat "$TMP/b.rc" 2>/dev/null)" 42
touch "$GATE"
for _ in $(seq 1 100); do
  if [[ -f $TMP/a.rc ]]; then break; fi
  sleep 0.1
done
check "A 跑的是 A 版（脚本没被 B 换掉）" "$(cat "$TMP/a" 2>/dev/null)" "who=A self=1 args=$VA"
check "A 的退出码是 A 版的" "$(cat "$TMP/a.rc" 2>/dev/null)" 41
check "A、B 各有自己的目录" "$([[ -d $BOOTDIR/$VA/deploy && -d $BOOTDIR/$VB/deploy ]] && echo yes || echo no)" yes
wait

echo "== 同一个提交同时来 6 次、A、B 交错来 6 次：每一次都跑对自己的版本"
rm -rf -- "$BOOTDIR" "$TMP"/c.* "$TMP"/d.*
rm -f -- "$GATE"
for i in 1 2 3 4 5 6; do
  boot_bg "$TMP/c.$i" "$VA"
  boot_bg "$TMP/d.$i" "$VB"
done
wait
bad=""
for i in 1 2 3 4 5 6; do
  if [[ "$(cat "$TMP/c.$i" 2>/dev/null)" != "who=A self=1 args=$VA" || "$(cat "$TMP/c.$i.rc" 2>/dev/null)" != 41 ]]; then bad+=" c.$i"; fi
  if [[ "$(cat "$TMP/d.$i" 2>/dev/null)" != "who=B self=1 args=$VB" || "$(cat "$TMP/d.$i.rc" 2>/dev/null)" != 42 ]]; then bad+=" d.$i"; fi
done
check "12 次各跑各的（串了或没跑成的：${bad:-无}）" "$bad" ""
check "只留下两个提交的目录，没有临时目录" "$(boot_items)" 2

echo "== 两天前的旧目录清掉，这一版的留着"
mkdir -p "$BOOTDIR/old-one/deploy" "$BOOTDIR/.tmp.stale"
touch -d '5 days ago' "$BOOTDIR/old-one" "$BOOTDIR/.tmp.stale"
# 这一版的目录本身也是旧的：不清
touch -d '5 days ago' "$BOOTDIR/$VA"
run_boot "$VA"
check "旧目录清掉了" "$([[ -e $BOOTDIR/old-one ]] && echo kept || echo gone)" gone
check "没解完的旧临时目录清掉了" "$([[ -e $BOOTDIR/.tmp.stale ]] && echo kept || echo gone)" gone
check "这一版的目录留着" "$([[ -d $BOOTDIR/$VA/deploy ]] && echo kept || echo gone)" kept
check "两天内的别的版本留着" "$([[ -d $BOOTDIR/$VB/deploy ]] && echo kept || echo gone)" kept

# ── 故意造出的失败：每一条都要退出 1、不改用在用版、不在 .boot 里留东西 ──
rm -rf -- "$BOOTDIR"

echo "== 【故意造出的失败】目标版没有 deploy/release.sh：拒发，不退回用旧的"
git -C "$CACHE" checkout -q -B missing "$NEW"
git -C "$CACHE" rm -q deploy/release.sh
commit "没有 release.sh"
MISSING=$(git -C "$CACHE" rev-parse HEAD)
git -C "$CACHE" checkout -q main
run_boot "$MISSING"
check "拒发的退出码" "$ENTRY_RC" 1
check "没有改用在用版" "$(cat "$MARKER" 2>/dev/null || echo absent)" absent
check "在用版没有被执行" "$(cat "$MARKER.ran" 2>/dev/null || echo absent)" absent
check "说了拒发、不改跑检出里的" "$(grep -c '不改跑检出里的 release.sh' "$TMP/err")" 1
check "说了没有 deploy/release.sh" "$(grep -c '没有 deploy/release.sh' "$TMP/err")" 1
check "没在 .boot 里留东西" "$(boot_items)" 0

echo "== 【故意造出的失败】目标版的 release.sh 读不出：拒发，不退回用旧的"
BLOB=$(git -C "$CACHE" rev-parse "$NEW:deploy/release.sh")
rm -f -- "$CACHE/.git/objects/${BLOB:0:2}/${BLOB:2}"
run_boot "$NEW"
check "读不出的退出码" "$ENTRY_RC" 1
check "读不出也没有改用在用版" "$(cat "$MARKER" 2>/dev/null || echo absent)" absent
check "读不出也没有执行在用版" "$(cat "$MARKER.ran" 2>/dev/null || echo absent)" absent
check "说了包解不开" "$(grep -c '解不开' "$TMP/err")" 1
check "解到一半失败，没在 .boot 里留东西" "$(boot_items)" 0

echo "== 【故意造出的失败】目标版的 release.sh 是符号链接：不跟，拒发"
git -C "$CACHE" checkout -q -B link-branch "$OLD"
# shellcheck disable=SC2016 # 单引号里的 ${MARKER:?} 要原样写进假脚本，由它执行时展开
printf '%s\n' '#!/usr/bin/env bash' 'printf followed >"${MARKER:?}"' >"$TMP/followed.sh"
# 直接往索引里写一条 120000（符号链接）的记录：不靠这台能不能建符号链接（Windows 上多半不能）
LINK_BLOB=$(printf '%s' "$TMP/followed.sh" | git -C "$CACHE" hash-object -w --stdin)
git -C "$CACHE" update-index --add --cacheinfo "120000,$LINK_BLOB,deploy/release.sh"
git -C "$CACHE" commit -q -m "符号链接"
LINK=$(git -C "$CACHE" rev-parse HEAD)
check "造出来的提交里 deploy/release.sh 确是符号链接" "$(git -C "$CACHE" ls-tree "$LINK" deploy/release.sh | cut -d' ' -f1)" 120000
git -C "$CACHE" checkout -q -f main
run_boot "$LINK"
check "符号链接拒发" "$ENTRY_RC" 1
check "说了不是普通文件" "$(grep -c '不是普通文件' "$TMP/err")" 1
check "没有跟着链接跑" "$(cat "$MARKER" 2>/dev/null || echo absent)" absent
check "没在 .boot 里留东西" "$(boot_items)" 0

echo "== 【故意造出的失败】提交号认不出：拒发"
run_boot '不是提交'
check "认不出的退出码" "$ENTRY_RC" 1
check "认不出也没有改用在用版" "$(cat "$MARKER" 2>/dev/null || echo absent)" absent
run_boot
check "没给提交号也拒发" "$ENTRY_RC" 1

echo "== 【故意造出的失败】裸仓里没有这个提交、又取不到（这个测试仓没有 origin）：拒发"
run_boot 0123456789012345678901234567890123456789
check "取不到的退出码" "$ENTRY_RC" 1
check "取不到也没有执行任何 release.sh" "$(cat "$MARKER" 2>/dev/null || echo absent)" absent
check "说了从 GitHub 取不到" "$(grep -c 'GitHub' "$TMP/err")" 1
check "没在 .boot 里留东西" "$(boot_items)" 0
run_boot 0123456
check "没有的短提交号拒发" "$ENTRY_RC" 1

url=https://github.com/thoerwink8/fleet-dao.git
check "自举和 release.sh 用同一个仓库地址" "$(grep -F -c -- "$url" "$BOOT") $(grep -F -c -- "$url" "$HERE/../release.sh")" "1 1"

if ((fail)); then
  echo "release-boot：不通过"
  printf '—— stdout ——\n%s\n—— stderr ——\n%s\n' "$(cat "$TMP/out" 2>/dev/null)" "$(cat "$TMP/err" 2>/dev/null)"
  exit 1
fi
echo "release-boot：通过"
