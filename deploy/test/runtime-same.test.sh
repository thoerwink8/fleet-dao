#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # APP_UNITS、SHA、FLEET_SERVICES 这些是给 source 进来的 release.sh 读写的
# 发版切版本前比运行内容（deploy/lib/runtime-same.mjs）：只改 docs/*.md 不暂停、不重启引擎和后端；
# 改了 packages/engine/src 照常暂停并重启引擎（后端没变就不重启后端）；改了 packages/api/src 只重启后端；
# 判法读不出、比较脚本不在、启动时间读不出、单元对不上，都照常重启。
# 取代码、迁移把关、健康检查换成桩；切版本、排空、暂停用的是 release.sh 里的真代码。不连网、不起真单元。
# 用法：bash deploy/test/runtime-same.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd -- "$HERE/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e
mkdir -p "$RELEASES"

# release.sh 的 NODE 是法国的 /usr/bin/node。CI 的 deploy job 不装 pnpm 也不建 fleet 账号，node 只由 setup-node
# 放进工具链缓存（sudo 又会换掉 PATH），所以照 auto-release-state 那套挑一个能用的；挑不到就是没跑成，不当通过。
NODE=""
for n in "$(command -v node 2>/dev/null || true)" /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node /usr/local/bin/node; do
  if [[ -x "$n" ]]; then
    NODE=$n
    break
  fi
done
if [[ -z "$NODE" ]]; then
  echo "runtime-same：没跑成：这台找不到 node"
  exit 2
fi

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
said() { grep -cF -- "$1" "$TMP/out" || true; } # 这一轮输出里有几行带这些字
calls_of() { grep -cE -- "$1" "$SC" || true; } # systemctl 调用里有几行对得上

# ── 直接比两棵小目录（不经发版）──

unit_text=$'[Service]\nExecStart=/usr/bin/node\n'
seed_tree() { # 目录
  local d=$1
  rm -rf -- "$d"
  mkdir -p "$d/packages/engine/src" "$d/packages/api/src" "$d/.units" "$d/docs" "$d/packages/x/src"
  printf '%s\n' '{"name":"fleet-dao","private":true}' >"$d/package.json"
  printf '%s\n' 'lock: 1' >"$d/pnpm-lock.yaml"
  printf '%s\n' 'packages:' '  - packages/*' >"$d/pnpm-workspace.yaml"
  printf '%s\n' '{"name":"@fleet-dao/engine","type":"module"}' >"$d/packages/engine/package.json"
  printf '%s\n' '{"name":"@fleet-dao/api","type":"module"}' >"$d/packages/api/package.json"
  printf '%s\n' '{"name":"@fleet-dao/x","type":"module","exports":{".":{"import":"./src/esm.ts","require":"./src/cjs.cjs"}}}' >"$d/packages/x/package.json"
  printf '%s\n' 'export const esm = 1;' >"$d/packages/x/src/esm.ts"
  printf '%s\n' 'module.exports.cjs = 1;' >"$d/packages/x/src/cjs.cjs"
  printf '%s\n' 'export const engine = 1;' >"$d/packages/engine/src/main.ts"
  printf '%s\n' 'export const api = 1;' >"$d/packages/api/src/main.ts"
  printf '%s\n' '文档' >"$d/docs/note.md"
  printf '%s' "$unit_text" >"$d/.units/fleet-engine.service"
  printf '%s' "$unit_text" >"$d/.units/fleet-api.service"
}
verdict() { # 单元 旧 新
  "$NODE" "$RUNTIME_SAME_JS" "$1" "$2" "$3" 2>/dev/null | head -n 1
}

A=$TMP/tree-a
B=$TMP/tree-b
seed_tree "$A"
cp -a "$A" "$B"
echo "== 判法：哪些算运行内容"
check "两棵一样：引擎 same" "$(verdict fleet-engine "$A" "$B")" same
check "两棵一样：后端 same" "$(verdict fleet-api "$A" "$B")" same
printf '%s\n' '只改了文档' >"$B/docs/note.md"
mkdir -p "$B/docs/sub"
printf '%s\n' '又一份' >"$B/docs/sub/more.md"
check "只改 docs/*.md：引擎 same" "$(verdict fleet-engine "$A" "$B")" same
check "只改 docs/*.md：后端 same" "$(verdict fleet-api "$A" "$B")" same
printf '%s\n' 'export const engine = 2;' >"$B/packages/engine/src/extra.ts"
check "改了 packages/engine/src（没被 import 的文件也算）：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
check "改了引擎 src：后端仍然 same" "$(verdict fleet-api "$A" "$B")" same
rm -f -- "$B/packages/engine/src/extra.ts"
printf '%s\n' 'export const api = 2;' >"$B/packages/api/src/main.ts"
check "改了 packages/api/src：后端 changed" "$(verdict fleet-api "$A" "$B")" changed
check "改了后端 src：引擎仍然 same" "$(verdict fleet-engine "$A" "$B")" same
rm -f -- "$B/pnpm-lock.yaml"
check "缺依赖锁：引擎 unknown（认不出就当变了）" "$(verdict fleet-engine "$A" "$B" | awk '{print $1}')" unknown
printf '%s\n' 'console.log("nope")' >"$TMP/bad.mjs"
saved_js=$RUNTIME_SAME_JS
RUNTIME_SAME_JS=$TMP/bad.mjs
check "比较脚本打出来的不是 same/changed/unknown：当 unknown" "$(runtime_tree_verdict fleet-engine "$A" "$B")" "unknown 比较没跑成"
RUNTIME_SAME_JS=$saved_js

echo "== 判法：引用方式（import / require 两组入口都算）"
# 引擎里引了 @fleet-dao/x，那个包 import、require 各有一个入口：改哪一个都得算 changed，只认一组会漏成 same
seed_tree "$A"
seed_tree "$B"
printf '%s\n' "import x from '@fleet-dao/x';" 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' "import x from '@fleet-dao/x';" 'export const engine = 1;' >"$B/packages/engine/src/main.ts"
check "两组入口、两边都没改：引擎 same" "$(verdict fleet-engine "$A" "$B")" same
printf '%s\n' 'module.exports.cjs = 2;' >"$B/packages/x/src/cjs.cjs"
check "只改了 require 那个入口：引擎 changed（不能漏成 same）" "$(verdict fleet-engine "$A" "$B")" changed
printf '%s\n' 'module.exports.cjs = 1;' >"$B/packages/x/src/cjs.cjs"
printf '%s\n' 'export const esm = 2;' >"$B/packages/x/src/esm.ts"
check "只改了 import 那个入口：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
printf '%s\n' 'export const esm = 1;' >"$B/packages/x/src/esm.ts"
check "改回原样：引擎 same" "$(verdict fleet-engine "$A" "$B")" same
check "两组入口：后端没引它，仍然 same" "$(verdict fleet-api "$A" "$B")" same
# 只有 default 一项时，import 和 require 都加载它（Node 两组都认 default）——改了也得算 changed
printf '%s\n' '{"name":"@fleet-dao/x","type":"module","exports":{".":{"default":"./src/esm.ts"}}}' >"$A/packages/x/package.json"
printf '%s\n' '{"name":"@fleet-dao/x","type":"module","exports":{".":{"default":"./src/esm.ts"}}}' >"$B/packages/x/package.json"
printf '%s\n' 'export const esm = 2;' >"$B/packages/x/src/esm.ts"
check "只有 default 一项、改了它：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
# 认不出的条件表（两组都不认）：unknown，调用方照常重启
printf '%s\n' '{"name":"@fleet-dao/x","type":"module","exports":{".":{"browser":"./src/esm.ts"}}}' >"$A/packages/x/package.json"
printf '%s\n' '{"name":"@fleet-dao/x","type":"module","exports":{".":{"browser":"./src/esm.ts"}}}' >"$B/packages/x/package.json"
check "导出只有认不出的条件：引擎 unknown（照常重启）" "$(verdict fleet-engine "$A" "$B" | awk '{print $1}')" unknown
printf '%s\n' '{"name":"@fleet-dao/x","type":"module","exports":{".":{"import":"./src/esm.ts","require":"./src/cjs.cjs"}}}' >"$A/packages/x/package.json"
printf '%s\n' '{"name":"@fleet-dao/x","type":"module","exports":{".":{"import":"./src/esm.ts","require":"./src/cjs.cjs"}}}' >"$B/packages/x/package.json"
printf '%s\n' 'export const esm = 1;' >"$B/packages/x/src/esm.ts"
printf '%s\n' 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' 'export const engine = 1;' >"$B/packages/engine/src/main.ts"

echo "== 判法：from 和说明符之间的注释也算引用"
# export { x } from /* 注释 */ '@fleet-dao/x' 两版这行一样。漏掉这个引用时，只改被导出的源码会判成 same。
seed_tree "$A"
seed_tree "$B"
printf '%s\n' "export { x } from /* 注释 */ '@fleet-dao/x';" 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' "export { x } from /* 注释 */ '@fleet-dao/x';" 'export const engine = 1;' >"$B/packages/engine/src/main.ts"
check "from 后块注释、两边都没改：引擎 same" "$(verdict fleet-engine "$A" "$B")" same
printf '%s\n' '只改了文档' >"$B/docs/note.md"
check "from 后块注释、只改 docs/*.md：引擎 same" "$(verdict fleet-engine "$A" "$B")" same
printf '%s\n' '文档' >"$B/docs/note.md"
printf '%s\n' 'export const esm = 2;' >"$B/packages/x/src/esm.ts"
check "from 后块注释、只改被导出的源码：引擎 changed（不能漏成 same）" "$(verdict fleet-engine "$A" "$B")" changed
printf '%s\n' 'export const esm = 1;' >"$B/packages/x/src/esm.ts"
printf '%s\n' 'module.exports.cjs = 2;' >"$B/packages/x/src/cjs.cjs"
check "from 后块注释、只改 require 入口：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
printf '%s\n' 'module.exports.cjs = 1;' >"$B/packages/x/src/cjs.cjs"
printf '%s\n' 'export { x } from // 行注释' "  '@fleet-dao/x';" 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' 'export { x } from // 行注释' "  '@fleet-dao/x';" 'export const engine = 1;' >"$B/packages/engine/src/main.ts"
printf '%s\n' 'export const esm = 3;' >"$B/packages/x/src/esm.ts"
check "from 后行注释、只改被导出的源码：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
printf '%s\n' "export { x } from /* a */ /* b */ '@fleet-dao/x';" 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' "export { x } from /* a */ /* b */ '@fleet-dao/x';" 'export const engine = 1;' >"$B/packages/engine/src/main.ts"
printf '%s\n' 'export const esm = 4;' >"$B/packages/x/src/esm.ts"
check "from 后连续块注释、只改被导出的源码：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
# 注释正文里的假说明符不算引用；注释后面的真说明符算
printf '%s\n' "export { x } from /* '@fleet-dao/missing' */ '@fleet-dao/x';" 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' "export { x } from /* '@fleet-dao/missing' */ '@fleet-dao/x';" 'export const engine = 1;' >"$B/packages/engine/src/main.ts"
printf '%s\n' 'export const esm = 1;' >"$B/packages/x/src/esm.ts"
check "注释里的假说明符不当成引用：引擎 same" "$(verdict fleet-engine "$A" "$B")" same
printf '%s\n' 'export const esm = 5;' >"$B/packages/x/src/esm.ts"
check "注释后面的真说明符仍算：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
# 跳过注释之后说明符不是静态字面量：unknown，调用方照常重启
# shellcheck disable=SC2016 # 单引号里是给 node 的 JS，模板字符串不归 shell 展开
nonstatic='export { x } from /* 注释 */ `@fleet-dao/${name}`;'
printf '%s\n' "$nonstatic" 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' "$nonstatic" 'export const engine = 1;' >"$B/packages/engine/src/main.ts"
check "from 后注释再加非静态说明符：引擎 unknown（照常重启）" "$(verdict fleet-engine "$A" "$B" | awk '{print $1}')" unknown
# from 当普通标识符：注释后面不是说明符，不当成引用，也不因此 unknown
printf '%s\n' 'const from = 1;' 'from /* 注释 */ ;' 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' 'const from = 1;' 'from /* 注释 */ ;' 'export const engine = 1;' >"$B/packages/engine/src/main.ts"
check "from 是标识符、注释后不是说明符：引擎 same" "$(verdict fleet-engine "$A" "$B")" same
printf '%s\n' 'const from = /* 注释 */ "@fleet-dao/x";' 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' 'const from = /* 注释 */ "@fleet-dao/x";' 'export const engine = 1;' >"$B/packages/engine/src/main.ts"
printf '%s\n' 'export const esm = 6;' >"$B/packages/x/src/esm.ts"
check "赋值里的注释和字符串不是 import：引擎 same" "$(verdict fleet-engine "$A" "$B")" same
printf '%s\n' "import /* 注释 */ ('@fleet-dao/x');" 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' "import /* 注释 */ ('@fleet-dao/x');" 'export const engine = 1;' >"$B/packages/engine/src/main.ts"
printf '%s\n' 'export const esm = 7;' >"$B/packages/x/src/esm.ts"
check "import() 和括号之间有注释、只改被导出的源码：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
printf '%s\n' "import(/* 注释 */ '@fleet-dao/x');" 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' "import(/* 注释 */ '@fleet-dao/x');" 'export const engine = 1;' >"$B/packages/engine/src/main.ts"
printf '%s\n' 'export const esm = 8;' >"$B/packages/x/src/esm.ts"
check "import() 括号里注释后再写说明符、只改被导出的源码：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
printf '%s\n' "const x = require /* 注释 */ ('@fleet-dao/x');" 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' "const x = require /* 注释 */ ('@fleet-dao/x');" 'export const engine = 1;' >"$B/packages/engine/src/main.ts"
printf '%s\n' 'export const esm = 1;' >"$B/packages/x/src/esm.ts"
printf '%s\n' 'module.exports.cjs = 9;' >"$B/packages/x/src/cjs.cjs"
check "require() 和括号之间有注释、只改 require 入口：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
printf '%s\n' "const x = require /* 注释 */ . /* 注释 */ resolve /* 注释 */ ('@fleet-dao/x');" 'export const engine = 1;' \
  >"$A/packages/engine/src/main.ts"
printf '%s\n' "const x = require /* 注释 */ . /* 注释 */ resolve /* 注释 */ ('@fleet-dao/x');" 'export const engine = 1;' \
  >"$B/packages/engine/src/main.ts"
printf '%s\n' 'module.exports.cjs = 10;' >"$B/packages/x/src/cjs.cjs"
check "require.resolve 各段之间有注释、只改 require 入口：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
printf '%s\n' "import { createRequire } from 'node:module';" \
  "const x = createRequire /* 注释 */ (import.meta.url) /* 注释 */ .resolve /* 注释 */ ('@fleet-dao/x');" \
  'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' "import { createRequire } from 'node:module';" \
  "const x = createRequire /* 注释 */ (import.meta.url) /* 注释 */ .resolve /* 注释 */ ('@fleet-dao/x');" \
  'export const engine = 1;' >"$B/packages/engine/src/main.ts"
printf '%s\n' 'module.exports.cjs = 11;' >"$B/packages/x/src/cjs.cjs"
check "createRequire().resolve 各段之间有注释、只改 require 入口：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
# new URL 的路径在包里、不在引擎 src 下：注释隔开时也得算进运行内容。两组入口都先改回一样，免得 cjs 的差异混进来。
printf '%s\n' "import x from '@fleet-dao/x';" 'export const engine = 1;' >"$A/packages/engine/src/main.ts"
printf '%s\n' "import x from '@fleet-dao/x';" 'export const engine = 1;' >"$B/packages/engine/src/main.ts"
printf '%s\n' 'module.exports.cjs = 1;' >"$A/packages/x/src/cjs.cjs"
printf '%s\n' 'module.exports.cjs = 1;' >"$B/packages/x/src/cjs.cjs"
printf '%s\n' 'export const esm = 1;' "const u = new /* 注释 */ URL(/* 注释 */ './data.json', /* 注释 */ import.meta.url);" \
  >"$A/packages/x/src/esm.ts"
printf '%s\n' 'export const esm = 1;' "const u = new /* 注释 */ URL(/* 注释 */ './data.json', /* 注释 */ import.meta.url);" \
  >"$B/packages/x/src/esm.ts"
printf '%s\n' 'v1' >"$A/packages/x/src/data.json"
printf '%s\n' 'v1' >"$B/packages/x/src/data.json"
check "new URL 各段之间有注释、数据文件一样：引擎 same" "$(verdict fleet-engine "$A" "$B")" same
printf '%s\n' 'v2' >"$B/packages/x/src/data.json"
check "new URL 各段之间有注释、只改数据文件：引擎 changed" "$(verdict fleet-engine "$A" "$B")" changed
printf '%s\n' 'export const esm = 1;' >"$A/packages/x/src/esm.ts"
printf '%s\n' 'export const esm = 1;' >"$B/packages/x/src/esm.ts"
rm -f -- "$A/packages/x/src/data.json" "$B/packages/x/src/data.json"

echo "== 判法：真仓（引擎真会加载的那棵树）"
REAL_A=$TMP/real-a
REAL_B=$TMP/real-b
if ! rsync -a --exclude .git --exclude node_modules "$ROOT/" "$REAL_A/"; then
  echo "  ✗ 没跑成：复制真仓失败"
  fail=1
else
  rsync -a --exclude .git --exclude node_modules "$ROOT/" "$REAL_B/"
  mkdir -p "$REAL_A/.units" "$REAL_B/.units"
  for u in fleet-engine fleet-api; do
    cp "$ROOT/deploy/france/$u.service" "$REAL_A/.units/$u.service"
    cp "$ROOT/deploy/france/$u.service" "$REAL_B/.units/$u.service"
  done
  if [[ -f "$ROOT/deploy/france/fleet-api.socket" ]]; then
    cp "$ROOT/deploy/france/fleet-api.socket" "$REAL_A/.units/fleet-api.socket"
    cp "$ROOT/deploy/france/fleet-api.socket" "$REAL_B/.units/fleet-api.socket"
  fi
  check "真仓对自己：引擎 same" "$(verdict fleet-engine "$REAL_A" "$REAL_B")" same
  printf '\n只加了一行文档\n' >>"$REAL_B/docs/ops.md"
  check "真仓只改 docs/*.md：引擎 same" "$(verdict fleet-engine "$REAL_A" "$REAL_B")" same
  printf '\n// 运行内容变了\n' >>"$REAL_B/packages/engine/src/main.ts"
  check "真仓改了 packages/engine/src：引擎 changed" "$(verdict fleet-engine "$REAL_A" "$REAL_B")" changed
fi
rm -rf -- "$REAL_A" "$REAL_B" "$A" "$B"

# ── 发版：没变不暂停不重启，变了或读不出照旧 ──

APP_UNITS=() # 不把单元写进 systemd（put_file 要 root）。装没装对得上，由下面放进 FLEET_SYSTEMD_DIR 的文件决定
FLEET_SERVICES="fleet-engine fleet-api"
FLEET_HK_PARTS=""
KEEP=20
FLEET_SYSTEMD_DIR=$TMP/systemd
mkdir -p "$FLEET_SYSTEMD_DIR"
SC=$TMP/systemctl-calls
API_CALLS=$TMP/api-calls
ENG=$TMP/engine-state
ENGINE_STATE_DEFAULT=$ENG
ENGINE_ENV=$TMP/no-engine.env
SHOW_TS=1700000000
SHOW_ENV_FILES=""
ENG_ENGINE=active
ENG_API=active
RUN_DIR=""
DRAIN_POLL=0
: >"$SC"
: >"$API_CALLS"

# shellcheck disable=SC2317,SC2329 # 桩，由 do_release 间接调用
fetch_code() { SHA=$1; ON_MAIN=1; }
schema_allows() { return 0; }
health_gate() { return 0; }
api_report_before() { return 0; }
api_wait_up() { return 0; }
running_release() { printf '%s' "$RUN_DIR"; }
sleep() {
  if [[ -f "$ENG/drain.json" ]]; then
    "$NODE" -e '
      const fs = require("fs");
      const st = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      st.sessions = [];
      fs.writeFileSync(process.argv[1], JSON.stringify(st) + "\n");
    ' "$ENG/drain.json"
  fi
}
systemctl() {
  printf '%s\n' "$*" >>"$SC"
  local cmd="" unit="" a
  for a in "$@"; do
    case "$a" in
    is-active | is-enabled | start | stop | restart | enable | disable | daemon-reload | show) cmd=$a ;;
    *.service | *.socket | *.timer) unit=$a ;;
    esac
  done
  case "$cmd" in
  is-active)
    if [[ "$unit" == fleet-engine.service ]]; then
      echo "$ENG_ENGINE"
      [[ "$ENG_ENGINE" == active ]]
      return
    fi
    if [[ "$unit" == fleet-api.service ]]; then
      echo "$ENG_API"
      [[ "$ENG_API" == active ]]
      return
    fi
    echo inactive
    return 1
    ;;
  is-enabled)
    echo enabled
    ;;
  show)
    if [[ "$*" == *ExecMainStartTimestamp* ]]; then
      printf '%s\n' "$SHOW_TS"
      return 0
    fi
    if [[ "$*" == *EnvironmentFiles* ]]; then
      printf '%s\n' "$SHOW_ENV_FILES"
      return 0
    fi
    if [[ "$*" == *MainPID* ]]; then
      if [[ "$unit" == fleet-engine.service && "$ENG_ENGINE" != active ]]; then echo 0; else echo "$$"; fi
      return 0
    fi
    if [[ "$*" == *NRestarts* ]]; then echo 0; return 0; fi
    return 0
    ;;
  stop)
    if [[ "$unit" == fleet-engine.service ]]; then ENG_ENGINE=inactive; fi
    if [[ "$unit" == fleet-api.service ]]; then ENG_API=inactive; fi
    ;;
  start | restart)
    if [[ "$unit" == fleet-engine.service ]]; then ENG_ENGINE=active; fi
    if [[ "$unit" == fleet-api.service ]]; then ENG_API=active; fi
    ;;
  *) ;;
  esac
}

OLD=$(printf 'a%.0s' {1..40})
DOC=$(printf 'b%.0s' {1..40})
ENGSRC=$(printf 'c%.0s' {1..40})
APISRC=$(printf 'd%.0s' {1..40})
NOLY=$(printf 'e%.0s' {1..40})
NOSCRIPT=$(printf 'f%.0s' {1..40})
NOTIME=$(printf '1%.0s' {1..40})
NOUNIT=$(printf '2%.0s' {1..40})
XSRC=$(printf '3%.0s' {1..40})

seed_release() { # 提交号
  local d=$RELEASES/$1
  seed_tree "$d"
  mkdir -p "$d/packages/api/bin"
  cat >"$d/packages/api/bin/fleet-api" <<FAKE
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$API_CALLS"
printf '%s\n' '{"schema":1,"by":"发版","reason":"x","pausedAt":"x","entries":[{"taskId":"t","repo":"o/r","issueNumber":1,"workflowId":"w","result":"paused","pausedOk":true}]}'
FAKE
  printf 'commit=%s\nbuilt=x\non_main=1\nweb=桩\nmigrations=0\n' "$1" >"$d/.fleet-release"
}
clone_release() { # 从 到
  rm -rf -- "${RELEASES:?}/$2"
  cp -a "$RELEASES/$1" "$RELEASES/$2"
  printf 'commit=%s\nbuilt=x\non_main=1\nweb=桩\nmigrations=0\n' "$2" >"$RELEASES/$2/.fleet-release"
}
write_drain() {
  mkdir -p "$ENG"
  "$NODE" -e '
    const fs = require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({
      schema: 2,
      pid: Number(process.argv[2]),
      writtenAt: "x",
      cordon: { source: "release", since: "x", until: "2026-10-15T00:00:00.000Z", why: "w" },
      overdue: false,
      sessions: [{ runId: "run-0-xxxxxxxx", stage: "execute", taskId: "t", phase: "running", since: "x" }],
    }) + "\n");
  ' "$ENG/drain.json" "$$"
}
release_to() { # 提交号
  : >"$SC"
  : >"$API_CALLS"
  rm -f -- "$DRAIN_REQUEST" "$PAUSE_FILE"
  write_drain
  ENG_ENGINE=active
  ENG_API=active
  RUN_DIR=$RELEASES/$OLD
  ln -sfn -- "$OLD" "$RELEASES/current"
  REDS=()
  CHANGES=()
  PENDING=()
  SKIP_RESTART=()
  DRAIN_WROTE=0
  ENGINE_STOPPED=0
  ENGINE_DRAINS=0
  do_release "$1" >"$TMP/out" 2>&1 || true
}

seed_release "$OLD"
# 在用的那一版就带「from 和说明符之间有注释」。只改文档时两版这行一样，仍然不该重启。
printf '%s\n' "export { x } from /* 注释 */ '@fleet-dao/x';" 'export const engine = 1;' \
  >"$RELEASES/$OLD/packages/engine/src/main.ts"
cp "$RELEASES/$OLD/.units/fleet-engine.service" "$FLEET_SYSTEMD_DIR/fleet-engine.service"
cp "$RELEASES/$OLD/.units/fleet-api.service" "$FLEET_SYSTEMD_DIR/fleet-api.service"

clone_release "$OLD" "$DOC"
printf '%s\n' '这一版只改了文档' >"$RELEASES/$DOC/docs/note.md"
printf '%s\n' '子目录里的文档' >"$RELEASES/$DOC/docs/extra.md"

echo "== 发版：只改 docs/*.md，不暂停、不重启"
release_to "$DOC"
check "切到只改文档的那一版" "$(current_sha)" "$DOC"
check "没有红" "${#REDS[@]}" 0
check "没停、没起引擎" "$(calls_of '^(stop|start|restart) fleet-engine\.service$')" 0
check "没停、没起后端" "$(calls_of '^(stop|start|restart) fleet-api\.service$')" 0
check "没给任务发暂停" "$(grep -c 'release pause' "$API_CALLS" || true)" 0
check "没写排空请求" "$([[ -e "$DRAIN_REQUEST" ]] && echo 有 || echo 没有)" 没有
check "日志写明引擎没重启" "$(said '引擎运行内容没变，没重启')" 1
check "日志写明后端没重启" "$(said '后端运行内容没变，没重启')" 1

clone_release "$OLD" "$ENGSRC"
printf '%s\n' 'export const touched = 1;' >"$RELEASES/$ENGSRC/packages/engine/src/touched.ts"
echo "== 发版：改了 packages/engine/src，引擎照常暂停并重启，后端不重启"
release_to "$ENGSRC"
check "切到改了引擎的那一版" "$(current_sha)" "$ENGSRC"
check "没有红" "${#REDS[@]}" 0
check "引擎停过再起来" "$(calls_of '^stop fleet-engine\.service$'):$(calls_of '^(start|restart) fleet-engine\.service$')" "1:1"
check "后端没重启" "$(calls_of '^(stop|start|restart) fleet-api\.service$')" 0
check "给手上有会话的任务发了暂停" "$(grep -c 'release pause' "$API_CALLS" || true)" 1
check "没有说引擎没重启" "$(said '引擎运行内容没变，没重启')" 0
check "日志写明后端没重启" "$(said '后端运行内容没变，没重启')" 1

clone_release "$OLD" "$XSRC"
printf '%s\n' 'export const esm = 2;' >"$RELEASES/$XSRC/packages/x/src/esm.ts"
echo "== 发版：from 后有注释，只改被引用包的源码，引擎照常暂停并重启"
release_to "$XSRC"
check "切到改了被引用包的那一版" "$(current_sha)" "$XSRC"
check "没有红" "${#REDS[@]}" 0
check "引擎停过再起来" "$(calls_of '^stop fleet-engine\.service$'):$(calls_of '^(start|restart) fleet-engine\.service$')" "1:1"
check "给手上有会话的任务发了暂停" "$(grep -c 'release pause' "$API_CALLS" || true)" 1
check "后端没重启" "$(calls_of '^(stop|start|restart) fleet-api\.service$')" 0
check "没有说引擎没重启" "$(said '引擎运行内容没变，没重启')" 0
check "日志写明后端没重启" "$(said '后端运行内容没变，没重启')" 1

clone_release "$OLD" "$APISRC"
printf '%s\n' 'export const api = 2;' >"$RELEASES/$APISRC/packages/api/src/main.ts"
echo "== 发版：改了 packages/api/src，只重启后端，引擎不暂停"
release_to "$APISRC"
check "切到改了后端的那一版" "$(current_sha)" "$APISRC"
check "没有红" "${#REDS[@]}" 0
check "引擎没停" "$(calls_of '^(stop|start|restart) fleet-engine\.service$')" 0
check "没发暂停" "$(grep -c 'release pause' "$API_CALLS" || true)" 0
check "后端重启了" "$(calls_of '^restart fleet-api\.service$')" 1
check "日志写明引擎没重启" "$(said '引擎运行内容没变，没重启')" 1
check "没有说后端没重启" "$(said '后端运行内容没变，没重启')" 0

clone_release "$OLD" "$NOLY"
rm -f -- "$RELEASES/$NOLY/pnpm-lock.yaml"
echo "== 发版：依赖锁读不出，照常重启引擎"
release_to "$NOLY"
check "切到读不出的那一版" "$(current_sha)" "$NOLY"
check "引擎停过" "$(calls_of '^stop fleet-engine\.service$')" 1
check "日志写明读不出、照常重启" "$(said 'fleet-engine 的运行内容读不出')" 1
check "没有说引擎没重启" "$(said '引擎运行内容没变，没重启')" 0

clone_release "$OLD" "$NOSCRIPT"
saved_js=$RUNTIME_SAME_JS
RUNTIME_SAME_JS=$TMP/no-such-runtime-same.mjs
echo "== 发版：比较脚本不在，照常重启"
release_to "$NOSCRIPT"
check "引擎停过" "$(calls_of '^stop fleet-engine\.service$')" 1
check "日志写明没有比较脚本" "$(said 'fleet-engine 的运行内容读不出（没有 runtime-same.mjs）')" 1
RUNTIME_SAME_JS=$saved_js

clone_release "$OLD" "$NOTIME"
printf '%s\n' '文档又改了' >"$RELEASES/$NOTIME/docs/note.md"
SHOW_TS=""
echo "== 发版：启动时间读不出，内容没变也照常重启"
release_to "$NOTIME"
check "引擎停过" "$(calls_of '^stop fleet-engine\.service$')" 1
check "日志写明单元或环境对不上" "$(said 'fleet-engine 的运行内容没变，但单元或环境对不上')" 1
check "没有说引擎没重启" "$(said '引擎运行内容没变，没重启')" 0
SHOW_TS=1700000000

clone_release "$OLD" "$NOUNIT"
printf '%s\n' '还是文档' >"$RELEASES/$NOUNIT/docs/note.md"
printf '%s\n' 'Description=变了' >>"$RELEASES/$NOUNIT/.units/fleet-engine.service"
echo "== 发版：单元对不上，内容没变也照常重启"
release_to "$NOUNIT"
check "引擎停过" "$(calls_of '^stop fleet-engine\.service$')" 1
check "没有说引擎没重启" "$(said '引擎运行内容没变，没重启')" 0

# 环境文件好几份打在一行：只看第一份会把后面改过的漏掉
echo "== 环境文件：一行里的每一份都算"
ENV_OLD=$TMP/env-old
ENV_NEW=$TMP/env-new
printf '%s\n' old >"$ENV_OLD"
printf '%s\n' new >"$ENV_NEW"
touch -d @1000 "$ENV_OLD"
touch -d @2000 "$ENV_NEW"
SHOW_TS=1500
SHOW_ENV_FILES="$ENV_OLD (ignore_errors=no) $ENV_NEW (ignore_errors=yes)"
if env_stable_since_start fleet-api.service; then stable=稳; else stable=不稳; fi
check "第三份环境文件比启动新：不当成没变" "$stable" 不稳
if env_changed_since_start fleet-api.service; then changed_env=变了; else changed_env=没变; fi
check "第三份环境文件比启动新：env_changed_since_start 认得出" "$changed_env" 变了
SHOW_ENV_FILES="$ENV_OLD (ignore_errors=no)"
if env_stable_since_start fleet-api.service; then stable=稳; else stable=不稳; fi
check "环境文件都比启动旧：当成没变" "$stable" 稳
SHOW_ENV_FILES="$TMP/env-gone.env (ignore_errors=yes)"
if env_stable_since_start fleet-api.service; then stable=稳; else stable=不稳; fi
check "单元列的环境文件已经不在了（可选文件被删掉）：不当成没变" "$stable" 不稳
if env_changed_since_start fleet-api.service; then changed_env=变了; else changed_env=没变; fi
check "环境文件不在了：env_changed_since_start 认得出" "$changed_env" 变了
SHOW_ENV_FILES=""
SHOW_TS=""
if env_stable_since_start fleet-api.service; then stable=稳; else stable=不稳; fi
check "启动时间是空的：不当成没变" "$stable" 不稳
SHOW_TS=1700000000
SHOW_ENV_FILES=""

echo "== 环境文件有一段认不出：不当成没变"
SHOW_ENV_FILES="/no/such.env (ignore_errors=no) not-a-path"
if env_stable_since_start fleet-api.service; then stable=稳; else stable=不稳; fi
check "环境文件列表认不出：不当成没变" "$stable" 不稳
SHOW_ENV_FILES=""

echo "== 退回：排空请求的 by 仍是 rollback（中间隔着 maybe_drain_engine）"
rm -f -- "$DRAIN_REQUEST"
ENG_ENGINE=active
RUN_DIR=$RELEASES/$OLD
(
  do_rollback() { drain_request "$DOC" 0; }
  do_rollback
)
by=$("$NODE" -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(r.by))' "$DRAIN_REQUEST" 2>/dev/null || true)
check "退回的排空请求记 rollback" "$by" rollback
rm -f -- "$DRAIN_REQUEST"
DRAIN_WROTE=0

if ((fail)); then
  echo "runtime-same：不通过"
  echo "---- 最后一轮输出 ----"
  cat "$TMP/out" 2>/dev/null || true
  exit 1
fi
echo "runtime-same：通过"
