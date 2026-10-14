#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# CI 里照法国发版的样子装一版、看服务入口的模块都找得到（.github/workflows/ci.yml 的 lint 里跑）。
# 为什么：CI 自己的 pnpm install 被 pnpm 认成 CI（全局虚拟仓自动关、布局和法国不同），在那上面跑测试绿了，法国照样可能起不来
# （065445a4：法国的构建沙箱是 env -i，不算 CI，依赖链到家目录里，fleet-api 报 ERR_MODULE_NOT_FOUND）。
# 这里和 release.sh 的 build_release 同一套：git archive 出这一版的文件 → env -i 下用 release.sh 的 RELEASE_PNPM_INSTALL 装 →
# links_inside 查符号链接没指到目录外 → packages/conventions/src/bin/release-smoke.ts 从 fleet-api、fleet-engine 的入口把
# 每条 import 用 node 解析一遍（只解析、不执行）。
# 唯一不同：pnpm 仓库用 CI 缓存的那份（--config.store-dir），不从零下载；仓库在目录外不要紧，链到它的会被 links_inside 拦下。
# 用法：bash deploy/release-smoke.sh [提交，默认 HEAD]。退出码：0 过；1 没过；2 没查成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd -- "$HERE/.." && pwd)
REV=${1:-HEAD}
TMP=$(mktemp -d) || exit 2
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
# shellcheck source=release.sh
source "$HERE/release.sh"
set +e

REL=$TMP/rel
mkdir -p "$REL" "$TMP/home"
if ! git -C "$REPO" archive --format=tar "$REV" | tar -x -f - -C "$REL"; then
  echo "没查成：git archive $REV 解不出来" >&2
  exit 2
fi
if ! store=$(cd -- "$REPO" && pnpm store path 2>/dev/null) || [[ -z "$store" ]]; then
  echo "没查成：读不出 pnpm store path" >&2
  exit 2
fi
pnpm_bin=$(command -v pnpm) || {
  echo "没查成：没有 pnpm" >&2
  exit 2
}
node_bin=$(command -v node) || {
  echo "没查成：没有 node" >&2
  exit 2
}
echo "照法国装依赖：env -i pnpm ${RELEASE_PNPM_INSTALL[*]}（仓库 $store）"
# env -i：和法国构建沙箱一样，不带 CI、GITHUB_ACTIONS 这类变量，pnpm 不会把自己当成在 CI 里
if ! (cd -- "$REL" && env -i HOME="$TMP/home" PATH="$(dirname -- "$pnpm_bin"):$(dirname -- "$node_bin"):/usr/bin:/bin" \
  "$pnpm_bin" "${RELEASE_PNPM_INSTALL[@]}" --config.store-dir="$store" >"$TMP/install.log" 2>&1); then
  tail -20 "$TMP/install.log" >&2
  echo "没过：照法国的参数 pnpm install 失败" >&2
  exit 1
fi
if ! links_inside "$REL"; then
  echo "没过：装完的依赖有符号链接指到这一版目录外（$LINKS_OUTSIDE_WHY）：法国服务看不到，会起不来" >&2
  exit 1
fi
echo "符号链接都在这一版目录里"
# 解析器用 PR 检出里的那份（不在被查的目录里跑代码），解析的是 $REL 里的文件
(cd -- "$REL" && env -i HOME="$TMP/home" PATH="$(dirname -- "$node_bin"):/usr/bin:/bin" \
  "$node_bin" --experimental-import-meta-resolve "$REPO/packages/conventions/src/bin/release-smoke.ts" "$REL")
