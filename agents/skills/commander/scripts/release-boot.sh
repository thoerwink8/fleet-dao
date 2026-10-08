#!/usr/bin/env bash
# 发版车的发版入口（#1294）。release-train-lib.mjs 把本文件整段 ssh 到法国，
# 用 `bash -c <本文件> fleet-release-boot <提交号> [release.sh 的参数…]` 跑。
# 法国部署检出 /srv/fleet-dao 上的 release.sh 经常还是上一版，改了 release.sh 的 PR 要等下一版才生效。
# 本文件不跑它：把目标提交收进裸仓（和 deploy/release.sh 同一个 $releases/.repo.git），
# 把那一版的 deploy/ 解到按提交号命名的私有目录 $releases/.boot/<完整提交号>，exec 那一版自带的 release.sh，
# 参数原样带过去（完整提交号在最前，--now、--unmerged 照传）。
# 互斥不在这里另做：被 exec 的 release.sh 自己拿发布锁（$releases/.lock）、排空、迁移、读回，一样不少。
# 本文件拿不拿锁都不会让两次发版串版：每个提交只解到自己的目录，目录是整个解好再原子地挪进来的，
# 挪进来以后没人改它，所以 A 发 A 版，B 发 B 版，同时来也各跑各的；两个发布谁先谁后由 release.sh 的锁排。
# 没有 deploy/release.sh、对象读不出、不是普通文件、解不开、取不到提交：退出 1，不改跑检出里那份。
# --check、--rollback 不走这里。FLEET_RELEASES_DIR 可换（测试）。提交已经在裸仓里就不再 fetch。
set -euo pipefail
umask 022
export GIT_TERMINAL_PROMPT=0

# 同 deploy/release.sh 的 REPO_URL。法国期望里登记的会话代理是空，这里直连；取不到就拒发。
REPO_URL=https://github.com/thoerwink8/fleet-dao.git
releases=${FLEET_RELEASES_DIR:-/srv/fleet-dao-releases}
cache=$releases/.repo.git
boot=$releases/.boot

refuse() {
  printf '%s：拒发，不改跑检出里的 release.sh\n' "$*" >&2
  exit 1
}

if [[ $# -lt 1 || ! $1 =~ ^[0-9a-f]{7,40}$ ]]; then
  refuse "目标提交认不出"
fi
sha=$1
shift

install -d -m 755 -- "$releases" "$boot"
if [[ ! -d $cache ]]; then
  git init -q --bare "$cache"
  git -C "$cache" remote add origin "$REPO_URL"
fi

git_at() { # 限时的 git。timeout 不在就直接跑（测试机可能没有）
  if command -v timeout >/dev/null 2>&1; then
    timeout 300 git -C "$cache" "$@"
  else
    git -C "$cache" "$@"
  fi
}

err=$(mktemp)
tmp=""
trap 'rm -f -- "$err"; if [[ -n $tmp ]]; then rm -rf -- "$tmp"; fi' EXIT
why() { tr '\n' ' ' <"$err"; }

if ! git -C "$cache" cat-file -e "${sha}^{commit}" 2>"$err"; then
  git_at fetch -q --prune origin '+refs/heads/main:refs/remotes/origin/main' 2>"$err" ||
    refuse "从 GitHub 取主线失败（$(why)）"
  if ! git -C "$cache" cat-file -e "${sha}^{commit}" 2>"$err"; then
    if ((${#sha} < 40)); then refuse "本地没有 ${sha}，短提交号没法向 GitHub 点名要：给完整的 40 位"; fi
    git_at fetch -q origin "$sha" 2>"$err" || refuse "向 GitHub 要不到提交 ${sha}（$(why)）"
  fi
fi
full=$(git -C "$cache" rev-parse --verify "${sha}^{commit}" 2>"$err") || refuse "目标提交 ${sha} 认不出（$(why)）"

# deploy/release.sh 要在这个提交里、是普通文件（不是符号链接）、对象读得出
line=$(git -C "$cache" ls-tree "$full" deploy/release.sh 2>"$err") || refuse "目标提交 ${full:0:12} 的 deploy/release.sh 读不出（$(why)）"
if [[ -z $line ]]; then refuse "目标提交 ${full:0:12} 没有 deploy/release.sh"; fi
if [[ ${line%% *} != 100644 && ${line%% *} != 100755 ]]; then
  refuse "目标提交 ${full:0:12} 的 deploy/release.sh 不是普通文件（${line%% *}）"
fi

# 解到临时目录，检查完整个挪到 .boot/<完整提交号>。目录已经在（同一个提交在发、或上次留下的）就用它：
# 同一个提交解出来的东西一样，它是挪进来的，不会是半截。
dest=$boot/$full
if [[ ! -f $dest/deploy/release.sh ]]; then
  tmp=$(mktemp -d "$boot/.tmp.XXXXXX")
  chmod 755 -- "$tmp" # mktemp 建的是 700，挪进来以后要和别的目录一样（umask 022）
  if ! { git -C "$cache" archive --format=tar "$full" deploy | tar -x -C "$tmp"; } 2>"$err"; then
    refuse "目标提交 ${full:0:12} 的包解不开（$(why)）"
  fi
  if [[ -L $tmp/deploy/release.sh || ! -f $tmp/deploy/release.sh ]]; then
    refuse "目标提交 ${full:0:12} 解开之后没有普通文件 deploy/release.sh"
  fi
  mv -T -- "$tmp" "$dest" 2>"$err" || [[ -f $dest/deploy/release.sh ]] || refuse "解开的包放不进 $dest（$(why)）"
  rm -rf -- "$tmp"
  tmp=""
fi
script=$dest/deploy/release.sh
if [[ -L $script || ! -f $script ]] || ! : <"$script"; then
  refuse "目标提交 ${full:0:12} 的 $script 读不出"
fi

# 清掉两天前的旧目录（含上次没解完留下的临时目录）。发一次版用不了两天；这一版的目录不清
find "$boot" -mindepth 1 -maxdepth 1 -mtime +2 ! -name "$full" -exec rm -rf -- {} + 2>/dev/null || true

printf '%s\n' "交给 ${full:0:12} 自带的 release.sh"
rm -f -- "$err"
trap - EXIT
exec bash "$script" "$full" "$@" || refuse "交不到 ${full:0:12} 自带的 release.sh"
