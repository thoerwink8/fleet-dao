#!/usr/bin/env bash
# 发版车入口（#1294）：release-boot.sh 先把目标提交的 deploy/ 解开，再 exec 那一版的 release.sh。
# 裸仓 HEAD 停在「在用版」（行为和目标版不同）。发版必须跑目标版。
# 【故意造出的失败】目标版没有 deploy/release.sh，或对象读不出、是符号链接：拒发，不退回跑在用版。
# 不连网、不需要 root。用法：bash deploy/test/release-boot.test.sh。退出码：0 通过，1 不通过，2 没跑成。
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
MARKER=$TMP/marker
export MARKER
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

# 脚本正文。失败路径直接跑它。cwd 不在裸仓里，相对路径的旧脚本碰不到。
run_boot() {
  rm -f -- "$MARKER" "$MARKER.ran"
  (
    cd -- "$TMP"
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
    cd -- "$TMP"
    bash -c "$cmd"
  ) >"$TMP/out" 2>"$TMP/err"
  ENTRY_RC=$?
}

git init -q -b main "$CACHE"
mkdir -p "$CACHE/deploy/lib"
printf '%s\n' '# 在用版的旁边文件' >"$CACHE/deploy/lib/common.sh"
cat >"$CACHE/deploy/release.sh" <<'EOF'
#!/usr/bin/env bash
# 在用版：从手放的旧位置装目录（这次要证明发版不跑这份）
printf 'behavior=in-use boot=%s args=%s\n' "${FLEET_RELEASE_BOOTSTRAPPED:-}" "$*" >"${MARKER:?}"
printf 'in-use\n' >>"${MARKER:?}.ran"
exit 7
EOF
commit "在用版"
OLD=$(git -C "$CACHE" rev-parse HEAD)

cat >"$CACHE/deploy/release.sh" <<'EOF'
#!/usr/bin/env bash
# 目标版：目录从仓里装。发版车把包交给这里才算用了这一版。
printf 'behavior=target boot=%s args=%s\n' "${FLEET_RELEASE_BOOTSTRAPPED:-}" "$*" >"${MARKER:?}"
printf 'target\n' >>"${MARKER:?}.ran"
exit 42
EOF
commit "目标版"
NEW=$(git -C "$CACHE" rev-parse HEAD)
git -C "$CACHE" branch target "$NEW"
git -C "$CACHE" checkout -q -B main "$OLD"
OLD_BLOB=$(git -C "$CACHE" rev-parse "$OLD:deploy/release.sh")
NEW_BLOB=$(git -C "$CACHE" rev-parse "$NEW:deploy/release.sh")

echo "== 在用版（裸仓 HEAD）和目标版行为不同：发版车的命令用目标版"
run_train "$NEW"
check "跑的是目标版，不是在用版" "$(cat "$MARKER" 2>/dev/null)" "behavior=target boot= args=$NEW"
check "没有先跑过在用版" "$(cat "$MARKER.ran" 2>/dev/null)" target
check "退出码是目标版的" "$ENTRY_RC" 42
check "在用版和目标版不是同一份脚本" "$([[ $OLD_BLOB == "$NEW_BLOB" ]] && echo yes || echo no)" no
check "裸仓 HEAD 仍是在用版" "$(git -C "$CACHE" rev-parse HEAD)" "$OLD"

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

echo "== 【故意造出的失败】目标版的 release.sh 读不出：拒发，不退回用旧的"
BLOB=$(git -C "$CACHE" rev-parse "$NEW:deploy/release.sh")
rm -f -- "$CACHE/.git/objects/${BLOB:0:2}/${BLOB:2}"
run_boot "$NEW"
check "读不出的退出码" "$ENTRY_RC" 1
check "读不出也没有改用在用版" "$(cat "$MARKER" 2>/dev/null || echo absent)" absent
check "读不出也没有执行在用版" "$(cat "$MARKER.ran" 2>/dev/null || echo absent)" absent
check "说了读不出" "$(grep -c '读不出' "$TMP/err")" 1

echo "== 【故意造出的失败】目标版的 release.sh 是符号链接：不跟，拒发"
git -C "$CACHE" checkout -q -B link-branch "$OLD"
rm -f -- "$CACHE/deploy/release.sh"
ln -s "$TMP/followed.sh" "$CACHE/deploy/release.sh"
printf '%s\n' '#!/usr/bin/env bash' 'printf followed >"${MARKER:?}"' >"$TMP/followed.sh"
commit "符号链接"
LINK=$(git -C "$CACHE" rev-parse HEAD)
git -C "$CACHE" checkout -q main
run_boot "$LINK"
check "符号链接拒发" "$ENTRY_RC" 1
check "没有跟着链接跑" "$(cat "$MARKER" 2>/dev/null || echo absent)" absent

echo "== 【故意造出的失败】提交号认不出：拒发"
run_boot '不是提交'
check "认不出的退出码" "$ENTRY_RC" 1
check "认不出也没有改用在用版" "$(cat "$MARKER" 2>/dev/null || echo absent)" absent

url=https://github.com/thoerwink8/fleet-dao.git
check "自举和 release.sh 用同一个仓库地址" "$(grep -F -c -- "$url" "$BOOT") $(grep -F -c -- "$url" "$HERE/../release.sh")" "1 1"

if ((fail)); then
  echo "release-boot：不通过"
  printf '—— stdout ——\n%s\n—— stderr ——\n%s\n' "$(cat "$TMP/out" 2>/dev/null)" "$(cat "$TMP/err" 2>/dev/null)"
  exit 1
fi
echo "release-boot：通过"
