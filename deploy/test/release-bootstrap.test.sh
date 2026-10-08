#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 发版自举（#1294）：跑到这份 release.sh 时，它先把目标提交的 deploy/ 从裸仓解开，再交给那一版自带的
# release.sh。发版车在检出还是旧脚本时不跑这份，那条入口在 release-boot.test.sh。
# 在用这份和目标那一版行为不同时，跑的必须是目标那一版。
# 【故意造出的失败】目标提交没有 deploy/release.sh，或对象读不出、不是普通文件：拒发，
# 不接着跑现在这份（不退回用旧的）。
# 不连网、不需要 root。用法：bash deploy/test/release-bootstrap.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if ! command -v git >/dev/null; then
  echo "release-bootstrap：没跑成：这台没有 git"
  exit 2
fi
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e # release.sh 开了 -e；这里自己判每一步
mkdir -p "$RELEASES"
CACHE=$TMP/src
MARKER=$TMP/marker
export MARKER
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

# 取代码换成桩：对象已经在 CACHE 里，不向 GitHub 要
fetch_code() {
  if [[ -z "${1:-}" ]]; then
    SHA=$(git -C "$CACHE" rev-parse HEAD) || return 1
  else
    SHA=$(git -C "$CACHE" rev-parse --verify "$1^{commit}") || return 1
  fi
  ON_MAIN=1
}

commit() { # 说明
  git -C "$CACHE" add -A
  git -C "$CACHE" commit -q -m "$1"
}

git init -q "$CACHE"
mkdir -p "$CACHE/deploy/lib"
printf '%s\n' '# 在用版的旁边文件，和目标版不是同一份' >"$CACHE/deploy/lib/common.sh"
cat >"$CACHE/deploy/release.sh" <<'EOF'
#!/usr/bin/env bash
# 在用版：从手放的旧位置装目录（这次要证明发版不跑这份）
printf 'behavior=in-use-old-catalog-path boot=%s args=%s\n' "${FLEET_RELEASE_BOOTSTRAPPED:-}" "$*" >"${MARKER:?}"
exit 7
EOF
commit "在用版"
OLD=$(git -C "$CACHE" rev-parse HEAD)

cat >"$CACHE/deploy/release.sh" <<'EOF'
#!/usr/bin/env bash
# 目标版：目录从仓里装。入口交到这里才算发版用了这一版。
printf 'behavior=target-catalog-from-repo boot=%s args=%s\n' "${FLEET_RELEASE_BOOTSTRAPPED:-}" "$*" >"${MARKER:?}"
exit 42
EOF
commit "目标版"
NEW=$(git -C "$CACHE" rev-parse HEAD)
OLD_BLOB=$(git -C "$CACHE" rev-parse "$OLD:deploy/release.sh")
NEW_BLOB=$(git -C "$CACHE" rev-parse "$NEW:deploy/release.sh")

# 和 main 里一样：set -e，hand_off 失败就停，后面那行是在用版自己的行为
run_entry() { # 提交号 [参数…]
  rm -f -- "$MARKER"
  (
    set -e
    hand_off_release "$@"
    printf 'behavior=in-use-old-catalog-path boot=%s args=%s\n' "${FLEET_RELEASE_BOOTSTRAPPED:-}" "$*" >"${MARKER:?}"
  ) >"$TMP/out" 2>&1
  ENTRY_RC=$?
}

echo "== 在用版和目标版行为不同：发版用目标版"
run_entry "$NEW" "$NEW" --now
check "跑的是目标版（从仓里装），不是在用版（旧位置）" "$(cat "$MARKER" 2>/dev/null)" \
  "behavior=target-catalog-from-repo boot=1 args=$NEW --now"
check "退出码是目标版的" "$ENTRY_RC" 42
check "没有退回跑在用版（在用版退出码是 7）" "$ENTRY_RC" 42

echo "== 不写提交号：解析成当前头之后，交给那一版的参数里带着这个完整提交"
run_entry "" --now
check "不写提交号也跑目标版，参数里是解析出的提交" "$(cat "$MARKER" 2>/dev/null)" \
  "behavior=target-catalog-from-repo boot=1 args=$NEW --now"
check "不写提交号的退出码是目标版的" "$ENTRY_RC" 42

echo "== 已经是目标那一版在跑：不再交一次（否则自己交自己）"
export FLEET_RELEASE_BOOTSTRAPPED=1
run_entry "$NEW" "$NEW" --now
check "不再 exec 目标版" "$(cat "$MARKER" 2>/dev/null)" "behavior=in-use-old-catalog-path boot=1 args=$NEW $NEW --now"
check "接着往下做的退出码" "$ENTRY_RC" 0
unset FLEET_RELEASE_BOOTSTRAPPED

echo "== 【故意造出的失败】目标版没有 deploy/release.sh：拒发，不退回用旧的"
git -C "$CACHE" rm -q deploy/release.sh
commit "没有 release.sh"
MISSING=$(git -C "$CACHE" rev-parse HEAD)
run_entry "$MISSING" "$MISSING"
check "拒发的退出码" "$ENTRY_RC" 1
check "没有改用在用版" "$(cat "$MARKER" 2>/dev/null || echo absent)" absent
check "说了拒发、不用现在这份" "$(grep -c '不用现在这份' "$TMP/out")" 1

echo "== 【故意造出的失败】目标版的 release.sh 读不出：拒发，不退回用旧的"
BLOB=$(git -C "$CACHE" rev-parse "$NEW:deploy/release.sh")
rm -f -- "$CACHE/.git/objects/${BLOB:0:2}/${BLOB:2}"
run_entry "$NEW" "$NEW" --now
check "读不出的退出码" "$ENTRY_RC" 1
check "读不出也没有改用在用版" "$(cat "$MARKER" 2>/dev/null || echo absent)" absent
check "说了读不出" "$(grep -c '读不出' "$TMP/out")" 1

echo "== 【故意造出的失败】目标版的 release.sh 是符号链接：不跟，拒发"
git -C "$CACHE" checkout -q "$OLD" -- deploy/release.sh
rm -f -- "$CACHE/deploy/release.sh"
ln -s "$TMP/followed.sh" "$CACHE/deploy/release.sh"
# shellcheck disable=SC2016 # 单引号里的 ${MARKER:?} 要原样写进假脚本，由它执行时展开
printf '%s\n' '#!/usr/bin/env bash' 'printf followed >"${MARKER:?}"' >"$TMP/followed.sh"
commit "符号链接"
LINK=$(git -C "$CACHE" rev-parse HEAD)
run_entry "$LINK" "$LINK"
check "符号链接拒发" "$ENTRY_RC" 1
check "没有跟着链接跑" "$(cat "$MARKER" 2>/dev/null || echo absent)" absent

echo "== 入口占着的发布锁交给目标版时不再抢一次；没占着仍拒"
if command -v flock >/dev/null; then
  exec 8>>"$RELEASES/.lock"
  flock -n 8
  export FLEET_RELEASE_BOOTSTRAPPED=1
  export FLEET_RELEASE_LOCK_HELD=1
  take_lock >/dev/null
  held=$?
  check "锁已在这次发布上：take_lock 不再失败" "$held" 0
  unset FLEET_RELEASE_LOCK_HELD
  take_lock >/dev/null
  held=$?
  check "别的发布占着锁：照旧拒" "$held" 1
  unset FLEET_RELEASE_BOOTSTRAPPED
  flock -u 8
  exec 8>&-
else
  echo "  … 没跑成：这台没有 flock"
  fail=1
fi

same=no
if [[ "$OLD_BLOB" == "$NEW_BLOB" ]]; then same=yes; fi
check "在用版和目标版不是同一份脚本" "$same" no

if ((fail)); then
  echo "release-bootstrap：不通过"
  exit 1
fi
echo "release-bootstrap：通过"
