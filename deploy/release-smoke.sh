#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# CI 里照法国发版的样子装一版、看服务入口的模块都找得到（.github/workflows/ci.yml 的 lint 里跑）。
# 为什么：CI 自己的 pnpm install 被 pnpm 认成 CI（全局虚拟仓自动关、布局和法国不同），在那上面跑测试绿了，法国照样可能起不来
# （065445a4：法国的构建沙箱是 env -i，不算 CI，依赖链到家目录里，fleet-api 报 ERR_MODULE_NOT_FOUND）。
# 这里和 release.sh 的 build_release 同一套：git archive 出这一版的文件 → pin_release_workspace 固定工作区设置 →
# env -i 下带 RELEASE_PNPM_ENV 用 RELEASE_PNPM_INSTALL 装 →
# 用 RELEASE_PNPM_WEB_BUILD 构建驾驶舱前端（带预渲染探针，并核它出了声，#3491）→ links_inside 查符号链接没指到目录外 →
# 再模拟事后有人在发布目录里直接敲 pnpm install（不带 RELEASE_PNPM_ENV、另一个家目录，#2901）：不许 Recreating、链接不许越界 →
# packages/conventions/src/bin/release-smoke.ts 从 fleet-api、fleet-engine 的入口把每条 import 用 node 解析一遍（只解析、不执行）。
# 唯一不同：pnpm 仓库用 CI 缓存的那份（pnpm_config_store_dir），不从零下载；仓库在目录外不要紧，链到它的会被 links_inside 拦下。
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
if ! pin_release_workspace "$REL"; then
  echo "没过：固定 pnpm 工作区设置失败（$PIN_WORKSPACE_WHY）：发版会在这一步停下、不切版本" >&2
  exit 1
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
# env -i：和法国构建沙箱一样，不带 CI、GITHUB_ACTIONS 这类变量，pnpm 不会把自己当成在 CI 里；RELEASE_PNPM_ENV 和法国沙箱带的一样。
# 仓库位置也用环境变量给（不是只给 install 的命令行开关）：之后的 pnpm run 见设置不一样会重装一遍，那就不是在验法国的样子了
run_pnpm() { # 日志 参数…
  local log=$1
  shift
  (cd -- "$REL" && env -i HOME="$TMP/home" PATH="$(dirname -- "$pnpm_bin"):$(dirname -- "$node_bin"):/usr/bin:/bin" \
    LANG=C.UTF-8 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${RELEASE_PNPM_ENV[@]}" "${BUILD_EXTRA_ENV[@]}" "pnpm_config_store_dir=$store" \
    "$pnpm_bin" "$@" >"$log" 2>&1)
}
echo "照法国装依赖：env -i ${RELEASE_PNPM_ENV[*]} pnpm ${RELEASE_PNPM_INSTALL[*]}（仓库 $store）"
if ! run_pnpm "$TMP/install.log" "${RELEASE_PNPM_INSTALL[@]}"; then
  grep -av '^Progress: ' "$TMP/install.log" | tail -40 >&2
  echo "没过：照法国的参数 pnpm install 失败" >&2
  exit 1
fi
echo "照法国构建前端：pnpm ${RELEASE_PNPM_WEB_BUILD[*]}（带预渲染探针 $RELEASE_WEB_TRACE）"
web_build_extra_env "$REL"
run_pnpm "$TMP/web.log" "${RELEASE_PNPM_WEB_BUILD[@]}"
web_rc=$?
BUILD_EXTRA_ENV=()
if ((web_rc != 0)); then
  grep -av '^Progress: ' "$TMP/web.log" | tail -60 >&2
  echo "没过：照法国的样子构建驾驶舱前端失败（发版会在这一步停下、不切版本）：$(web_build_why "$TMP/web.log")" >&2
  exit 1
fi
# 探针要真出声（发往本机的预渲染请求拿到了响应头）：构建换了框架版本、探针失灵了，在这里红，不等到法国上预渲染超时才发现没有线索（#3491）
if ! grep -aq '^\[prerender-trace\] #1 响应头 200 ' "$TMP/web.log"; then
  grep -a '^\[prerender-trace\]' "$TMP/web.log" >&2
  echo "没过：前端构建带着预渲染探针，却没看到预渲染请求拿到 200 响应头的那一行（探针失灵，或预渲染不再经 node:http 发请求）" >&2
  exit 1
fi
# 服务端那一头和「期间」那行也要出声（#3491）：超时时靠它们分清卡在收请求、载入服务端产物还是渲染；预览服务换了写法看不到，在这里红
for want in '#1 服务端收到 GET / ' '#1 服务端发完响应 200 ' '#1 期间：'; do
  if ! grep -aqF "[prerender-trace] $want" "$TMP/web.log"; then
    grep -a '^\[prerender-trace\]' "$TMP/web.log" >&2
    echo "没过：前端构建带着预渲染探针，却没看到「$want」那一行（预览服务不再经 node:http 的 Server 收请求，或探针失灵）" >&2
    exit 1
  fi
done
if grep -aq 'Recreating ' "$TMP/web.log"; then
  grep -a 'Recreating ' "$TMP/web.log" >&2
  echo "没过：构建前 pnpm 把依赖重装了一遍（设置和装的时候不一致），法国上布局会变" >&2
  exit 1
fi
if [[ ! -f "$REL/packages/web/dist/client/index.html" ]]; then
  echo "没过：前端构建完没有 packages/web/dist/client/index.html" >&2
  exit 1
fi
if ! links_inside "$REL"; then
  echo "没过：装完、构建完有符号链接指到这一版目录外（$LINKS_OUTSIDE_WHY）：法国服务看不到，会起不来" >&2
  exit 1
fi
echo "前端构建过了；符号链接都在这一版目录里"
# 发布目录里事后有人直接敲 pnpm（不带 RELEASE_PNPM_ENV，另一个家目录和仓库，如 root）：依赖不能被重装、链接不能指到目录外（#2901）。
# 出现 Recreating（pnpm 认为设置变了、要整棵重装）或符号链接越界都算没过
run_bare_pnpm() { # 日志 参数…
  local log=$1
  shift
  mkdir -p "$TMP/home-bare"
  (cd -- "$REL" && env -i HOME="$TMP/home-bare" PATH="$(dirname -- "$pnpm_bin"):$(dirname -- "$node_bin"):/usr/bin:/bin" \
    LANG=C.UTF-8 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "pnpm_config_store_dir=$store" "$pnpm_bin" "$@" >"$log" 2>&1)
}
echo "照事后有人直接敲 pnpm：不带 RELEASE_PNPM_ENV，pnpm install --frozen-lockfile"
if ! run_bare_pnpm "$TMP/bare.log" install --frozen-lockfile --reporter=append-only; then
  grep -av '^Progress: ' "$TMP/bare.log" | tail -40 >&2
  echo "没过：发布目录里不带设置直接 pnpm install 失败" >&2
  exit 1
fi
if grep -aq 'Recreating ' "$TMP/bare.log"; then
  grep -a 'Recreating ' "$TMP/bare.log" >&2
  echo "没过：发布目录里不带设置直接敲 pnpm，依赖被重装了一遍（pnpm-workspace.yaml 没固定住）" >&2
  exit 1
fi
if ! links_inside "$REL"; then
  echo "没过：不带设置直接敲 pnpm 之后有符号链接指到这一版目录外（$LINKS_OUTSIDE_WHY）" >&2
  exit 1
fi
echo "不带设置直接 pnpm install：没重装、链接都在这一版目录里"
# 解析器用 PR 检出里的那份（不在被查的目录里跑代码），解析的是 $REL 里的文件
(cd -- "$REL" && env -i HOME="$TMP/home" PATH="$(dirname -- "$node_bin"):/usr/bin:/bin" \
  "$node_bin" --experimental-import-meta-resolve "$REPO/packages/conventions/src/bin/release-smoke.ts" "$REL")
