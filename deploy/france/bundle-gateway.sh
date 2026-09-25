#!/usr/bin/env bash
# 把飞书网关（packages/feishu）打成一个文件：香港上只放这一个 gateway.mjs 和固定版本的 node，不放仓库、不装依赖、不连 GitHub。
# 发布脚本（deploy/release.sh）在法国构建每一版时调它；deploy/test/gateway-bundle.test.sh 也用它（source 进去单测冒烟）。
#   bash deploy/france/bundle-gateway.sh <仓库根目录（依赖已装好）> <输出文件（绝对路径）>
# 打完当场冒烟，退出码：0 打好了，1 没打成或冒烟没过。
set -Eeuo pipefail

# 冒烟：不给任何配置跑一次，要停在读配置那一步、报「配置有问题」（退出 1）——说明整个文件的模块都加载得起来
# （打包漏了东西会在这之前就报别的错）。拷到仓库外头的临时目录里跑：香港上这个文件旁边、上面都没有 node_modules；
# 留在仓库里跑，漏打进来的包会从仓库的 node_modules 里找到，冒烟照样过
smoke() { # 文件 node
  local probe out rc
  probe=$(mktemp -d)
  cp -- "$1" "$probe/gateway.mjs"
  out=$(cd / && env -i PATH=/usr/bin:/bin "$2" "$probe/gateway.mjs" 2>&1) && rc=0 || rc=$?
  rm -rf -- "$probe"
  if [[ "$rc" != 1 || "$out" != *'配置有问题'* ]]; then
    echo "打出来的网关冒烟没过（不给配置跑，应停在读配置、退出 1；实际退出 $rc）：$(head -c 400 <<<"$out")" >&2
    return 1
  fi
}

bundle() { # 仓库根目录 输出文件 node
  local banner
  if [[ "$2" != /* ]]; then
    echo "输出文件要写绝对路径：$2" >&2
    return 1
  fi
  if [[ ! -x "$1/node_modules/.bin/esbuild" ]]; then
    echo "没有 $1/node_modules/.bin/esbuild：先 pnpm install" >&2
    return 1
  fi
  # ESM 打包里没有 require、__dirname：飞书 SDK 和它的依赖（axios、ws、protobufjs）有些是 CommonJS，要现成的这两样。
  # SDK 靠 __dirname 找自己的 package.json 读版本号（只用在请求头里），打包后找不到就记成 unknown，不影响收发。
  # ws 的 bufferutil、utf-8-validate 是可选的原生加速包，没装就用纯 JS，不打进来
  banner="import { createRequire as fleetDaoCreateRequire } from 'node:module';"
  banner+=" import { fileURLToPath as fleetDaoFileURLToPath } from 'node:url';"
  banner+=" import { dirname as fleetDaoDirname } from 'node:path';"
  banner+=" const require = fleetDaoCreateRequire(import.meta.url);"
  banner+=" const __filename = fleetDaoFileURLToPath(import.meta.url);"
  banner+=" const __dirname = fleetDaoDirname(__filename);"
  (cd -- "$1" && node_modules/.bin/esbuild packages/feishu/src/main.ts --bundle --platform=node --target=node22 \
    --format=esm --outfile="$2" --legal-comments=none --log-level=warning \
    --external:bufferutil --external:utf-8-validate "--banner:js=$banner") || return 1
  smoke "$2" "$3"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  bundle "${1:?用法：bundle-gateway.sh <仓库根目录> <输出文件>}" "${2:?用法：bundle-gateway.sh <仓库根目录> <输出文件>}" \
    "${FLEET_BUNDLE_NODE:-$(command -v node)}"
fi
