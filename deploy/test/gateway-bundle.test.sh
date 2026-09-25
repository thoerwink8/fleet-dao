#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 飞书网关打成一个文件（deploy/france/bundle-gateway.sh）：打得出来、冒烟过（不给配置跑，停在读配置那一步）；
# 静态 import 只剩 node 自带的模块；同一份代码打两遍一字不差（香港按提交号认版本，同一个提交号换了内容就不收）；
# 冒烟判不过的样本真拦得住——包括「漏打进来的包在仓库里找得到、香港上找不到」那种。
# 不连网：冒烟只跑到读配置。要仓库里装好依赖（pnpm install）和 node，没有就记「没跑成」、退出 2。
# 用法：bash deploy/test/gateway-bundle.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd -- "$HERE/../.." && pwd)
BUNDLE=$REPO/deploy/france/bundle-gateway.sh
NODE=$(command -v node) || NODE=""
if [[ ! -x "$REPO/node_modules/.bin/esbuild" || -z "$NODE" ]]; then
  echo "gateway-bundle：没跑成：仓库里没装依赖（node_modules/.bin/esbuild）或这台没有 node，先 pnpm install"
  exit 2
fi
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
# shellcheck source=../france/bundle-gateway.sh
source "$BUNDLE"
set +e

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

# 文件里要到 node_modules 里找的静态 import（node 自带的模块不算）；一个一行。故意不借打包脚本的东西，自己读文件判
outside_imports() { # 文件
  "$NODE" -e '
    const { readFileSync } = require("node:fs");
    const { isBuiltin } = require("node:module");
    const src = readFileSync(process.argv[1], "utf8");
    const found = new Set();
    for (const m of src.matchAll(/^\s*import\s(?:[^;]*?\sfrom\s*)?["\x27]([^"\x27]+)["\x27]/gm)) {
      if (!isBuiltin(m[1])) found.add(m[1]);
    }
    process.stdout.write([...found].sort().join("\n"));
  ' "$1"
}

echo "== 打得出来、冒烟过；import 只剩 node 自带的；打两遍一字不差"
bash "$BUNDLE" "$REPO" "$TMP/one/gateway.mjs" >"$TMP/log" 2>&1
check "打成了（含冒烟）" "$?" 0
if [[ -f "$TMP/one/gateway.mjs" ]]; then
  size=$(stat -c %s "$TMP/one/gateway.mjs")
  check "是一个像样的文件（大于 1 MB：飞书 SDK 连同依赖都在里面）" "$((size > 1024 * 1024))" 1
  check "没有要到 node_modules 里找的 import" "$(outside_imports "$TMP/one/gateway.mjs")" ""
  bash "$BUNDLE" "$REPO" "$TMP/two/gateway.mjs" >>"$TMP/log" 2>&1
  check "再打一遍：一字不差" "$(sha256sum <"$TMP/two/gateway.mjs" | cut -c1-64)" \
    "$(sha256sum <"$TMP/one/gateway.mjs" | cut -c1-64)"
else
  echo "  ✗ 没打出文件：$(tail -5 "$TMP/log")"
  fail=1
fi
bash "$BUNDLE" "$REPO" relative/gateway.mjs >/dev/null 2>&1
check "输出文件不是绝对路径：不打" "$?" 1

echo "== 查 import 的那段自己也要拦得住：夹带一个第三方包的样本"
printf 'import { createRequire } from "node:module";\nimport fs from "fs";\nimport "fake-dep";\nimport x from "left-pad";\n' \
  >"$TMP/imports.mjs"
check "认出第三方包、放过 node 自带的" "$(outside_imports "$TMP/imports.mjs" | tr '\n' ' ')" "fake-dep left-pad"

echo "== 冒烟：漏打进来的包在旁边的 node_modules 里找得到（像在仓库里跑），香港上找不到——要判没过"
mkdir -p "$TMP/proj/node_modules/fake-dep"
printf '{"name":"fake-dep","version":"1.0.0","main":"index.js"}\n' >"$TMP/proj/node_modules/fake-dep/package.json"
printf 'module.exports = 1;\n' >"$TMP/proj/node_modules/fake-dep/index.js"
printf 'import "fake-dep";\nconsole.error("配置有问题：样本");\nprocess.exit(1);\n' >"$TMP/proj/gateway.mjs"
out=$(cd "$TMP/proj" && "$NODE" gateway.mjs 2>&1)
rc=$?
if [[ "$out" == *配置有问题* ]]; then said=是; else said=否; fi
check "样本在原地跑：找得到那个包、停在「配置有问题」（原地冒烟会被它骗过）" "$rc:$said" "1:是"
smoke "$TMP/proj/gateway.mjs" "$NODE" 2>"$TMP/log"
check "冒烟（拷到外头跑）：没过" "$?" 1
check "说了是冒烟没过" "$(grep -c '冒烟没过' "$TMP/log")" 1

echo "== 冒烟：跑完退出 0、什么都没说（没走到读配置），或退出 1 却不是停在读配置，都判没过"
printf '#!/bin/sh\nexit 0\n' >"$TMP/fake-node"
chmod +x "$TMP/fake-node"
smoke "$TMP/proj/gateway.mjs" "$TMP/fake-node" 2>/dev/null
check "退出 0：没过" "$?" 1
printf '#!/bin/sh\necho "SyntaxError: Unexpected token" >&2\nexit 1\n' >"$TMP/fake-node"
smoke "$TMP/proj/gateway.mjs" "$TMP/fake-node" 2>/dev/null
check "退出 1 但不是停在读配置：没过" "$?" 1

if ((fail)); then
  echo "gateway-bundle：不通过"
  exit 1
fi
echo "gateway-bundle：通过"
