#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy/lib/session-pnpm.sh（AI 会话用的 pnpm）的判据，每条失败路径都故意造出来：
#   1. france.sh 顶部钉的 pnpm 版本和仓根 package.json 的 packageManager 一样，校验和是 npm integrity 的写法
#      （升 pnpm 漏改一处这里就红；这一段不要 root）
#   2. 装：核 sha512、核包名和版本，装出来的都归 root、别的身份改不动，入口关掉 node 的编译缓存；装完以别的身份跑得出版本；
#      第二遍不下载、一处不改；装着的文件被改、被删、钉的校验和换了就重装
#   3. 校验和对不上、下载失败、包名或版本不对、入口不在或越出包外、不是 tgz、版本和校验和的写法认不出：判红、返回 1，什么都不装
#   4. 引擎给会话的 PATH：照在跑的引擎进程读（FLEET_CLI_BIN 在就用它、去掉两头空白；不在就按启动命令里 main.ts 的真实路径
#      算 packages/cli/bin），主进程号不对、进程没了、读不到启动命令、启动命令认不出、入口解不出真实路径都明确失败，不拿空当 PATH
#   5. 按一条 PATH 跑 pnpm --version：找不到、跑不起来、卡住、不理叫停、输出认不出、先找到的不是装的那个、版本不对、
#      起命令那一步就没成、临时文件建不了，都判红或明确失败
# 不出网：pnpm 包是现造的（package.json 加一个打印版本号的入口），用 file:// 地址「下载」。
# 要 root（第 1 段除外）：装出来的要归 root，还得建临时用户、以他的身份跑。
# 用法：sudo bash deploy/test/session-pnpm.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$HERE/.." && pwd)
# shellcheck source=../lib/common.sh
source "$DEPLOY/lib/common.sh"
# shellcheck source=../lib/session-pnpm.sh
source "$DEPLOY/lib/session-pnpm.sh"

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
has() { # 说明 文本 要有的（grep -E）
  if grep -qE -- "$3" <<<"$2"; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：「%s」里没有「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
last_red() { if ((${#REDS[@]})); then printf '%s' "${REDS[-1]}"; fi; }

echo "== 1. france.sh 钉的 pnpm 和仓根 package.json 的一样"
if ! command -v node >/dev/null; then
  echo "session-pnpm：没跑成：这台没有 node"
  exit 2
fi
want=$(node -p 'require(process.argv[1]).packageManager' "$DEPLOY/../package.json" 2>/dev/null) || want=""
pinned=$(sed -n 's/^PNPM_VERSION=//p' "$DEPLOY/france.sh")
integrity=$(sed -n 's/^PNPM_INTEGRITY=//p' "$DEPLOY/france.sh")
check "仓根 package.json 的 packageManager 是 pnpm@<版本>" "$([[ "$want" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]] && echo 是)" 是
check "france.sh 的 PNPM_VERSION 就是这一版" "pnpm@$pinned" "$want"
check "france.sh 的 PNPM_INTEGRITY 是 npm integrity 的写法" "$([[ "$integrity" =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]] && echo 是)" 是

if ((EUID != 0)); then
  echo "session-pnpm：第 2 段起没跑成：要 root（装出来的要归 root，还得建临时用户、以他的身份跑）"
  if ((fail)); then exit 1; fi
  exit 2
fi

U=fleet-pnpm-test-$$
T=$(mktemp -d /var/tmp/session-pnpm-test.XXXXXX)
cleanup() {
  pkill -KILL -u "$U" >/dev/null 2>&1
  userdel "$U" >/dev/null 2>&1
  rm -rf -- "$T"
}
trap cleanup EXIT
chmod 755 "$T"
H=$T/home
if ! useradd --system --user-group --home-dir "$H" --create-home --shell /bin/bash "$U" >/dev/null 2>&1; then
  echo "session-pnpm：没跑成：建不了临时用户 $U"
  exit 2
fi
SESSION_PNPM_NODE=$(command -v node)
SESSION_PNPM_TIMEOUT=2
mkdir -p "$T/opt" "$T/bin"
chmod 755 "$T/opt" "$T/bin"

# 以临时用户、给定的 PATH 跑（照 fleet-agent-scope 的样子：环境清干净，只留 HOME、USER、PATH 这几样）
as_u() { # PATH 命令…
  local path=$1
  shift
  (cd -- "$H" && runuser -u "$U" -- env -i HOME="$H" USER="$U" LOGNAME="$U" PATH="$path" LANG=C.UTF-8 "$@")
}

# 造一个 pnpm 包打成 tgz：路径进 PKG，它的 npm integrity 进 PKG_INTEGRITY。入口正文不给就是「--version 打印这个版本」
n=0
PKG=""
PKG_INTEGRITY=""
make_pkg() { # 名字 版本 [bin.pnpm 写的入口] [bin/pnpm.mjs 的正文]
  local name=$1 ver=$2 entry=${3:-bin/pnpm.mjs} body=${4:-} src
  n=$((n + 1))
  src=$T/src-$n
  mkdir -p "$src/package/bin" "$src/package/dist"
  printf '{"name":"%s","version":"%s","bin":{"pnpm":"%s","pnpx":"bin/pnpx.mjs"}}\n' "$name" "$ver" "$entry" >"$src/package/package.json"
  if [[ -z "$body" ]]; then body="if (process.argv.includes('--version')) console.log('$ver'); else process.exit(2);"; fi
  printf '%s\n' "$body" >"$src/package/bin/pnpm.mjs"
  printf 'export const bundled = %d;\n' "$n" >"$src/package/dist/pnpm.mjs"
  PKG=$T/pkg-$n.tgz
  tar -czf "$PKG" -C "$src" package
  PKG_INTEGRITY="sha512-$(openssl dgst -sha512 -binary <"$PKG" | base64 -w0)"
}

echo "== 2. 装：核 sha512、核包名和版本，都归 root、别人改不动；第二遍不下载、不改；动过就重装"
make_pkg pnpm 11.1.2
GOOD=$PKG
GOOD_INT=$PKG_INTEGRITY
ROOT=$T/opt/pnpm
BIN=$T/bin/pnpm
install_good() { ensure_session_pnpm 11.1.2 "$GOOD_INT" "file://$GOOD" "$ROOT" "$BIN" as_u /usr/bin:/bin >/dev/null; }
CHANGES=() REDS=()
install_good
check "装成了（返回 0）" "$?" 0
check "没有红" "${#REDS[@]}" 0
has "记了一笔装的改动" "${CHANGES[*]}" '装 pnpm 11\.1\.2（sha512 已核对）'
check "装完以临时用户跑入口，报的是这一版" "$SESSION_PNPM_AT $SESSION_PNPM_HAVE" "$BIN 11.1.2"
check "装的都归 root" "$(find "$ROOT" "$BIN" ! -user root -printf '%p\n' | head -3)" ""
check "组和别人都写不了" "$(find "$ROOT" "$BIN" -perm /022 -printf '%p\n' | head -3)" ""
check "入口 root 755" "$(stat -c '%U:%G %a' "$BIN")" "root:root 755"
check "入口关掉 node 的编译缓存" "$(grep -cxF 'NODE_DISABLE_COMPILE_CACHE=1' "$BIN")" 1
check "入口用钉的 node 跑包里的入口" "$(grep -cxF "exec \"$SESSION_PNPM_NODE\" \"$ROOT/11.1.2/bin/pnpm.mjs\" \"\$@\"" "$BIN")" 1
# shellcheck disable=SC2016 # $1 要由临时用户的 sh 展开
check "临时用户改不了入口" "$(as_u /usr/bin:/bin sh -c 'echo x >>"$1"' sh "$BIN" 2>/dev/null && echo 改得了)" ""
check "临时用户往包里放不进东西" "$(as_u /usr/bin:/bin touch "$ROOT/11.1.2/bin/x" 2>/dev/null && echo 放得进)" ""
mv -- "$GOOD" "$GOOD.away"
CHANGES=() REDS=()
install_good
check "第二遍返回 0" "$?" 0
check "第二遍一处没改、没红（也没去下载：包已经挪走了）" "${#CHANGES[@]}:${#REDS[@]}" 0:0
mv -- "$GOOD.away" "$GOOD"
echo '// 被改过' >>"$ROOT/11.1.2/dist/pnpm.mjs"
session_pnpm_intact "$ROOT/11.1.2" "$GOOD_INT"
check "包里的文件被改过：认得出来" "$?" 1
CHANGES=() REDS=()
install_good
has "被改过就重装" "${CHANGES[*]}" '装 pnpm 11\.1\.2'
session_pnpm_intact "$ROOT/11.1.2" "$GOOD_INT"
check "重装后和装的时候一样" "$?" 0
rm -f -- "$ROOT/11.1.2/bin/pnpm.mjs"
session_pnpm_intact "$ROOT/11.1.2" "$GOOD_INT"
check "入口文件被删：认得出来" "$?" 1
CHANGES=() REDS=()
install_good
has "被删就重装" "${CHANGES[*]}" '装 pnpm 11\.1\.2'
make_pkg pnpm 11.1.2 bin/pnpm.mjs "if (process.argv.includes('--version')) console.log('11.1.2');"
session_pnpm_intact "$ROOT/11.1.2" "$PKG_INTEGRITY"
check "钉的校验和换了：认得出来（要重装）" "$?" 1
echo '# 手改一行' >>"$BIN"
CHANGES=() REDS=()
install_good
has "入口被手改：写回去" "${CHANGES[*]}" "写 $BIN"
check "写回去之后又核了一遍版本" "$SESSION_PNPM_HAVE" 11.1.2

echo "== 3. 核不上就不装：判红、返回 1，什么都不装"
refuse=0
expect_refuse() { # 说明 版本 sha512 地址 红里要有的（grep -E）
  local root bin
  refuse=$((refuse + 1))
  root=$T/refuse-$refuse
  bin=$T/bin/refuse-$refuse
  CHANGES=() REDS=()
  ensure_session_pnpm "$2" "$3" "$4" "$root" "$bin" as_u /usr/bin:/bin >/dev/null
  check "$1：返回 1" "$?" 1
  check "$1：记一笔红" "${#REDS[@]}" 1
  has "$1：红里说清" "$(last_red)" "$5"
  check "$1：什么都没装" "$(ls -A "$root" 2>/dev/null)$([[ -e "$bin" ]] && echo 入口在)" ""
}
make_pkg pnpm 11.1.2 bin/pnpm.mjs "console.log('11.1.2 改过的');"
expect_refuse "包被换过（sha512 对不上）" 11.1.2 "$GOOD_INT" "file://$PKG" 'sha512 对不上，不装'
expect_refuse "下载失败" 11.1.2 "$GOOD_INT" "file://$T/没有这个包.tgz" '下载失败'
make_pkg pnpm 11.1.3
expect_refuse "包里是别的版本" 11.1.2 "$PKG_INTEGRITY" "file://$PKG" '包是「pnpm@11\.1\.3」，要的是 pnpm@11\.1\.2'
make_pkg not-pnpm 11.1.2
expect_refuse "包名不对" 11.1.2 "$PKG_INTEGRITY" "file://$PKG" '包是「not-pnpm@11\.1\.2」'
make_pkg pnpm 11.1.2 bin/missing.mjs
expect_refuse "入口不在包里" 11.1.2 "$PKG_INTEGRITY" "file://$PKG" '入口认不出或不在：「bin/missing\.mjs」'
make_pkg pnpm 11.1.2 ../../etc/passwd
expect_refuse "入口越出包外" 11.1.2 "$PKG_INTEGRITY" "file://$PKG" '入口认不出或不在'
echo '不是 tgz' >"$T/not-a-tgz"
expect_refuse "不是 tgz" 11.1.2 "sha512-$(openssl dgst -sha512 -binary <"$T/not-a-tgz" | base64 -w0)" "file://$T/not-a-tgz" '解不开'
expect_refuse "版本的写法认不出" 11.1 "$GOOD_INT" "file://$GOOD" '版本认不出：「11\.1」'
expect_refuse "校验和的写法认不出" 11.1.2 "sha256-abc" "file://$GOOD" '不是 npm integrity 的写法'

echo "== 4. 引擎给会话的 PATH：照在跑的引擎进程读"
SESSION_PROC=$T/proc
# 造一个「进程」：环境一项一个参数，-- 之后是启动命令（和 /proc/<进程号>/environ、cmdline 一样用 \0 隔开）
fake_engine() { # 进程号 环境… -- 启动命令…
  local d=$SESSION_PROC/$1
  shift
  mkdir -p "$d"
  : >"$d/environ"
  while (($#)) && [[ "$1" != -- ]]; do
    printf '%s\0' "$1" >>"$d/environ"
    shift
  done
  shift
  : >"$d/cmdline"
  while (($#)); do
    printf '%s\0' "$1" >>"$d/cmdline"
    shift
  done
}
mkdir -p "$T/rel/abc123/packages/engine/src"
: >"$T/rel/abc123/packages/engine/src/main.ts"
ln -s abc123 "$T/rel/current"
MAIN=$T/rel/current/packages/engine/src/main.ts
SYS=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fake_engine 101 LANG=C.UTF-8 "PATH=$SYS" FLEET_CLI_BIN=/opt/cli/bin FLEET_AGENT_TOKEN_SECRET=不该带出来 -- /usr/bin/node "$MAIN"
engine_session_path 101
check "配了 FLEET_CLI_BIN：它在前，引擎自己的 PATH 接在后面" "$?:$SESSION_PATH" "0:/opt/cli/bin:$SYS"
check "别的环境变量不带出来" "$(grep -c 不该带出来 <<<"$SESSION_PATH$SESSION_PATH_WHY")" 0
fake_engine 102 "PATH=$SYS" -- /usr/bin/node "$MAIN"
engine_session_path 102
check "没配：按 main.ts 的真实路径（current 是链接）算 packages/cli/bin" "$?:$SESSION_PATH" "0:$T/rel/abc123/packages/cli/bin:$SYS"
fake_engine 103 "PATH=$SYS" "FLEET_CLI_BIN=  " -- /usr/bin/node --max-old-space-size=2048 "$MAIN"
engine_session_path 103
check "FLEET_CLI_BIN 只有空白算没配；node 带着参数也认得出入口" "$?:$SESSION_PATH" "0:$T/rel/abc123/packages/cli/bin:$SYS"
fake_engine 104 "FLEET_CLI_BIN= /opt/cli/bin " -- /usr/bin/node "$MAIN"
engine_session_path 104
check "引擎自己没有 PATH：只剩 fleet 命令的目录，FLEET_CLI_BIN 去掉两头空白" "$?:$SESSION_PATH" "0:/opt/cli/bin"
expect_no_path() { # 说明 进程号 原因里要有的（grep -E）
  engine_session_path "$2"
  check "$1：返回 1，SESSION_PATH 是空的" "$?:$SESSION_PATH" "1:"
  has "$1：原因说清" "$SESSION_PATH_WHY" "$3"
}
expect_no_path "主进程号是 0（引擎没在跑）" 0 '引擎没在跑'
expect_no_path "主进程号是空的" "" '引擎没在跑'
expect_no_path "主进程号认不出" abc '引擎没在跑'
expect_no_path "进程没了" 999 '读不到引擎进程（999）的环境'
mkdir -p "$SESSION_PROC/105"
printf 'PATH=%s\0' "$SYS" >"$SESSION_PROC/105/environ"
expect_no_path "读不到启动命令" 105 '读不到引擎进程（105）的启动命令'
fake_engine 106 "PATH=$SYS" -- /usr/bin/node /srv/别的/app.ts
expect_no_path "启动命令里没有 main.ts" 106 '认不出引擎的启动命令'
fake_engine 107 "PATH=$SYS" -- /usr/bin/node "$T/rel/没有这一版/packages/engine/src/main.ts"
expect_no_path "入口解不出真实路径" 107 '解不出真实路径'

echo "== 5. 按一条 PATH 跑 pnpm --version"
fake_pnpm() { # 目录 正文
  mkdir -p "$1"
  chmod 755 "$1"
  printf '#!/bin/sh\n%s\n' "$2" >"$1/pnpm"
  chmod 755 "$1/pnpm"
}
expect_red() { # 说明 PATH 红里要有的（grep -E） [要的版本]
  REDS=()
  check_session_pnpm "${4:-11.1.2}" "$BIN" "测试的 PATH" as_u "$2" >/dev/null
  check "$1：记一笔红" "${#REDS[@]}" 1
  has "$1：红里说清" "$(last_red)" "$3"
}
REDS=()
check_session_pnpm 11.1.2 "$BIN" "测试的 PATH" as_u "$T/bin:/usr/bin:/bin" >/dev/null
check "找得到、就是装的那个、版本对：不红" "${#REDS[@]}" 0
check "找到的是装的入口，版本对" "$SESSION_PNPM_AT $SESSION_PNPM_HAVE" "$BIN 11.1.2"
mkdir -p "$T/empty"
chmod 755 "$T/empty"
expect_red "PATH 上没有 pnpm" "$T/empty" 'PATH 上找不到 pnpm'
fake_pnpm "$T/shadow" 'echo 11.1.2'
expect_red "先找到的不是装的那个" "$T/shadow:$T/bin:/usr/bin:/bin" "先找到的 pnpm 是 $T/shadow/pnpm，不是装机装的 $BIN"
expect_red "版本不对" "$T/bin:/usr/bin:/bin" '上的 pnpm 是 11\.1\.2，应为 11\.1\.3' 11.1.3
fake_pnpm "$T/garbage" 'echo "pnpm, version unknown"'
expect_red "输出认不出" "$T/garbage:/usr/bin:/bin" '输出认不出'
fake_pnpm "$T/crash" 'echo "Error: 坏了" >&2; exit 3'
expect_red "跑不起来" "$T/crash:/usr/bin:/bin" "找到 $T/crash/pnpm，跑 pnpm --version 退出 3：Error: 坏了"
fake_pnpm "$T/hang" 'sleep 60'
t0=$SECONDS
expect_red "卡住" "$T/hang:/usr/bin:/bin" '卡住，被 timeout 叫停（退出码 124'
check "卡住：几秒就返回（SESSION_PNPM_TIMEOUT=2）" "$((SECONDS - t0 <= 5))" 1
fake_pnpm "$T/stubborn" "trap '' TERM; sleep 60"
t0=$SECONDS
expect_red "不理叫停" "$T/stubborn:/usr/bin:/bin" '退出码 137'
check "不理叫停：再过 5 秒被强杀就返回" "$((SECONDS - t0 <= 10))" 1
pkill -KILL -u "$U" >/dev/null 2>&1
refused_runner() {
  echo "sudo: a password is required" >&2
  return 1
}
REDS=()
check_session_pnpm 11.1.2 "$BIN" "测试的 PATH" refused_runner >/dev/null
has "起命令那一步就没成：判红，带着它的报错" "$(last_red)" '退出 1：sudo: a password is required'
TMPDIR=$T/没有这个目录 session_pnpm_probe pnpm as_u "$T/bin:/usr/bin:/bin"
check "放输出的临时文件建不了：没查成" "$?" 1
has "临时文件建不了：原因说没查成" "$SESSION_PNPM_WHY" '建不了放输出的临时文件.*没查成'

if ((fail)); then
  echo "session-pnpm：不通过"
  exit 1
fi
echo "session-pnpm：通过"
