#!/usr/bin/env bash
# 发版车的发版入口（#1294）。release-train-lib.mjs 把本文件整段 ssh 到法国，
# 用 `bash -c <本文件> fleet-release-boot <提交号>` 跑（$1 是提交号）。
# 法国部署检出 /srv/fleet-dao 上的 release.sh 经常还是上一版。本文件不跑它：
# 先把目标提交收进裸仓（和 deploy/release.sh 同一个 /srv/fleet-dao-releases/.repo.git），
# 再把那一版的 deploy/ 解开，exec 它自带的 release.sh。改了 release.sh 的提交，
# 发版车这一次就用那一版——技能随开会话同步到本机，不靠法国检出先更新。
# 没有 deploy/release.sh、对象读不出、不是普通文件、解不开：退出 1，不改跑检出里那份。
# 互斥、历史、排空、读回都在被 exec 的那份里，这里不另做。--check、--rollback 不走这里。
# FLEET_RELEASES_DIR 可换（测试）。对象已经在裸仓里就不再 fetch。
set -euo pipefail
umask 022
export GIT_TERMINAL_PROMPT=0

# 同 deploy/release.sh 的 REPO_URL。法国期望里的会话代理是空，这里直连；取不到就拒发。
REPO_URL=https://github.com/thoerwink8/fleet-dao.git
releases=${FLEET_RELEASES_DIR:-/srv/fleet-dao-releases}
cache=$releases/.repo.git
dest=$releases/.bootstrap-entry
errf=$releases/.bootstrap-err

refuse() {
  printf '%s\n' "$*" >&2
  exit 1
}

if [[ $# -ne 1 || ! $1 =~ ^[0-9a-f]{7,40}$ ]]; then
  refuse "目标提交认不出：拒发，不改跑检出里的 release.sh"
fi
sha=$1

install -d -m 755 -- "$releases"
if [[ -d $cache ]]; then
  if [[ ! -f $cache/HEAD && ! -d $cache/.git ]]; then
    refuse "裸仓 $cache 不是 git 仓库：拒发，不改跑检出里的 release.sh"
  fi
else
  git init -q --bare "$cache"
  git -C "$cache" remote add origin "$REPO_URL"
fi
if ! git -C "$cache" remote get-url origin >/dev/null 2>&1; then
  git -C "$cache" remote add origin "$REPO_URL"
fi

git_at() { # 限时的 git。timeout 不在就直接跑（测试机可能没有）
  if command -v timeout >/dev/null 2>&1; then
    timeout 300 git -C "$cache" "$@"
  else
    git -C "$cache" "$@"
  fi
}

: >"$errf"
if ! git -C "$cache" cat-file -e "${sha}^{commit}" 2>"$errf"; then
  if ! git_at fetch -q --prune origin '+refs/heads/main:refs/remotes/origin/main' 2>"$errf"; then
    why=$(tr '\n' ' ' <"$errf")
    refuse "从 GitHub 取主线失败（${why:-没有输出}）：拒发，不改跑检出里的 release.sh"
  fi
  if ! git -C "$cache" cat-file -e "${sha}^{commit}" 2>"$errf"; then
    if ((${#sha} < 40)); then
      refuse "本地没有 ${sha}，短提交号没法向 GitHub 点名要：给完整的 40 位。拒发，不改跑检出里的 release.sh"
    fi
    if ! git_at fetch -q origin "$sha" 2>"$errf"; then
      why=$(tr '\n' ' ' <"$errf")
      refuse "向 GitHub 要不到提交 ${sha}（${why:-没有输出}）：拒发，不改跑检出里的 release.sh"
    fi
  fi
fi

if ! full=$(git -C "$cache" rev-parse --verify "${sha}^{commit}" 2>"$errf"); then
  why=$(tr '\n' ' ' <"$errf")
  refuse "目标提交 ${sha} 认不出（${why:-没有输出}）：拒发，不改跑检出里的 release.sh"
fi

if ! line=$(git -C "$cache" ls-tree "$full" deploy/release.sh 2>"$errf"); then
  why=$(tr '\n' ' ' <"$errf")
  refuse "目标提交 ${full:0:12} 的 deploy/release.sh 读不出（${why:-没有输出}）：拒发，不改跑检出里的 release.sh"
fi
if [[ -z $line ]]; then
  refuse "目标提交 ${full:0:12} 没有 deploy/release.sh：拒发，不改跑检出里的 release.sh"
fi
mode=${line%% *}
if [[ $mode != 100644 && $mode != 100755 ]]; then
  refuse "目标提交 ${full:0:12} 的 deploy/release.sh 不是普通文件（${mode}）：拒发，不改跑检出里的 release.sh"
fi
blob=$(awk '{ print $3 }' <<<"$line")
if [[ ! $blob =~ ^[0-9a-f]{40}$ ]] || ! git -C "$cache" cat-file -e "$blob" 2>"$errf"; then
  why=$(tr '\n' ' ' <"$errf")
  refuse "目标提交 ${full:0:12} 的 deploy/release.sh 读不出（${why:-对象不在}）：拒发，不改跑检出里的 release.sh"
fi

rm -rf -- "$dest"
install -d -m 755 -- "$dest"
if ! git -C "$cache" archive --format=tar "$full" deploy 2>"$errf" | tar -x -C "$dest" 2>>"$errf"; then
  why=$(tr '\n' ' ' <"$errf")
  refuse "目标提交 ${full:0:12} 的包解不开（${why:-没有输出}）：拒发，不改跑检出里的 release.sh"
fi
script=$dest/deploy/release.sh
if [[ -L $script || ! -f $script ]]; then
  refuse "目标提交 ${full:0:12} 解开之后没有普通文件 deploy/release.sh：拒发，不改跑检出里的 release.sh"
fi
if ! : <"$script"; then
  refuse "目标提交 ${full:0:12} 的 deploy/release.sh 读不出：拒发，不改跑检出里的 release.sh"
fi
printf '%s\n' "交给 ${full:0:12} 自带的 release.sh"
exec bash "$script" "$full" || refuse "交不到 ${full:0:12} 自带的 release.sh：拒发，不改跑检出里的 release.sh"
