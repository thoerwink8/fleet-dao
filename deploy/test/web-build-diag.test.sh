#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # REDS、CHANGES、PENDING 是给 source 进来的 release.sh（common.sh）里的函数读写的
# shellcheck disable=SC2016 # 单引号里的反引号是期望的字面文字（pnpm 报错里的 `react-router build`），不该展开
# 发布时前端构建失败，发布日志怎么说（#3491）：
# - 红字取真正的报错行，不再把产物文件名（route-error-*.js 含 error）粘进去；
# - 失败和成功都带前后资源读数、构建用时、预渲染探针打的时间点；预渲染超时再多一句怎么对照；
# - 探针只在构建这一条命令上带（NODE_OPTIONS），带完清掉；这一版代码里没有探针文件就不带。
# 构建用的是 release.sh 里的真代码 build_web，只把构建沙箱换成原地跑的桩（桩把 pnpm 那一步换成「写好日志、返回指定退出码」）。
# 用法：bash deploy/test/web-build-diag.test.sh（不用 root）。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd -- "$HERE/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e # release.sh 开了 -e；这里自己判每一步
NODE=$(command -v node) || NODE=""

fail=0
skipped=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
reset() {
  REDS=()
  CHANGES=()
  PENDING=()
}
has() { # 说明 内容 子串
  if [[ "$2" == *"$3"* ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：没找到「%s」，内容：%s\n' "$1" "$3" "${2:0:300}"
    fail=1
  fi
}
lacks() { # 说明 内容 子串
  if [[ "$2" != *"$3"* ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：不该出现「%s」，内容：%s\n' "$1" "$3" "${2:0:300}"
    fail=1
  fi
}

# 2026-10-21 法国发布日志里构建日志末尾的样子（#3491）：CSS 警告、产物文件行（文件名含 error）、预渲染超时的栈、pnpm 的收尾
incident_log() {
  cat <<'EOF'
Progress: resolved 404, reused 404, downloaded 0, added 404, done
    ::highlight(transcript-find-now) {
┆               ^-- 'highlight' is not recognized as a valid pseudo-element. Did you mean ':highlight' (pseudo-class) or is this a typo?
dist/client/assets/shown-error-B-QXWF5O.js                                   0.28 kB │ gzip:   0.21 kB
dist/client/assets/route-error-DqjtRn8o.js                                   1.72 kB │ gzip:   0.91 kB
✓ built in 2.84s
Error: Prerender: Request failed for /: The operation was aborted due to timeout
    at defaultHandleError (file:///srv/x/node_modules/@react-router/dev/dist/vite.js:893:8)
    at attempt (file:///srv/x/node_modules/@react-router/dev/dist/vite.js:841:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
/srv/x/packages/web:
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @fleet-dao/web@0.0.0 build: `react-router build`
Exit status 1
EOF
}

echo "== 红字取真正的报错行：产物文件名里的 error 不算（#3491）"
incident_log >"$TMP/incident.log"
why=$(web_build_why "$TMP/incident.log")
check "预渲染超时：红字是 Error 行加 pnpm 收尾行" "$why" \
  'Error: Prerender: Request failed for /: The operation was aborted due to timeout [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @fleet-dao/web@0.0.0 build: `react-router build` '
lacks "红字里没有产物文件名" "$why" "route-error"
lacks "红字里没有栈" "$why" "defaultHandleError"

printf '\033[31m[MISSING_EXPORT]\033[0m "x" is not exported by "y".\n   ╭─[ a.tsx:1:1 ]\n\033[31m✗\033[0m Build failed in 2.26s\n' >"$TMP/ansi.log"
check "带颜色码的 [CODE] 行：去掉颜色码再取" "$(web_build_why "$TMP/ansi.log")" '[MISSING_EXPORT] "x" is not exported by "y". '

printf 'Progress: resolved 1\nsome line\nanother line\nlast line\n' >"$TMP/plain.log"
check "一行报错都认不出：取最后 3 行，不含 Progress" "$(web_build_why "$TMP/plain.log")" 'some line another line last line '
check "日志读不到：明说读不到，不留空" "$(web_build_why "$TMP/nowhere.log")" '日志里读不到报错'

echo "== 资源读数：每一项都有值，读不到写「读不到」"
line=$(resource_line)
has "有核数、load、CPU 压力、内存压力、可用内存" "$line" "核，load "
has "CPU 压力一项" "$line" "，CPU 压力 "
has "内存压力一项" "$line" "，内存压力 "
has "可用内存一项" "$line" "，可用内存 "
lacks "没有空项" "$line" "，，"

echo "== build_web：失败和成功都带前后资源、用时、探针时间点；探针只在构建那条命令上带"
if [[ -z "$NODE" ]]; then
  echo "  … 没跑成：这台没有 node"
  skipped=1
else
  NEXT_RC=0     # 桩 pnpm 的退出码
  NEXT_LOG=""   # 桩 pnpm 写进构建日志的内容（函数名）
  SEEN_EXTRA="" # 桩 pnpm 被叫起来时看到的额外环境变量
  as_build_in() { # 目录 命令…：pnpm 换成桩，其余原地跑
    local dir=$1
    shift
    if [[ "$1" == pnpm ]]; then
      SEEN_EXTRA="${BUILD_EXTRA_ENV[*]:-}"
      "$NEXT_LOG"
      return "$NEXT_RC"
    fi
    (cd -- "$dir" && "$@")
  }
  trace_log() {
    cat <<'EOF'
[prerender-trace] #1 GET / 发出，进程已跑 3300ms
[prerender-trace] #1 连上 ::1（IPv6）+12ms
[prerender-trace] #1 响应头 200 +1500ms
[prerender-trace] #1 响应收完 +1501ms
[prerender-trace] 进程结束（只是读数，单看比例不能当根因）：墙钟 5000ms，自己用掉 CPU 4000ms，非自愿上下文切换 10 次，事件循环最长停 1100ms，最大内存 300MB，系统 load 1.00/1.00/1.00，16 核
EOF
  }
  fail_log() {
    incident_log
  }
  ok_log() {
    trace_log
    echo "✓ built in 2.84s"
  }
  new_stage() { # 目录名 [带探针]
    local s=$TMP/$1
    mkdir -p "$s/packages/web/dist/client" "$s/deploy/lib"
    printf '{"scripts":{"build":"react-router build"}}\n' >"$s/packages/web/package.json"
    cp -R -- "$REPO/deploy/web" "$s/deploy/web"
    mkdir -p "$s/deploy/hk"
    cp -- "$REPO/deploy/hk/placeholder.html" "$s/deploy/hk/placeholder.html"
    if [[ "${2:-}" == trace ]]; then cp -- "$REPO/deploy/lib/prerender-trace.mjs" "$s/deploy/lib/prerender-trace.mjs"; fi
    : >"$s/packages/web/dist/client/index.html"
    printf '%s' "$s"
  }

  reset
  stage=$(new_stage fail trace)
  NEXT_RC=1
  NEXT_LOG=fail_log
  SEEN_EXTRA=""
  : >"$TMP/fail.build.log"
  # 不放进 $(…)：REDS 要记在这个 shell 里
  build_web "$stage" "$TMP/fail.build.log" >"$TMP/fail.out" 2>&1
  rc=$?
  out=$(<"$TMP/fail.out")
  check "前端构建退出码非 0：build_web 返回 1" "$rc" 1
  check "只记一条红" "${#REDS[@]}" 1
  has "红字是预渲染超时那一行" "${REDS[0]:-}" "Error: Prerender: Request failed for /: The operation was aborted due to timeout"
  lacks "红字里没有产物文件名" "${REDS[0]:-}" "route-error"
  has "红字写明没切版本" "${REDS[0]:-}" "没切版本"
  has "构建前资源" "$out" "构建前资源："
  has "构建用时和退出码" "$out" "前端构建用了 "
  has "构建后资源" "$out" "构建后资源："
  has "没有探针行时明说探针没出声" "$out" "探针没出声"
  has "没出声不等于没发请求：说清探针看不到哪几种发法" "$out" "不能据此断定请求没发"
  has "预渲染超时：说明固定 10 秒、不重试、同进程" "$out" "固定 10 秒不回就报错、不重试"
  has "CPU 与墙钟的比例只当读数：要结合 PSI、事件循环、上下文切换" "$out" "不能单凭它断定 CPU 饥饿、被抢占或别的根因"
  has "写明要结合 PSI" "$out" "PSI（/proc/pressure）"
  has "说清服务端那几行怎么分两头" "$out" "「连接断了，响应还没发完」是服务端处理没做完就被掐断"
  has "说清期间那行看载入服务端产物、GC、事件循环" "$out" "动态 import（预览服务头一次载入服务端产物）还有没结束的"
  has "几行都没有时不猜" "$out" "不往任何一头猜"
  lacks "不再把比例直接解释成被抢占" "$out" "（被抢占）"
  has "构建日志末尾原样贴出" "$out" "构建日志末尾 60 行"
  has "带着探针：NODE_OPTIONS 预载这一版目录里的文件" "$SEEN_EXTRA" "NODE_OPTIONS=--import=$stage/deploy/lib/prerender-trace.mjs"
  check "构建命令跑完就清掉额外环境变量" "${#BUILD_EXTRA_ENV[@]}" 0

  reset
  stage=$(new_stage ok trace)
  NEXT_RC=0
  NEXT_LOG=ok_log
  : >"$TMP/ok.build.log"
  out=$(build_web "$stage" "$TMP/ok.build.log" 2>&1)
  check "成功：build_web 返回 0" "$?" 0
  has "成功也打探针行（留一份正常构建的对照）" "$out" "[prerender-trace] #1 响应头 200 +1500ms"
  has "成功也打构建前资源" "$out" "构建前资源："
  lacks "成功不贴「预渲染请求固定 10 秒」那句" "$out" "固定 10 秒不回就报错"
  lacks "成功不贴构建日志末尾" "$out" "构建日志末尾"

  reset
  stage=$(new_stage old)
  NEXT_RC=0
  NEXT_LOG=ok_log
  SEEN_EXTRA="x"
  : >"$TMP/old.build.log"
  build_web "$stage" "$TMP/old.build.log" >/dev/null 2>&1
  check "这一版代码里没有探针文件：什么额外环境变量都不带" "$SEEN_EXTRA" ""
fi

echo "== 探针文件自己：真装在 node 上能起（语法、导入都对）"
if [[ -z "$NODE" ]]; then
  echo "  … 没跑成：这台没有 node"
  skipped=1
else
  # 法国是 POSIX 绝对路径；这里转成 file: 地址，Windows 上的 node 才认
  trace_url=$("$NODE" -e 'process.stdout.write(require("node:url").pathToFileURL(process.argv[1]).href)' "$REPO/deploy/lib/prerender-trace.mjs")
  out=$("$NODE" --import="$trace_url" -e 'process.stdout.write("alive")' 2>&1)
  check "预载探针后 node 照常跑、没发本机请求就一个字都不多说" "$?:$out" "0:alive"
fi

if ((fail)); then
  echo "不通过"
  exit 1
fi
if ((skipped)); then
  echo "有没跑成的"
  exit 2
fi
echo "通过"
